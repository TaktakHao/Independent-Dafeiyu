import { EventEmitter } from 'node:events'
import { HelperProcess } from '../../helper-process.js'
import {
  CompanionMessageKind,
  createMessage,
} from '../../protocol.js'
import type { StateManager } from './state.ts'
import type {
  AudioEventPayload,
  AudioOptions,
  FrontAppPayload,
  PlayOptions,
  ScreenLockPayload,
  SpeakOptions,
  StandaloneConfig,
  UserTouchPayload,
} from './types.ts'

/**
 * 核心运行时调度器：负责 Helper 进程生命周期、NDJSON 通信、事件总线、状态同步与急停
 */
export class RuntimeScheduler extends EventEmitter {
  private helper: any = null
  private state: StateManager
  private config: StandaloneConfig
  private audioQueue: AudioOptions[] = []
  private isShuttingDown: boolean = false
  private statusBarSyncTimer: any = null

  constructor(state: StateManager, config: StandaloneConfig = {}) {
    super()
    this.state = state
    this.config = config
  }

  async start(): Promise<void> {
    if (this.helper || this.isShuttingDown) return
    this.state.setConnectionStatus('starting')

    this.helper = new HelperProcess({
      headless: this.config.headless ?? false,
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      heartbeatMs: this.config.heartbeatMs ?? 5000,
      heartbeatTimeoutMs: this.config.heartbeatTimeoutMs ?? 15000,
      startupTimeoutMs: this.config.startupTimeoutMs ?? 60000,
      restartDelayMs: this.config.restartDelayMs ?? 750,
      maxStartFailures: this.config.maxStartFailures ?? 5,
      onReady: () => {
        this.state.setConnectionStatus('ready')
        this.syncStatusBar()
        this.emit('helper_ready')
      },
      onClosed: () => {
        this.state.setConnectionStatus('stopped')
        this.emit('helper_closed')
      },
      onAudioEvent: (payload: AudioEventPayload) => {
        this.handleAudioEvent(payload)
      },
      onFrontApp: (payload: FrontAppPayload) => {
        this.state.setActiveApp(payload.bundleId, payload.name)
        this.emit('front_app', payload)
      },
      onScreenLock: (payload: ScreenLockPayload) => {
        this.state.setScreenLock(payload.locked)
        this.emit('screen_lock', payload)
      },
      onUserTouch: (payload: UserTouchPayload) => {
        this.handleUserTouch(payload)
      },
      onSettingsChange: (settings: any) => {
        this.emit('settings_changed', settings)
      },
    })

    this.helper.start()

    // 监听状态机变更，自动防抖同步状态栏至 Helper
    this.state.on('stats_changed', () => this.debouncedSyncStatusBar())
    this.state.on('mode_changed', () => this.syncStatusBar())
    this.state.on('emotion_changed', () => this.debouncedSyncStatusBar())
  }

  play(clip: string, options: Partial<PlayOptions> = {}): void {
    if (!this.helper) return
    const msg = createMessage(CompanionMessageKind.PLAY, {
      clip,
      maxMs: options.maxMs,
      loop: options.loop ?? false,
      resumeState: options.resumeState ?? 'IDLE',
    })
    this.helper.send(msg)
  }

  async playClip(options: { clip: string; maxMs?: number; loop?: boolean; resumeState?: string }): Promise<void> {
    this.play(options.clip, options)
  }

  speak(text: string, options: Partial<SpeakOptions> = {}): string {
    const id = options.id ?? `utt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    if (!this.helper) return id
    const msg = createMessage(CompanionMessageKind.SPEAK, {
      id,
      text,
      style: options.style,
      typewriter: options.typewriter ?? true,
      holdMs: options.holdMs ?? 1500,
    })
    this.helper.send(msg)
    return id
  }

  async speakText(options: { text: string; style?: string; typewriter?: boolean; holdMs?: number; id?: string }): Promise<string> {
    return this.speak(options.text, options)
  }

  playAudio(path: string, options: Partial<AudioOptions> = {}): void {
    if (options.interrupt) {
      this.stopAudio()
    }
    const item: AudioOptions = {
      id: options.id ?? `aud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      seq: options.seq ?? 0,
      path,
      interrupt: options.interrupt ?? false,
    }

    if (!this.helper) return

    // 下发到 Helper
    const msg = createMessage(CompanionMessageKind.AUDIO, item)
    this.helper.send(msg)
  }

  stopAudio(): void {
    this.audioQueue = []
    if (!this.helper) return
    const msg = createMessage(CompanionMessageKind.AUDIO_STOP)
    this.helper.send(msg)
    this.state.setTalking(false)
    this.state.setCurrentAudioId(null)
  }

  setTalking(on: boolean): void {
    this.state.setTalking(on)
    if (!this.helper) return
    const msg = createMessage(CompanionMessageKind.TALKING, { on })
    this.helper.send(msg)
  }

  syncStatusBar(): void {
    if (!this.helper) return
    const text = this.state.formatStatusBarText()
    const msg = createMessage(CompanionMessageKind.STATUS_BAR, { text })
    this.helper.send(msg)
  }

  private debouncedSyncStatusBar(): void {
    if (this.statusBarSyncTimer) clearTimeout(this.statusBarSyncTimer)
    this.statusBarSyncTimer = setTimeout(() => {
      this.syncStatusBar()
      this.statusBarSyncTimer = null
    }, 100)
    this.statusBarSyncTimer.unref?.()
  }

  /**
   * 全局急停机制 (Emergency Stop)
   */
  emergencyStop(): void {
    this.stopAudio()
    this.play('idle', { maxMs: 0, resumeState: 'IDLE' })
    this.setTalking(false)
    this.emit('emergency_stopped')
  }

  private handleAudioEvent(payload: AudioEventPayload): void {
    this.emit('audio_event', payload)
    if (payload.event === 'started') {
      this.state.setTalking(true)
      this.state.setCurrentAudioId(payload.id)
    } else if (payload.event === 'ended' || payload.event === 'interrupted') {
      this.state.setTalking(false)
      this.state.setCurrentAudioId(null)
      // 若有待播队列，自动触发下一句
      if (this.audioQueue.length > 0) {
        const next = this.audioQueue.shift()!
        this.playAudio(next.path, next)
      }
    }
  }

  private handleUserTouch(payload: UserTouchPayload): void {
    this.emit('user_touch', payload)
    // 桌面抚摸反馈逻辑：摸摸头/戳一戳加好感度与心情
    if (payload.clip === 'head_pat') {
      this.state.updateStats({ mood: this.state.getStats().mood + 3 })
      this.play('head_pat', { maxMs: 3500, resumeState: 'IDLE' })
    } else if (payload.clip === 'poke') {
      this.play('poke', { maxMs: 3000, resumeState: 'IDLE' })
    } else if (payload.clip === 'tail') {
      this.play('tail', { maxMs: 3000, resumeState: 'IDLE' })
    }
  }

  async stop(reason = 'shutdown'): Promise<void> {
    this.isShuttingDown = true
    if (this.statusBarSyncTimer) clearTimeout(this.statusBarSyncTimer)
    this.state.setConnectionStatus('stopped')
    if (this.helper) {
      this.helper.stop(reason)
      this.helper = null
    }
    this.emit('stopped', reason)
  }
}
