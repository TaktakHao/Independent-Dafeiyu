/**
 * @file working.ts
 * Milestone M3: L1 工作记忆环形缓冲区与滑动窗口淘汰机制
 * 
 * 核心技术标准：
 * 1. 内存中维护最近对话轮次队列，滑动窗口严格受控于预算（默认 ~500 tokens）。
 * 2. 精确中英文混合 Token 估算：中文按单字权重，英文按单词/字符权重。
 * 3. 溢出淘汰通知：当新入队导致总 token 超限时，从队头挤出最旧轮次，触发 onEvict 回调供 L2 摘要增量消费。
 * 4. 线程安全（同步操作）与零内存泄漏，支持清理与快照提取。
 */

import { EventEmitter } from 'node:events'
import type { DialogueTurn } from './types.ts'

export type EvictListener = (evictedTurns: DialogueTurn[]) => void

/**
 * 中英文混合 Token 快速估算
 * 中文字符约占 1~1.2 tokens，英文单词约占 1.3 tokens (4 字符 ≈ 1 token)
 */
export function estimateTokens(text: string): number {
  if (!text || typeof text !== 'string') return 0
  let tokens = 0
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    // CJK 统一表意文字及扩展区：每个汉字按 1.2 估算
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || code >= 0x20000) {
      tokens += 1.2
    } else {
      // 英文与空白符号：每字符约 0.35 tokens
      tokens += 0.35
    }
  }
  return Math.max(1, Math.ceil(tokens))
}

export class WorkingMemory extends EventEmitter {
  private turns: DialogueTurn[] = []
  private maxTokens: number
  private totalTokens: number = 0
  private idCounter: number = 0

  /**
   * @param maxTokens 最大 Token 预算，默认 500
   */
  constructor(maxTokens: number = 500) {
    super()
    this.maxTokens = Math.max(50, maxTokens)
  }

  /**
   * 注册淘汰监听器 (供 L2 摘要引擎消费)
   */
  onEvict(listener: EvictListener): this {
    return this.on('evict', listener)
  }

  /**
   * 追加一轮对话
   * @param turn 对话数据
   * @returns 被挤出的对话轮次数组 (若无溢出则返回空数组)
   */
  addTurn(turn: {
    role: 'user' | 'assistant'
    text: string
    actor?: string
    timestamp?: number
  }): DialogueTurn[] {
    const text = typeof turn.text === 'string' ? turn.text : String(turn.text ?? '')
    const tokens = estimateTokens(text)
    const turnRecord: DialogueTurn = {
      id: `turn_${Date.now()}_${++this.idCounter}`,
      role: turn.role,
      text,
      actor: turn.actor || (turn.role === 'assistant' ? 'daughter' : 'user'),
      timestamp: turn.timestamp || Date.now(),
      tokens
    }

    this.turns.push(turnRecord)
    this.totalTokens += tokens

    const evicted: DialogueTurn[] = []

    // 当总 Token 超出预算硬上限时，从队头按序弹出最旧轮次
    while (this.totalTokens > this.maxTokens && this.turns.length > 0) {
      const removed = this.turns.shift()
      if (removed) {
        this.totalTokens -= removed.tokens
        evicted.push(removed)
      }
    }

    if (evicted.length > 0) {
      this.emit('evict', evicted)
    }

    return evicted
  }

  /**
   * 获取用于组装 Prompt 的最近对话历史
   */
  getRecentDialogues(): Array<{ role: 'user' | 'assistant'; text: string; actor?: string }> {
    return this.turns.map((t) => ({
      role: t.role,
      text: t.text,
      actor: t.actor
    }))
  }

  /**
   * 获取所有完整轮次
   */
  getAllTurns(): DialogueTurn[] {
    return [...this.turns]
  }

  /**
   * 获取当前总 Token 估算值
   */
  getTotalTokens(): number {
    return this.totalTokens
  }

  /**
   * 获取当前总轮数
   */
  getTurnCount(): number {
    return this.turns.length
  }

  /**
   * 清空工作记忆
   */
  clear(): void {
    this.turns = []
    this.totalTokens = 0
  }
}
