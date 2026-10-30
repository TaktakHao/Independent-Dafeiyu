import { EventEmitter } from 'node:events'
import type {
  ActiveAppInfo,
  ConnectionStatus,
  EmotionState,
  OperationalMode,
  RPGStats,
  StandaloneStateSnapshot,
} from './types.ts'

/**
 * 判定应用所属大类（用于直播模式隐私脱敏与赛博共生行为分类）
 */
function classifyApp(bundleId: string, name: string): 'code' | 'browser' | 'chat' | 'media' | 'other' {
  const lowerId = (bundleId || '').toLowerCase()
  const lowerName = (name || '').toLowerCase()
  if (
    lowerId.includes('vscode') ||
    lowerId.includes('cursor') ||
    lowerId.includes('antigravity') ||
    lowerId.includes('xcode') ||
    lowerId.includes('jetbrains') ||
    lowerId.includes('terminal') ||
    lowerId.includes('iterm') ||
    lowerId.includes('warp') ||
    lowerName.includes('terminal') ||
    lowerName.includes('cursor') ||
    lowerName.includes('antigravity') ||
    lowerName.includes('code')
  ) {
    return 'code'
  }
  if (
    lowerId.includes('bilibili') ||
    lowerId.includes('douyin') ||
    lowerId.includes('iina') ||
    lowerId.includes('vlc') ||
    lowerId.includes('neteasemusic') ||
    lowerId.includes('qqmusic') ||
    lowerId.includes('spotify') ||
    lowerId.includes('apple.music') ||
    lowerId.includes('apple.tv') ||
    lowerName.includes('bilibili') ||
    lowerName.includes('哔哩') ||
    lowerName.includes('抖音') ||
    lowerName.includes('iina') ||
    lowerName.includes('音乐') ||
    lowerName.includes('music') ||
    lowerName.includes('spotify') ||
    lowerName.includes('youtube')
  ) {
    return 'media'
  }
  if (
    lowerId.includes('wechat') ||
    lowerId.includes('tencent.xinwechat') ||
    lowerId.includes('tencent.qq') ||
    lowerId.includes('telegram') ||
    lowerId.includes('slack') ||
    lowerId.includes('discord') ||
    lowerId.includes('lark') ||
    lowerId.includes('feishu') ||
    lowerName.includes('微信') ||
    lowerName.includes('wechat') ||
    lowerName.includes('飞书') ||
    lowerName.includes('feishu') ||
    lowerName.includes('lark') ||
    lowerName.includes('telegram') ||
    lowerName.includes('discord') ||
    lowerName.includes('qq')
  ) {
    return 'chat'
  }
  if (
    lowerId.includes('chrome') ||
    lowerId.includes('safari') ||
    lowerId.includes('brave') ||
    lowerId.includes('firefox') ||
    lowerId.includes('edge') ||
    lowerId.includes('arc') ||
    lowerName.includes('chrome') ||
    lowerName.includes('safari') ||
    lowerName.includes('arc')
  ) {
    return 'browser'
  }
  return 'other'
}

/**
 * 全局状态机与数据总线管理器
 */
export class StateManager extends EventEmitter {
  private mode: OperationalMode = 'companion'
  private connection: ConnectionStatus = 'unstarted'
  private emotion: EmotionState = 'HAPPY'
  private stats: RPGStats = { hunger: 80, mood: 70, energy: 90 }
  private activeApp: ActiveAppInfo | null = null
  private screenLocked: boolean = false
  private isTalking: boolean = false
  private currentAudioId: string | null = null
  private lastUpdated: number = Date.now()

  constructor(initialMode: OperationalMode = 'companion') {
    super()
    this.setMode(initialMode)
  }

  getMode(): OperationalMode {
    return this.mode
  }

  setMode(newMode: OperationalMode): void {
    if (newMode !== 'companion' && newMode !== 'work' && newMode !== 'live') {
      throw new TypeError(`Invalid operational mode: ${String(newMode)}`)
    }
    const previous = this.mode
    this.mode = newMode

    // 直播模式合规保护铁律：强行 clamp 心情 >= 30，绝不进入 SULKING 态
    if (newMode === 'live') {
      if (this.stats.mood < 30) {
        this.stats.mood = 30
      }
      if (this.emotion === 'SULKING') {
        this.emotion = 'TSUNDERE'
      }
    }

    this.lastUpdated = Date.now()
    this.emit('mode_changed', { previous, current: newMode })
    this.emit('state_changed', this.getSnapshot())
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connection
  }

