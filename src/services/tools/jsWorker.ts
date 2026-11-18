/// <reference lib="webworker" />

/**
 * 用户脚本执行器：跑在独立 Worker 里，执行模型生成的 JS。
 * 不是安全边界（同源 Worker 仍可触达浏览器 API），只用于隔离 UI 线程并限制时长；
 * 因此这里不注入任何密钥或聊天数据，只给一份文件快照。
 */

type RunRequest = {
  id: number
  code: string
  /** 文本文件：路径 => 正文 */
  files: Record<string, string>
  /** 二进制文件：路径 => 原始字节与 MIME */
  binaries: Record<string, { data: ArrayBuffer; mimeType?: string }>
  maxOutputBytes: number
}

type Reply =
  | { id: number; type: 'output'; stream: 'out' | 'err'; text: string }
  | { id: number; type: 'result'; value: string }
  | { id: number; type: 'error'; message: string }
  | {
      id: number
      type: 'done'
      files: Record<string, string>
      binaries: Record<string, { data: ArrayBuffer; mimeType?: string }>
      deleted: string[]
    }

const scope = self as unknown as DedicatedWorkerGlobalScope
const send = (message: Reply) => scope.postMessage(message)

/** 参数名遮蔽：让脚本拿不到网络、存储、DOM 和动态代码入口。注意 eval 不能作为严格模式下的参数名 */
const BLOCKED = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'importScripts',
  'indexedDB',
  'caches',
  'localStorage',
  'sessionStorage',
  'navigator',
  'location',
  'history',
  'postMessage',
  'close',
  'self',
  'globalThis',
  'Function',
]

