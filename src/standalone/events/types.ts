/**
 * @file types.ts
 * 标准事件定义与优先级分类契约
 */

export type EventPriority = 'P0' | 'P1' | 'P2'

export type EventKind =
  | 'GIFT'
  | 'DANMAKU'
  | 'ENTER'
  | 'LIKE'
  | 'TOUCH'
  | 'SCHEDULE'
  | 'FRONT_APP'
  | 'HOST_TALK'
  | 'HOST_CMD'
  | 'PROACTIVE'

export interface StandardEvent {
  id: string
  ts: number
  priority: EventPriority
  kind: EventKind
  actor?: {
    uid: string
    nickname: string
  }
  text?: string
  gift?: {
    name: string
    count: number
    isBig: boolean
  }
  meta?: Record<string, unknown>
}
