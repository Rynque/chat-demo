import {
  ApiError,
  API_ORIGIN,
  isErrorBody,
  readErrorResponse,
  request as httpRequest,
} from './client.js'
import { readServerSentEvents } from './sse.js'
import type {
  AssistantBlockParam,
  ClientToolDeclaration,
  CreateMessageRequest,
  FileBlockParam,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
  TextBlockParam,
  ToolResultBlockParam,
} from './types.js'

/**
 * Chat Completions（OpenAI 兼容）协议的请求/响应类型，只取本应用用到的部分。
 * 文档：https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
 * 非思考模式即可使用客户端工具，因此消息请求改走 POST /chat/completions；
 * 内部仍产出 Messages 形状的 MessageStreamEvent，reply.ts / UI 不变。
 */

type ChatTextPart = { type: 'text'; text: string }
type ChatImagePart = { type: 'image_url'; image_url: { url: string } }
type ChatFilePart = { type: 'file'; file_id: string }
type ChatContentPart = ChatTextPart | ChatImagePart | ChatFilePart

type ChatToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ChatMessage =
  | { role: 'system'; content: string }
  // Chat Completions 原生支持该角色，必须紧挨在所属 user 消息之前
  | { role: 'latest_reminder'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | {
      role: 'assistant'
      content: string | null
      /** 开启思考模式且请求携带 tools 时，历史轮次的思维链必须完整回传 */
      reasoning_content?: string
      tool_calls?: ChatToolCall[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

type ChatTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ClientToolDeclaration['input_schema']
  }
}

type ChatCompletionRequest = {
  model: CreateMessageRequest['model']
  messages: ChatMessage[]
  thinking: CreateMessageRequest['thinking']
  tools: ChatTool[]
  safety_check?: CreateMessageRequest['safety_check']
  title?: CreateMessageRequest['title']
  stream: true
  stream_options: { include_usage: true }
}

type ChatToolCallDelta = {
  /** 同一次响应内的调用序号，参数的增量按它归组 */
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

type ChatDelta = {
  content?: string
  reasoning_content?: string
  tool_calls: ChatToolCallDelta[]
  title?: string
}

type ChatChunk = {
  id: string
  model: string
  delta: ChatDelta
  finishReason: string | null
  usage: MessageUsage | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * usage.prompt_cache_miss_tokens 对应内部 input_tokens（未命中缓存的输入），
 * prompt_cache_hit_tokens 对应 cache_read_input_tokens；Chat Completions 没有
 * cache_creation 字段，固定为 0。文档：/zh-cn/api/create-chat-completion#schema-completion-usage
 */
const readUsage = (value: unknown): MessageUsage | null => {
  if (!isRecord(value)) {
    return null
  }
  const inputTokens = value.prompt_cache_miss_tokens
  const cacheReadTokens = value.prompt_cache_hit_tokens
  const outputTokens = value.completion_tokens
  if (
    !isFiniteNumber(inputTokens) ||
    !isFiniteNumber(cacheReadTokens) ||
    !isFiniteNumber(outputTokens)
  ) {
    return null
  }
  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheReadTokens,
    output_tokens: outputTokens,
  }
}

const readToolCallDeltas = (value: unknown): ChatToolCallDelta[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || !Number.isSafeInteger(item.index) || (item.index as number) < 0) {
      return []
    }
    const fn = isRecord(item.function) ? item.function : undefined
    return [
      {
        index: item.index as number,
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(fn && (typeof fn.name === 'string' || typeof fn.arguments === 'string')
          ? {
              function: {
                ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
                ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}),
              },
            }
          : {}),
      },
    ]
  })
}

const readChunk = (value: unknown): ChatChunk | null => {
  if (!isRecord(value)) {
    return null
  }
  // include_usage 时最后一个块带 usage：可能没有 choices，仍需读出用量
  const choices = Array.isArray(value.choices) ? value.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : null
  const delta = choice && isRecord(choice.delta) ? choice.delta : {}
  return {
    id: typeof value.id === 'string' ? value.id : '',
    model: typeof value.model === 'string' ? value.model : '',
    delta: {
      ...(typeof delta.content === 'string' && delta.content !== ''
        ? { content: delta.content }
        : {}),
      ...(typeof delta.reasoning_content === 'string' && delta.reasoning_content !== ''
        ? { reasoning_content: delta.reasoning_content }
        : {}),
      ...(typeof delta.title === 'string' ? { title: delta.title } : {}),
      tool_calls: readToolCallDeltas(delta.tool_calls),
    },
    finishReason:
      choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    usage: readUsage(value.usage),
  }
}

