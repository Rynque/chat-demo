import type {
  AssistantBlockParam,
  FileBlockParam,
  MessageParam,
  MessageStreamEvent,
  OutputBlockStart,
  TextBlockParam,
  ToolResultBlockParam,
} from '../api/types.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  UserMessage,
} from './types.js'

/**
 * 文件按 Files API 的 file_id（附件的 serverId）引用：图片用 image 块，其余用 document 块。
 * 发送前 streamReply 会先补齐 serverId；仍为 null 的是本地没有原件的附件，不进入请求。
 */
const toFileBlocks = (files: FileAttachment[]): FileBlockParam[] =>
  files.flatMap(({ serverId, isImage }) =>
    serverId
      ? [
          {
            type: isImage ? 'image' : 'document',
            source: { type: 'file', file_id: serverId },
          },
        ]
      : []
  )

const toReplyBlock = (block: OutputBlockStart, now: number): ReplyBlock | null => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, citations: block.citations ?? [] }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
        startedAt: now,
      }
    case 'tool_use':
      // 参数可能随后续 input_json_delta 补齐，先记下调用本身
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
        status: 'running',
      }
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      return block
    default:
      return null
  }
}

const updateBlock = (
  reply: AssistantMessage,
  index: number,
  update: (block: ReplyBlock) => ReplyBlock
): AssistantMessage => {
  const block = reply.blocks[index]
  if (!block) {
    return reply
  }
  const blocks = [...reply.blocks]
  blocks[index] = update(block)
  return { ...reply, blocks }
}

/**
 * 把一个流式事件合并进回复：只追加可识别的内容块，用本次请求的临时索引映射处理增量。
 * 客户端工具的参数由 input_json_delta 分片到达，先攒在 inputs 里，块结束时再解析。
 */
export const applyEvent = (
  reply: AssistantMessage,
  event: MessageStreamEvent,
  now: number,
  blockIndexes: Map<number, number>,
  inputs: Map<number, string>
): AssistantMessage => {
  const next: AssistantMessage =
    reply.status === 'streaming' ? reply : { ...reply, status: 'streaming' }
  switch (event.type) {
    case 'message_start':
      return { ...next, usage: event.message.usage ?? next.usage }
    case 'content_block_start': {
      blockIndexes.delete(event.index)
      inputs.delete(event.index)
      const block = toReplyBlock(event.content_block, now)
      if (!block) {
        return next
      }
      blockIndexes.set(event.index, next.blocks.length)
      return { ...next, blocks: [...next.blocks, block] }
    }
    case 'content_block_delta': {
      const { delta } = event
      if (delta.type === 'input_json_delta') {
        inputs.set(event.index, (inputs.get(event.index) ?? '') + delta.partial_json)
        return next
      }
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      return updateBlock(next, index, (block) => {
        if (block.type === 'text' && delta.type === 'text_delta') {
          return { ...block, text: block.text + delta.text }
        }
        if (block.type === 'thinking' && delta.type === 'thinking_delta') {
          return { ...block, thinking: block.thinking + delta.thinking }
        }
        if (block.type === 'thinking' && delta.type === 'signature_delta') {
          return { ...block, signature: (block.signature ?? '') + delta.signature }
        }
        if (block.type === 'text' && delta.type === 'citations_delta') {
          return { ...block, citations: [...(block.citations ?? []), delta.citation] }
        }
        return block
      })
    }
    case 'content_block_stop': {
      const raw = inputs.get(event.index)
      inputs.delete(event.index)
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      blockIndexes.delete(event.index)
      return updateBlock(next, index, (block) => {
        if (block.type === 'tool_use' && raw) {
          return { ...block, input: parseToolInput(raw) }
        }
        return block.type === 'thinking' &&
          block.startedAt !== undefined &&
          block.endedAt === undefined
          ? { ...block, endedAt: now }
          : block
      })
    }
    case 'message_delta':
      return {
        ...next,
        stopReason: event.delta.stop_reason,
        stopDetails: event.delta.stop_details,
        usage: event.usage ?? next.usage,
      }
    default:
      return next
  }
}

