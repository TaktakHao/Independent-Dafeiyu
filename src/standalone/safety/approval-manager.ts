/**
 * @file approval-manager.ts
 * Milestone M2: 权限审批管理器状态机、短码循环生成、每用户双重限流与 SQLite 审计持久化
 *
 * 核心技术标准：
 * 1. 严格单向状态机：pending -> approved | rejected | expired
 * 2. 循环短码系统：#A101 ~ #A999 游标递增，活跃冲突检测与自动绕回
 * 3. 5 分钟 TTL 闭环：基于 unref() 定时器与 cleanupExpiredRequests 批量兜底
 * 4. 防刷轰炸双重限流：单用户全局最多 1 条挂起中单据 + 60 秒严格创建冷却
 * 5. 进程自愈与持久化：冷启动自动载入存活单据并补全剩余定时器，过期单据批量沉淀
 * 6. 完备事件广播：approval_created / request_created, approval_resolved / request_approved / request_rejected, approval_expired / request_expired
 */

import { EventEmitter } from 'node:events'
import type { DatabaseSync, StatementSync } from 'node:sqlite'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export type ApprovalChannel = 'group' | 'private'
export type ApprovalAction = 'approve' | 'reject'

export interface ApprovalRequest {
  id: string
  code: string // 例如 '#A101'
  senderId: string // 例如 'qq:12345678'
  senderExternalId: string // 纯数字 QQ 号
  senderName: string // 例如 '小王'
  channel: ApprovalChannel // 'group' | 'private'
  groupId?: string // 群聊来源群号
  intent: any // 意图动作或 TaskIntent
  intentLabel: string // 人类可读动作摘要，例如 '查看电脑状态'
  params: Record<string, any> // 序列化动作参数
  rawText: string // 原始输入消息
  status: ApprovalStatus
  createdAt: number
  expiresAt: number
  resolvedAt?: number
  resolvedBy?: string // 'owner:123456' | 'console' | 'system_timeout'
  resultSummary?: string
  success?: boolean
  request?: ApprovalRequest
}

export interface CreateApprovalOptions {
  senderId?: string
  userId?: string
  senderName?: string
  nickname?: string
  channel?: ApprovalChannel
  groupId?: string
  intent: any
  intentLabel?: string
  params?: Record<string, any>
  rawText: string
  ttlMs?: number // 默认 300_000 (5 分钟)
}

export interface ApprovalError {
  success: false
  error: string
  reason: string
  message: string
}

export type CreateApprovalResult = (ApprovalRequest & { success: true; request: ApprovalRequest }) | ApprovalError

export interface ResolveApprovalResult {
  success: boolean
  request?: ApprovalRequest
  error?: string
  message: string
}

export interface ApprovalManagerOptions {
  ttlMs?: number // 默认 300_000 毫秒 (5 分钟)
  cooldownMs?: number // 默认 60_000 毫秒 (60 秒)
}

export class ApprovalManager extends EventEmitter {
  private db?: DatabaseSync
  private ttlMs: number
  private cooldownMs: number

  // 内存状态池
  private pendingRequests: Map<string, ApprovalRequest> = new Map() // code -> req
  private idToCodeMap: Map<string, string> = new Map() // id -> code
  private userPendingMap: Map<string, string> = new Map() // senderExternalId -> code
  private userCooldowns: Map<string, number> = new Map() // senderExternalId -> lastCreatedTimestamp
  private timers: Map<string, NodeJS.Timeout> = new Map() // code -> timer

  // 短码游标 (#A101 ~ #A999)
  private codeCursor: number = 101

  // 预编译 SQLite 语句缓存
  private stmtInsert?: StatementSync
  private stmtResolve?: StatementSync
  private stmtExpireBatch?: StatementSync
  private stmtFindByCode?: StatementSync
  private stmtFindById?: StatementSync
  private stmtFindAllPending?: StatementSync
  private stmtFindLatestByUser?: StatementSync

  constructor(db?: DatabaseSync, options: ApprovalManagerOptions = {}) {
    super()
    this.db = db
    this.ttlMs = options.ttlMs ?? 300_000 // 默认 5 分钟
    this.cooldownMs = options.cooldownMs ?? 60_000 // 默认 60 秒

    if (this.db) {
      this.initStatements()
      this.recoverFromDatabase()
    }
  }

