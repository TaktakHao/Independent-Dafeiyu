/**
 * 大肥鱼独立伴侣核心 — TypeScript 类型与接口契约
 */

export type OperationalMode = 'companion' | 'live'

export type ConnectionStatus =
  | 'unstarted'
  | 'starting'
  | 'ready'
  | 'reconnecting'
  | 'stopped'
  | 'failed'

export type EmotionState =
  | 'HAPPY'
  | 'TSUNDERE'
  | 'GRUMPY'
  | 'SULKING'
  | 'SLEEPY'

export type AudioEventKind = 'started' | 'ended' | 'interrupted'

export interface RPGStats {
  hunger: number   // 0 - 100
  mood: number     // 0 - 100
  energy: number   // 0 - 100
}

export interface ActiveAppInfo {
  bundleId: string
  name: string
  category: 'code' | 'browser' | 'chat' | 'other'
  lastActiveAt: number
}

export interface PlayOptions {
  clip: string
  maxMs?: number
  loop?: boolean
  resumeState?: string
}

export interface SpeakOptions {
  id?: string
  text: string
  style?: string
  typewriter?: boolean
  holdMs?: number
}

export interface AudioOptions {
  id?: string
  seq?: number
  path: string
  interrupt?: boolean
}

export interface AudioEventPayload {
  protocolVersion: number
  kind: 'audio_event'
  id: string
  seq: number
  event: AudioEventKind
  durationMs?: number
  timestamp?: number
}

export interface FrontAppPayload {
  protocolVersion: number
  kind: 'front_app'
  bundleId: string
  name: string
  timestamp?: number
}

export interface ScreenLockPayload {
  protocolVersion: number
  kind: 'screen_lock'
  locked: boolean
  timestamp?: number
}

export interface UserTouchPayload {
  protocolVersion: number
  kind: 'user_touch'
  clip: 'head_pat' | 'poke' | 'tail' | string
  timestamp?: number
}

export interface StandaloneStateSnapshot {
  mode: OperationalMode
  connection: ConnectionStatus
  emotion: EmotionState
  stats: RPGStats
  statusBarText: string
  activeApp: ActiveAppInfo | null
  screenLocked: boolean
  isTalking: boolean
  currentAudioId: string | null
  updatedAt: number
}

export interface StandaloneConfig {
  mode?: OperationalMode
  headless?: boolean
  webPort?: number
  heartbeatMs?: number
  heartbeatTimeoutMs?: number
  startupTimeoutMs?: number
  restartDelayMs?: number
  maxStartFailures?: number
  command?: string
  args?: string[]
  env?: Record<string, string>
}
