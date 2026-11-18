import { useTranslate } from '../../i18n/index.js'
import { useState } from 'react'
import { readFile } from '../../services/vfs.js'
import { getExtension, formatSize } from '../../services/attachments.js'
import type { PresentedFile } from '../../services/chat/types.js'
import { showToast } from '../base/toastState.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { IconBrowseOutline16, IconDownloadOutline16 } from '../base/icons.js'
import { FileIcon } from '../files/FileIcon.js'
import styles from './PresentedFiles.module.css'

/** 从 VFS 读取文本并按 Blob 下载；读取失败（文件已被删除）用 toast 说明 */
const downloadFile = async (sessionId: string, file: PresentedFile) => {
  try {
    const record = await readFile(sessionId, file.path)
    const blob = new Blob([record.content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
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
 * 点击下载；VFS 目前只有文本文件，提供预览弹窗，以后有二进制时只保留下载。
 */
export const PresentedFiles = ({
  sessionId,
  files,
}: {
  sessionId: string
  files: PresentedFile[]
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
      <span className={styles.label}>{t('presentFilesLabel')}</span>
      <div className={styles.cards}>
        {files.map((file) => (
          <div key={file.path} className={styles.card} title={file.path}>
            <span className={styles.icon}>
              <FileIcon ext={getExtension(file.title)} />
            </span>
            <div className={styles.body}>
              <span className={styles.name}>{file.title}</span>
              <span className={styles.meta}>
                {[getExtension(file.title), formatSize(file.size)].filter(Boolean).join(' · ')}
              </span>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.action}
                aria-label={t('presentFilePreview')}
                onClick={() => void openPreview(file)}
              >
                <IconBrowseOutline16 />
              </button>
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