const truncate = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n…（输出已截断）` : text

const run = async ({ id, code, files, binaries, maxOutputBytes }: RunRequest) => {
  /** 文本文件按字符串、二进制按 Uint8Array 存放在同一张表里 */
  type Entry =
    | { kind: 'text'; content: string }
    | { kind: 'binary'; data: Uint8Array; mimeType?: string }
  const store = new Map<string, Entry>()
  for (const [path, content] of Object.entries(files)) {
    store.set(path, { kind: 'text', content })
  }
  for (const [path, entry] of Object.entries(binaries)) {
    store.set(path, {
      kind: 'binary',
      data: new Uint8Array(entry.data),
      ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
    })
  }
  const dirty = new Set<string>()
  /** fs.unlink 删掉的路径：空内容代表删除，二进制需要单独的删除列表 */
  const removed = new Set<string>()
  let out = ''
  let err = ''

  const write = (stream: 'out' | 'err', text: string) => {
    const line = `${text}\n`
    if (stream === 'out') {
      if (out.length < maxOutputBytes) {
        out += line
      }
    } else if (err.length < maxOutputBytes) {
      err += line
    }
  }

  const format = (value: unknown): string => {
    if (typeof value === 'string') {
      return value
    }
    try {
      return JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      return String(value)
    }
  }

  /** 接受 Uint8Array / ArrayBuffer / 普通数字数组，统一成 Uint8Array 副本 */
  const toBytes = (value: unknown): Uint8Array => {
    if (value instanceof Uint8Array) {
      return new Uint8Array(value)
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value.slice(0))
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      )
    }
    if (Array.isArray(value)) {
      return Uint8Array.from(value.map((item) => Number(item) & 0xff))
    }
    throw new Error('writeFileBytes 需要 Uint8Array、ArrayBuffer 或数字数组')
  }

  const consoleShim = {
    log: (...args: unknown[]) => write('out', args.map(format).join(' ')),
    info: (...args: unknown[]) => write('out', args.map(format).join(' ')),
    debug: (...args: unknown[]) => write('out', args.map(format).join(' ')),
    warn: (...args: unknown[]) => write('err', args.map(format).join(' ')),
    error: (...args: unknown[]) => write('err', args.map(format).join(' ')),
    table: (...args: unknown[]) => write('out', args.map(format).join(' ')),
  }

  const normalize = (path: unknown) =>
    String(path ?? '')
      .replace(/^\.?\//, '')
      .trim()

  const fsShim = {
    readFile: (path: unknown) => {
      const key = normalize(path)
      const entry = store.get(key)
      if (!entry) {
        throw new Error(`no such file: ${key}`)
      }
      if (entry.kind === 'binary') {
        throw new Error(`${key} 是二进制文件，请用 fs.readFileBytes 读取`)
      }
      return entry.content
    },
    readFileBytes: (path: unknown): Uint8Array => {
      const key = normalize(path)
      const entry = store.get(key)
      if (!entry) {
        throw new Error(`no such file: ${key}`)
      }
      // 文本按 UTF-8 编码成字节；返回副本，避免脚本改写内部快照
      const data = entry.kind === 'binary' ? entry.data : new TextEncoder().encode(entry.content)
      return new Uint8Array(data)
    },
    writeFile: (path: unknown, content: unknown) => {
      const key = normalize(path)
      store.set(key, { kind: 'text', content: String(content ?? '') })
      dirty.add(key)
      removed.delete(key)
    },
    writeFileBytes: (path: unknown, data: unknown, mimeType?: unknown) => {
      const key = normalize(path)
      const bytes = toBytes(data)
      const type = typeof mimeType === 'string' && mimeType.trim() ? mimeType.trim() : undefined
      store.set(key, { kind: 'binary', data: bytes, ...(type ? { mimeType: type } : {}) })
      dirty.add(key)
      removed.delete(key)
    },
    appendFile: (path: unknown, content: unknown) => {
      const key = normalize(path)
      const entry = store.get(key)
      if (entry?.kind === 'binary') {
        throw new Error(`${key} 是二进制文件，不能追加文本`)
      }
      store.set(key, { kind: 'text', content: (entry?.content ?? '') + String(content ?? '') })
      dirty.add(key)
      removed.delete(key)
    },
    exists: (path: unknown) => store.has(normalize(path)),
    unlink: (path: unknown) => {
      const key = normalize(path)
      if (!store.delete(key)) {
        throw new Error(`no such file: ${key}`)
      }
      dirty.delete(key)
      removed.add(key)
    },
    list: () => [...store.keys()].sort(),
    /** 查看单个文件类型与大小，便于脚本区分文本与二进制 */
    stat: (path: unknown) => {
      const key = normalize(path)
      const entry = store.get(key)
      if (!entry) {
        throw new Error(`no such file: ${key}`)
      }
      return entry.kind === 'binary'
        ? {
            path: key,
            kind: 'binary' as const,
            size: entry.data.byteLength,
            ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
          }
        : {
            path: key,
            kind: 'text' as const,
            size: new TextEncoder().encode(entry.content).byteLength,
          }
    },
  }

  const print = (...args: unknown[]) => write('out', args.map(format).join(' '))

  /** 收集脚本改动的文件：文本、二进制与删除分开回传 */
  const collectChanges = () => {
    const text: Record<string, string> = {}
    const bytes: Record<string, { data: ArrayBuffer; mimeType?: string }> = {}
    for (const key of dirty) {
      const entry = store.get(key)
      if (!entry) {
        continue
      }
      if (entry.kind === 'binary') {
        // 复制一份独立的 ArrayBuffer，避免结构化克隆共享同一块内存
        bytes[key] = {
          data: entry.data.slice().buffer,
          ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
        }
      } else {
        text[key] = entry.content
      }
    }
    return { files: text, binaries: bytes, deleted: [...removed] }
  }

  try {
    // 严格模式 + 参数遮蔽：脚本里再声明函数也拿不到被遮蔽的全局；eval/Function 一并堵住
    const names = ['console', 'fs', 'print', ...BLOCKED]
    // eslint-disable-next-line no-new-func
    const factory = new Function(...names, `"use strict";\nreturn (async () => {\n${code}\n})()`)
    const result: unknown = await factory(
      consoleShim,
      fsShim,
      print,
      ...BLOCKED.map(() => undefined)
    )
    if (out) {
      send({ id, type: 'output', stream: 'out', text: truncate(out, maxOutputBytes) })
    }
    if (err) {
      send({ id, type: 'output', stream: 'err', text: truncate(err, maxOutputBytes) })
    }
    if (result !== undefined) {
      send({ id, type: 'result', value: truncate(format(result), maxOutputBytes) })
    }
    send({ id, type: 'done', ...collectChanges() })
  } catch (error) {
    if (out) {
      send({ id, type: 'output', stream: 'out', text: truncate(out, maxOutputBytes) })
    }
    if (err) {
      send({ id, type: 'output', stream: 'err', text: truncate(err, maxOutputBytes) })
    }
    send({
      id,
      type: 'error',
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    // 出错也要发 done，否则主线程只能等到超时
    send({ id, type: 'done', ...collectChanges() })
  }
}

scope.addEventListener('message', (event: MessageEvent<RunRequest>) => {
  void run(event.data)
})
