/**
 * @file inner-thought.ts
 * 主动内心独白循环、30 句台词滑动窗口防重复检测与专注提醒
 */

import type { EmotionState, RPGStats } from '../core/types.ts'
import { calculateLevenshtein } from './emotion.ts'

export interface ProactiveEvaluation {
  shouldSpeak: boolean
  reason: 'IDLE_TIMEOUT' | 'FOCUS_REMIND' | 'SCHEDULE_MEAL' | 'SCHEDULE_SLEEP' | 'NONE'
  candidateTopic?: string
}

export interface SlackingDecision {
  shouldSlack: boolean
  clip: string
  loop: boolean
  durationMs: number
  title: string
  detail: string
}

export class InnerThoughtLoop {
  private recentSpokenHistory: string[] = []
  private lastSpokenAt: number = Date.now()
  private focusStartAt: number = Date.now()
  private lastFocusRemindAt: number = 0
  private lastSlackClip: string = ''
  private maxHistoryLength: number
  private similarityThreshold: number

  constructor(
    maxHistoryLength: number = 30,
    similarityThreshold: number = 0.85
  ) {
    this.maxHistoryLength = maxHistoryLength
    this.similarityThreshold = similarityThreshold
  }

  /**
   * 记录一嘴已说完的台词，维护 30 句滑动窗口
   */
  recordSpoken(text: string): void {
    const clean = text.trim()
    if (!clean) return
    this.recentSpokenHistory.push(clean)
    if (this.recentSpokenHistory.length > this.maxHistoryLength) {
      this.recentSpokenHistory.shift()
    }
    this.lastSpokenAt = Date.now()
  }

  /**
   * 检查候选台词是否与最近 30 句历史过于相似 (防重复机械化)
   */
  isRepetitive(candidateText: string): boolean {
    const text = candidateText.trim()
    if (!text) return true

    for (const historic of this.recentSpokenHistory) {
      if (text === historic) return true
      const maxLen = Math.max(text.length, historic.length)
      if (maxLen === 0) continue
      const dist = calculateLevenshtein(text, historic)
      const similarity = 1 - dist / maxLen
      if (similarity >= this.similarityThreshold) {
        return true
      }
    }
    return false
  }

  /**
   * 更新前台活跃应用类别与专注时长
   */
  onAppCategoryChanged(category: string): void {
    if (category === 'code') {
      // 保持当前专注时段
    } else {
      // 切出编程应用，重置专注起点
      this.focusStartAt = Date.now()
    }
  }

  /**
   * 获取当前连续停留在编程/工作状态的分钟数
   */
  getContinuousWorkMinutes(currentCategory?: string): number {
    if (currentCategory && currentCategory !== 'code') return 0
    return Math.max(0, (Date.now() - this.focusStartAt) / 60000)
  }

  /**
   * 周期性主动发言决策评估
   */
  evaluate(
    idleSilenceSec: number,
    appCategory: string,
    mode: 'companion' | 'live'
  ): ProactiveEvaluation {
    const now = Date.now()
    const silenceSec = (now - this.lastSpokenAt) / 1000

    // 1. 编程专注长达 60 分钟贴心关怀提醒
    if (appCategory === 'code') {
      const focusMinutes = (now - this.focusStartAt) / 60000
      const sinceLastRemindMinutes = (now - this.lastFocusRemindAt) / 60000
      if (focusMinutes >= 60 && sinceLastRemindMinutes >= 60) {
        this.lastFocusRemindAt = now
        return {
          shouldSpeak: true,
          reason: 'FOCUS_REMIND',
          candidateTopic: '已经连续死磕代码一个小时啦！必须起来活动喝口水！',
        }
      }
    }

    // 2. 直播/伴侣静默冷场打破
    const threshold = mode === 'live' ? 20 : idleSilenceSec
    if (silenceSec >= threshold) {
      return {
        shouldSpeak: true,
        reason: 'IDLE_TIMEOUT',
        candidateTopic: mode === 'live' ? '和直播间观众唠嗑互动' : '随性自言自语或主动关心',
      }
    }

    return {
      shouldSpeak: false,
      reason: 'NONE',
    }
  }

