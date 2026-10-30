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

export interface ScopedWorkingMemoryOptions {
  defaultMaxTokens?: number
  defaultTokenBudget?: number
  groupTokenBudget?: number
  privateTokenBudget?: number
  maxSessions?: number
  sessionTtlMs?: number
}

export interface ScopedTurnInput {
  role: 'user' | 'assistant'
  text: string
  actor?: string
  speakerName?: string
  timestamp?: number
}

interface SessionEntry {
  memory: WorkingMemory
  lastAccessed: number
  createdAt: number
}

/**
 * 作用域工作记忆管理器 (ScopedWorkingMemory)
 * 维护会话隔离的滑动窗口：
 * - group:<groupId>      -> QQ 群聊上下文 (按群物理隔离，用户消息带发言人标签)
 * - private:<userId>     -> 个人私聊上下文
 * - console:host         -> Web 控制台主播专属会话
 */
export class ScopedWorkingMemory extends EventEmitter {
  private sessions: Map<string, SessionEntry> = new Map()
  private defaultMaxTokens: number
  private groupTokenBudget?: number
  private privateTokenBudget?: number
  private maxSessions: number
  private sessionTtlMs: number

  constructor(options: ScopedWorkingMemoryOptions | number = {}) {
    super()
    if (typeof options === 'number') {
      this.defaultMaxTokens = Math.max(50, options)
      this.maxSessions = 100
      this.sessionTtlMs = 2 * 3600 * 1000
    } else {
      this.defaultMaxTokens = Math.max(50, options.defaultMaxTokens ?? options.defaultTokenBudget ?? 500)
      this.groupTokenBudget = options.groupTokenBudget
      this.privateTokenBudget = options.privateTokenBudget
      this.maxSessions = Math.max(5, options.maxSessions ?? 100)
      this.sessionTtlMs = Math.max(60000, options.sessionTtlMs ?? 2 * 3600 * 1000)
    }
  }

  /**
   * 会话 Key 标准化工具
   */
  static normalizeSessionKey(
    channel: 'group' | 'private' | 'console' | string,
    id?: string | number
  ): string {
    const raw = String(channel).trim()
    if (raw.startsWith('group:') || raw.startsWith('private:') || raw.startsWith('console:')) {
      return raw
    }
    if (raw === 'group') return `group:${id ?? 'default'}`
    if (raw === 'private') return `private:${id ?? 'host'}`
    if (raw === 'console') return 'console:host'
    return `session:${raw}`
  }

  /**
   * 获取或懒初始化指定会话的工作记忆实例 (带 LRU 淘汰)
   */
  getOrCreateSession(sessionKey: string, customTokens?: number): WorkingMemory {
    const key = (sessionKey || '').trim() || 'default'
    const now = Date.now()

    const existing = this.sessions.get(key)
    if (existing) {
      existing.lastAccessed = now
      return existing.memory
    }

    // 检查并执行 LRU 会话级淘汰
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldestSession()
    }

    let tokenBudget = customTokens ?? this.defaultMaxTokens
    if (customTokens === undefined) {
      if (key.startsWith('group:') && this.groupTokenBudget) {
        tokenBudget = this.groupTokenBudget
      } else if (key.startsWith('private:') && this.privateTokenBudget) {
        tokenBudget = this.privateTokenBudget
      }
    }

    const wm = new WorkingMemory(tokenBudget)

    // 转发单会话淘汰事件至全局总线与具名事件
    wm.onEvict((evictedTurns) => {
      this.emit('evict', { sessionKey: key, evictedTurns })
      this.emit(`evict:${key}`, evictedTurns)
    })

    this.sessions.set(key, {
      memory: wm,
      lastAccessed: now,
      createdAt: now,
    })

    return wm
  }

  /**
   * 别名方法：获取指定会话的工作记忆实例
   */
  getMemory(sessionKey: string, customTokens?: number): WorkingMemory {
    return this.getOrCreateSession(sessionKey, customTokens)
  }

  /**
   * 向指定会话写入一轮对话
   * 若为群聊会话 (group:<id>) 且角色为 user，自动追加说话人身份前缀标签 [preferredTitle || nickname]: text
   */
  addTurn(sessionKey: string, turn: ScopedTurnInput): DialogueTurn[] {
    const safeKey = (sessionKey || '').trim() || 'default'
    const wm = this.getOrCreateSession(safeKey)
    const isGroup = safeKey.startsWith('group:')

    let text = typeof turn.text === 'string' ? turn.text : String(turn.text ?? '')

    if (isGroup && turn.role === 'user') {
      const speaker = (turn.speakerName || turn.actor || '群友').trim()
      // 防止重复添加标签
      if (!text.startsWith(`[${speaker}]:`)) {
        text = `[${speaker}]: ${text}`
      }
    }

    return wm.addTurn({
      role: turn.role,
      text,
      actor: turn.actor,
      timestamp: turn.timestamp,
    })
  }

  /**
   * 获取指定会话用于组装 Prompt 的最近对话列表
   */
  getRecentDialogues(sessionKey: string): Array<{ role: 'user' | 'assistant'; text: string; actor?: string }> {
    const key = (sessionKey || '').trim() || 'default'
    const entry = this.sessions.get(key)
    if (!entry) return []
    entry.lastAccessed = Date.now()
    return entry.memory.getRecentDialogues()
  }

  /**
   * 获取指定会话全部轮次
   */
  getAllTurns(sessionKey: string): DialogueTurn[] {
    const key = (sessionKey || '').trim() || 'default'
    const entry = this.sessions.get(key)
    return entry ? entry.memory.getAllTurns() : []
  }

  /**
   * 获取指定会话当前 Token 估算值
   */
  getTotalTokens(sessionKey: string): number {
    const key = (sessionKey || '').trim() || 'default'
    const entry = this.sessions.get(key)
    return entry ? entry.memory.getTotalTokens() : 0
  }

  /**
   * 获取当前活跃会话数量
   */
  getSessionCount(): number {
    return this.sessions.size
  }

  /**
   * 监听指定会话的溢出淘汰事件
   */
  onSessionEvict(sessionKey: string, listener: EvictListener): this {
    const key = (sessionKey || '').trim() || 'default'
    return this.on(`evict:${key}`, listener)
  }

  /**
   * 清空指定会话或全部会话
   */
  clear(sessionKey?: string): void {
    if (sessionKey !== undefined && sessionKey !== null) {
      const key = (sessionKey || '').trim() || 'default'
      const entry = this.sessions.get(key)
      if (entry) entry.memory.clear()
    } else {
      this.sessions.clear()
    }
  }

  /**
   * LRU 驱逐策略：优先驱逐超时的会话；若未超时，驱逐最久未访问的非主机群聊会话
   */
  private evictOldestSession(): void {
    const now = Date.now()
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of this.sessions.entries()) {
      // 永久保护主机控制台和主机私聊会话
      if (key === 'console:host' || key === 'private:host') continue

      // 超过 TTL 直接驱逐
      if (now - entry.lastAccessed > this.sessionTtlMs) {
        this.sessions.delete(key)
        this.emit('session_evict', key)
        return
      }

      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed
        oldestKey = key
      }
    }

    if (oldestKey) {
      this.sessions.delete(oldestKey)
      this.emit('session_evict', oldestKey)
    }
  }
}

