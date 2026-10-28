/**
 * @file inner-thought.ts
 * 主动内心独白循环、30 句台词滑动窗口防重复检测与专注提醒
 */

import { calculateLevenshtein } from './emotion.ts'

export interface ProactiveEvaluation {
  shouldSpeak: boolean
  reason: 'IDLE_TIMEOUT' | 'FOCUS_REMIND' | 'SCHEDULE_MEAL' | 'SCHEDULE_SLEEP' | 'NONE'
  candidateTopic?: string
}

export class InnerThoughtLoop {
  private recentSpokenHistory: string[] = []
  private lastSpokenAt: number = Date.now()
  private focusStartAt: number = Date.now()
  private lastFocusRemindAt: number = 0
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
}
