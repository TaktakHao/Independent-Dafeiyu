/**
 * @file screen-danmaku.ts
 * 屏幕弹幕 OCR 捕获驱动：最长公共后缀 (LCS) 增量去重与直播事件解析
 */

import { EventEmitter } from 'node:events'
import type { StandardEvent } from '../events/types.ts'

export interface RawOcrLine {
  text: string
  confidence: number
  y: number
}

/**
 * 滚动弹幕最长公共后缀 (LCS) 增量去重算法
 */
export function calculateLCSDeduplication(previousLines: string[], incomingLines: string[]): string[] {
  if (!previousLines || previousLines.length === 0) {
    return incomingLines.slice()
  }
  if (!incomingLines || incomingLines.length === 0) {
    return []
  }

  const maxOverlap = Math.min(previousLines.length, incomingLines.length)
  let bestMatchIndex = 0

  for (let k = 1; k <= maxOverlap; k++) {
    const prevSlice = previousLines.slice(previousLines.length - k)
    const incomingSlice = incomingLines.slice(0, k)
    let allMatch = true
    for (let i = 0; i < k; i++) {
      if (prevSlice[i] !== incomingSlice[i]) {
        allMatch = false
        break
      }
    }
    if (allMatch) {
      bestMatchIndex = k
    }
  }

  return incomingLines.slice(bestMatchIndex)
}

export class ScreenDanmakuSensor extends EventEmitter {
  private historyFrames: string[][] = []
  private minConfidence: number

  constructor(minConfidence: number = 0.5) {
    super()
    this.minConfidence = minConfidence
  }

  /**
   * 处理一帧 OCR 原始识别文本行
   */
  processFrame(rawLines: RawOcrLine[]): StandardEvent[] {
    const validLines = rawLines
      .filter((l) => l.confidence >= this.minConfidence && l.text.trim().length > 0)
      .sort((a, b) => a.y - b.y)
      .map((l) => l.text.trim())

    const previousFrame = this.historyFrames.length > 0
      ? this.historyFrames[this.historyFrames.length - 1]
      : []

    const incrementalLines = calculateLCSDeduplication(previousFrame, validLines)
    this.historyFrames.push(validLines)
    if (this.historyFrames.length > 20) {
      this.historyFrames.shift()
    }

    const events: StandardEvent[] = []
    for (const line of incrementalLines) {
      const parsed = this.parseDanmakuLine(line)
      if (parsed) {
        events.push(parsed)
        this.emit('event', parsed)
      }
    }

    return events
  }

  /**
   * 解析单行弹幕文字为标准直播事件
   */
  parseDanmakuLine(line: string): StandardEvent | null {
    const now = Date.now()
    const id = `danmaku-${now}-${Math.random().toString(36).slice(2, 7)}`

    // 1. 礼物格式: 昵称: 送出 荧光棒 x1
    const giftMatch = line.match(/^(.+?):\s*送出\s*(.+?)\s*x(\d+)$/)
    if (giftMatch) {
      const count = parseInt(giftMatch[3], 10)
      const name = giftMatch[2].trim()
      const isBig = count >= 10 || ['嘉年华', '火箭', '跑车', '大肥鱼'].some(g => name.includes(g))
      return {
        id,
        ts: now,
        priority: isBig ? 'P0' : 'P1',
        kind: 'GIFT',
        actor: { uid: `viewer-${giftMatch[1].trim()}`, nickname: giftMatch[1].trim() },
        gift: { name, count, isBig },
        text: `送出了 ${name} x${count}`,
      }
    }

    // 2. 进房格式: 欢迎 昵称 进入直播间
    const enterMatch = line.match(/^欢迎\s*(.+?)\s*进入直播间$/)
    if (enterMatch) {
      return {
        id,
        ts: now,
        priority: 'P2',
        kind: 'ENTER',
        actor: { uid: `viewer-${enterMatch[1].trim()}`, nickname: enterMatch[1].trim() },
        text: '进入了直播间',
      }
    }

    // 3. 点赞格式: 昵称 点了赞
    const likeMatch = line.match(/^(.+?)\s*点了赞$/)
    if (likeMatch) {
      return {
        id,
        ts: now,
        priority: 'P2',
        kind: 'LIKE',
        actor: { uid: `viewer-${likeMatch[1].trim()}`, nickname: likeMatch[1].trim() },
        text: '为主播点了赞',
      }
    }

    // 4. 普通发言: 昵称: 内容
    const chatMatch = line.match(/^(.+?):\s*(.+)$/)
    if (chatMatch) {
      return {
        id,
        ts: now,
        priority: 'P1',
        kind: 'DANMAKU',
        actor: { uid: `viewer-${chatMatch[1].trim()}`, nickname: chatMatch[1].trim() },
        text: chatMatch[2].trim(),
      }
    }

    return null
  }
}
