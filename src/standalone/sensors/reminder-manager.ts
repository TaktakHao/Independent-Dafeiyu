/**
 * @file reminder-manager.ts
 * 闲置 Mac 自然语言定时提醒与管家计划任务管理器 (Reminder & Cron Steward)
 *
 * 核心功能：
 * 1. 自然语言解析：
 *    - 相对时间倒计时：如「20分钟后提醒我看代码」、「半小时后帮我查一下okx持仓」、「10秒后提醒我喝水」
 *    - 每日定时日常：如「每天早上8点半给我汇报电脑状态」、「每天23点提醒我睡觉」
 *    - 当日特定时间点：如「下午3点提醒我开会」
 * 2. 意图分流：
 *    - 纯提醒 (is_task: false) -> 到点傲娇催促
 *    - 自动化任务 (is_task: true) -> 到点自动调用 TaskExecutor 执行查询并汇报
 * 3. 基于 SQLite (scheduled_reminders) 的持久化，防进程重启遗忘。
 */

import { EventEmitter } from 'node:events'
import type { DatabaseSync } from 'node:sqlite'

export interface ScheduledReminder {
  id: string
  type: 'once' | 'daily'
  trigger_time: number // once: 绝对毫秒戳; daily: 分钟偏移量 (0~1439)
  target_user_id: string
  channel: 'private' | 'group'
  group_id?: string | null
  content: string
  is_task: number // 0 | 1
  status: 'active' | 'fired' | 'cancelled'
  created_at: number
  last_fired_at?: number | null
}

export interface ParsedReminderIntent {
  isReminder: boolean
  type?: 'once' | 'daily'
  targetMs?: number // 对 once 类型的绝对执行毫秒戳
  dailyMinute?: number // 对 daily 类型的当天分钟偏移量
  delayDesc?: string // 人类可读时间描述，如 "20分钟后" 或 "每天 08:30"
  content?: string // 提醒内容或待办任务
  isTask?: boolean // 是否为需要主动执行的系统任务
  ackReply?: string // 傲娇确认台词
}

const TASK_KEYWORDS = /(?:查|检查|体检|排查|搜索|搜一下|截图|截屏|看屏幕|okx|docker|容器|状态|电量|磁盘|清理)/i

export class ReminderManager extends EventEmitter {
  private db: DatabaseSync
  private timer: NodeJS.Timeout | null = null
  private checkIntervalMs: number

  constructor(db: DatabaseSync, checkIntervalMs: number = 10000) {
    super()
    this.db = db
    this.checkIntervalMs = checkIntervalMs
  }

