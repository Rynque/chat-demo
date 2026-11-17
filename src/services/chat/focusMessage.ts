/**
 * 搜索命中后要定位的消息：写入后由 MessageList 取走并滚动，
 * 打开另一个会话时消息列表还没渲染，因此同时留一份待处理值。
 */
type Listener = (messageId: string) => void

let pending: string | null = null
const listeners = new Set<Listener>()

export const focusMessage = (messageId: string) => {
  pending = messageId
  for (const listener of listeners) {
    listener(messageId)
  }
}

export const takeFocusedMessage = () => {
  const messageId = pending
  pending = null
  return messageId
}

/** 已挂载的消息列表订阅后续跳转，会话内再次搜索时也能定位 */
export const onFocusMessage = (listener: Listener) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
