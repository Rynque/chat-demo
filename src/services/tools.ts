import { request, API_ORIGIN } from './api/client.js'
import type { ClientToolDeclaration } from './api/types.js'
import type { ToolCallData, ToolSection, ToolSource } from './chat/types.js'
import { applyWrites, deleteFile, listFiles, readFile, snapshot, writeFile } from './vfs.js'
import { runScript } from './tools/jsSandbox.js'

/** 单次工具结果：content 交给模型，data 只用于界面展示 */
export type ToolOutcome = { content: string; data?: ToolCallData }

export type ToolContext = { apiKey: string; sessionId: string; signal: AbortSignal }

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
    description: '按查询词检索网页，返回标题、链接与摘要。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询词，支持 site: 等检索语法，长度上限 128 字符。' },
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
    description: '抓取指定 URL，返回页面标题与 Markdown 正文。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 HTTP 或 HTTPS 地址。' },
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

/** 脚本执行的时长与输出上限：超出即终止 Worker */
const EXEC_TIMEOUT_MS = 5000
const MAX_OUTPUT_BYTES = 8192
/** 时间线展开预览的上限：避免把整份文件复制进消息记录 */
const MAX_PREVIEW_CHARS = 8000
const MAX_PREVIEW_TOTAL = 20000

const toolOutcome = (
  name: string,
  summary: string,
  content: string,
  sections?: ToolSection[]
): ToolOutcome => ({
  content,
  data: {
    kind: 'tool',
    name,
    summary,
    ...(sections && sections.length > 0 ? { sections } : {}),
  },
})

/** 把一段文本转成可展开块，超长截断并标注；多个块共享同一份配额 */
const previewSection = (
  label: string,
  content: string,
  options: { command?: boolean; budget?: { left: number } } = {}
): ToolSection | null => {
  const budget = options.budget?.left ?? MAX_PREVIEW_TOTAL
  if (budget <= 0 || content === '') {
    return null
  }
  const limit = Math.min(MAX_PREVIEW_CHARS, budget)
  const truncated = content.length > limit
  if (options.budget) {
    options.budget.left -= Math.min(content.length, limit)
  }
  return {
    label,
    content: truncated ? `${content.slice(0, limit)}\n…` : content,
    ...(options.command ? { command: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  }
}

const previewSections = (
  items: { label: string; content: string; command?: boolean }[]
): ToolSection[] => {
  const budget = { left: MAX_PREVIEW_TOTAL }
  return items.flatMap((item) => {
    const section = previewSection(item.label, item.content, {
      ...(item.command ? { command: true } : {}),
      budget,
    })
    return section ? [section] : []
  })
}

const countLines = (text: string) => (text === '' ? 0 : text.split('\n').length)

const vfsListTool: Tool = {
  declaration: {
    name: 'vfs_list',
    description: '列出当前会话虚拟文件系统中的文件路径与大小。',
    input_schema: { type: 'object', properties: {} },
  },
  run: async (_input, { sessionId }) => {
    const files = await listFiles(sessionId)
    if (files.length === 0) {
      return toolOutcome('vfs_list', '文件系统为空', '虚拟文件系统为空。')
    }
    const content = files.map((file) => `${file.path}\t${file.size} B`).join('\n')
    return toolOutcome('vfs_list', `列出 ${files.length} 个文件`, content)
  },
}

const vfsReadTool: Tool = {
  declaration: {
    name: 'vfs_read',
    description: '读取虚拟文件，返回带行号的内容；offset 与 limit 用于截取片段。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '虚拟文件路径，例如 notes/todo.md。' },
        offset: { type: 'integer', description: '起始行号，从 1 开始，默认 1。' },
        limit: { type: 'integer', description: '最多读取的行数，默认 200，上限 400。' },
      },
      required: ['path'],
    },
  },
  run: async (input, { sessionId }) => {
    const rawPath = readString(input.path)
    const file = await readFile(sessionId, rawPath)
    const offset = Math.max(1, Math.floor(Number(input.offset) || 1))
    const limit = Math.min(400, Math.max(1, Math.floor(Number(input.limit) || 200)))
    const lines = file.content.split('\n')
    const end = Math.min(lines.length, offset - 1 + limit)
    const body = lines
      .slice(offset - 1, end)
      .map((line, index) => `${offset + index}\t${line}`)
      .join('\n')
    const tail =
      end < lines.length ? `\n…（共 ${lines.length} 行，已读到第 ${end} 行，可用 offset 继续）` : ''
    return toolOutcome(
      'vfs_read',
      `读取 ${file.path}（${countLines(file.content)} 行）`,
      `${file.path}\n${body}${tail}`
    )
  },
}

const vfsWriteTool: Tool = {
  declaration: {
    name: 'vfs_write',
    description: '写入或覆盖虚拟文件。受单文件大小、会话总量与文件数配额限制，超出时返回错误。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '虚拟文件路径，例如 notes/todo.md。' },
        content: { type: 'string', description: '完整文件内容，文本。' },
      },
      required: ['path', 'content'],
    },
  },
  run: async (input, { sessionId }) => {
    const content = typeof input.content === 'string' ? input.content : String(input.content ?? '')
    const result = await writeFile(sessionId, readString(input.path), content)
    return toolOutcome(
      'vfs_write',
      `写入 ${result.path}（${result.size} B）`,
      `已写入 ${result.path}（${result.size} B，${countLines(content)} 行）。`,
      previewSections([{ label: `写入文件：${result.path}`, content }])
    )
  },
}

