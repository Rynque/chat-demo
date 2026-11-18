import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { useState } from 'react'
import {
  cancelAsk,
  submitAskAnswers,
  useAskQuestions,
  type AskAnswer,
  type AskEntry,
  type AskQuestion,
} from '../../services/chat/askQuestions.js'
import { resumeAskUser } from '../../services/chat/store.js'
import type { AskStep } from '../../services/chat/view.js'
import { Button } from '../base/Button.js'
import {
  IconChatBubbleOutline20,
  IconCheckedOutline14,
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
 * 询问工具的提问卡片：
 * answered 折叠为「提问 · x/y 已回答」，可展开查看问答；
 * 等待回答时渲染交互卡片（登记表里有当前调用），单选 / 多选 / 自定义输入 / 提交；
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

  if (step.status === 'wip' && !entry) {
    return (
      <AskRow isLast={isLast} active>
        <span className={clsx(styles.intro, styles.shimmer)}>{t('askPreparing')}</span>
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

  return (
    <AskRow isLast={isLast} active>
      <InteractiveForm entry={entry} />
    </AskRow>
  )
}

/** 等待回答的交互卡片；草稿按问题 id 存在本地状态，提交后整体交给登记表回调 */
const InteractiveForm = ({ entry }: { entry: AskEntry }) => {
  const t = useTranslate()
  const [draft, setDraft] = useState<Record<string, { selected: string[]; custom: string }>>({})

  const pick = (question: AskQuestion, label: string) => {
    setDraft((previous) => {
      const current = previous[question.id]?.selected ?? []
      const selected = question.multi_select
        ? current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label]
        : current.includes(label)
          ? []
          : [label]
      return {
        ...previous,
        [question.id]: { selected, custom: previous[question.id]?.custom ?? '' },
      }
    })
  }

  const setCustom = (id: string, value: string) => {
    setDraft((previous) => ({
      ...previous,
      [id]: { selected: previous[id]?.selected ?? [], custom: value },
    }))
  }

  const submit = () => {
    const answers: AskAnswer[] = entry.questions.map((question) => {
      const item = draft[question.id]
      const selected = item?.selected ?? []
      const custom = item?.custom.trim() ?? ''
      return { id: question.id, selected, ...(custom ? { custom } : {}) }
    })
    submitAskAnswers(entry.callId, answers)
  }

  return (
    <div className={styles.card}>
      {entry.questions.map((question) => {
        const item = draft[question.id]
        const selected = item?.selected ?? []
        return (
          <div key={question.id} className={styles.questionItem}>
            {question.header ? <span className={styles.header}>{question.header}</span> : null}
            <div className={styles.question}>{question.question}</div>
            {question.options ? (
              <div className={styles.options} role={question.multi_select ? 'group' : 'radiogroup'}>
                {question.options.map((option) => {
                  const checked = selected.includes(option.label)
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role={question.multi_select ? 'checkbox' : 'radio'}
                      aria-checked={checked}
                      className={clsx(styles.option, checked && styles.selected)}
                      onClick={() => pick(question, option.label)}
                    >
                      <span
                        className={clsx(
                          styles.mark,
                          question.multi_select && styles.checkbox,
                          checked && styles.markChecked
                        )}
                      >
                        {checked ? (
                          <span className={styles.markIcon}>
                            <IconCheckedOutline14 />
                          </span>
                        ) : null}
                      </span>
                      <span className={styles.optionBody}>
                        <span className={styles.optionLabel}>{option.label}</span>
                        {option.description ? (
                          <span className={styles.optionDescription}>{option.description}</span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
                <input
                  className={styles.input}
                  placeholder={t('askCustomPlaceholder')}
                  value={item?.custom ?? ''}
                  onChange={(event) => setCustom(question.id, event.target.value)}
                />
              </div>
            ) : (
              <input
                className={styles.input}
                placeholder={t('askInputPlaceholder')}
                value={item?.custom ?? ''}
                onChange={(event) => setCustom(question.id, event.target.value)}
              />
            )}
          </div>
        )
      })}
      <div className={styles.footer}>
        <span className={styles.hint}>{t('askSkipHint')}</span>
        <button type="button" className={styles.cancel} onClick={() => cancelAsk(entry.callId)}>
          {t('cancel')}
        </button>
        <Button size="s" onClick={submit}>
          {t('askSubmit')}
        </Button>
      </div>
    </div>
  )
}