  setConnectionStatus(status: ConnectionStatus): void {
    if (this.connection === status) return
    this.connection = status
    this.lastUpdated = Date.now()
    this.emit('connection_changed', status)
    this.emit('state_changed', this.getSnapshot())
  }

  getEmotion(): EmotionState {
    return this.emotion
  }

  setEmotion(newEmotion: EmotionState): void {
    // 直播保护铁律：禁止进入 SULKING
    let target = newEmotion
    if (this.mode === 'live' && target === 'SULKING') {
      target = 'GRUMPY'
    }
    if (this.emotion === target) return
    this.emotion = target
    this.lastUpdated = Date.now()
    this.emit('emotion_changed', target)
    this.emit('state_changed', this.getSnapshot())
  }

  getStats(): RPGStats {
    return { ...this.stats }
  }

  updateStats(partial: Partial<RPGStats>): void {
    if (partial.hunger !== undefined) {
      this.stats.hunger = Math.max(0, Math.min(100, Math.round(partial.hunger)))
    }
    if (partial.energy !== undefined) {
      this.stats.energy = Math.max(0, Math.min(100, Math.round(partial.energy)))
    }
    if (partial.mood !== undefined) {
      const minMood = this.mode === 'live' ? 30 : 0
      this.stats.mood = Math.max(minMood, Math.min(100, Math.round(partial.mood)))
    }
    this.lastUpdated = Date.now()
    this.emit('stats_changed', this.getStats())
    this.emit('state_changed', this.getSnapshot())
  }

  getActiveApp(): ActiveAppInfo | null {
    return this.activeApp ? { ...this.activeApp } : null
  }

  setActiveApp(bundleId: string, name: string): void {
    const category = classifyApp(bundleId, name)
    // 直播模式合规隐私：对具体 App 名字脱敏，仅记录类别
    const safeName = this.mode === 'live' ? category.toUpperCase() : name
    this.activeApp = {
      bundleId,
      name: safeName,
      category,
      lastActiveAt: Date.now(),
    }
    this.lastUpdated = Date.now()
    this.emit('app_changed', this.getActiveApp())
    this.emit('state_changed', this.getSnapshot())
  }

  isScreenLocked(): boolean {
    return this.screenLocked
  }

  setScreenLock(locked: boolean): void {
    if (this.screenLocked === locked) return
    this.screenLocked = locked
    this.lastUpdated = Date.now()
    this.emit('screen_lock_changed', locked)
    this.emit('state_changed', this.getSnapshot())
  }

  getIsTalking(): boolean {
    return this.isTalking
  }

  setTalking(talking: boolean): void {
    if (this.isTalking === talking) return
    this.isTalking = talking
    this.lastUpdated = Date.now()
    this.emit('talking_changed', talking)
    this.emit('state_changed', this.getSnapshot())
  }

  setCurrentAudioId(id: string | null): void {
    this.currentAudioId = id
    this.lastUpdated = Date.now()
  }

  getCurrentAudioId(): string | null {
    return this.currentAudioId
  }

  /**
   * 生成适合 Swift Helper status_bar 渲染的 RPG 状态文本
   */
  formatStatusBarText(): string {
    const emotionMap: Record<EmotionState, string> = {
      HAPPY: '开心',
      TSUNDERE: '傲娇',
      GRUMPY: '炸毛',
      SULKING: '委屈',
      SLEEPY: '犯困',
    }
    const emotionLabel = emotionMap[this.emotion] ?? '休眠'
    const modeLabel =
      this.mode === 'live' ? '直播中' : this.mode === 'work' ? '🛠️工作中' : '陪伴中'
    let appLabel = ''
    if (this.activeApp?.name) {
      let displayName = this.activeApp.name
      if (displayName.toLowerCase().includes('antigravity')) displayName = 'Antigravity'
      else if (displayName.toLowerCase().includes('cursor')) displayName = 'Cursor'
      appLabel = ` [${displayName}]`
    }
    return `🍙 ${this.stats.hunger}%  ❤️ ${this.stats.mood} ${emotionLabel}  ⚡ ${this.stats.energy}%  · ${modeLabel}${appLabel}`
  }

  getSnapshot(): StandaloneStateSnapshot {
    return {
      mode: this.mode,
      connection: this.connection,
      emotion: this.emotion,
      stats: this.getStats(),
      statusBarText: this.formatStatusBarText(),
      activeApp: this.getActiveApp(),
      screenLocked: this.screenLocked,
      isTalking: this.isTalking,
      currentAudioId: this.currentAudioId,
      updatedAt: this.lastUpdated,
    }
  }
}
