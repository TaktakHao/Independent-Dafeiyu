/**
 * @file emotion.ts
 * 拟人化三轴情感状态机与防恶意操控数值引擎
 */

import type { EmotionState, RPGStats } from '../core/types.ts'

/**
 * 5 态迟滞情绪状态机核心决策算法（带迟滞区间防抖）
 */
export function evaluateEmotionFSM(
  mood: number,
  hunger: number,
  energy: number,
  currentState: EmotionState = 'TSUNDERE',
  liveMode: boolean = false
): EmotionState {
  // 1. 直播合规硬约束：心情下限 clamp 到 30，绝不进入消极消极罢工的 SULKING
  let effectiveMood = mood
  if (liveMode) {
    if (effectiveMood < 30) effectiveMood = 30
    if (currentState === 'SULKING') currentState = 'GRUMPY'
  }

  // 2. 精力枯竭优先判定
  if (energy < 20) {
    return 'SLEEPY'
  }

  // 3. 伴侣模式下的消极委屈态 (SULKING)
  if (!liveMode) {
    if (currentState === 'SULKING') {
      if (effectiveMood >= 28) return 'GRUMPY'
      return 'SULKING'
    }
    if (effectiveMood < 25) {
      return 'SULKING'
    }
  }

  // 4. 炸毛小脾气态 (GRUMPY)
  if (currentState === 'GRUMPY') {
    if (effectiveMood >= 46 && hunger >= 35) {
      return 'TSUNDERE'
    }
    return 'GRUMPY'
  }
  if (hunger < 30 || effectiveMood < 40) {
    return 'GRUMPY'
  }

  // 5. 开心撒娇态 (HAPPY)
  if (currentState === 'HAPPY') {
    if (effectiveMood < 60) {
      return 'TSUNDERE'
    }
    return 'HAPPY'
  }
  if (effectiveMood >= 78) {
    return 'HAPPY'
  }

  // 6. 默认基准模式：傲娇斗嘴态 (TSUNDERE)
  return 'TSUNDERE'
}

/**
 * 计算两个字符串的 Levenshtein 最小编辑距离
 */
export function calculateLevenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length

  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }
  return dp[m][n]
}

/**
 * 情绪数值与防操控引擎
 */
export class EmotionEngine {
  private stats: RPGStats = { hunger: 80, mood: 70, energy: 90 }
  private emotion: EmotionState = 'HAPPY'
  private viewerDeltas: Map<string, { delta: number; resetAt: number }> = new Map()
  private totalDeltaPerMin = 0
  private totalDeltaResetAt = Date.now() + 60000
  private baselineMood: number
  private perViewerCap: number
  private totalCap: number

  constructor(
    baselineMood: number = 60,
    perViewerCap: number = 6,
    totalCap: number = 15
  ) {
    this.baselineMood = baselineMood
    this.perViewerCap = perViewerCap
    this.totalCap = totalCap
  }

  getState(liveMode: boolean): { stats: RPGStats; emotion: EmotionState } {
    this.emotion = evaluateEmotionFSM(
      this.stats.mood,
      this.stats.hunger,
      this.stats.energy,
      this.emotion,
      liveMode
    )
    return { stats: { ...this.stats }, emotion: this.emotion }
  }

  /**
   * 应用心情增减并实施观众单人防刷屏钳制
   */
  applyMoodIntent(intentDelta: number, viewerUid: string = 'host', liveMode: boolean = false): number {
    const now = Date.now()

    // 刷新全服 1 分钟累计限制
    if (now >= this.totalDeltaResetAt) {
      this.totalDeltaPerMin = 0
      this.totalDeltaResetAt = now + 60000
    }

    // 刷新单观众 1 分钟累计限制
    let viewerRecord = this.viewerDeltas.get(viewerUid)
    if (!viewerRecord || now >= viewerRecord.resetAt) {
      viewerRecord = { delta: 0, resetAt: now + 60000 }
      this.viewerDeltas.set(viewerUid, viewerRecord)
    }

    // 钳制单人贡献
    const allowedForViewer = Math.max(
      -this.perViewerCap - viewerRecord.delta,
      Math.min(this.perViewerCap - viewerRecord.delta, intentDelta)
    )
    // 钳制全服贡献
    const allowedTotal = Math.max(
      -this.totalCap - this.totalDeltaPerMin,
      Math.min(this.totalCap - this.totalDeltaPerMin, allowedForViewer)
    )

    viewerRecord.delta += allowedTotal
    this.totalDeltaPerMin += allowedTotal

    const minMood = liveMode ? 30 : 0
    this.stats.mood = Math.max(minMood, Math.min(100, this.stats.mood + allowedTotal))
    this.emotion = evaluateEmotionFSM(
      this.stats.mood,
      this.stats.hunger,
      this.stats.energy,
      this.emotion,
      liveMode
    )

    return allowedTotal
  }

  feed(amount: number = 10): void {
    this.stats.hunger = Math.min(100, this.stats.hunger + amount)
    this.applyMoodIntent(3, 'feed')
  }

  decayTick(liveMode: boolean): void {
    // 饱食度自然衰减
    this.stats.hunger = Math.max(0, this.stats.hunger - 1)
    // 心情向基线回归
    if (this.stats.mood > this.baselineMood) {
      this.stats.mood = Math.max(this.baselineMood, this.stats.mood - 1)
    } else if (this.stats.mood < this.baselineMood) {
      const minMood = liveMode ? 30 : 0
      this.stats.mood = Math.min(this.baselineMood, Math.max(minMood, this.stats.mood + 1))
    }
    this.emotion = evaluateEmotionFSM(
      this.stats.mood,
      this.stats.hunger,
      this.stats.energy,
      this.emotion,
      liveMode
    )
  }
}