/** 内部只认这四种结束原因；拒答在 Chat Completions 用 content_filter 表示 */
const readStopReason = (finishReason: string): StopReason | null => {
  switch (finishReason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    default:
      return null
  }
}

/**
 * 图片/文件块：file 来源统一转成 {type:'file', file_id}（图像方式 3、文档引用）；
 * base64 与 url 只有图片支持，转成 image_url。文档：/zh-cn/guides/vision
 */
const toContentPart = (block: FileBlockParam): ChatContentPart | null => {
  const { source } = block
  switch (source.type) {
    case 'file':
      return { type: 'file', file_id: source.file_id }
    case 'base64':
      return block.type === 'image'
        ? {
            type: 'image_url',
            image_url: { url: `data:${source.media_type};base64,${source.data}` },
          }
        : null
    case 'url':
      return block.type === 'image' ? { type: 'image_url', image_url: { url: source.url } } : null
    default:
      return null
  }
}

/**
 * user 段：tool_result 必须转成独立的 tool 消息并紧跟 assistant 的 tool_calls，
 * 因此排在同一个 user 段的文字/图片之前；其余块合成一条 user 消息。
 */
const toUserMessages = (
  content: string | (FileBlockParam | TextBlockParam | ToolResultBlockParam)[]
): ChatMessage[] => {
  if (typeof content === 'string') {
    return [{ role: 'user', content }]
  }
  const toolMessages: ChatMessage[] = []
  const parts: ChatContentPart[] = []
  for (const block of content) {
    if (block.type === 'tool_result') {
      toolMessages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: block.content,
      })
      continue
    }
    const part =
      block.type === 'text' ? { type: 'text' as const, text: block.text } : toContentPart(block)
    if (part) {
      parts.push(part)
    }
  }
  return [...toolMessages, ...(parts.length > 0 ? [{ role: 'user' as const, content: parts }] : [])]
}

/**
 * assistant 段：文字合并为 content，思考回传为 reasoning_content（携带 tools 时服务端
 * 要求回传历史思维链），客户端工具调用转成 tool_calls。
 * 联网工具的服务端块在 Chat Completions 没有对应字段，这里省略。
 */
