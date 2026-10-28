/**
 * @file ocr-mock.js
 * 模拟 native/danmaku-ocr Swift CLI 屏幕弹幕 OCR 识别管道与滚动去重
 */

import { EventEmitter } from 'node:events'
import { calculateLCSDeduplication } from './contract-validators.js'

export class DanmakuOcrMock extends EventEmitter {
  constructor() {
    super()
    this.historyFrames = []
    this.emittedEvents = []
    this.diskWriteCount = 0 // 监控有无违法落盘
  }

  /**
   * 模拟一帧 OCR 文本行输入
   * @param {Array<{ text: string, confidence: number, y: number }>} rawLines 
   */
  processFrame(rawLines) {
    // 1. 过滤置信度 < 0.5 的杂乱行
    const validLines = rawLines
      .filter((line) => line.confidence >= 0.5 && line.text.trim().length > 0)
      .sort((a, b) => a.y - b.y)
      .map((l) => l.text.trim())

    // 2. 与上一帧进行 LCS 对齐去重
    const previousFrame = this.historyFrames.length > 0 ? this.historyFrames[this.historyFrames.length - 1] : []
    const incrementalLines = calculateLCSDeduplication(previousFrame, validLines)

    // 3. 记录历史帧 (纯内存存储，无磁盘写操作)
    this.historyFrames.push(validLines)

    // 4. 解析行事件并广播
    for (const line of incrementalLines) {
      const event = this._parseDanmakuLine(line)
      if (event) {
        this.emittedEvents.push(event)
        this.emit('event', event)
      }
    }

    return incrementalLines
  }

  _parseDanmakuLine(line) {
    // 礼物格式: 昵称: 送出 荧光棒 x1
    const giftMatch = line.match(/^(.+?):\s*送出\s*(.+?)\s*x(\d+)$/)
    if (giftMatch) {
      return {
        type: 'GIFT',
        viewer: giftMatch[1].trim(),
        giftName: giftMatch[2].trim(),
        count: parseInt(giftMatch[3], 10),
        raw: line,
      }
    }

    // 进房格式: 欢迎 昵称 进入直播间
    const enterMatch = line.match(/^欢迎\s*(.+?)\s*进入直播间$/)
    if (enterMatch) {
      return {
        type: 'ENTER',
        viewer: enterMatch[1].trim(),
        raw: line,
      }
    }

    // 点赞格式: 昵称 点了赞
    const likeMatch = line.match(/^(.+?)\s*点了赞$/)
    if (likeMatch) {
      return {
        type: 'LIKE',
        viewer: likeMatch[1].trim(),
        raw: line,
      }
    }

    // 普通发言: 昵称: 内容
    const chatMatch = line.match(/^(.+?):\s*(.+)$/)
    if (chatMatch) {
      return {
        type: 'DANMAKU',
        viewer: chatMatch[1].trim(),
        content: chatMatch[2].trim(),
        raw: line,
      }
    }

    return null
  }
}