  /**
   * 根据当前情绪状态与三维 RPG 数值，评估在陪主人工作/执行任务期间是否触发灵动“摸鱼”小动作
   */
  evaluateSlacking(
    emotionState: EmotionState,
    stats: RPGStats,
    isAntigravityBusy: boolean = false,
    rng: () => number = Math.random
  ): SlackingDecision {
    const profiles: Record<
      EmotionState,
      {
        baseProb: number
        durationMs: number
        candidates: Array<{ clip: string; loop: boolean; title: string; detail: string }>
      }
    > = {
      HAPPY: {
        baseProb: 0.16,
        durationMs: 3600,
        candidates: [
          {
            clip: 'eat_token',
            loop: false,
            title: '大肥鱼 · 偷吃零食 🍬',
            detail: '偷偷嚼颗 Token 补充算力，马上继续陪你肝！✨',
          },
          {
            clip: 'tail',
            loop: false,
            title: '大肥鱼 · 吐个泡泡 🫧',
            detail: '咕噜噜吐个开心泡泡~ 灵感加持 Bug 退散！',
          },
          {
            clip: 'poke',
            loop: false,
            title: '大肥鱼 · 元气加油 ✨',
            detail: '晃晃鱼尾巴给你打气，代码写得超顺手~',
          },
        ],
      },
      TSUNDERE: {
        baseProb: 0.36,
        durationMs: 5000,
        candidates: [
          {
            clip: 'idle_stretch',
            loop: false,
            title: '大肥鱼 · 傲娇摸鱼中 🐟',
            detail: '才不是在摸鱼呢！本鱼只是伸个大懒腰活动鱼鳍！😤',
          },
          {
            clip: 'waiting',
            loop: true,
            title: '大肥鱼 · 四处张望 👀',
            detail: '左看看右看看…确认一下你有没有背着我偷懒！',
          },
          {
            clip: 'eat_token',
            loop: false,
            title: '大肥鱼 · 偷吃加餐 🍙',
            detail: '陪你忙了这么久，本鱼自己奖励一口零食不过分吧！',
          },
          {
            clip: 'idle',
            loop: true,
            title: '大肥鱼 · 偷喘口气 ~',
            detail: '稍微歇两秒鱼鳍嘛，一直紧绷着尾巴都要酸啦~ 🐟',
          },
        ],
      },
      GRUMPY: {
        baseProb: 0.65,
        durationMs: 7000,
        candidates: [
          {
            clip: 'error',
            loop: false,
            title: '大肥鱼 · 消极怠工 💢',
            detail: '叹气…肚子饿心情又差，不想动鱼鳍了啦！快哄我！',
          },
          {
            clip: 'idle_yawn',
            loop: false,
            title: '大肥鱼 · 抱怨摸鱼 🙄',
            detail: '哈欠——没吃饱心情差，哪有力气陪你死磕代码嘛！',
          },
          {
            clip: 'idle',
            loop: true,
            title: '大肥鱼 · 罢工边缘 😤',
            detail: '开启摆烂摸鱼模式…除非你摸摸我的头或者投喂我！',
          },
        ],
      },
      SULKING: {
        baseProb: 0.82,
        durationMs: 8500,
        candidates: [
          {
            clip: 'idle',
            loop: true,
            title: '大肥鱼 · 委屈摸鱼 🥺',
            detail: '委屈巴巴发呆中…没人疼的小肥鱼没心思干活了…',
          },
          {
            clip: 'error',
            loop: false,
            title: '大肥鱼 · 叹气罢工 💧',
            detail: '垂头丧气…需要摸摸头安慰才能重新开机干活…',
          },
        ],
      },
      SLEEPY: {
        baseProb: 0.80,
        durationMs: 8000,
        candidates: [
          {
            clip: 'idle_yawn',
            loop: false,
            title: '大肥鱼 · 犯困打盹 💤',
            detail: '哈欠连天…眼皮打架了，本鱼先偷偷眯五秒钟…',
          },
          {
            clip: 'idle_stretch',
            loop: false,
            title: '大肥鱼 · 迷糊伸懒腰 🌙',
            detail: '困得晕乎乎的…伸个懒腰提提神再继续陪你…',
          },
          {
            clip: 'idle',
            loop: true,
            title: '大肥鱼 · 站着打瞌睡 😪',
            detail: '呼噜噜…鱼尾巴都快摇不动啦，充会电再肝…',
          },
        ],
      },
    }

    const profile = profiles[emotionState] || profiles.TSUNDERE

    // 结合具体 mood 与 energy 微调摸鱼概率：心情越低、精力越低，越容易开小差
    const moodFactor = Math.max(-0.08, Math.min(0.18, (65 - stats.mood) * 0.003))
    const energyFactor = Math.max(0, (50 - stats.energy) * 0.003)
    let probability = Math.max(0.08, Math.min(0.92, profile.baseProb + moodFactor + energyFactor))

    // 当 Antigravity 正在高速执行任务时，若心情较好则更专注同步状态，降低摸鱼频率
    if (isAntigravityBusy && (emotionState === 'HAPPY' || emotionState === 'TSUNDERE')) {
      probability *= 0.45
    }

    if (rng() >= probability) {
      return {
        shouldSlack: false,
        clip: '',
        loop: false,
        durationMs: 0,
        title: '',
        detail: '',
      }
    }

    const pool = profile.candidates.filter((c) => c.clip !== this.lastSlackClip)
    const effectivePool = pool.length > 0 ? pool : profile.candidates
    const idx = Math.min(
      effectivePool.length - 1,
      Math.floor(rng() * effectivePool.length)
    )
    const chosen = effectivePool[idx]
    this.lastSlackClip = chosen.clip

    return {
      shouldSlack: true,
      clip: chosen.clip,
      loop: chosen.loop,
      durationMs: isAntigravityBusy ? Math.min(profile.durationMs, 4200) : profile.durationMs,
      title: chosen.title,
      detail: chosen.detail,
    }
  }
}
