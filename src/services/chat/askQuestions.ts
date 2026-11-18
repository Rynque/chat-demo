import { create } from 'zustand'

/**
 * 询问工具（ask_user_question）的提问数据与待回答登记表。
 * 工具执行时在表里登记一条待回答项，界面据此渲染提问卡片；用户提交后
 * 由登记时的回调决定去向：工具调用等待 Promise resolve，刷新后的恢复则续上工具循环。
 * 登记表只存在于内存：刷新后由「有 tool_use 无 tool_result」的界面状态标为已中断，提供重新提问。
 */

export type AskOption = {
  label: string
  description?: string
}

export type AskQuestion = {
  /** 问题标识，回答按它对应 */
  id: string
  question: string
  /** 问题所属主题的短标签 */
  header?: string
  /** 缺省时为自由输入题 */
  options?: AskOption[]
  multi_select?: boolean
}

export type AskAnswer = {
  id: string
  /** 选中的选项文案；跳过的题返回空数组 */
  selected: string[]
  /** 自定义输入的内容 */
  custom?: string
}

/** 单个问题的长度上限：超限直接截断，避免把上下文撑爆 */
const LIMITS = {
  questions: 4,
  id: 64,
  question: 1000,
  header: 12,
  options: 8,
  optionLabel: 100,
  optionDescription: 300,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readText = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.trim().slice(0, limit) : ''

/**
 * 解析并校验模型给出的 questions：缺 id 或正文的项直接丢弃，重复 id 只保留第一个，
 * 字段一律截断到上限，确保进入上下文与界面的数据都可控。
 */
export const parseAskQuestions = (value: unknown): AskQuestion[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const questions: AskQuestion[] = []
  for (const item of value.slice(0, LIMITS.questions)) {
    if (!isRecord(item)) {
      continue
    }
    const id = readText(item.id, LIMITS.id)
    const question = readText(item.question, LIMITS.question)
    if (!id || !question || seen.has(id)) {
      continue
    }
    seen.add(id)
    const header = readText(item.header, LIMITS.header)
    const options = Array.isArray(item.options)
      ? item.options.slice(0, LIMITS.options).flatMap((option) => {
          if (!isRecord(option)) {
            return []
          }
          const label = readText(option.label, LIMITS.optionLabel)
          if (!label) {
            return []
          }
          const description = readText(option.description, LIMITS.optionDescription)
          return [{ label, ...(description ? { description } : {}) }]
        })
      : []
    questions.push({
      id,
      question,
      ...(header ? { header } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(item.multi_select === true ? { multi_select: true } : {}),
    })
  }
  return questions
}

/** 提问卡片交互的完整输入：问题与提交/取消回调。 */
export type AskEntry = {
  /** 调用的 tool_use_id，也是登记表的键 */
  callId: string
  /** 属于哪个会话：提问卡片占用该会话的输入框位置 */
  sessionId: string
  questions: AskQuestion[]
  /** 提交所有问题的回答（跳过的题为空 selected）；回调内部负责取消登记 */
  onSubmit: (answers: AskAnswer[]) => void
  /** 用户取消提问：不回答、不折叠卡片，由模型决定下一步 */
  onCancel: () => void
}

type AskState = {
  /** 按工具调用的 tool_use_id 登记 */
  entries: Record<string, AskEntry>
}

export const useAskQuestions = create<AskState>(() => ({ entries: {} }))

const { getState: get, setState: set } = useAskQuestions

export const registerAskEntry = (callId: string, entry: AskEntry) => {
  set((state) => ({ entries: { ...state.entries, [callId]: entry } }))
}

export const unregisterAskEntry = (callId: string) => {
  set((state) => {
    if (!Object.hasOwn(state.entries, callId)) {
      return state
    }
    return {
      entries: Object.fromEntries(Object.entries(state.entries).filter(([id]) => id !== callId)),
    }
  })
}

export const submitAskAnswers = (callId: string, answers: AskAnswer[]) => {
  get().entries[callId]?.onSubmit(answers)
}

export const cancelAsk = (callId: string) => {
  get().entries[callId]?.onCancel()
}

/** 回答提交后交给模型的文本：按 spec 的输出形状 */
export const askAnswersContent = (answers: AskAnswer[]) =>
  JSON.stringify({
    answers: answers.map((answer) => ({
      id: answer.id,
      selected: answer.selected,
      ...(answer.custom ? { custom: answer.custom } : {}),
    })),
  })

/** 提问被中断/取消时回给模型的错误文案，沿用 DSH 的错误码 */
export const ASK_ABORTED_MESSAGE = 'ASK_ABORTED：用户已停止生成，本轮提问未回答'
export const ASK_CANCELLED_MESSAGE = 'ASK_CANCELLED：用户取消了提问，未回答任何问题'