const toAssistantMessages = (blocks: AssistantBlockParam[]): ChatMessage[] => {
  const texts: string[] = []
  const thoughts: string[] = []
  const toolCalls: ChatToolCall[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      texts.push(block.text)
    } else if (block.type === 'thinking') {
      if (block.thinking.trim()) {
        thoughts.push(block.thinking)
      }
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      })
    }
  }
  if (texts.length === 0 && thoughts.length === 0 && toolCalls.length === 0) {
    return []
  }
  return [
    {
      role: 'assistant',
      content: texts.length > 0 ? texts.join('\n\n') : null,
      ...(thoughts.length > 0 ? { reasoning_content: thoughts.join('\n\n') } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ]
}

const toMessages = (message: MessageParam): ChatMessage[] => {
  switch (message.role) {
    case 'latest_reminder':
      return [{ role: 'latest_reminder', content: message.content }]
    case 'user':
      return toUserMessages(message.content)
    case 'assistant':
      return toAssistantMessages(message.content)
  }
}

const toChatMessages = (request: CreateMessageRequest): ChatMessage[] => {
  const messages: ChatMessage[] = [{ role: 'system', content: request.system }]
  for (const message of request.messages) {
    messages.push(...toMessages(message))
  }
  return messages
}

const toChatRequest = (request: CreateMessageRequest): ChatCompletionRequest => ({
  model: request.model,
  messages: toChatMessages(request),
  thinking: request.thinking,
  tools: request.tools.map(({ name, description, input_schema }) => ({
    type: 'function',
    function: { name, description, parameters: input_schema },
  })),
  ...(request.safety_check ? { safety_check: request.safety_check } : {}),
  ...(request.title ? { title: request.title } : {}),
  stream: true,
  stream_options: { include_usage: true },
})

type OpenBlock = { index: number; kind: 'thinking' | 'text' }

type ToolCallState = {
  id: string
  name: string
  arguments: string
  /** 已经通过 input_json_delta 下发过的参数长度 */
  emitted: number
  blockIndex?: number
}

/**
 * POST /chat/completions（stream: true, stream_options.include_usage: true），
 * 把 OpenAI 兼容的 chunk 还原成内部事件：思考/正文/客户端工具各成一块，
 * 结束时补上 message_delta（含 usage、title）与 message_stop。
 * 错误处理与 Anthropic 客户端一致：HTTP 错误体、流内错误帧、断流分别映射为 ApiError。
 */
export async function* streamChatMessage(
  apiKey: string,
  request: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await httpRequest(`${API_ORIGIN}/chat/completions`, {
    method: 'POST',
    headers: {
      // Chat Completions 用 Bearer 鉴权；文档：/zh-cn/api/create-chat-completion#身份验证
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(toChatRequest(request)),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }

  const events: MessageStreamEvent[] = []
  let started = false
  let nextBlockIndex = 0
  let open: OpenBlock | null = null
  const toolBlocks = new Map<number, number>()
  const toolStates = new Map<number, ToolCallState>()
  let usage: MessageUsage | undefined
  let title: string | undefined

  const closeOpenBlock = () => {
    if (open) {
      events.push({ type: 'content_block_stop', index: open.index })
      open = null
    }
  }

  const openBlock = (kind: OpenBlock['kind']): number => {
    if (open?.kind === kind) {
      return open.index
    }
    closeOpenBlock()
    const index = nextBlockIndex++
    open = { index, kind }
    events.push({
      type: 'content_block_start',
      index,
      content_block:
        kind === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' },
    })
    return index
  }

  /** 工具调用按 index 归组；id 与 name 齐了才建块，参数增量随后补发 */
  const applyToolCallDelta = (delta: ChatToolCallDelta) => {
    let state = toolStates.get(delta.index)
    if (!state) {
      state = { id: '', name: '', arguments: '', emitted: 0 }
      toolStates.set(delta.index, state)
    }
    if (state.id === '' && delta.id) {
      state.id = delta.id
    }
    if (state.name === '' && delta.function?.name) {
      state.name = delta.function.name
    }
    if (delta.function?.arguments) {
      state.arguments += delta.function.arguments
    }
    if (state.blockIndex === undefined) {
      if (state.id === '' || state.name === '') {
        return
      }
      closeOpenBlock()
      state.blockIndex = nextBlockIndex++
      toolBlocks.set(delta.index, state.blockIndex)
      events.push({
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
      })
    }
    if (state.arguments.length > state.emitted) {
      events.push({
        type: 'content_block_delta',
        index: state.blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: state.arguments.slice(state.emitted),
        },
      })
      state.emitted = state.arguments.length
    }
  }

  const closeToolBlocks = () => {
    for (const index of toolBlocks.values()) {
      events.push({ type: 'content_block_stop', index })
    }
    toolBlocks.clear()
  }

  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    if (data === '[DONE]') {
      break
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const chunk = readChunk(payload)
    if (!chunk) {
      continue
    }
    if (!started) {
      started = true
      events.push({
        type: 'message_start',
        message: { id: chunk.id, model: chunk.model || request.model },
      })
    }
    if (chunk.usage) {
      usage = chunk.usage
    }

    const { delta } = chunk
    if (delta.reasoning_content) {
      events.push({
        type: 'content_block_delta',
        index: openBlock('thinking'),
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      })
    }
    if (delta.content) {
      events.push({
        type: 'content_block_delta',
        index: openBlock('text'),
        delta: { type: 'text_delta', text: delta.content },
      })
    }
    for (const toolCall of delta.tool_calls) {
      applyToolCallDelta(toolCall)
    }
    if (delta.title !== undefined) {
      title = delta.title
    }

    if (chunk.finishReason !== null) {
      closeOpenBlock()
      closeToolBlocks()
      const stopReason = readStopReason(chunk.finishReason)
      if (stopReason === null) {
        // 资源不足、服务端中止等没有对应的内部结束原因，按断流处理
        yield* events
        throw new ApiError('interrupted', '')
      }
      events.push({
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
          ...(stopReason === 'refusal'
            ? { stop_details: { type: 'refusal', category: null, explanation: null } }
            : {}),
          ...(title ? { title } : {}),
        },
        ...(usage ? { usage } : {}),
      })
      events.push({ type: 'message_stop' })
      yield* events
      return
    }
    yield* events
    events.length = 0
  }
  // 与 Anthropic 客户端一致：没有正常结束前断流，不推测原因
  throw new ApiError('interrupted', '')
}