  /**
   * 初始化预编译 SQLite 语句
   */
  private initStatements(): void {
    if (!this.db) return

    try {
      this.stmtInsert = this.db.prepare(`
        INSERT INTO approval_requests (
          id, code, sender_id, sender_name, channel, group_id,
          intent, intent_label, params, raw_text, status,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `)

      this.stmtResolve = this.db.prepare(`
        UPDATE approval_requests
        SET status = ?, resolved_at = ?, resolved_by = ?, result_summary = ?
        WHERE id = ?
      `)

      this.stmtExpireBatch = this.db.prepare(`
        UPDATE approval_requests
        SET status = 'expired', resolved_at = ?, resolved_by = 'system_timeout'
        WHERE status = 'pending' AND expires_at <= ?
      `)

      this.stmtFindByCode = this.db.prepare(`
        SELECT * FROM approval_requests WHERE code = ? ORDER BY created_at DESC LIMIT 1
      `)

      this.stmtFindById = this.db.prepare(`
        SELECT * FROM approval_requests WHERE id = ? LIMIT 1
      `)

      this.stmtFindAllPending = this.db.prepare(`
        SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at ASC
      `)

      this.stmtFindLatestByUser = this.db.prepare(`
        SELECT created_at FROM approval_requests WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1
      `)
    } catch (err) {
      console.warn('[ApprovalManager] 初始化 SQLite 预编译语句失败:', err)
    }
  }

  /**
   * 冷启动时从数据库恢复未完成的审批单，并清理已过期单据
   */
  private recoverFromDatabase(): void {
    if (!this.db || !this.stmtFindAllPending) return

    const now = Date.now()
    // 1. 先批量标记数据库中已超时的单据
    if (this.stmtExpireBatch) {
      try {
        this.stmtExpireBatch.run(now, now)
      } catch {}
    }

    // 2. 加载剩余仍然有效的 pending 单据到内存
    try {
      const rows = this.stmtFindAllPending.all() as any[]
      for (const row of rows) {
        const req = this.rowToRequest(row)
        if (req.expiresAt <= now) {
          continue
        }

        this.pendingRequests.set(req.code, req)
        this.idToCodeMap.set(req.id, req.code)
        this.userPendingMap.set(req.senderExternalId, req.code)

        // 重新调度剩余时间的超时定时器
        const remainingMs = Math.max(100, req.expiresAt - now)
        this.scheduleTimer(req.code, remainingMs)
      }
    } catch (err) {
      console.warn('[ApprovalManager] 从数据库恢复 pending 单据失败:', err)
    }
  }

  /**
   * 循环生成下一个短单号 (#A101 - #A999)
   */
  private generateNextCode(): string | null {
    let attempts = 0
    while (attempts < 899) {
      const code = `#A${this.codeCursor}`
      this.codeCursor = this.codeCursor >= 999 ? 101 : this.codeCursor + 1

      // 检查当前是否有挂起冲突
      if (!this.pendingRequests.has(code)) {
        return code
      }
      attempts++
    }

    // 若占满，先主动清理一次超时单据
    const cleaned = this.cleanupExpiredRequests()
    if (cleaned > 0) {
      return this.generateNextCode()
    }

    return null
  }

  /**
   * 标准化单号格式 (去除空格、统一大写、补齐 # 前缀)
   */
  public normalizeCode(raw: string): string {
    const trimmed = (raw || '').trim().toUpperCase()
    if (!trimmed) return ''
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  }

  /**
   * 生成人类可读的操作摘要
   */
  public humanReadableLabel(intent: any): string {
    if (!intent) return '未知操作'
    const subAction = intent.subAction || ''
    const target = intent.queryOrTarget || ''

    if (subAction === 'system_status') return '查看电脑状态'
    if (subAction === 'volume') return '调节电脑音量'
    if (subAction === 'list_files') return '查看电脑文件'
    if (subAction === 'open_app') return `打开应用: ${target}`
    if (subAction === 'open_url') return `打开网页: ${target}`
    if (intent.category === 'antigravity') return `执行代码任务: ${String(target).slice(0, 16)}`
    return `${intent.category || 'action'}:${subAction || target}`
  }

