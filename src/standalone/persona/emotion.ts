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

  /**
   * 同步外部状态管理器中的数值至 EmotionEngine，消除事实源分裂
   */
  setStats(partial: Partial<RPGStats>, liveMode: boolean = false): void {
    if (partial.hunger !== undefined) {
      this.stats.hunger = Math.max(0, Math.min(100, Math.round(partial.hunger)))
    }
    if (partial.energy !== undefined) {
      this.stats.energy = Math.max(0, Math.min(100, Math.round(partial.energy)))
    }
    if (partial.mood !== undefined) {
      const minMood = liveMode ? 30 : 0
      this.stats.mood = Math.max(minMood, Math.min(100, Math.round(partial.mood)))
    }
    this.emotion = evaluateEmotionFSM(
      this.stats.mood,
      this.stats.hunger,
      this.stats.energy,
      this.emotion,
      liveMode
    )
  }

  /**
   * 赛博共生体状态同步时钟 (Symbiotic Metabolism Tick)
   * 1. 饱食度 (hunger) 映射自 Antigravity + DeepSeek 实时剩余算力额度
   * 2. 心情 (mood) 与精力 (energy) 跟随主人的工作时长、看视频娱乐、聊天社交、锁屏休息动态起伏
   */
  symbioticTick(context: {
    appCategory?: 'code' | 'browser' | 'chat' | 'media' | 'other'
    continuousWorkMin?: number
    isAntigravityBusy?: boolean
    screenLocked?: boolean
    quotaSatietyPct?: number
    liveMode?: boolean
    hourOfDay?: number
  }): { stats: RPGStats; emotion: EmotionState } {
    const liveMode = Boolean(context.liveMode)
    const minMood = liveMode ? 30 : 0
    const hour = context.hourOfDay ?? new Date().getHours()

    // 1. 饱食度 = 实时剩余算力额度 (Antigravity + DeepSeek)
    if (typeof context.quotaSatietyPct === 'number' && !Number.isNaN(context.quotaSatietyPct)) {
      this.stats.hunger = Math.max(5, Math.min(100, Math.round(context.quotaSatietyPct)))
    }

    // 2. 心情与精力：随主人行为状态自动流转
    if (context.screenLocked) {
      // 锁屏休息：精力快速充电，心情平和恢复
      this.stats.energy = Math.min(100, this.stats.energy + 4)
      if (this.stats.mood < 75) {
        this.stats.mood = Math.min(75, this.stats.mood + 2)
      }
    } else if (context.appCategory === 'media') {
      // 看视频 / 听歌放松：多巴胺回血，心情与精力显著恢复
      this.stats.mood = Math.min(92, this.stats.mood + 3)
      this.stats.energy = Math.min(98, this.stats.energy + 2)
    } else if (context.appCategory === 'chat') {
      // 聊天社交 / 水群吃瓜：解除工作紧绷，心情缓慢回温
      this.stats.mood = Math.min(88, this.stats.mood + 2)
      this.stats.energy = Math.min(95, this.stats.energy + 1)
    } else if (context.appCategory === 'browser' && !context.isAntigravityBusy) {
      // 网页冲浪 / 看资讯：心情温和恢复至舒适区
      if (this.stats.mood < 82) {
        this.stats.mood = Math.min(82, this.stats.mood + 1)
      }
      this.stats.energy = Math.min(92, this.stats.energy + 1)
    } else if (context.appCategory === 'code' || context.isAntigravityBusy) {
      // 持续停留在工作/编程状态：心情随专注时长呈现真实的阶段性起伏
      const workMin = context.continuousWorkMin ?? 0
      if (workMin <= 20) {
        // 心流起步期 (0~20min)：陪老爸一起干劲满满，心情微升
        if (this.stats.mood < 82) {
          this.stats.mood = Math.min(82, this.stats.mood + 1)
        }
      } else if (workMin <= 45) {
        // 专注紧绷期 (20~45min)：高强度紧绷下心情小幅波动回落，摸鱼小动作增加
        const wave = Math.sin(workMin / 5) >= 0 ? 0 : -1
        this.stats.mood = Math.max(minMood, Math.min(100, this.stats.mood + wave))
        this.stats.energy = Math.max(25, this.stats.energy - 1)
      } else {
        // 久坐死磕期 (>45min)：枯燥疲惫累积，心情下滑催促老爸切出去看视频/聊天歇会儿
        this.stats.mood = Math.max(minMood, this.stats.mood - 2)
        this.stats.energy = Math.max(15, this.stats.energy - 2)
      }
    } else {
      // 其他日常停留：向舒适基线平滑回归
      if (this.stats.mood < this.baselineMood + 8) {
        this.stats.mood = Math.min(this.baselineMood + 8, this.stats.mood + 1)
      } else if (this.stats.mood > 85) {
        this.stats.mood = Math.max(85, this.stats.mood - 1)
      }
    }

    // 3. 深夜熬夜生物钟联动 (23:30 ~ 05:00)
    if ((hour >= 23 || hour < 5) && !context.screenLocked) {
      this.stats.energy = Math.max(12, this.stats.energy - 2)
    }

    this.emotion = evaluateEmotionFSM(
      this.stats.mood,
      this.stats.hunger,
      this.stats.energy,
      this.emotion,
      liveMode
    )

    return { stats: { ...this.stats }, emotion: this.emotion }
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
