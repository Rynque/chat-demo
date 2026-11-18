import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 虚拟文件系统的配额，可由用户在设置里调整 */
export type VfsLimits = {
  /** 单个文件上限（字节） */
  maxFileBytes: number
  /** 会话内总量上限（字节） */
  maxTotalBytes: number
  /** 会话内文件数上限 */
  maxFiles: number
}

export const DEFAULT_VFS_LIMITS: VfsLimits = {
  // 支持二进制与上传挂载后按真实字节计，单文件与总量适度提高，容纳用户上传与脚本产出的 zip
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 32,
}

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考开关、侧边栏收起状态、虚拟文件配额、工具轮次 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  siderCollapsed: boolean
  vfsLimits: VfsLimits
  /** 每次回复最多执行多少轮工具调用；用完后强制模型直接作答 */
  toolRounds: number
}

/** 工具轮次默认值与可配置范围 */
export const DEFAULT_TOOL_ROUNDS = 12
export const TOOL_ROUNDS_MIN = 1
export const TOOL_ROUNDS_MAX = 50

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  siderCollapsed: 'chat-demo:sider-collapsed',
  vfsLimits: 'chat-demo:vfs-limits',
  toolRounds: 'chat-demo:tool-rounds',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 配额设成非法值时回落到默认值，避免写死一个 0 让工具彻底不可用 */
const initialVfsLimits = (): VfsLimits => {
  try {
    const saved: unknown = JSON.parse(read(KEYS.vfsLimits) ?? 'null')
    if (typeof saved !== 'object' || saved === null) {
      return DEFAULT_VFS_LIMITS
    }
    const value = saved as Partial<VfsLimits>
    const pick = (next: unknown, fallback: number) =>
      typeof next === 'number' && Number.isFinite(next) && next > 0 ? Math.floor(next) : fallback
    return {
      maxFileBytes: pick(value.maxFileBytes, DEFAULT_VFS_LIMITS.maxFileBytes),
      maxTotalBytes: pick(value.maxTotalBytes, DEFAULT_VFS_LIMITS.maxTotalBytes),
      maxFiles: pick(value.maxFiles, DEFAULT_VFS_LIMITS.maxFiles),
    }
  } catch {
    return DEFAULT_VFS_LIMITS
  }
}

/** 工具轮次：缺失或越界时回落到默认值，读取时夹到合法范围 */
const initialToolRounds = (): number => {
  const saved = Number(read(KEYS.toolRounds))
  if (!Number.isFinite(saved) || saved < TOOL_ROUNDS_MIN) {
    return DEFAULT_TOOL_ROUNDS
  }
  return Math.min(TOOL_ROUNDS_MAX, Math.floor(saved))
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  vfsLimits: initialVfsLimits(),
  toolRounds: initialToolRounds(),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

/** 合并式更新配额，只覆盖传入的字段 */
export const setVfsLimits = (limits: Partial<VfsLimits>) => {
  const next = { ...useSettings.getState().vfsLimits, ...limits }
  write(KEYS.vfsLimits, JSON.stringify(next))
  useSettings.setState({ vfsLimits: next })
}

/** 工具轮次：写入前夹到合法范围 */
export const setToolRounds = (toolRounds: number) => {
  const next = Math.min(TOOL_ROUNDS_MAX, Math.max(TOOL_ROUNDS_MIN, Math.floor(toolRounds)))
  write(KEYS.toolRounds, String(next))
  useSettings.setState({ toolRounds: next })
}
