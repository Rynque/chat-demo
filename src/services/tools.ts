import { request, API_ORIGIN } from './api/client.js'
import type { ClientToolDeclaration } from './api/types.js'
import type { ToolCallData, ToolSource } from './chat/types.js'

/** 单次工具结果：content 交给模型，data 只用于界面展示 */
export type ToolOutcome = { content: string; data?: ToolCallData }

export type ToolContext = { apiKey: string; signal: AbortSignal }

type Tool = {
  declaration: ClientToolDeclaration
  run: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolOutcome>
}

/** 搜索结果上限与正文截断长度：控制回传给模型的 token 规模 */
const SEARCH_LIMIT = 8
const FETCH_CONTENT_LIMIT = 12000

const readString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const toolRequest = async (
  path: string,
  body: Record<string, unknown>,
  { apiKey, signal }: ToolContext
): Promise<unknown> => {
  const response = await request(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      // 原生工具接口用 Bearer，同时带上 x-api-key 兼容两种鉴权
      authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
  return response.json()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readSearchResults = (value: unknown): ToolSource[] => {
  const results = isRecord(value) && Array.isArray(value.results) ? value.results : []
  return results.flatMap((item) => {
    if (!isRecord(item) || typeof item.url !== 'string' || typeof item.title !== 'string') {
      return []
    }
    return [
      {
        url: item.url,
        title: item.title,
        snippet: typeof item.snippet === 'string' ? item.snippet : '',
        siteName: typeof item.site_name === 'string' ? item.site_name : null,
        siteIcon: typeof item.site_icon === 'string' ? item.site_icon : null,
        publishedAt: typeof item.date === 'string' ? item.date : null,
      },
    ]
  })
}

const webSearchTool: Tool = {
  declaration: {
    name: 'web_search',
    description:
      '搜索网页。需要最新信息、外部事实核查，或用户明确要求联网检索时使用；返回标题、链接与摘要。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，支持 site: 等语法，最多 128 字符' },
      },
      required: ['query'],
    },
  },
  run: async (input, context) => {
    const query = readString(input.query).slice(0, 128)
    if (!query) {
      throw new Error('query 不能为空')
    }
    const payload = await toolRequest('/v1/tools/search', { query, count: SEARCH_LIMIT }, context)
    const results = readSearchResults(payload)
    const content =
      results.length === 0
        ? `搜索「${query}」没有结果。`
        : `搜索「${query}」的结果：\n\n${results
            .map(
              (item, index) =>
                `${index + 1}. ${item.title}\n${item.url}\n${item.snippet || '（无摘要）'}`
            )
            .join('\n\n')}`
    return { content, data: { kind: 'search', query, results } }
  },
}

const fetchTool: Tool = {
  declaration: {
    name: 'fetch_url',
    description:
      '抓取指定网页，返回标题与 Markdown 正文。用户给出链接、或搜索结果需要展开细节时使用。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 HTTP/HTTPS 地址' },
      },
      required: ['url'],
    },
  },
  run: async (input, context) => {
    const url = readString(input.url)
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('url 必须是 HTTP/HTTPS 地址')
    }
    const payload = await toolRequest('/v1/tools/fetch', { url }, context)
    const record = isRecord(payload) ? payload : {}
    const title = typeof record.title === 'string' ? record.title : ''
    const body = typeof record.content === 'string' ? record.content : ''
    if (!body) {
      throw new Error('页面没有可读正文')
    }
    const content = `网页：${title || url}\n${url}\n\n${body.slice(0, FETCH_CONTENT_LIMIT)}`
    return {
      content,
      data: { kind: 'fetch', url, title: title || url, excerpt: body.slice(0, 200) },
    }
  },
}

/** 新增工具只需在这里加一项：声明给模型、执行在本地 */
const TOOLS: Tool[] = [webSearchTool, fetchTool]

export const TOOL_DECLARATIONS = TOOLS.map((tool) => tool.declaration)

export const runTool = (name: string, input: Record<string, unknown>, context: ToolContext) => {
  const tool = TOOLS.find((item) => item.declaration.name === name)
  if (!tool) {
    throw new Error(`未知工具：${name}`)
  }
  return tool.run(input, context)
}