/** 参数解析失败时保留空对象并标记错误，避免整条回复中断 */
const parseToolInput = (raw: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * 回复结束：未结束的思考块以当前时间收尾。
 * 安全拒绝（stop_reason: refusal）时已下发的思考与正文不能撤回，按协议要求由客户端丢弃，只保留工具块。
 */
export const settleReply = (
  reply: AssistantMessage,
  status: Extract<ReplyStatus, 'done' | 'stopped' | 'error'>,
  now: number,
  error?: AssistantMessage['error']
): AssistantMessage => ({
  ...reply,
  status,
  error,
  blocks: reply.blocks.flatMap((block): ReplyBlock[] => {
    if (reply.stopReason === 'refusal' && (block.type === 'thinking' || block.type === 'text')) {
      return []
    }
    return block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
      ? [{ ...block, endedAt: now }]
      : [block]
  }),
})

/** 回复里所有文本块拼起来，用于复制与判断是否有回答 */
export const getReplyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/** 可以直接续写的错误类型：网络中断、流错误、未正常结束或读流失败；鉴权/额度等错误重试无意义 */
const CONTINUABLE_ERRORS = new Set(['network', 'stream', 'interrupted', 'protocol'])

/**
 * 可续写：正常达到输出上限、被用户停止，或网络类错误中断且已有部分内容。
 * 末条限制由调用方判断，拒绝和客户端工具调用不能续写。
 * 本轮含服务端工具调用或结果（含 READ_LINK 和孤立结果块）的回复不能续写。
 * 服务端模板提示不能作为续写前缀。
 */
export const canContinueReply = (reply: AssistantMessage): boolean => {
  if (
    !reply.prefix ||
    reply.stopReason === 'refusal' ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some(
      (block) =>
        block.type === 'server_tool_use' ||
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result' ||
        block.type === 'tool_use' ||
        block.type === 'tool_result' ||
        (block.type === 'text' && block.isTemplate)
    )
  ) {
    return false
  }
  const partial = reply.blocks.some(
    (block) =>
      (block.type === 'text' && block.text.trim() !== '') ||
      (block.type === 'thinking' && block.thinking.trim() !== '')
  )
  if (!partial) {
    return false
  }
  const recoverable =
    reply.status === 'error' && !!reply.error && CONTINUABLE_ERRORS.has(reply.error.kind)
  return (
    recoverable ||
    reply.status === 'stopped' ||
    (reply.status === 'done' && reply.stopReason === 'max_tokens')
  )
}

/** 工具往返必须成对：缺结果的调用会被服务端拒绝，这类轮次不能进上下文 */
const hasCompleteTools = (blocks: ReplyBlock[]) => {
  const results = new Set(
    blocks.flatMap((block) => (block.type === 'tool_result' ? [block.tool_use_id] : []))
  )
  return blocks.every((block) => block.type !== 'tool_use' || results.has(block.id))
}

/**
 * 已结束或停止、有正文或完整工具往返的回复才放进上下文；被安全拒绝的轮次不回传。
 * 服务端模板提示不进入上下文。
 */
const isUsableReply = (message: Message): message is AssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
  hasCompleteTools(message.blocks) &&
  (getReplyText(message) !== '' || message.blocks.some((block) => block.type === 'tool_use'))

/** 有文件时用内容块数组：先文件后文本，文件按 Files API 的 file_id 引用 */
const toUserParam = ({ content, files }: UserMessage): MessageParam => {
  const blocks = toFileBlocks(files)
  return blocks.length === 0
    ? { role: 'user', content }
    : {
        role: 'user',
        content: [...blocks, ...(content ? [{ type: 'text' as const, text: content }] : [])],
      }
}

/**
 * 把一条回复拆成请求里的多段 message：
 * - assistant 段只带正文、思考与客户端工具调用；
 * - 每条 tool_use 的结果进紧随其后的 user 段，且排在文本之前；
 * - 历史里只回传 kind 为 read_link 的服务端工具块，且必须有签名。
 */
export const toReplyMessages = (
  { blocks }: AssistantMessage,
  /**
   * 请求带 tools 时，历史每一轮的 reasoning_content 都必须完整回传，否则返回 400
   * （见 thinking_mode 指南）；本应用始终声明工具，因此默认保留思考。
   */
  keepThinking = true
): MessageParam[] => {
  // 服务端阅读链接靠签名恢复网页，缺少有效签名的调用与结果都不回传。
  const unsigned = new Set(
    blocks.flatMap((block) =>
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      block.content.type === 'web_fetch_result' &&
      !block.signature?.trim()
        ? [block.tool_use_id]
        : []
    )
  )
  const messages: MessageParam[] = []
  let assistant: AssistantBlockParam[] = []
  let results: ToolResultBlockParam[] = []
  /** 正在拼接的文本块；遇到非文本块就结束 */
  let text: TextBlockParam | null = null

  const flushAssistant = () => {
    if (assistant.length > 0) {
      messages.push({ role: 'assistant', content: assistant })
      assistant = []
    }
    text = null
  }
  const flushResults = () => {
    if (results.length > 0) {
      messages.push({ role: 'user', content: results })
      results = []
    }
  }

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      flushAssistant()
      results.push({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
      })
      continue
    }
    flushResults()
    if (block.type === 'text') {
      if (block.isTemplate) {
        continue
      }
      if (text) {
        text.text += block.text
      } else {
        const previous = assistant.at(-1)
        text = {
          type: 'text',
          text: `${previous?.type === 'text' ? '\n\n' : ''}${block.text}`,
        }
        assistant.push(text)
      }
      continue
    }
    text = null
    if (block.type === 'thinking') {
      if (keepThinking && block.thinking.trim()) {
        assistant.push({
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature ?? '',
        })
      }
    } else if (block.type === 'tool_use') {
      assistant.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
    } else if (
      block.type === 'server_tool_use' &&
      block.kind === 'read_link' &&
      !unsigned.has(block.id)
    ) {
      const { type, id, name, input, kind } = block
      assistant.push({ type, id, name, input, kind })
    } else if (
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      !unsigned.has(block.tool_use_id)
    ) {
      assistant.push(block)
    }
  }
  flushAssistant()
  flushResults()
  return messages
}

