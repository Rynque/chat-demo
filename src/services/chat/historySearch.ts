import { getVisibleMessages } from './branches.js'
import { loadSession } from './db.js'
import { getReplyText } from './reply.js'
import { useChatStore } from './store.js'
import type { Session, SessionSummary } from './types.js'

/** 每页扫描的会话数：本地读取分批进行，避免一次打开太多会话详情 */
export const SEARCH_PAGE_SESSIONS = 20
/** 单页最多返回的命中数，超出的部分交给「查找更早的消息」继续 */
const MAX_PAGE_HITS = 40
/** 摘要里命中位置前后的字数 */
const SNIPPET_BEFORE = 32
const SNIPPET_AFTER = 88

export type HistoryHit = {
  key: string
  sessionId: string
  /** 命中消息，打开会话后定位到它 */
  messageId: string
  sessionTitle: string
  titleRanges: [number, number][]
  snippet: string
  snippetRanges: [number, number][]
  /** 命中消息的时间，用于排序与展示 */
  at: number
}

export type HistorySearchPage = {
  hits: HistoryHit[]
  /** 已经扫描到的位置，下一页从这里继续 */
  scanned: number
  /** 是否还有更早的会话没扫描 */
  more: boolean
}

/** 忽略大小写的全部命中位置，用于把摘要与标题里的关键词标出来 */
const rangesIn = (text: string, query: string): [number, number][] => {
  if (!text || !query) {
    return []
  }
  const ranges: [number, number][] = []
  const lower = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  for (
    let index = lower.indexOf(needle);
    index >= 0 && ranges.length < 20;
    index = lower.indexOf(needle, index + needle.length)
  ) {
    ranges.push([index, index + needle.length])
  }
  return ranges
}

const flatten = (text: string) => text.replace(/\s+/g, ' ').trim()

/** 以第一处命中为中心截取摘要，两端补省略号，范围按截取后的字符串重新计算 */
const snippetOf = (text: string, query: string) => {
  const flat = flatten(text)
  const index = flat.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (index < 0) {
    return null
  }
  const start = Math.max(0, index - SNIPPET_BEFORE)
  const end = Math.min(flat.length, index + query.length + SNIPPET_AFTER)
  const snippet = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
  return { snippet, ranges: rangesIn(snippet, query) }
}

/** 只搜索当前分支：命中项要能在会话里直接看到 */
const scanSession = (session: Session, query: string): HistoryHit[] => {
  const titleRanges = rangesIn(session.title, query)
  const messages = getVisibleMessages(session)
  const hits: HistoryHit[] = []
  for (const message of messages) {
    const text = message.role === 'user' ? message.content : getReplyText(message)
    const snippet = snippetOf(text, query)
    if (!snippet) {
      continue
    }
    hits.push({
      key: `${session.id}:${message.id}`,
      sessionId: session.id,
      messageId: message.id,
      sessionTitle: session.title,
      titleRanges,
      snippet: snippet.snippet,
      snippetRanges: snippet.ranges,
      at: message.createdAt,
    })
  }
  if (hits.length > 0 || titleRanges.length === 0) {
    return hits
  }
  // 只有标题命中时，用第一条提问定位，摘要取它的开头
  const first = messages.find((message) => message.role === 'user')
  const snippet = first ? flatten(first.content).slice(0, SNIPPET_BEFORE + SNIPPET_AFTER) : ''
  return first
    ? [
        {
          key: `${session.id}:${first.id}`,
          sessionId: session.id,
          messageId: first.id,
          sessionTitle: session.title,
          titleRanges,
          snippet,
          snippetRanges: [],
          at: first.createdAt,
        },
      ]
    : []
}

/** 会话详情优先取界面缓存，未打开的再从 IndexedDB 读 */
const readSession = async (id: string) =>
  useChatStore.getState().sessionCache[id] ?? (await loadSession(id))

/**
 * 按 updatedAt 降序逐段搜索本地会话：从 from 开始扫描 count 个会话，
 * 命中按时间倒序返回；还有更早的会话时 more 为 true。
 */
export const searchHistory = async (
  rawQuery: string,
  sessions: SessionSummary[],
  { from = 0, count = SEARCH_PAGE_SESSIONS }: { from?: number; count?: number } = {}
): Promise<HistorySearchPage> => {
  const query = rawQuery.trim()
  const hits: HistoryHit[] = []
  let index = from
  while (query && index < sessions.length && index < from + count) {
    const session = await readSession(sessions[index].id)
    index += 1
    if (!session) {
      continue
    }
    hits.push(...scanSession(session, query))
    if (hits.length >= MAX_PAGE_HITS) {
      break
    }
  }
  hits.sort((left, right) => right.at - left.at)
  return {
    hits: hits.slice(0, MAX_PAGE_HITS),
    scanned: index,
    more: index < sessions.length,
  }
}