  /**
   * 创建新的审批请求 (带防刷频控校验与单人并发限制)
   */
  public createRequest(options: CreateApprovalOptions): CreateApprovalResult {
    const rawSender = (options.senderId || options.userId || '').trim()
    if (!rawSender) {
      return {
        success: false,
        error: 'INVALID_SENDER',
        reason: '发起人身份不能为空',
        message: '发起人身份不能为空',
      }
    }

    const cleanExternalId = rawSender.replace(/^qq:/i, '').trim()
    const senderId = `qq:${cleanExternalId}`
    const senderName = options.senderName || options.nickname || cleanExternalId || '群友'
    const now = Date.now()

    // 1. 单人并发限制：同一用户只能存在 1 条 pending 审批单
    const existingCode = this.userPendingMap.get(cleanExternalId)
    if (existingCode && this.pendingRequests.has(existingCode)) {
      const reason = `你已经有一个待审批请求（单号 ${existingCode}）正在等老爸批复啦，请耐心等待哦~`
      return {
        success: false,
        error: 'DUPLICATE_PENDING',
        reason,
        message: reason,
      }
    }

    // 2. 60 秒冷却限流校验
    let lastCreated = this.userCooldowns.get(cleanExternalId)
    if (!lastCreated && this.stmtFindLatestByUser) {
      try {
        const row = this.stmtFindLatestByUser.get(senderId) as { created_at?: number } | undefined
        if (row?.created_at) lastCreated = row.created_at
      } catch {}
    }

    if (lastCreated && now - lastCreated < this.cooldownMs) {
      const remainSec = Math.ceil((this.cooldownMs - (now - lastCreated)) / 1000)
      const reason = `请求太频繁啦！请稍等 ${remainSec} 秒再向老爸申请操作哦~`
      return {
        success: false,
        error: 'RATE_LIMITED',
        reason,
        message: reason,
      }
    }

    // 3. 生成循环短单号
    const code = this.generateNextCode()
    if (!code) {
      const reason = '当前待审批单据已达上限，请稍候再试~'
      return {
        success: false,
        error: 'APPROVAL_POOL_EXHAUSTED',
        reason,
        message: reason,
      }
    }

    const ttl = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : this.ttlMs
    const expiresAt = now + ttl
    const randSuffix = Math.random().toString(36).slice(2, 8)
    const id = `req_${now}_${code.replace('#', '')}_${randSuffix}`
    const intentLabel = options.intentLabel || this.humanReadableLabel(options.intent)

    const req: ApprovalRequest = {
      id,
      code,
      senderId,
      senderExternalId: cleanExternalId,
      senderName,
      channel: options.channel || 'group',
      groupId: options.groupId,
      intent: options.intent,
      intentLabel,
      params: options.params || {},
      rawText: options.rawText || '',
      status: 'pending',
      createdAt: now,
      expiresAt,
    }

    // 挂载双重返回值兼容 (设置 request 为不可枚举属性，防止 JSON.stringify 循环引用报错)
    req.success = true
    Object.defineProperty(req, 'request', {
      value: req,
      enumerable: false,
      configurable: true,
      writable: true,
    })

    // 4. 更新内存索引
    this.pendingRequests.set(code, req)
    this.idToCodeMap.set(id, code)
    this.userPendingMap.set(cleanExternalId, code)
    this.userCooldowns.set(cleanExternalId, now)

    // 5. 调度 5 分钟超时定时器 (unref 避免阻塞退出)
    this.scheduleTimer(code, ttl)

    // 6. 持久化至 SQLite (无损序列化完整 intent 对象，保证冷启动恢复后 queryOrTarget 等参数 100% 完好)
    if (this.stmtInsert) {
      try {
        const serializedIntent = typeof req.intent === 'object' && req.intent !== null
          ? JSON.stringify(req.intent)
          : String(req.intent)
        this.stmtInsert.run(
          req.id,
          req.code,
          req.senderId,
          req.senderName,
          req.channel,
          req.groupId ?? null,
          serializedIntent,
          req.intentLabel,
          JSON.stringify(req.params),
          req.rawText,
          req.createdAt,
          req.expiresAt
        )
      } catch (err) {
        console.warn('[ApprovalManager] 写入 approval_requests 失败:', err)
      }
    }

    // 7. 广播事件
    this.emit('approval_created', req)
    this.emit('request_created', req)

    return req as (ApprovalRequest & { success: true; request: ApprovalRequest })
  }

