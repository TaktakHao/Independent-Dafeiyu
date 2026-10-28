/**
 * @file schedule.ts
 * 一日作息时钟：早起、饭点、专注提醒与深夜日记触发器
 */

import { EventEmitter } from 'node:events'
import type { StandardEvent } from '../events/types.ts'

export class ScheduleClock extends EventEmitter {
  private timer: any = null
  private lastTriggeredDate: string = ''
  private triggeredMeals: Set<string> = new Set()
  private checkIntervalMs: number

  constructor(checkIntervalMs: number = 60000) {
    super()
    this.checkIntervalMs = checkIntervalMs
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.checkIntervalMs)
    this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  tick(): void {
    const now = new Date()
    const hours = now.getHours()
    const minutes = now.getMinutes()
    const todayStr = now.toISOString().slice(0, 10)

    if (this.lastTriggeredDate !== todayStr) {
      this.lastTriggeredDate = todayStr
      this.triggeredMeals.clear()
    }

    // 1. 午餐饭点 12:00 - 12:30
    if (hours === 12 && minutes < 30 && !this.triggeredMeals.has('lunch')) {
      this.triggeredMeals.add('lunch')
      this.emitEvent('SCHEDULE', '午饭时间到啦！本鱼肚子已经咕咕叫啦，老爸今天吃什么好吃的呀？')
    }

    // 2. 晚餐饭点 18:00 - 18:30
    if (hours === 18 && minutes < 30 && !this.triggeredMeals.has('dinner')) {
      this.triggeredMeals.add('dinner')
      this.emitEvent('SCHEDULE', '晚饭时间到！搬了一天砖，该奖励自己一份大餐犒劳一下啦~')
    }

    // 3. 睡前 23:30 日记沉淀触发
    if (hours === 23 && minutes >= 30 && !this.triggeredMeals.has('bedtime')) {
      this.triggeredMeals.add('bedtime')
      this.emit('bedtime_diary_trigger', now)
      this.emitEvent('SCHEDULE', '唔…已经到深夜啦，好困好困…大肥鱼要去梦里数小鱼干啦，Zzz…')
    }
  }

  private emitEvent(kind: any, text: string): void {
    const event: StandardEvent = {
      id: `schedule-${Date.now()}`,
      ts: Date.now(),
      priority: 'P2',
      kind,
      text,
      actor: { uid: 'system', nickname: '作息闹钟' },
    }
    this.emit('event', event)
  }
}
