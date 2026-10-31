/**
 * @file companion-lifecycle.ts
 * 桌面共生体状态同步、灵动摸鱼微动作与传感器事件绑定控制器
 *
 * 职责边界：
 * 1. 计算并同步大肥鱼与主人前台窗口 (IDE / 终端 / 浏览器 / 影音) 及 Antigravity 任务的协同状态
 * 2. 管理 15s 灵动摸鱼与空闲微动作循环 (slackingTimer)
 * 3. 管理 60s 赛博共生体 RPG 状态演化与 QQ 主动破冰搭话循环 (decayTimer)
 * 4. 统一绑定弹幕传感器、作息时钟、额度传感器、桌面触摸与控制台事件
 */

import type { StateManager } from '../core/state.ts'
import type { RuntimeScheduler } from '../core/scheduler.ts'
import type { MemoryStore } from '../memory/store.ts'
import type { DiaryGenerator } from '../memory/diary.ts'
import type { EmotionEngine } from './emotion.ts'
import { evaluateEmotionFSM } from './emotion.ts'
import type { InnerThoughtLoop } from './inner-thought.ts'
import type { PriorityEventQueue } from '../events/queue.ts'
import type { StandardEvent } from '../events/types.ts'
import type { DialoguePipeline } from '../events/dialogue-pipeline.ts'
import type { ScreenDanmakuSensor } from '../sensors/screen-danmaku.ts'
import type { ScheduleClock } from '../sensors/schedule.ts'
import type { AntigravitySensor } from '../sensors/antigravity.ts'
import type { QuotaSensor } from '../sensors/quota.ts'
import type { ConsoleServer } from '../console/server.ts'
import type { QqOrchestrator } from '../gateway/qq-orchestrator.ts'

export interface CompanionLifecycleDeps {
  state: StateManager
  scheduler: RuntimeScheduler
  memory: MemoryStore
  diaryGenerator: DiaryGenerator
  emotion: EmotionEngine
  innerThought: InnerThoughtLoop
  eventQueue: PriorityEventQueue
  dialoguePipeline: DialoguePipeline
  danmakuSensor: ScreenDanmakuSensor
  scheduleClock: ScheduleClock
  antigravitySensor: AntigravitySensor
  quotaSensor: QuotaSensor
  consoleServer: ConsoleServer
  qqOrchestrator: QqOrchestrator
}

const IDLE_MICRO_ACTIONS = [
  { clip: 'tail', ms: 3000, msg: '大肥鱼 · 吐泡泡摇尾巴 🫧', detail: '咕噜噜~ 鱼尾巴轻轻拍打桌面' },
  { clip: 'idle_stretch', ms: 3600, msg: '大肥鱼 · 惬意伸懒腰 🤸', detail: '使劲伸直鱼鳍，舒舒服服舒展一下~' },
  { clip: 'idle_yawn', ms: 3400, msg: '大肥鱼 · 揉揉眼睛打哈欠 🥱', detail: '呼啊——稍微打个小哈欠，精神百倍！' },
  { clip: 'waiting', ms: 3200, msg: '大肥鱼 · 左右张望 👀', detail: '呆呆地看看屏幕，看看老爸在忙啥' },
  { clip: 'eat_token', ms: 3000, msg: '大肥鱼 · 嚼算力小糖果 🍬', detail: '偷偷嚼嚼小零食，蓄满赛博能量~' },
]

export class CompanionLifecycleController {
  private readonly deps: CompanionLifecycleDeps
  private isSlacking = false
  private slackResumeTimer: ReturnType<typeof setTimeout> | null = null
  private slackingTimer: ReturnType<typeof setInterval> | null = null
  private decayTimer: ReturnType<typeof setInterval> | null = null
  private lastIdleMicroAt = 0

  constructor(deps: CompanionLifecycleDeps) {
    this.deps = deps
  }

