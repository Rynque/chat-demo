/// <reference lib="webworker" />

/**
 * 用户脚本执行器：跑在独立 Worker 里，执行模型生成的 JS。
 * 不是安全边界（同源 Worker 仍可触达浏览器 API），只用于隔离 UI 线程并限制时长；
 * 因此这里不注入任何密钥或聊天数据，只给一份文件快照。
 */

type RunRequest = {
  id: number
  code: string
  files: Record<string, string>
  maxOutputBytes: number
}

type Reply =
  | { id: number; type: 'output'; stream: 'out' | 'err'; text: string }
  | { id: number; type: 'result'; value: string }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'done'; files: Record<string, string> }

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

const run = async ({ id, code, files, maxOutputBytes }: RunRequest) => {
  const store = new Map(Object.entries(files))
  const dirty = new Set<string>()
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
      const content = store.get(key)
      if (content === undefined) {
        throw new Error(`no such file: ${key}`)
      }
      return content
    },
    writeFile: (path: unknown, content: unknown) => {
      const key = normalize(path)
      store.set(key, String(content ?? ''))
      dirty.add(key)
    },
    appendFile: (path: unknown, content: unknown) => {
      const key = normalize(path)
      store.set(key, (store.get(key) ?? '') + String(content ?? ''))
      dirty.add(key)
    },
    exists: (path: unknown) => store.has(normalize(path)),
    unlink: (path: unknown) => {
      const key = normalize(path)
      if (!store.delete(key)) {
        throw new Error(`no such file: ${key}`)
      }
      dirty.add(key)
    },
    list: () => [...store.keys()].sort(),
  }

  const print = (...args: unknown[]) => write('out', args.map(format).join(' '))

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
    const changed: Record<string, string> = {}
    for (const key of dirty) {
      const value = store.get(key)
      if (value !== undefined) {
        changed[key] = value
      }
    }
    send({ id, type: 'done', files: changed })
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
    const changed: Record<string, string> = {}
    for (const key of dirty) {
      const value = store.get(key)
      if (value !== undefined) {
        changed[key] = value
      }
    }
    send({ id, type: 'done', files: changed })
  }
}

scope.addEventListener('message', (event: MessageEvent<RunRequest>) => {
  void run(event.data)
})
