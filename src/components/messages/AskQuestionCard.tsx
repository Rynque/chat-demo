import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { useState } from 'react'
import { useAskQuestions, type AskAnswer, type AskQuestion } from '../../services/chat/askQuestions.js'
import { resumeAskUser } from '../../services/chat/store.js'
import type { AskStep } from '../../services/chat/view.js'
import { Button } from '../base/Button.js'
import {
  IconChatBubbleOutline20,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '../base/icons.js'
import styles from './AskQuestionCard.module.css'

/** 已回答数：有选中项或自定义输入的题才算回答，其余视为跳过 */
const answeredCount = (questions: AskQuestion[], answers: AskAnswer[]) => {
  const byId = new Map(answers.map((answer) => [answer.id, answer]))
  return questions.filter((question) => {
    const answer = byId.get(question.id)
    return !!answer && (answer.selected.length > 0 || !!answer.custom?.trim())
  }).length
}

/** 时间线里的提问行外壳 */
const AskRow = ({
  children,
  isLast,
  active,
}: {
  children: React.ReactNode
  isLast: boolean
  active?: boolean
}) => (
  <div className={clsx(styles.tool, !isLast && styles.withLine)}>
    <span className={clsx(styles.toolIcon, !active && styles.stoppedIcon)}>
      <IconChatBubbleOutline20 />
    </span>
    <div className={styles.toolBody}>{children}</div>
  </div>
)

/**
 * 询问工具在时间线里的记录行：
 * 等待回答时只提示状态（作答面板占用输入框位置，见 AskComposer）；
 * answered 折叠为「提问 · x/y 已回答」，可展开查看问答；
 * 刷新遗留的中断提问提供重新提问；被停止或取消的只提示不可恢复。
 */
export const AskQuestionCard = ({
  sessionId,
  messageId,
  step,
  isLast,
  canResume,
}: {
  sessionId: string
  messageId: string
  step: AskStep
  isLast: boolean
  /** 仅当前回复是可视路径最后一条时提供重新提问 */
  canResume: boolean
}) => {
  const t = useTranslate()
  const entry = useAskQuestions((state) => state.entries[step.callId])
  const [expanded, setExpanded] = useState(false)

  if (step.status === 'answered' && step.answers) {
    const count = answeredCount(step.questions, step.answers)
    const byId = new Map(step.answers.map((answer) => [answer.id, answer]))
    return (
      <AskRow isLast={isLast}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className={styles.intro}>
            {t('askAnsweredLabel', { answered: count, total: step.questions.length })}
          </span>
          {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </button>
        {expanded ? (
          <div className={styles.details}>
            {step.questions.map((question) => {
              const answer = byId.get(question.id)
              const text = answer
                ? [answer.selected.join('、'), answer.custom?.trim()].filter(Boolean).join('；') ||
                  t('askSkipped')
                : t('askSkipped')
              return (
                <div key={question.id} className={styles.detail}>
                  <div className={styles.detailQuestion}>{question.question}</div>
                  <div className={styles.detailAnswer}>{text}</div>
                </div>
              )
            })}
          </div>
        ) : null}
      </AskRow>
    )
  }

  // 等待回答：作答面板在输入框位置，时间线只保留状态
  if (step.status === 'wip') {
    return (
      <AskRow isLast={isLast} active>
        <span className={clsx(styles.intro, entry ? undefined : styles.shimmer)}>
          {entry ? t('askWaitingReply') : t('askPreparing')}
        </span>
      </AskRow>
    )
  }

  if (step.status === 'failed') {
    return (
      <AskRow isLast={isLast}>
        <span className={styles.intro}>{t('askInterrupted')}</span>
      </AskRow>
    )
  }

  if (!entry) {
    return (
      <AskRow isLast={isLast}>
        <span className={styles.intro}>{t('askInterrupted')}</span>
        {canResume ? (
          <Button
            variant="outlined"
            size="s"
            className={styles.reAsk}
            onClick={() => resumeAskUser(sessionId, messageId, step.callId)}
          >
            {t('askReAsk')}
          </Button>
        ) : null}
      </AskRow>
    )
  }

  return null
}