  /**
   * 绑定全量状态同步、传感器、控制台与桌面交互事件，并启动共生定时器
   */
  public start(): void {
    this.bindEmotionAndQuotaSync()
    this.bindSensorsAndConsole()
    this.bindDesktopAndTouchEvents()
    this.startTimers()
  }

  /**
   * 停止所有周期定时器并清理挂起状态
   */
  public stop(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer)
      this.decayTimer = null
    }
    if (this.slackingTimer) {
      clearInterval(this.slackingTimer)
      this.slackingTimer = null
    }
    this.clearSlackState()
  }

  private clearSlackState(): void {
    this.isSlacking = false
    if (this.slackResumeTimer) {
      clearTimeout(this.slackResumeTimer)
      this.slackResumeTimer = null
    }
  }

  /**
   * 计算当前与主人前台应用及 Antigravity 任务完全同步的目标状态
   */
  public computeSyncedCompanionState(): {
    state: 'IDLE' | 'THINKING' | 'WORKING' | 'WAITING'
    activity?: string
    clip: string
    message: string
    detail: string
  } {
    const { state, antigravitySensor } = this.deps

    if (state.isScreenLocked()) {
      return {
        state: 'IDLE',
        clip: 'idle',
        message: '大肥鱼 · 休眠待命',
        detail: '屏幕已锁定 🌙 乖乖等你回来',
      }
    }

    const agStatus = antigravitySensor.getStatus()
    if (agStatus.isBusy) {
      const cState = agStatus.companionState || 'WORKING'
      const titleMap: Record<string, string> = {
        THINKING: '大肥鱼 · 同步思考中 🧠',
        WORKING: '大肥鱼 · 协同施法中 🪄',
        WAITING: '大肥鱼 · 等你指示 👀',
        IDLE: '大肥鱼 · 协同中',
      }
      return {
        state: cState,
        activity: agStatus.activity,
        clip: agStatus.clip || 'working',
        message: titleMap[cState] || '大肥鱼 · 协同中',
        detail: agStatus.statusMessage || 'Antigravity 正在施展魔法中 🪄……',
      }
    }

    const active = state.getActiveApp()
    if (active) {
      const lowerName = (active.name || '').toLowerCase()
      const lowerId = (active.bundleId || '').toLowerCase()

      if (lowerName.includes('antigravity') || lowerId.includes('antigravity')) {
        return {
          state: 'WORKING',
          activity: 'editing',
          clip: 'working',
          message: '大肥鱼 · 同步编码中',
          detail: 'Antigravity 编码中 ✨ 全程陪你专注',
        }
      }
      if (lowerName.includes('cursor') || lowerId.includes('cursor')) {
        return {
          state: 'WORKING',
          activity: 'editing',
          clip: 'working',
          message: '大肥鱼 · 同步编码中',
          detail: 'Cursor 编码中 💻 陪你一起敲代码',
        }
      }
      if (
        lowerId.includes('terminal') ||
        lowerId.includes('iterm') ||
        lowerName.includes('terminal') ||
        lowerName.includes('iterm')
      ) {
        return {
          state: 'WORKING',
          activity: 'commanding',
          clip: 'working_command',
          message: '大肥鱼 · 终端协同中',
          detail: `${active.name || '终端'} 调试中 ⚡ 陪你盯紧输出`,
        }
      }
      if (active.category === 'code') {
        return {
          state: 'WORKING',
          activity: 'editing',
          clip: 'working',
          message: '大肥鱼 · 同步专注中',
          detail: `${active.name || '开发工具'} 运行中 · 陪你一起肝`,
        }
      }
      if (active.category === 'media') {
        return {
          state: 'IDLE',
          clip: 'tail',
          message: '大肥鱼 · 陪你追剧听歌 🍿',
          detail: `${active.name || '影音娱乐'} 放松中 ✨ 心情与精力回血中 ~`,
        }
      }
      if (active.category === 'chat') {
        return {
          state: 'IDLE',
          clip: 'waiting',
          message: '大肥鱼 · 陪你唠嗑吃瓜 💬',
          detail: `${active.name || '聊天社交'} 互动中 ~ 紧绷感慢慢消散`,
        }
      }
      if (active.category === 'browser') {
        return {
          state: 'WORKING',
          activity: 'searching',
          clip: 'working_search',
          message: '大肥鱼 · 陪你查资料',
          detail: '查阅资料中 🌐 · 陪你一起找灵感',
        }
      }
    }

    if (state.getMode() === 'work') {
      return {
        state: 'WORKING',
        activity: 'commanding',
        clip: 'working_command',
        message: '大肥鱼 · 🛠️ 工作模式待命',
        detail: '随时听候差遣，帮老爸执行任务与操控电脑 ⚡',
      }
    }

    return {
      state: 'IDLE',
      clip: 'idle',
      message: '大肥鱼 · 陪伴中',
      detail: '随时随地陪你聊天 ~',
    }
  }

  /**
   * 立即将大肥鱼恢复/同步到当前与主人一致的工作或待机姿态
   */
  public readonly applySyncedState = (): void => {
    const { state, scheduler } = this.deps
    if (state.getMode() === 'live' || state.getIsTalking()) return
    this.clearSlackState()
    const synced = this.computeSyncedCompanionState()
    scheduler.updateStateCard({
      state: synced.state,
      activity: synced.activity,
      message: synced.message,
      detail: synced.detail,
    })
    if (synced.state === 'IDLE') {
      scheduler.play('idle', { maxMs: 60, resumeState: 'IDLE' })
    } else {
      scheduler.play(synced.clip, { loop: true, resumeState: synced.state })
    }
  }

  private bindEmotionAndQuotaSync(): void {
    const { state, emotion, quotaSensor } = this.deps

    const syncEmotionFromStats = () => {
      const s = state.getStats()
      const isLive = state.getMode() === 'live'
      emotion.setStats(s, isLive)
      const nextEmo = evaluateEmotionFSM(s.mood, s.hunger, s.energy, state.getEmotion(), isLive)
      state.setEmotion(nextEmo)
    }
    state.on('stats_changed', syncEmotionFromStats)
    syncEmotionFromStats()

    const syncHungerFromQuota = () => {
      const report = quotaSensor.getReport()
      state.updateStats({ hunger: report.satietyPct })
    }
    quotaSensor.on('quota_updated', syncHungerFromQuota)
    syncHungerFromQuota()
  }

  private bindSensorsAndConsole(): void {
    const {
      danmakuSensor,
      scheduleClock,
      diaryGenerator,
      consoleServer,
      eventQueue,
      scheduler,
      innerThought,
      dialoguePipeline,
      qqOrchestrator,
      state,
    } = this.deps

    danmakuSensor.on('event', (e: StandardEvent) => {
      eventQueue.enqueue(e)
      dialoguePipeline.dispatchNextEvent()
    })

    scheduleClock.on('event', (e: StandardEvent) => {
      eventQueue.enqueue(e)
      dialoguePipeline.dispatchNextEvent()
      if (e.text) {
        qqOrchestrator.sendScheduleGreeting(e.text, e.meta?.scheduleType)
      }
    })

    scheduleClock.on('bedtime_diary_trigger', async (date: Date) => {
      try {
        await diaryGenerator.generateDiary({ date, mode: state.getMode() })
      } catch {
        // 容错处理
      }
    })

    consoleServer.on('emergency_stop', async () => {
      eventQueue.clear()
      await scheduler.emergencyStop()
    })

    consoleServer.on('host_say', async ({ text, clip }: { text: string; clip: string }) => {
      innerThought.recordSpoken(text)
      await dialoguePipeline.speakWithVoice(text, clip || 'happy', 'happy')
    })

    consoleServer.on(
      'chat_message',
      async ({
        text,
        forceWorkMode,
        respond,
      }: {
        text: string
        forceWorkMode?: boolean
        respond: (res: any) => void
      }) => {
        const evt: StandardEvent & { forceWorkMode?: boolean } = {
          id: `chat-${Date.now()}`,
          ts: Date.now(),
          priority: 'P0',
          kind: 'HOST_TALK',
          actor: { uid: 'host', nickname: '你' },
          text,
          forceWorkMode,
        }
        await dialoguePipeline.handleEvent(evt, respond)
      }
    )

    consoleServer.on('danmaku_injected', (body: any) => {
      const rawText = body.text || ''
      const nick = body.nickname || '测试观众'
      const evt: StandardEvent = {
        id: `inject-${Date.now()}`,
        ts: Date.now(),
        priority: 'P1',
        kind: 'DANMAKU',
        actor: { uid: `viewer-${nick}`, nickname: nick },
        text: rawText,
      }
      eventQueue.enqueue(evt)
      dialoguePipeline.dispatchNextEvent()
    })
  }

  private bindDesktopAndTouchEvents(): void {
    const {
      state,
      scheduler,
      innerThought,
      antigravitySensor,
      quotaSensor,
      eventQueue,
      dialoguePipeline,
    } = this.deps

    scheduler.on('front_app', (payload: any) => {
      state.setActiveApp(payload.bundleId, payload.name)
      const active = state.getActiveApp()
      if (active) {
        innerThought.onAppCategoryChanged(active.category)
        if (active.category === 'media') {
          state.updateStats({ mood: Math.min(95, state.getStats().mood + 2) })
        } else if (active.category === 'chat') {
          state.updateStats({ mood: Math.min(92, state.getStats().mood + 1) })
        }
        scheduler.syncStatusBar()
        this.applySyncedState()
      }
    })

    state.on('mode_changed', ({ current }: { previous: string; current: string }) => {
      if (current === 'work') {
        this.applySyncedState()
        scheduler.speak('哼，本鱼已切入【工作模式】！有什么任务尽管吩咐我吧~', {
          style: 'happy',
          typewriter: true,
          holdMs: 2500,
        })
      } else if (current === 'companion') {
        this.applySyncedState()
      }
    })

    scheduler.on('screen_lock', () => {
      this.applySyncedState()
    })

    scheduler.on('helper_ready', () => {
      const t = setTimeout(() => this.applySyncedState(), 400)
      t.unref?.()
    })

    scheduler.on('audio_event', (payload: any) => {
      if (payload.event === 'ended' || payload.event === 'interrupted') {
        const t = setTimeout(() => this.applySyncedState(), 300)
        t.unref?.()
      }
    })

    antigravitySensor.on('activity_change', (act: any) => {
      if (state.getMode() !== 'companion') return
      if (act.isBusy) {
        this.applySyncedState()
      } else {
        this.clearSlackState()
        state.updateStats({ mood: Math.min(96, state.getStats().mood + 2) })
        quotaSensor.refreshAll(false).catch(() => {})
        scheduler.updateStateCard({
          state: 'IDLE',
          message: '大肥鱼 · 任务达成 🎉',
          detail: act.statusMessage || 'Antigravity 任务执行完成啦 ✨',
        })
        scheduler.play('success', { maxMs: 3200, resumeState: 'IDLE' })
        this.slackResumeTimer = setTimeout(() => {
          this.slackResumeTimer = null
          this.applySyncedState()
        }, 3300)
        this.slackResumeTimer.unref?.()
      }
    })

    scheduler.on('user_touch', (payload: any) => {
      const wasSlacking = this.isSlacking
      this.clearSlackState()

      const touchMap: Record<string, string> = {
        head_pat: '摸摸头',
        poke: '戳一戳',
        tail: '揪尾巴',
      }
      const keyword = touchMap[payload.clip] || '摸头'
      eventQueue.enqueue({
        id: `touch-${Date.now()}`,
        ts: Date.now(),
        priority: 'P1',
        kind: 'TOUCH',
        text: wasSlacking ? `${keyword}（抓包你摸鱼啦）` : keyword,
        actor: { uid: 'host', nickname: '你' },
      })
      dialoguePipeline.dispatchNextEvent()

      this.slackResumeTimer = setTimeout(() => {
        this.slackResumeTimer = null
        this.applySyncedState()
      }, 3600)
      this.slackResumeTimer.unref?.()
    })
  }

  private startTimers(): void {
    const {
      state,
      scheduler,
      memory,
      emotion,
      innerThought,
      antigravitySensor,
      quotaSensor,
      qqOrchestrator,
    } = this.deps

    // 1. 每 15 秒评估一次“忙里偷闲摸鱼”与空闲微动作
    this.slackingTimer = setInterval(() => {
      if (state.getMode() !== 'companion' || state.getIsTalking() || this.isSlacking) return
      const synced = this.computeSyncedCompanionState()
      const currentStats = state.getStats()
      const currentEmotion = state.getEmotion()
      const agBusy = antigravitySensor.getStatus().isBusy
      const now = Date.now()

      if (synced.state === 'WORKING' || synced.state === 'THINKING') {
        const decision = innerThought.evaluateSlacking(currentEmotion, currentStats, agBusy)
        if (decision.shouldSlack) {
          this.isSlacking = true
          scheduler.updateStateCard({
            state: synced.state,
            activity: synced.activity,
            message: decision.title,
            detail: decision.detail,
          })
          scheduler.play(decision.clip, {
            maxMs: decision.durationMs,
            loop: decision.loop,
            resumeState: synced.state,
          })

          this.slackResumeTimer = setTimeout(() => {
            this.isSlacking = false
            this.slackResumeTimer = null
            this.applySyncedState()
          }, decision.durationMs)
          this.slackResumeTimer.unref?.()
        }
        return
      }

      if (synced.state === 'IDLE' && now - this.lastIdleMicroAt > 28000) {
        if (Math.random() < 0.65) {
          this.lastIdleMicroAt = now
          const act = IDLE_MICRO_ACTIONS[Math.floor(Math.random() * IDLE_MICRO_ACTIONS.length)]
          this.isSlacking = true
          scheduler.updateStateCard({
            state: 'IDLE',
            message: act.msg,
            detail: act.detail,
          })
          scheduler.play(act.clip, {
            maxMs: act.ms,
            loop: false,
            resumeState: 'IDLE',
          })

          this.slackResumeTimer = setTimeout(() => {
            this.isSlacking = false
            this.slackResumeTimer = null
            this.applySyncedState()
          }, act.ms)
          this.slackResumeTimer.unref?.()
        }
      }
    }, 15000)
    this.slackingTimer.unref?.()

    // 2. 每 60 秒根据主人的工作/娱乐状态与 AI 剩余额度演化 RPG 数值，并评估 QQ 主动破冰搭话
    this.decayTimer = setInterval(() => {
      const isLive = state.getMode() === 'live'
      const active = state.getActiveApp()
      const quotaReport = quotaSensor.getReport()
      const continuousWorkMin = innerThought.getContinuousWorkMinutes(active?.category)
      const next = emotion.symbioticTick({
        appCategory: active?.category,
        continuousWorkMin,
        isAntigravityBusy: antigravitySensor.getStatus().isBusy,
        screenLocked: state.isScreenLocked(),
        quotaSatietyPct: quotaReport.satietyPct,
        liveMode: isLive,
      })
      state.updateStats(next.stats)
      const currentStats = state.getStats()
      memory.saveRpgState(currentStats.hunger, currentStats.mood, currentStats.energy)

      qqOrchestrator.trySendProactiveCompanionPoke(continuousWorkMin, active || undefined)
    }, 60000)
    this.decayTimer.unref?.()
  }
}
