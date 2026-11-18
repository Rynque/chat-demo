import {
  deleteVfsFile,
  listAllVfsFiles,
  listVfsFiles,
  readVfsFile,
  writeVfsFile,
  type StoredVfsFile,
} from './chat/db.js'
import { useSettings } from './settings.js'

/** 会话内路径 => 存储 id；用 NUL 分隔，路径里不会再出现 */
const fileId = (sessionId: string, path: string) => `${sessionId}\u0000${path}`

const encoder = new TextEncoder()
const byteLength = (text: string) => encoder.encode(text).length

const limits = () => useSettings.getState().vfsLimits

const formatBytes = (bytes: number) =>
  bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`

/** 文件类型：旧数据没有 kind，按文本处理 */
export const fileKind = (file: StoredVfsFile): 'text' | 'binary' => file.kind ?? 'text'

/** 统一成相对路径：反斜杠转正斜杠、去掉 ./ 与多余分隔符，禁止越级 */
export const normalizePath = (raw: string): string => {
  const path = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
  if (!path) {
    throw new Error('路径不能为空')
  }
  if (path.startsWith('/')) {
    throw new Error('请使用相对路径，不要以 / 开头')
  }
  if (path.length > 128) {
    throw new Error('路径过长（上限 128 个字符）')
  }
  if (path.split('/').some((segment) => segment === '..')) {
    throw new Error('路径不能包含 ..')
  }
  return path
}

export const listFiles = async (sessionId: string): Promise<StoredVfsFile[]> =>
  (await listVfsFiles(sessionId)).sort((left, right) => left.path.localeCompare(right.path))

export const readFile = async (sessionId: string, rawPath: string): Promise<StoredVfsFile> => {
  const path = normalizePath(rawPath)
  const file = await readVfsFile(fileId(sessionId, path))
  if (!file) {
    throw new Error(`文件不存在：${path}`)
  }
  if (fileKind(file) === 'binary') {
    throw new Error(`文件是二进制，不能按文本读取：${path}（请用 fs.readFileBytes）`)
  }
  return file
}

/** 二进制读取：文本文件按 UTF-8 编码返回字节，二进制文件原样返回 Blob */
export const readFileBytes = async (
  sessionId: string,
  rawPath: string
): Promise<{ path: string; blob: Blob; size: number; mimeType: string }> => {
  const path = normalizePath(rawPath)
  const file = await readVfsFile(fileId(sessionId, path))
  if (!file) {
    throw new Error(`文件不存在：${path}`)
  }
  if (fileKind(file) === 'binary' && file.blob) {
    return {
      path,
      blob: file.blob,
      size: file.size,
      mimeType: file.mimeType || file.blob.type || 'application/octet-stream',
    }
  }
  return {
    path,
    blob: new Blob([file.content], { type: 'text/plain;charset=utf-8' }),
    size: file.size,
    mimeType: 'text/plain;charset=utf-8',
  }
}

export const deleteFile = async (sessionId: string, rawPath: string): Promise<string> => {
  const path = normalizePath(rawPath)
  const id = fileId(sessionId, path)
  const file = await readVfsFile(id)
  if (!file) {
    throw new Error(`文件不存在：${path}`)
  }
  await deleteVfsFile(id)
  return path
}

/** 写入前的配额校验：单文件、总量、文件数都不会被突破；size 是真实字节数 */
const assertQuota = async (sessionId: string, path: string, size: number) => {
  const { maxFileBytes, maxTotalBytes, maxFiles } = limits()
  if (size > maxFileBytes) {
    throw new Error(`文件超过单文件上限（${formatBytes(maxFileBytes)}）`)
  }
  const files = await listVfsFiles(sessionId)
  const existing = files.find((file) => file.path === path)
  const total = files.reduce((sum, file) => sum + file.size, 0) - (existing?.size ?? 0) + size
  if (total > maxTotalBytes) {
    throw new Error(`虚拟文件总量超过上限（${formatBytes(maxTotalBytes)}）`)
  }
  if (!existing && files.length >= maxFiles) {
    throw new Error(`文件数量超过上限（${maxFiles} 个）`)
  }
}

/** 写入文本；同一路径上的二进制文件会被替换为文本 */
export const writeFile = async (
  sessionId: string,
  rawPath: string,
  content: string
): Promise<{ path: string; size: number }> => {
  const path = normalizePath(rawPath)
  const size = byteLength(content)
  await assertQuota(sessionId, path, size)
  await writeVfsFile({
    id: fileId(sessionId, path),
    sessionId,
    path,
    content,
    kind: 'text',
    size,
    updatedAt: Date.now(),
  })
  return { path, size }
}

/** 写入二进制；同一路径上的文本文件会被替换为二进制 */
export const writeFileBytes = async (
  sessionId: string,
  rawPath: string,
  bytes: Uint8Array,
  mimeType = 'application/octet-stream'
): Promise<{ path: string; size: number }> => {
  const path = normalizePath(rawPath)
  const size = bytes.byteLength
  await assertQuota(sessionId, path, size)
  // 复制一份，避免调用方的缓冲区后续被改写；Blob 由 IndexedDB 原样存储
  const copy = new Uint8Array(bytes)
  await writeVfsFile({
    id: fileId(sessionId, path),
    sessionId,
    path,
    content: '',
    blob: new Blob([copy], { type: mimeType }),
    kind: 'binary',
    mimeType,
    size,
    updatedAt: Date.now(),
  })
  return { path, size }
}

/** 执行前的文件快照：文本内容与二进制原件（含 MIME）分开传输 */
export const snapshot = async (
  sessionId: string
): Promise<{
  text: Record<string, string>
  bytes: Record<string, { data: ArrayBuffer; mimeType?: string }>
}> => {
  const files = await listVfsFiles(sessionId)
  const text: Record<string, string> = {}
  const bytes: Record<string, { data: ArrayBuffer; mimeType?: string }> = {}
  for (const file of files) {
    if (fileKind(file) === 'binary' && file.blob) {
      bytes[file.path] = {
        data: await file.blob.arrayBuffer(),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      }
      continue
    }
    text[file.path] = file.content
  }
  return { text, bytes }
}

/**
 * 脚本结束后回写改动：文本与二进制分开处理，删除的路径直接移除。
 * 文本内容为空视为删除（与旧行为一致），二进制允许零字节文件。
 */
export const applyWrites = async (
  sessionId: string,
  writes: {
    text: Record<string, string>
    bytes: Record<string, { data: ArrayBuffer; mimeType?: string }>
  },
  deleted: string[] = []
): Promise<string[]> => {
  const changed: string[] = []
  for (const path of deleted) {
    await deleteFile(sessionId, path).catch(() => {})
    changed.push(path)
  }
  for (const [path, content] of Object.entries(writes.text)) {
    if (content === '') {
      await deleteFile(sessionId, path).catch(() => {})
      changed.push(path)
      continue
    }
    const result = await writeFile(sessionId, path, content)
    changed.push(result.path)
  }
  for (const [path, entry] of Object.entries(writes.bytes)) {
    const result = await writeFileBytes(
      sessionId,
      path,
      new Uint8Array(entry.data),
      entry.mimeType || 'application/octet-stream'
    )
    changed.push(result.path)
  }
  return changed
}

export const totalSize = async (sessionId: string): Promise<number> =>
  (await listVfsFiles(sessionId)).reduce((sum, file) => sum + file.size, 0)

/** 全部会话的占用统计，设置里展示 */
export const stats = async (): Promise<{ files: number; bytes: number }> => {
  const files = await listAllVfsFiles()
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) }
}