/** 历史中会进入请求上下文的轮次：提问后紧跟可用回答的才保留 */
export const getContextRounds = (history: Message[]): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && isUsableReply(reply)) {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

/**
 * latest_reminder 只接受单行五段格式（日期,星期,位置,平台,语言）。
 * 旧版本曾把补充说明追加成第二行，服务端会直接拒绝，因此发送时只保留第一行。
 */
const normalizeReminder = (value: string | undefined) => {
  const line = value?.split(/\r?\n/, 1)[0]?.trim()
  return line ? line : undefined
}

/**
 * 把会话转成请求的 messages：只保留「提问 + 有回答的回复」成对的轮次，最后接上本轮提问。
 * 失败或没有回答的轮次不进上下文。续写时末尾再带上本轮 assistant。
 */
export const toRequestMessages = (
  history: Message[],
  question: UserMessage,
  prefix?: AssistantMessage,
  latestReminder?: string
): MessageParam[] => {
  const messages: MessageParam[] = []
  let previousReminder: string | undefined
  const appendReminder = (reminder: string | undefined) => {
    const normalized = normalizeReminder(reminder)
    // 仅在当前分支首次出现或内容变化时插入快照；缺少快照的消息保持原有内容。
    if (normalized && normalized !== previousReminder) {
      messages.push({ role: 'latest_reminder', content: normalized })
      previousReminder = normalized
    }
  }
  for (const [user, reply] of getContextRounds(history)) {
    // 历史提问没有文字、附件也都没有 serverId 时，提问为空，连同回答一起省略。
    if (!user.content && toFileBlocks(user.files).length === 0) {
      continue
    }
    appendReminder(reply.latestReminder)
    messages.push(toUserParam(user), ...toReplyMessages(reply))
  }
  appendReminder(latestReminder)
  messages.push(toUserParam(question))
  if (prefix?.prefix) {
    const last = toReplyMessages(prefix, true).at(-1)
    // 没有非空白正文或有效思考时直接重发原问题，避免服务端拒绝空 Prefill。
    if (
      last?.role === 'assistant' &&
      last.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'thinking' && block.thinking.trim())
      )
    ) {
      messages.push(last)
    }
  }
  return messages
}

/** 思考用时（秒），至少 1 秒 */
export const getThinkingSeconds = (startedAt: number, endedAt: number) =>
  Math.max(1, Math.round((endedAt - startedAt) / 1000))
