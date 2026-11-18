import { useMemo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import type { Session } from '../../services/chat/types.js'

/** token 数格式化：一千以上按 K 展示，保留一位小数 */
const formatTokens = (tokens: number) =>
  tokens >= 1024 ? `${(tokens / 1024).toFixed(1).replace(/\.0$/, '')}K` : String(tokens)

/**
 * 输入框下方的状态行：生成中固定展示「内容由 AI 生成，请仔细甄别」，
 * 结束后展示本轮用量（没有 usage 时仍显示提示语）。
 * 上下文占用取最近一轮请求的完整输入（input + cache + output），
 * 本轮与会话累计都是 output tokens。
 */
export const TokenUsage = ({
  session,
  streaming,
}: {
  session: Session
  streaming: boolean
}) => {
  const t = useTranslate()
  const summary = useMemo(() => {
    let last: { input: number; output: number } | null = null
    let totalOutput = 0
    for (const message of getVisibleMessages(session)) {
      if (message.role !== 'assistant' || !message.usage) {
        continue
      }
      const { usage } = message
      // 下一轮上下文 = 本轮输入（含缓存）+ 本轮输出
      last = {
        input:
          usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
        output: usage.output_tokens,
      }
      totalOutput += usage.output_tokens
    }
    if (!last) {
      return null
    }
    return { context: last.input + last.output, lastOutput: last.output, totalOutput }
  }, [session])

  if (streaming || !summary) {
    return <>{t('contentCaveat')}</>
  }
  return (
    <>
      {t('tokenUsageSummary', {
        context: formatTokens(summary.context),
        output: formatTokens(summary.lastOutput),
        total: formatTokens(summary.totalOutput),
      })}
    </>
  )
}
