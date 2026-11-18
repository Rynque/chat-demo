import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { useAskQuestions } from '../../services/chat/askQuestions.js'
import type { Session } from '../../services/chat/types.js'
import { AskComposer } from '../chatInput/AskComposer.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { TokenUsage } from './TokenUsage.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  // 待回答的提问占用输入框位置；输入框隐藏但草稿由草稿服务保留
  const pendingAsk = useAskQuestions((state) => {
    const entries = Object.values(state.entries)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].sessionId === session.id) {
        return entries[index]
      }
    }
    return undefined
  })
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} />
      ) : (
        <div className={styles.header}>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.inputContainer}>
            <TokenUsage session={session} />
            {pendingAsk ? (
              <AskComposer key={pendingAsk.callId} entry={pendingAsk} />
            ) : (
              <ChatInput sessionId={session.id} />
            )}
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
    </div>
  )
}
