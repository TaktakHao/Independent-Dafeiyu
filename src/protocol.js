/**
 * 大肥鱼桌面伴侣与直播版 — 双版本通信协议契约 (Protocol v1 & v2)
 */

export const PROTOCOL_VERSION_V1 = 1
export const PROTOCOL_VERSION_V2 = 2
export const PROTOCOL_VERSION = PROTOCOL_VERSION_V1
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(new Set([1, 2]))

export const CompanionState = Object.freeze({
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  WORKING: 'WORKING',
  WAITING: 'WAITING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  DISCONNECTED: 'DISCONNECTED',
})

export const CompanionMessageKind = Object.freeze({
  // v1 基础消息 (Core <-> Helper)
  READY: 'ready',
  HELLO: 'hello',
  STATE: 'state',
  PULSE: 'pulse',
  TASK: 'task',
  TASKS: 'tasks',
  CONFIG: 'config',
  BALANCE: 'balance',
  SETTINGS: 'settings',
  PING: 'ping',
  PONG: 'pong',
  CLOSED: 'closed',
  SHUTDOWN: 'shutdown',

  // v2 下行指令消息 (Core -> Helper)
  PLAY: 'play',
  SPEAK: 'speak',
  AUDIO: 'audio',
  AUDIO_STOP: 'audio_stop',
  STATUS_BAR: 'status_bar',
  TALKING: 'talking',

  // v2 上行事件消息 (Helper -> Core)
  AUDIO_EVENT: 'audio_event',
  FRONT_APP: 'front_app',
  SCREEN_LOCK: 'screen_lock',
  USER_TOUCH: 'user_touch',
})

const states = new Set(Object.values(CompanionState))
const kinds = new Set(Object.values(CompanionMessageKind))

export const V2_MESSAGE_KINDS = Object.freeze(new Set([
  CompanionMessageKind.PLAY,
  CompanionMessageKind.SPEAK,
  CompanionMessageKind.AUDIO,
  CompanionMessageKind.AUDIO_STOP,
  CompanionMessageKind.STATUS_BAR,
  CompanionMessageKind.TALKING,
  CompanionMessageKind.AUDIO_EVENT,
  CompanionMessageKind.FRONT_APP,
  CompanionMessageKind.SCREEN_LOCK,
  CompanionMessageKind.USER_TOUCH,
]))

/**
 * 构造协议消息（自动适配协议版本）
 */
export function createMessage(kind, payload = {}) {
  if (!kinds.has(kind)) throw new TypeError(`Unknown companion message kind: ${kind}`)
  const defaultVersion = V2_MESSAGE_KINDS.has(kind) ? PROTOCOL_VERSION_V2 : PROTOCOL_VERSION
  const { protocolVersion = defaultVersion, ...rest } = payload
  return {
    protocolVersion,
    kind,
    timestamp: Date.now(),
    ...rest,
  }
}

/**
 * 校验协议消息结构合法性
 */
export function assertCompanionMessage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Companion message must be an object')
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.has(value.protocolVersion)) {
    throw new TypeError(`Unsupported protocol version: ${String(value.protocolVersion)}`)
  }
  if (!kinds.has(value.kind)) throw new TypeError(`Unknown companion message kind: ${String(value.kind)}`)

  // v1 state 与 pulse 状态校验
  if ((value.kind === CompanionMessageKind.STATE || value.kind === CompanionMessageKind.PULSE)
    && !states.has(value.state)) {
    throw new TypeError(`Unknown companion state: ${String(value.state)}`)
  }

  // v2 消息细化字段校验
  if (value.kind === CompanionMessageKind.PLAY) {
    if (typeof value.clip !== 'string' || !value.clip) {
      throw new TypeError('PLAY message requires a non-empty string "clip"')
    }
    if (value.maxMs !== undefined && (typeof value.maxMs !== 'number' || value.maxMs < 0)) {
      throw new TypeError('PLAY message "maxMs" must be a non-negative number')
    }
  } else if (value.kind === CompanionMessageKind.SPEAK) {
    if (typeof value.text !== 'string') {
      throw new TypeError('SPEAK message requires string "text"')
    }
  } else if (value.kind === CompanionMessageKind.AUDIO) {
    if (typeof value.path !== 'string' || !value.path) {
      throw new TypeError('AUDIO message requires a non-empty string "path"')
    }
  } else if (value.kind === CompanionMessageKind.STATUS_BAR) {
    if (typeof value.text !== 'string') {
      throw new TypeError('STATUS_BAR message requires string "text"')
    }
  } else if (value.kind === CompanionMessageKind.TALKING) {
    if (typeof value.on !== 'boolean') {
      throw new TypeError('TALKING message requires boolean "on"')
    }
  } else if (value.kind === CompanionMessageKind.AUDIO_EVENT) {
    if (!['started', 'ended', 'interrupted'].includes(value.event)) {
      throw new TypeError(`AUDIO_EVENT message "event" must be started, ended, or interrupted: ${String(value.event)}`)
    }
  } else if (value.kind === CompanionMessageKind.FRONT_APP) {
    if (typeof value.bundleId !== 'string' || typeof value.name !== 'string') {
      throw new TypeError('FRONT_APP message requires string "bundleId" and string "name"')
    }
  } else if (value.kind === CompanionMessageKind.SCREEN_LOCK) {
    if (typeof value.locked !== 'boolean') {
      throw new TypeError('SCREEN_LOCK message requires boolean "locked"')
    }
  } else if (value.kind === CompanionMessageKind.USER_TOUCH) {
    if (typeof value.clip !== 'string' || !value.clip) {
      throw new TypeError('USER_TOUCH message requires a non-empty string "clip"')
    }
  }

  return value
}

/**
 * 编码并添加换行符
 */
export function encodeMessage(message) {
  assertCompanionMessage(message)
  return `${JSON.stringify(message)}\n`
}
