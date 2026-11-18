/** 主线程侧：起一个 Worker 跑用户脚本，超时就终止；每次调用一个 Worker，不保留状态 */
export type ScriptRequest = {
  code: string
  /** 文本文件：路径 => 正文 */
  files: Record<string, string>
  /** 二进制文件：路径 => 原始字节与 MIME */
  binaries: Record<string, { data: ArrayBuffer; mimeType?: string }>
  timeoutMs: number
  maxOutputBytes: number
}

export type ScriptResult = {
  ok: boolean
  stdout: string
  stderr: string
  value?: string
  error?: string
  /** 脚本写过的文本文件，键为路径 */
  files: Record<string, string>
  /** 脚本写过的二进制文件，键为路径 */
  binaries: Record<string, { data: ArrayBuffer; mimeType?: string }>
  /** 脚本删除的路径 */
  deleted: string[]
}

const emptyResult = (): ScriptResult => ({ ok: true, stdout: '', stderr: '', files: {}, binaries: {}, deleted: [] })

/** 超时后直接终止：同源 Worker 无法安全打断死循环 */
export const runScript = (request: ScriptRequest): Promise<ScriptResult> =>
  new Promise((resolve) => {
    const worker = new Worker(new URL('./jsWorker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const current: ScriptResult = emptyResult()
    const finish = (result: ScriptResult) => {
      if (settled) {
        return
      }
      settled = true
      worker.terminate()
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({
        ...emptyResult(),
        ok: false,
        error: `执行超时（${request.timeoutMs / 1000}s），已中止`,
      })
    }, request.timeoutMs)

    worker.addEventListener('message', (event: MessageEvent) => {
      const message = event.data as
        | { type: 'output'; stream: 'out' | 'err'; text: string }
        | { type: 'result'; value: string }
        | { type: 'error'; message: string }
        | {
            type: 'done'
            files: Record<string, string>
            binaries: Record<string, { data: ArrayBuffer; mimeType?: string }>
            deleted: string[]
          }
      if (message.type === 'output') {
        current[message.stream === 'out' ? 'stdout' : 'stderr'] += message.text
        return
      }
      if (message.type === 'result') {
        current.value = message.value
        return
      }
      if (message.type === 'error') {
        current.error = message.message
        current.ok = false
        return
      }
      if (message.type === 'done') {
        current.files = message.files
        current.binaries = message.binaries
        current.deleted = message.deleted
        clearTimeout(timer)
        finish({ ...current })
      }
    })

    worker.addEventListener('error', (event) => {
      clearTimeout(timer)
      finish({
        ...emptyResult(),
        ok: false,
        stdout: current.stdout,
        stderr: current.stderr,
        error: `执行器崩溃：${event.message || '未知错误'}`,
      })
    })

    worker.postMessage({
      id: 1,
      code: request.code,
      files: request.files,
      binaries: request.binaries,
      maxOutputBytes: request.maxOutputBytes,
    })
  })