const vfsDeleteTool: Tool = {
  declaration: {
    name: 'vfs_delete',
    description: '删除虚拟文件。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '要删除的文件路径。' } },
      required: ['path'],
    },
  },
  run: async (input, { sessionId }) => {
    const path = await deleteFile(sessionId, readString(input.path))
    return toolOutcome('vfs_delete', `删除 ${path}`, `已删除 ${path}。`)
  },
}

const runJsTool: Tool = {
  declaration: {
    name: 'js_run',
    description:
      '在 Worker 沙箱中执行 JavaScript。运行环境不提供 require、fetch、DOM 与网络访问；提供 console、print 与 fs 接口（readFile、writeFile、appendFile、exists、unlink、list），用于读写当前会话的虚拟文件。支持顶层 await。',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 JavaScript 代码，可使用 await。' },
      },
      required: ['code'],
    },
  },
  run: async (input, { sessionId }) => {
    const code = typeof input.code === 'string' ? input.code : ''
    if (!code.trim()) {
      throw new Error('code 不能为空')
    }
    const files = await snapshot(sessionId)
    const result = await runScript({
      code,
      files,
      timeoutMs: EXEC_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    })
    const changed =
      Object.keys(result.files).length > 0 ? await applyWrites(sessionId, result.files) : []
    const parts: string[] = []
    if (result.stdout) {
      parts.push(`stdout:\n${result.stdout.trimEnd()}`)
    }
    if (result.stderr) {
      parts.push(`stderr:\n${result.stderr.trimEnd()}`)
    }
    if (result.value !== undefined) {
      parts.push(`返回值：\n${result.value}`)
    }
    if (changed.length > 0) {
      parts.push(`写入文件：${changed.join(', ')}`)
    }
    if (!result.ok) {
      parts.push(`错误：${result.error ?? '执行失败'}`)
    }
    const summary = '运行脚本'
    // 脚本用 fs.* 改文件属于执行副作用，不算「写入文件」；这里只展示命令本身与返回值
    const budget = { left: MAX_PREVIEW_TOTAL }
    const script = previewSection('执行命令', code.trimEnd(), { command: true, budget })
    // > 后面是返回值；脚本没有返回值时退回显示 stdout，避免丢失输出
    const returned = result.value !== undefined ? result.value : result.stdout.trimEnd()
    const output = returned ? previewSection('输出', returned, { budget }) : null
    const sections: ToolSection[] = []
    if (script) {
      sections.push({
        ...script,
        ...(output ? { output: output.content } : {}),
        ...(output?.truncated ? { truncated: true } : {}),
      })
    }
    for (const item of result.stderr
      ? [{ label: '错误输出', content: result.stderr.trimEnd() }]
      : []) {
      const section = previewSection(item.label, item.content, { budget })
      if (section) {
        sections.push(section)
      }
    }
    return toolOutcome('js_run', summary, parts.join('\n\n') || '（脚本没有输出）', sections)
  },
}

/** 运行虚拟文件：按 JS 执行文件内容，界面块展示返回值或错误 */
const runFileTool: Tool = {
  declaration: {
    name: 'js_run_file',
    description: '执行虚拟文件中的 JavaScript，返回返回值或错误信息。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '要执行的虚拟文件路径。' } },
      required: ['path'],
    },
  },
  run: async (input, { sessionId }) => {
    const file = await readFile(sessionId, readString(input.path))
    const files = await snapshot(sessionId)
    const result = await runScript({
      code: file.content,
      files,
      timeoutMs: EXEC_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    })
    const changed =
      Object.keys(result.files).length > 0 ? await applyWrites(sessionId, result.files) : []
    const parts: string[] = []
    if (result.value !== undefined) {
      parts.push(`返回值：\n${result.value}`)
    }
    if (result.stdout) {
      parts.push(`stdout:\n${result.stdout.trimEnd()}`)
    }
    if (result.stderr) {
      parts.push(`stderr:\n${result.stderr.trimEnd()}`)
    }
    if (changed.length > 0) {
      parts.push(`写入文件：${changed.join(', ')}`)
    }
    if (!result.ok) {
      parts.push(`错误：${result.error ?? '执行失败'}`)
    }
    const shown = result.ok
      ? (result.value ?? (result.stdout.trimEnd() || '（脚本没有返回值）'))
      : (result.error ?? '执行失败')
    return toolOutcome(
      'js_run_file',
      `运行 ${file.path}`,
      parts.join('\n\n') || '（没有输出）',
      previewSections([{ label: `运行文件：${file.path}`, content: shown }])
    )
  },
}

/** 新增工具只需在这里加一项：声明给模型、执行在本地 */
const TOOLS: Tool[] = [
  webSearchTool,
  fetchTool,
  vfsListTool,
  vfsReadTool,
  vfsWriteTool,
  vfsDeleteTool,
  runJsTool,
  runFileTool,
]

export const TOOL_DECLARATIONS = TOOLS.map((tool) => tool.declaration)

export const runTool = (name: string, input: Record<string, unknown>, context: ToolContext) => {
  const tool = TOOLS.find((item) => item.declaration.name === name)
  if (!tool) {
    throw new Error(`未知工具：${name}`)
  }
  return tool.run(input, context)
}
