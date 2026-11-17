import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { PHOTO_ACCEPT } from '../../services/attachments.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { IconCameraOutline16, IconRefreshOutline16 } from '../base/icons.js'
import styles from './CameraDialog.module.css'

/** 摄像头不可用的原因，决定提示文案和是否给出重试 */
type Failure = 'permission' | 'nodevice' | 'unsupported' | 'failed'

const FAILURE_TEXT = {
  permission: 'cameraPermissionDenied',
  nodevice: 'cameraNoDevice',
  unsupported: 'cameraUnsupported',
  failed: 'cameraFailed',
} as const

const readFailure = (error: unknown): Failure => {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'permission'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'nodevice'
  }
  return 'failed'
}

/** 与系统相机一致的文件名，导出到本机后能按拍摄时间排序 */
const photoName = () => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `IMG_${date}_${time}.jpg`
}

/**
 * 暂时下架：输入框里的入口已移除，实现与文案保留，恢复时在 ChatInput 的 .right 加回按钮并渲染本组件即可。
 * 拍照：优先用页面内的实时预览，可切换前后摄像头、连拍，拍摄后照片直接交给输入框。
 * 非安全上下文（如 file:// 页面）或没有摄像头权限时，退回到系统相机。
 */
export const CameraDialog = ({
  onCapture,
  onClose,
}: {
  /** 每拍到一张就回调一次，弹窗保持打开以便连拍 */
  onCapture: (file: File) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fallbackRef = useRef<HTMLInputElement>(null)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [ready, setReady] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [flippable, setFlippable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [count, setCount] = useState(0)
  const [flash, setFlash] = useState(0)

  useEffect(() => {
    let cancelled = false
    const media = navigator.mediaDevices
    const release = () => {
      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop()
      }
      streamRef.current = null
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
    if (!media?.getUserMedia) {
      setFailure('unsupported')
      return
    }
    setReady(false)
    setFailure(null)
    const open = async () => {
      try {
        const stream = await media.getUserMedia({
          audio: false,
          video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        })
        // 权限确认期间弹窗可能已关闭或已切换摄像头
        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop()
          }
          return
        }
        release()
        streamRef.current = stream
        const video = videoRef.current
        if (!video) {
          return
        }
        video.srcObject = stream
        await video.play()
        if (!cancelled) {
          setReady(true)
        }
      } catch (error) {
        if (!cancelled) {
          setFailure(readFailure(error))
        }
      }
    }
    void open()
    return () => {
      cancelled = true
      release()
    }
  }, [facing, attempt])

  // 设备名要授权后才能读到，因此在拿到画面后再判断是否存在第二个摄像头
  useEffect(() => {
    if (!ready) {
      return
    }
    let cancelled = false
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (!cancelled) {
          setFlippable(devices.filter((device) => device.kind === 'videoinput').length > 1)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [ready])

  const capture = useCallback(() => {
    const video = videoRef.current
    const width = video?.videoWidth ?? 0
    const height = video?.videoHeight ?? 0
    if (!video || !width || !height) {
      return
    }
    const context = document.createElement('canvas').getContext('2d')
    if (!context) {
      return
    }
    const canvas = context.canvas
    canvas.width = width
    canvas.height = height
    context.drawImage(video, 0, 0, width, height)
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          return
        }
        onCapture(new File([blob], photoName(), { type: 'image/jpeg', lastModified: Date.now() }))
        setCount((value) => value + 1)
        setFlash((value) => value + 1)
      },
      'image/jpeg',
      0.92
    )
  }, [onCapture])

  // 系统相机是一次性拍摄，选完即关闭弹窗
  const handleFallback = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) {
      return
    }
    for (const file of files) {
      onCapture(file)
    }
    onClose()
  }

  return (
    <Modal title={t('cameraTitle')} closable onClose={onClose}>
      <div className={styles.stage}>
        <video
          ref={videoRef}
          className={clsx(
            styles.video,
            facing === 'user' && styles.mirror,
            !ready && styles.hidden
          )}
          aria-hidden
          playsInline
          muted
          autoPlay
        />
        {failure ? (
          <div className={styles.state} role="alert">
            <span className={styles.stateIcon}>
              <IconCameraOutline16 />
            </span>
            <p className={styles.message}>{t(FAILURE_TEXT[failure])}</p>
            <div className={styles.stateActions}>
              {failure === 'permission' || failure === 'failed' ? (
                <Button
                  size="m"
                  variant="outlined"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  {t('retry')}
                </Button>
              ) : null}
              <Button size="m" onClick={() => fallbackRef.current?.click()}>
                {t('cameraFallback')}
              </Button>
            </div>
            <input
              ref={fallbackRef}
              type="file"
              accept={PHOTO_ACCEPT}
              capture="environment"
              hidden
              onChange={handleFallback}
            />
          </div>
        ) : ready ? null : (
          <div className={styles.state}>
            <span className={styles.spinner} aria-hidden />
            <p className={styles.message}>{t('cameraStarting')}</p>
          </div>
        )}
        {count > 0 ? (
          <span className={styles.count} role="status">
            {t('cameraShotCount', { count })}
          </span>
        ) : null}
        {flash > 0 ? <span key={flash} className={styles.flash} aria-hidden /> : null}
      </div>
      <p className={styles.hint}>{t('cameraHint')}</p>
      <div className={styles.controls}>
        <span className={styles.start}>
          <IconButton
            size="m"
            icon={<IconRefreshOutline16 />}
            tooltip={t('cameraSwitch')}
            disabled={!ready || !flippable}
            onClick={() => setFacing((value) => (value === 'environment' ? 'user' : 'environment'))}
          />
        </span>
        <button
          type="button"
          className={styles.shutter}
          aria-label={t('cameraShutter')}
          disabled={!ready}
          onClick={capture}
        >
          <span className={styles.shutterCore} />
        </button>
        <span className={styles.end}>
          <Button size="m" variant="outlined" onClick={onClose}>
            {t('cameraDone')}
          </Button>
        </span>
      </div>
    </Modal>
  )
}
