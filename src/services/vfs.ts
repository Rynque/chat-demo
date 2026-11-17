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
  return file
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

/** 写入前按当前配额校验：单文件、总量、文件数都不会被突破 */
export const writeFile = async (
  sessionId: string,
  rawPath: string,
  content: string
): Promise<{ path: string; size: number }> => {
  const path = normalizePath(rawPath)
  const { maxFileBytes, maxTotalBytes, maxFiles } = limits()
  const size = byteLength(content)
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
  const now = Date.now()
  await writeVfsFile({
    id: fileId(sessionId, path),
    sessionId,
    path,
    content,
    size,
    updatedAt: now,
  })
  return { path, size }
}

/** 执行前的文件快照，脚本里的 fs 只操作这份内存副本 */
export const snapshot = async (sessionId: string): Promise<Record<string, string>> =>
  Object.fromEntries((await listVfsFiles(sessionId)).map((file) => [file.path, file.content]))

/** 脚本结束后回写改动过的文件；空内容视为删除 */
export const applyWrites = async (
  sessionId: string,
  writes: Record<string, string>
): Promise<string[]> => {
  const changed: string[] = []
  for (const [path, content] of Object.entries(writes)) {
    if (content === '') {
      await deleteFile(sessionId, path).catch(() => {})
      changed.push(path)
      continue
    }
    const result = await writeFile(sessionId, path, content)
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