  /**
   * 审批处理 (批准或驳回)
   */
  public resolveRequest(
    codeOrId: string,
    action: ApprovalAction,
    resolvedBy: string
  ): ResolveApprovalResult {
    const rawInput = (codeOrId || '').trim()
    if (!rawInput) {
      return { success: false, error: '审批单号或 ID 不能为空', message: '审批单号或 ID 不能为空' }
    }

    // 统一通过 code 查找活跃请求
    let code = this.normalizeCode(rawInput)
    let req = this.pendingRequests.get(code)

    if (!req) {
      // 尝试是否传入的是 id
      const mappedCode = this.idToCodeMap.get(rawInput)
      if (mappedCode) {
        code = mappedCode
        req = this.pendingRequests.get(code)
      }
    }

    const now = Date.now()

    // 若内存中未找到，检查数据库是否已过期或已处理
    if (!req) {
      if (this.db) {
        const dbReq = this.getRequestByCode(code) || (this.stmtFindById ? this.getRequestById(rawInput) : undefined)
        if (dbReq) {
          if (dbReq.status !== 'pending') {
            const msg = `单号 ${code} 已于早前处理完毕 (状态: ${dbReq.status})`
            return {
              success: false,
              request: dbReq,
              error: msg,
              message: msg,
            }
          }
          if (dbReq.expiresAt <= now) {
            const msg = `单号 ${code} 已超时过期`
            return { success: false, request: dbReq, error: msg, message: msg }
          }
        }
      }
      const msg = `单号 ${code} 不存在或已失效`
      return { success: false, error: msg, message: msg }
    }

    // 检查是否已超时
    if (now >= req.expiresAt) {
      this.handleExpire(code)
      const msg = `单号 ${code} 已超时失效`
      return { success: false, request: req, error: msg, message: msg }
    }

    // 状态单向流转
    this.clearTimer(code)
    req.status = action === 'approve' ? 'approved' : 'rejected'
    req.resolvedAt = now
    req.resolvedBy = resolvedBy

    // 移出活跃集合
    this.pendingRequests.delete(code)
    this.idToCodeMap.delete(req.id)
    if (this.userPendingMap.get(req.senderExternalId) === code) {
      this.userPendingMap.delete(req.senderExternalId)
    }

    // 持久化更新
    if (this.stmtResolve) {
      try {
        this.stmtResolve.run(req.status, req.resolvedAt, req.resolvedBy, req.resultSummary ?? null, req.id)
      } catch (err) {
        console.warn('[ApprovalManager] 更新 approval_requests 状态失败:', err)
      }
    }

    // 广播事件
    this.emit('approval_resolved', req, action, resolvedBy)
    if (action === 'approve') {
      this.emit('request_approved', req)
    } else {
      this.emit('request_rejected', req)
    }

    const successMsg = `已成功${action === 'approve' ? '批准' : '驳回'}单号 ${code}`
    return { success: true, request: req, message: successMsg }
  }

  /**
   * 异步批准请求快捷方法
   */
  public async approve(
    codeOrId: string,
    handledBy: string = 'owner_qq'
  ): Promise<{ success: boolean; request?: ApprovalRequest; message: string }> {
    const res = this.resolveRequest(codeOrId, 'approve', handledBy)
    return {
      success: res.success,
      request: res.request,
      message: res.message || res.error || '',
    }
  }

  /**
   * 异步驳回请求快捷方法
   */
  public async reject(
    codeOrId: string,
    handledBy: string = 'owner_qq'
  ): Promise<{ success: boolean; request?: ApprovalRequest; message: string }> {
    const res = this.resolveRequest(codeOrId, 'reject', handledBy)
    return {
      success: res.success,
      request: res.request,
      message: res.message || res.error || '',
    }
  }

  /**
   * 根据单号获取请求详情 (优先内存，穿透 SQLite)
   */
  public getRequestByCode(code: string): ApprovalRequest | undefined {
    const normalized = this.normalizeCode(code)
    if (!normalized) return undefined

    const inMemory = this.pendingRequests.get(normalized)
    if (inMemory) return inMemory

    if (this.stmtFindByCode) {
      try {
        const row = this.stmtFindByCode.get(normalized) as any
        if (row) return this.rowToRequest(row)
      } catch {}
    }

    return undefined
  }

  /**
   * 根据单号获取待审批请求 (兼容别名)
   */
  public getPendingByCode(code: string): ApprovalRequest | undefined {
    return this.getRequestByCode(code)
  }

  /**
   * 根据唯一 ID 获取请求详情
   */
  public getRequestById(id: string): ApprovalRequest | undefined {
    const code = this.idToCodeMap.get(id)
    if (code) {
      const inMemory = this.pendingRequests.get(code)
      if (inMemory) return inMemory
    }

    if (this.stmtFindById) {
      try {
        const row = this.stmtFindById.get(id) as any
        if (row) return this.rowToRequest(row)
      } catch {}
    }

    return undefined
  }