  public start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.checkIntervalMs)
    this.tick()
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 自然语言提取定时意图
   */
  public parseNaturalLanguage(rawText: string): ParsedReminderIntent {
    const text = (rawText || '').trim()
    const now = Date.now()
    const nowDate = new Date(now)

    // 1. 识别“每天”周期任务：如“每天[早上|上午|下午|晚上]?8点半/08:30 [提醒我|帮我|执行] xxx”
    const dailyMatch = text.match(
      /(?:每天|每日)(?:的)?\s*(?:(早上|上午|中午|下午|晚上))?\s*(\d{1,2})(?:[:：点时](\d{1,2})?|点半)?\s*(?:分)?\s*(?:帮我|提醒我|代表我|叫我|自动)?\s*(.+)/i
    )
    if (dailyMatch) {
      const period = dailyMatch[1] || ''
      let hour = parseInt(dailyMatch[2], 10)
      let minute = 0
      if (text.includes('点半')) {
        minute = 30
      } else if (dailyMatch[3]) {
        minute = parseInt(dailyMatch[3], 10)
      }

      if ((period === '下午' || period === '晚上') && hour < 12) {
        hour += 12
      } else if (period === '中午' && hour < 11) {
        hour += 12
      }

      const dailyMinute = hour * 60 + minute
      const content = (dailyMatch[4] || '').replace(/^[，,、\s]+/, '').trim()
      const isTask = TASK_KEYWORDS.test(content)
      const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

      return {
        isReminder: true,
        type: 'daily',
        dailyMinute,
        delayDesc: `每天 ${timeStr}`,
        content,
        isTask,
        ackReply: isTask
          ? `收到！大肥鱼小本本记下啦：每天 ${timeStr} 自动帮老爸【${content}】！`
          : `哼，记住啦！每天 ${timeStr} 本鱼会准时来提醒老爸【${content}】的~`,
      }
    }

    // 2. 识别相对时间倒计时：如“20分钟后 / 1小时后 / 半小时后 / 45秒后 [提醒我|帮我] xxx”
    const relativeMatch = text.match(
      /(?:(\d+|半|一|两|三|几)\s*(个半?小时|小时|分钟|分|秒钟|秒)后?)\s*(?:帮我|提醒我|叫我|通知我)?\s*(.+)/i
    )
    if (relativeMatch) {
      const numStr = relativeMatch[1]
      const unit = relativeMatch[2]
      const content = (relativeMatch[3] || '').replace(/^[，,、\s]+/, '').trim()

      let msOffset = 0
      let humanDesc = ''

      if (numStr === '半') {
        if (unit.includes('小时')) {
          msOffset = 30 * 60 * 1000
          humanDesc = '半小时后'
        } else {
          msOffset = 30 * 1000
          humanDesc = '30秒后'
        }
      } else {
        let n = parseInt(numStr, 10)
        if (Number.isNaN(n)) {
          if (numStr === '一') n = 1
          else if (numStr === '两') n = 2
          else if (numStr === '三') n = 3
          else n = 1
        }

        if (unit.includes('小时')) {
          msOffset = n * 3600 * 1000
          humanDesc = `${n}小时后`
        } else if (unit.includes('分')) {
          msOffset = n * 60 * 1000
          humanDesc = `${n}分钟后`
        } else if (unit.includes('秒')) {
          msOffset = n * 1000
          humanDesc = `${n}秒后`
        }
      }

      if (msOffset > 0 && content) {
        const isTask = TASK_KEYWORDS.test(content)
        return {
          isReminder: true,
          type: 'once',
          targetMs: now + msOffset,
          delayDesc: humanDesc,
          content,
          isTask,
          ackReply: isTask
            ? `好嘞！大肥鱼设定了倒计时，${humanDesc} 本鱼马上帮老爸执行【${content}】！`
            : `遵命！本鱼这就支棱起小闹钟，${humanDesc} 准时戳老爸【${content}】~ ⏰`,
        }
      }
    }

    return { isReminder: false }
  }

  /**
   * 创建并持久化一条定时任务
   */
  public addReminder(params: {
    type: 'once' | 'daily'
    triggerTime: number
    targetUserId: string
    channel: 'private' | 'group'
    groupId?: string | null
    content: string
    isTask: boolean
  }): ScheduledReminder {
    const id = `rem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const stmt = this.db.prepare(`
      INSERT INTO scheduled_reminders (
        id, type, trigger_time, target_user_id, channel, group_id, content, is_task, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `)

    stmt.run(
      id,
      params.type,
      params.triggerTime,
      params.targetUserId,
      params.channel,
      params.groupId || null,
      params.content,
      params.isTask ? 1 : 0,
      Date.now()
    )

    return {
      id,
      type: params.type,
      trigger_time: params.triggerTime,
      target_user_id: params.targetUserId,
      channel: params.channel,
      group_id: params.groupId,
      content: params.content,
      is_task: params.isTask ? 1 : 0,
      status: 'active',
      created_at: Date.now(),
    }
  }

  /**
   * 周期检查并派发就绪的任务
   */
  public tick(): void {
    const now = Date.now()
    const nowDate = new Date(now)
    const currentDayMinute = nowDate.getHours() * 60 + nowDate.getMinutes()
    const startOfTodayMs = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime()

    try {
      // 1. 检查单次任务 (type = 'once')
      const onceRows = this.db
        .prepare(`
          SELECT * FROM scheduled_reminders
          WHERE type = 'once' AND status = 'active' AND trigger_time <= ?
        `)
        .all(now) as ScheduledReminder[]

      for (const item of onceRows) {
        this.db
          .prepare(`UPDATE scheduled_reminders SET status = 'fired', last_fired_at = ? WHERE id = ?`)
          .run(now, item.id)
        this.emit('reminder_fired', item)
      }

      // 2. 检查每日定时任务 (type = 'daily')
      const dailyRows = this.db
        .prepare(`
          SELECT * FROM scheduled_reminders
          WHERE type = 'daily' AND status = 'active' AND trigger_time = ?
        `)
        .all(currentDayMinute) as ScheduledReminder[]

      for (const item of dailyRows) {
        // 防止今天同一分钟重复触发 (需确保 last_fired_at 不在今天同一天)
        const lastFired = item.last_fired_at || 0
        if (lastFired < startOfTodayMs) {
          this.db
            .prepare(`UPDATE scheduled_reminders SET last_fired_at = ? WHERE id = ?`)
            .run(now, item.id)
          this.emit('reminder_fired', item)
        }
      }
    } catch (err: any) {
      console.warn('[ReminderManager] 轮询定时任务异常:', err?.message || String(err))
    }
  }

  /**
   * 获取所有活跃中的计划任务
   */
  public listActiveReminders(targetUserId?: string): ScheduledReminder[] {
    try {
      if (targetUserId) {
        return this.db
          .prepare(`SELECT * FROM scheduled_reminders WHERE status = 'active' AND target_user_id = ? ORDER BY trigger_time ASC`)
          .all(targetUserId) as ScheduledReminder[]
      }
      return this.db
        .prepare(`SELECT * FROM scheduled_reminders WHERE status = 'active' ORDER BY trigger_time ASC`)
        .all() as ScheduledReminder[]
    } catch {
      return []
    }
  }

  /**
   * 取消任务
   */
  public cancelReminder(id: string): boolean {
    try {
      const res = this.db
        .prepare(`UPDATE scheduled_reminders SET status = 'cancelled' WHERE id = ? AND status = 'active'`)
        .run(id)
      return (res as any).changes > 0
    } catch {
      return false
    }
  }
}
