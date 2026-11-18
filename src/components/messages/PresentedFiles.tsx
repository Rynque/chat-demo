import { useTranslate } from '../../i18n/index.js'
import { useState } from 'react'
import { readFile, readFileBytes } from '../../services/vfs.js'
import { getExtension, formatSize } from '../../services/attachments.js'
import type { PresentedFile } from '../../services/chat/types.js'
import { showToast } from '../base/toastState.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { IconBrowseOutline16, IconDownloadOutline16 } from '../base/icons.js'
import { FileIcon } from '../files/FileIcon.js'
import styles from './PresentedFiles.module.css'

/** 从 VFS 读取原件下载：二进制保留原 MIME，文本按 UTF-8 纯文本；读取失败用 toast 说明 */
const downloadFile = async (sessionId: string, file: PresentedFile) => {
  try {
    const record = await readFileBytes(sessionId, file.path)
    const url = URL.createObjectURL(record.blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.path.split('/').at(-1) || file.title
    anchor.click()
    URL.revokeObjectURL(url)
  } catch {
    showToast({ key: 'presentFileMissing' })
  }
}

/**
 * 本轮产出文件（present_files 结果）：卡片显示文件名 / 大小 / 类型，
 * 点击下载；文本文件提供预览弹窗，二进制只保留下载。
 */
export const PresentedFiles = ({
  sessionId,
  files,
  showLabel = true,
}: {
  sessionId: string
  files: PresentedFile[]
  /** 内联在调用提示下方时不重复显示「产出文件」标签 */
  showLabel?: boolean
}) => {
  const t = useTranslate()
  const [preview, setPreview] = useState<{ file: PresentedFile; content: string } | null>(null)

  const openPreview = async (file: PresentedFile) => {
    try {
      const record = await readFile(sessionId, file.path)
      setPreview({ file, content: record.content })
    } catch {
      showToast({ key: 'presentFileMissing' })
    }
  }

  return (
    <div className={styles.section}>
      {showLabel ? <span className={styles.label}>{t('presentFilesLabel')}</span> : null}
      <div className={styles.cards}>
        {files.map((file) => (
          <div key={file.path} className={styles.card} title={file.path}>
            <span className={styles.icon}>
              <FileIcon ext={getExtension(file.title)} />
            </span>
            <div className={styles.body}>
              <span className={styles.name}>{file.title}</span>
              <span className={styles.meta}>
                {[
                  getExtension(file.title),
                  formatSize(file.size),
                  file.kind === 'binary' ? t('presentFileBinary') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            <div className={styles.actions}>
              {file.kind === 'text' ? (
                <button
                  type="button"
                  className={styles.action}
                  aria-label={t('presentFilePreview')}
                  onClick={() => void openPreview(file)}
                >
                  <IconBrowseOutline16 />
                </button>
              ) : null}
              <button
                type="button"
                className={styles.action}
                aria-label={t('presentFileDownload')}
                onClick={() => void downloadFile(sessionId, file)}
              >
                <IconDownloadOutline16 />
              </button>
            </div>
          </div>
        ))}
      </div>
      {preview ? (
        <Modal
          title={preview.file.title}
          closable
          onClose={() => setPreview(null)}
          footer={
            <Button
              onClick={() => {
                void downloadFile(sessionId, preview.file)
                setPreview(null)
              }}
            >
              {t('presentFileDownload')}
            </Button>
          }
        >
          <pre className={styles.preview}>{preview.content}</pre>
        </Modal>
      ) : null}
    </div>
  )
}
