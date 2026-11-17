import { rm } from 'node:fs/promises'

// dist 可能正是某个终端的当前目录：目录本身删不掉，但内容已清空，构建可以继续写入
try {
  await rm('dist', { recursive: true, force: true })
} catch (error) {
  if (error.code !== 'EBUSY' && error.code !== 'EPERM') {
    throw error
  }
}
