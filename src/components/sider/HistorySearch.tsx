import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { focusMessage } from '../../services/chat/focusMessage.js'
import { searchHistory, type HistoryHit } from '../../services/chat/historySearch.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import { useSettings, type Locale } from '../../services/settings.js'
import { IconButton } from '../base/IconButton.js'
import { IconArrowLeftOutline16, IconCloseFill14, IconSearchOutline16 } from '../base/icons.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './HistorySearch.module.css'

/** 输入停顿后再检索，避免每个字符都读一遍本地会话 */
const DEBOUNCE = 160

type Status = 'idle' | 'searching' | 'done' | 'more' | 'error'

/** 结果里的日期：同一年只写月日，跨年才带年份 */
const formatHitDate = (at: number, locale: Locale) => {
  const date = new Date(at)
  if (locale !== 'zh-CN') {
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`
  }
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === new Date().getFullYear()
    ? monthDay
    : `${date.getFullYear()}年${monthDay}`
}

const Highlight = ({
  text,
  ranges,
}: {
  text: string
  ranges: readonly (readonly [number, number])[]
}) => {
  if (ranges.length === 0) {
    return text
  }
  const parts: ReactNode[] = []
  let cursor = 0
  ranges.forEach(([start, end], index) => {
    if (start > cursor) {
      parts.push(text.slice(cursor, start))
    }
    parts.push(
      <mark key={index} className={styles.mark}>
        {text.slice(start, end)}
      </mark>
    )
    cursor = end
  })
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }
  return <>{parts}</>
}

/**
 * 历史对话搜索：和官网一致地在会话内容里找关键词，命中按时间倒序排列，
 * 点结果跳到对应消息；本地数据分批扫描，用「查找更早的消息」继续。
 */
export const HistorySearch = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const sessions = useChatStore((state) => state.sessions)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<HistoryHit[]>([])
  const [scanned, setScanned] = useState(0)
  const [more, setMore] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  /** -1 表示没有选中项：避免刚出结果就有一条看起来被选中 */
  const [active, setActive] = useState(-1)
  const [attempt, setAttempt] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const runRef = useRef(0)

  const keyword = query.trim()

  useEffect(() => {
    if (!keyword) {
      setHits([])
      setScanned(0)
      setMore(false)
      setStatus('idle')
      setActive(-1)
      return
    }
    const run = (runRef.current += 1)
    setHits([])
    setScanned(0)
    setMore(false)
    setStatus('searching')
    setActive(-1)
    const timer = setTimeout(() => {
      void searchHistory(keyword, sessions)
        .then((page) => {
          if (runRef.current !== run) {
            return
          }
          setHits(page.hits)
          setScanned(page.scanned)
          setMore(page.more)
          setStatus('done')
        })
        .catch(() => {
          if (runRef.current === run) {
            setStatus('error')
          }
        })
    }, DEBOUNCE)
    return () => clearTimeout(timer)
  }, [keyword, sessions, attempt])

  // 键盘上下选择时把条目带进可视区域
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, hits])

  const open = useCallback(
    (hit: HistoryHit) => {
      focusMessage(hit.messageId)
      selectSession(hit.sessionId)
      closeMobileSider()
      onClose()
    },
    [onClose]
  )

  const loadMore = () => {
    if (!keyword || status !== 'done' || !more) {
      return
    }
    const run = runRef.current
    setStatus('more')
    void searchHistory(keyword, sessions, { from: scanned })
      .then((page) => {
        if (runRef.current !== run) {
          return
        }
        setHits((previous) => [...previous, ...page.hits])
        setScanned(page.scanned)
        setMore(page.more)
        setStatus('done')
      })
      .catch(() => {
        if (runRef.current === run) {
          setStatus('error')
        }
      })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (hits.length === 0) {
        return
      }
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) =>
        current < 0 ? (step > 0 ? 0 : hits.length - 1) : (current + step + hits.length) % hits.length
      )
      return
    }
    const target = hits[active < 0 ? 0 : active]
    if (event.key === 'Enter' && target && !event.nativeEvent.isComposing) {
      event.preventDefault()
      open(target)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (query) {
        setQuery('')
      } else {
        onClose()
      }
    }
  }

  const searching = status === 'searching'
  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconArrowLeftOutline16 />}
          tooltip={t('historySearchClose')}
          onClick={onClose}
        />
        <div className={styles.field}>
          <span className={styles.fieldIcon} aria-hidden>
            <IconSearchOutline16 />
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            placeholder={t('historySearchPlaceholder')}
            aria-label={t('historySearchPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {query ? (
            <button
              type="button"
              className={styles.clear}
              aria-label={t('historySearchClear')}
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
            >
              <IconCloseFill14 />
            </button>
          ) : null}
        </div>
      </div>
      <div ref={listRef} className={styles.body}>
        {status === 'idle' ? <p className={styles.tip}>{t('historySearchIdleHint')}</p> : null}
        {searching ? (
          <p className={styles.tip} role="status">
            <span className={styles.spinner} aria-hidden />
            {t('historySearchSearching')}
          </p>
        ) : null}
        {status === 'error' ? (
          <p className={styles.tip} role="alert">
            {t('historySearchFailed')}
            <button
              type="button"
              className={styles.retry}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t('retry')}
            </button>
          </p>
        ) : null}
        {status === 'done' && hits.length === 0 ? (
          <p className={styles.tip}>
            {more ? (
              <>
                {t('historySearchNoResultRecently')}
                <button type="button" className={styles.inlineMore} onClick={loadMore}>
                  {t('historySearchEarlier')}
                </button>
              </>
            ) : (
              t('historySearchNoResult')
            )}
          </p>
        ) : null}
        {hits.length > 0 ? (
          <div role="listbox" aria-label={t('historySearchResults')}>
            {hits.map((hit, index) => (
              <button
                key={hit.key}
                type="button"
                role="option"
                aria-selected={index === active}
                data-active={index === active}
                className={clsx(styles.hit, index === active && styles.active)}
                onMouseEnter={() => setActive(index)}
                onClick={() => open(hit)}
              >
                <span className={styles.hitTop}>
                  <span className={styles.hitTitle}>
                    <Highlight
                      text={hit.sessionTitle || t('untitledChat')}
                      ranges={hit.titleRanges}
                    />
                  </span>
                  <span className={styles.hitDate}>{formatHitDate(hit.at, locale)}</span>
                </span>
                <span className={styles.hitSnippet}>
                  <Highlight text={hit.snippet} ranges={hit.snippetRanges} />
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {status === 'more' ? (
          <p className={styles.tip} role="status">
            <span className={styles.spinner} aria-hidden />
            {t('historySearchLoadingMore')}
          </p>
        ) : null}
        {status === 'done' && more && hits.length > 0 ? (
          <button type="button" className={styles.more} onClick={loadMore}>
            {t('historySearchEarlier')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