  /**
   * 获取所有当前处于 pending 状态的请求列表
   */
  public listPendingRequests(): ApprovalRequest[] {
    this.cleanupExpiredRequests()
    return Array.from(this.pendingRequests.values()).sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt
      }
      return a.code.localeCompare(b.code)
    })
  }

  /**
   * 获取所有当前处于 pending 状态的请求列表 (兼容别名)
   */
  public getPendingList(): ApprovalRequest[] {
    return this.listPendingRequests()
  }

  /**
   * 获取近期已处理/已过期的审批审计记录列表 (供 Web 控制台审计流展示)
   */
  public listRecentHistory(limit: number = 30): ApprovalRequest[] {
    this.cleanupExpiredRequests()
    if (!this.db) return []
    try {
      const rows = this.db.prepare(`
        SELECT * FROM approval_requests
        WHERE status != 'pending'
        ORDER BY COALESCE(resolved_at, created_at) DESC
        LIMIT ?
      `).all(Math.max(1, limit)) as any[]
      return rows.map((r) => this.rowToRequest(r))
    } catch {
      return []
    }
  }

  /**
   * 获取最新一条 pending 请求 (用于主人省略单号秒批)
   */
  public getLatestPending(): ApprovalRequest | undefined {
    const list = this.listPendingRequests()
    if (list.length === 0) return undefined
    return list.sort((a, b) => {
      if (b.createdAt !== a.createdAt) {
        return b.createdAt - a.createdAt
      }
      return b.code.localeCompare(a.code)
    })[0]
  }

  /**
   * 主动扫描并清理所有已超时的待审批请求，返回清理数量
   */
  public cleanupExpiredRequests(): number {
    const now = Date.now()
    let cleanedCount = 0

    // 1. 扫描内存中的过期请求
    for (const [code, req] of Array.from(this.pendingRequests.entries())) {
      if (now >= req.expiresAt) {
        this.handleExpire(code)
        cleanedCount++
      }
    }

    // 2. 数据库批量标记
    if (this.stmtExpireBatch) {
      try {
        this.stmtExpireBatch.run(now, now)
      } catch {}
    }

    return cleanedCount
  }

  /**
   * 单个请求超时处理
   */
  private handleExpire(code: string): void {
    const req = this.pendingRequests.get(code)
    if (!req || req.status !== 'pending') return

    const now = Date.now()
    this.clearTimer(code)

    req.status = 'expired'
    req.resolvedAt = now
    req.resolvedBy = 'system_timeout'

    this.pendingRequests.delete(code)
    this.idToCodeMap.delete(req.id)
    if (this.userPendingMap.get(req.senderExternalId) === code) {
      this.userPendingMap.delete(req.senderExternalId)
    }

    if (this.stmtResolve) {
      try {
        this.stmtResolve.run('expired', now, 'system_timeout', null, req.id)
      } catch {}
    }

    this.emit('approval_expired', req)
    this.emit('request_expired', req)
  }

  /**
   * 注册单据定时器 (必须 unref)
   */
  private scheduleTimer(code: string, delayMs: number): void {
    this.clearTimer(code)
    const timer = setTimeout(() => {
      this.handleExpire(code)
    }, delayMs)
    timer.unref() // 防止阻止 Node.js 进程退出
    this.timers.set(code, timer)
  }

  /**
   * 安全清理单据定时器
   */
  private clearTimer(code: string): void {
    const timer = this.timers.get(code)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(code)
    }
  }

  /**
   * 彻底销毁管理器实例，清空所有活跃定时器
   */
  public destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.pendingRequests.clear()
    this.idToCodeMap.clear()
    this.userPendingMap.clear()
    this.userCooldowns.clear()
    this.removeAllListeners()
  }

  /**
   * SQLite 数据库行转换为 ApprovalRequest 实体
   */
  private rowToRequest(row: any): ApprovalRequest {
    let parsedParams: Record<string, any> = {}
    try {
      parsedParams = typeof row.params === 'string' ? JSON.parse(row.params) : (row.params || {})
    } catch {
      parsedParams = {}
    }

    let parsedIntent: any = row.intent
    if (typeof row.intent === 'string' && row.intent.trim().startsWith('{')) {
      try {
        parsedIntent = JSON.parse(row.intent)
      } catch {
        parsedIntent = row.intent
      }
    }

    const cleanExternalId = String(row.sender_id || '').replace(/^qq:/i, '').trim()

    return {
      id: row.id,
      code: row.code,
      senderId: row.sender_id,
      senderExternalId: cleanExternalId,
      senderName: row.sender_name,
      channel: row.channel as ApprovalChannel,
      groupId: row.group_id ?? undefined,
      intent: parsedIntent,
      intentLabel: row.intent_label,
      params: parsedParams,
      rawText: row.raw_text,
      status: row.status as ApprovalStatus,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
      resultSummary: row.result_summary ?? undefined,
    }
  }
}
