import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { AskEntry, AskQuestion } from '../../services/chat/askQuestions.js'
import { Button } from '../base/Button.js'
import { IconCheckedOutline14 } from '../base/icons.js'
import styles from './AskComposer.module.css'

type AnswerDraft = { selected: string[]; custom: string }

/**
 * 询问工具的作答面板：临时占用输入框的位置与宽度，输入框随之隐藏（草稿仍保留在草稿服务里）。
 * 一次只显示一道题，底部按「上一题 / 下一题 / 提交」导航；未作答的题目提交时按跳过处理。
 */
export const AskComposer = ({ entry }: { entry: AskEntry }) => {
  const t = useTranslate()
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({})
  const total = entry.questions.length
  const question = entry.questions[Math.min(index, total - 1)]
  const current = drafts[question.id] ?? { selected: [], custom: '' }
  const last = index >= total - 1

  const update = (next: Partial<AnswerDraft>) => {
    setDrafts((previous) => {
      const draft = previous[question.id] ?? { selected: [], custom: '' }
      return { ...previous, [question.id]: { ...draft, ...next } }
    })
  }

  const pick = (question: AskQuestion, label: string) => {
    // 用函数式更新：连续点击多选项时基于最新草稿累加，避免闭包里的旧值互相覆盖
    setDrafts((previous) => {
      const draft = previous[question.id] ?? { selected: [], custom: '' }
      const selected = question.multi_select
        ? draft.selected.includes(label)
          ? draft.selected.filter((item) => item !== label)
          : [...draft.selected, label]
        : draft.selected.includes(label)
          ? []
          : [label]
      return { ...previous, [question.id]: { ...draft, selected } }
    })
  }

  const submit = () => {
    entry.onSubmit(
      entry.questions.map((item) => {
        const draft = drafts[item.id]
        const selected = draft?.selected ?? []
        const custom = draft?.custom.trim() ?? ''
        return { id: item.id, selected, ...(custom ? { custom } : {}) }
      })
    )
  }

  const goNext = () => {
    if (!last) {
      setIndex(index + 1)
    }
  }

  return (
    <div className={styles.wrapper} role="group" aria-label={t('askComposerLabel')}>
      <div className={styles.header}>
        <span className={styles.progress}>{t('askProgress', { index: index + 1, total })}</span>
        {question.header ? <span className={styles.tag}>{question.header}</span> : null}
      </div>
      <div className={styles.body}>
        <div className={styles.question}>{question.question}</div>
        {question.options ? (
          <>
            <div className={styles.options} role={question.multi_select ? 'group' : 'radiogroup'}>
              {question.options.map((option) => {
                const checked = current.selected.includes(option.label)
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
            </div>
            <input
              className={styles.input}
              placeholder={t('askCustomPlaceholder')}
              value={current.custom}
              onChange={(event) => update({ custom: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  if (last) {
                    submit()
                  } else {
                    goNext()
                  }
                }
              }}
            />
          </>
        ) : (
          <input
            className={styles.input}
            placeholder={t('askInputPlaceholder')}
            value={current.custom}
            onChange={(event) => update({ custom: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (last) {
                  submit()
                } else {
                  goNext()
                }
              }
            }}
          />
        )}
      </div>
      <div className={styles.footer}>
        <button type="button" className={styles.cancel} onClick={() => entry.onCancel()}>
          {t('cancel')}
        </button>
        <div className={styles.nav}>
          <Button
            variant="outlined"
            size="s"
            disabled={index === 0}
            onClick={() => setIndex(index - 1)}
          >
            {t('askPrev')}
          </Button>
          {/* 提交只出现在最后一题；前面只提供「下一题」 */}
          {last ? (
            <Button size="s" onClick={submit}>
              {t('askSubmit')}
            </Button>
          ) : (
            <Button variant="outlined" size="s" onClick={goNext}>
              {t('askNext')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
