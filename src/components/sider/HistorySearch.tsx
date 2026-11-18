import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { focusMessage } from '../../services/chat/focusMessage.js'
import { searchHistory, type HistoryHit } from '../../services/chat/historySearch.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import { useSettings, type Locale } from '../../services/settings.js'
import { IconChatBubbleOutline20, IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './HistorySearch.module.css'

/** 输入停顿后再检索，避免每个字符都读一遍本地会话 */
const DEBOUNCE = 160

type Status = 'idle' | 'searching' | 'done' | 'more' | 'error'

/** 结果时间：当天到分钟，同年到日期，跨年带年份 */
const formatHitTime = (at: number, locale: Locale) => {
  const date = new Date(at)
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  const monthDay =
    locale === 'zh-CN'
      ? `${date.getMonth() + 1}月${date.getDate()}日`
      : `${date.getMonth() + 1}/${date.getDate()}`
  return date.getFullYear() === now.getFullYear()
    ? monthDay
    : locale === 'zh-CN'
      ? `${date.getFullYear()}年${monthDay}`
      : `${monthDay}/${date.getFullYear()}`
}

const Highlight = ({
  text,
  ranges,
  emphasis,
}: {
  text: string
  ranges: readonly (readonly [number, number])[]
  emphasis: 'title' | 'snippet'
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
      <span key={index} className={emphasis === 'title' ? styles.markTitle : styles.markSnippet}>
        {text.slice(start, end)}
      </span>
    )
    cursor = end
  })
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }
  return <>{parts}</>
}

/**
 * 历史对话搜索：与官网一致的全屏遮罩 + 居中模态（移动端整页），
 * 结果按时间倒序，点一条跳到对应消息。
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
  const [active, setActive] = useState(0)
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
      setActive(0)
      return
    }
    const run = (runRef.current += 1)
    setStatus('searching')
    // 新关键词开始检索时清掉上一轮结果，避免旧条目与加载状态同时渲染
    setHits([])
    setScanned(0)
    setMore(false)
    setActive(0)
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

  // 键盘选择时把条目带进可视区域
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
      setActive((current) => (current + step + hits.length) % hits.length)
      return
    }
    if (event.key === 'Enter' && hits[active] && !event.nativeEvent.isComposing) {
      event.preventDefault()
      open(hits[active])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const listLabel = useMemo(() => t('historySearchResults'), [t])

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className={styles.stage}>
        <div
          className={clsx(styles.dialog, keyword && styles.expanded)}
          role="dialog"
          aria-modal="true"
          aria-label={t('historySearchTrigger')}
        >
          <div className={styles.header}>
            <span className={styles.headerIcon} aria-hidden>
              <IconSearchOutline16 />
            </span>
            <input
              ref={inputRef}
              className={styles.input}
              role="searchbox"
              value={query}
              placeholder={t('historySearchPlaceholder')}
              aria-label={t('historySearchPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
            />
            <span className={styles.divider} aria-hidden />
            <button
              type="button"
              className={styles.close}
              aria-label={t('close')}
              onClick={onClose}
            >
              <IconCloseOutline16 />
            </button>
          </div>
          {/* 没有输入内容时只保留头部，结果区不参与布局 */}
          {keyword ? (
            <div ref={listRef} className={styles.body} role="listbox" aria-label={listLabel}>
              {status === 'searching' ? (
                <p className={styles.state} role="status">
                  <span className={styles.spinner} aria-hidden />
                  {t('historySearchSearching')}
                </p>
              ) : null}
              {status === 'error' ? (
                <p className={styles.state} role="alert">
                  {t('historySearchFailed')}
                  <button
                    type="button"
                    className={styles.stateAction}
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    {t('retry')}
                  </button>
                </p>
              ) : null}
              {status === 'done' && hits.length === 0 ? (
                <p className={styles.state}>
                  <IconSearchOutline16 />
                  {t('historySearchNoResult')}
                </p>
              ) : null}
              {hits.map((hit, index) => (
                <button
                  key={hit.key}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  aria-posinset={index + 1}
                  aria-setsize={hits.length}
                  data-active={index === active}
                  className={clsx(styles.item, index === active && styles.active)}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => open(hit)}
                >
                  <span className={styles.itemIcon} aria-hidden>
                    <IconChatBubbleOutline20 />
                  </span>
                  <span className={styles.itemMain}>
                    <span className={styles.itemTop}>
                      <span className={styles.itemTitle}>
                        <Highlight
                          text={hit.sessionTitle || t('untitledChat')}
                          ranges={hit.titleRanges}
                          emphasis="title"
                        />
                      </span>
                      <span className={styles.itemTime}>{formatHitTime(hit.at, locale)}</span>
                    </span>
                    <span className={styles.itemSnippet}>
                      <Highlight text={hit.snippet} ranges={hit.snippetRanges} emphasis="snippet" />
                    </span>
                  </span>
                </button>
              ))}
              {status === 'more' ? (
                <p className={styles.state} role="status">
                  <span className={styles.spinner} aria-hidden />
                  {t('historySearchLoadingMore')}
                </p>
              ) : null}
              {status === 'done' && more ? (
                <button type="button" className={styles.more} onClick={loadMore}>
                  {t('historySearchEarlier')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}
