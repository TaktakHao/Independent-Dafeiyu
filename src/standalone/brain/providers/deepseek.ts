/**
 * @file deepseek.ts
 * Tier 2: DeepSeek Chat API SSE 流式客户端与 5.0 元每日预算限额守卫
 */

import fs from 'node:fs'
import path from 'node:path'
import type {
  BrainProvider,
  BrainRequest,
  BrainResult,
  BrainOutput,
  BrainTier,
  LayeredPrompt,
  ProviderStatusInfo,
} from '../types.ts'
import { normalizeReplyIntent, parseStreamingMeta } from '../streaming.ts'

export interface DeepSeekConfig {
  id?: string
  name?: string
  apiKey?: string
  endpoint?: string
  baseUrl?: string
  model?: string
  dailyBudgetCny?: number
  dailyBudgetLimit?: number
  budgetStorePath?: string
  timeoutMs?: number
  enabled?: boolean
}

export interface DeepSeekBalanceInfo {
  status: 'ready' | 'not-configured' | 'auth-error' | 'error'
  available: boolean
  totalBalance: number
  grantedBalance: number
  toppedUpBalance: number
  currency: string
  checkedAt: number
  error?: string
  summary: string
}

interface BudgetSnapshot {
  date: string
  totalCostCny: number
  promptHitTokens: number
  promptMissTokens: number
  completionTokens: number
  callCount: number
  isTripped: boolean
  lastResetAt: number
}

/**
 * 每日预算限额守卫 (5.0 CNY 熔断防护，支持东八区跨天自动重置与持久化)
 */
export class DailyBudgetGuard {
  private dailyBudgetCny: number
  private storePath?: string
  private snapshot: BudgetSnapshot

  // 定价模型 (元 / Token)
  private readonly CACHE_HIT_PRICE = 0.0000005    // ¥0.50 / 1M tokens
  private readonly CACHE_MISS_PRICE = 0.000002    // ¥2.00 / 1M tokens
  private readonly COMPLETION_PRICE = 0.000008    // ¥8.00 / 1M tokens

  constructor(dailyBudgetCny = 5.0, storePath?: string) {
    this.dailyBudgetCny = dailyBudgetCny
    this.storePath = storePath

    const today = this.getTodayDateString()
    this.snapshot = {
      date: today,
      totalCostCny: 0,
      promptHitTokens: 0,
      promptMissTokens: 0,
      completionTokens: 0,
      callCount: 0,
      isTripped: false,
      lastResetAt: Date.now(),
    }

    this.load()
    this.checkMidnightRollover()
  }

  private getTodayDateString(): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .replace(/\//g, '-')
  }

  private load(): void {
    if (!this.storePath) return
    try {
      const fullPath = path.resolve(process.cwd(), this.storePath)
      if (fs.existsSync(fullPath)) {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
        if (data && typeof data.totalCostCny === 'number') {
          this.snapshot = data
        }
      }
    } catch (_) {}
  }

  private persist(): void {
    if (!this.storePath) return
    try {
      const fullPath = path.resolve(process.cwd(), this.storePath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, JSON.stringify(this.snapshot, null, 2), 'utf-8')
    } catch (_) {}
  }

  checkMidnightRollover(): void {
    const today = this.getTodayDateString()
    if (today !== this.snapshot.date) {
      this.snapshot = {
        date: today,
        totalCostCny: 0,
        promptHitTokens: 0,
        promptMissTokens: 0,
        completionTokens: 0,
        callCount: 0,
        isTripped: false,
        lastResetAt: Date.now(),
      }
      this.persist()
    }
  }

  getCost(): number {
    this.checkMidnightRollover()
    return this.snapshot.totalCostCny
  }

  getBudget(): number {
    return this.dailyBudgetCny
  }

  setBudget(budget: number): void {
    this.dailyBudgetCny = budget
    this.checkBudgetLimit()
  }

  addCost(cost: number): void {
    this.checkMidnightRollover()
    this.snapshot.totalCostCny += cost
    this.snapshot.callCount++
    this.checkBudgetLimit()
    this.persist()
  }

  recordUsage(hitTokens: number, missTokens: number, completionTokens: number): number {
    this.checkMidnightRollover()
    const callCost =
      hitTokens * this.CACHE_HIT_PRICE +
      missTokens * this.CACHE_MISS_PRICE +
      completionTokens * this.COMPLETION_PRICE

    this.snapshot.promptHitTokens += hitTokens
    this.snapshot.promptMissTokens += missTokens
    this.snapshot.completionTokens += completionTokens
    this.snapshot.totalCostCny += callCost
    this.snapshot.callCount++

    this.checkBudgetLimit()
    this.persist()
    return callCost
  }

  private checkBudgetLimit(): void {
    if (this.snapshot.totalCostCny >= this.dailyBudgetCny) {
      this.snapshot.isTripped = true
    } else {
      this.snapshot.isTripped = false
    }
  }

  isBudgetExceeded(): boolean {
    this.checkMidnightRollover()
    return this.snapshot.isTripped || this.snapshot.totalCostCny >= this.dailyBudgetCny
  }

  reset(): void {
    this.snapshot.totalCostCny = 0
    this.snapshot.isTripped = false
    this.snapshot.callCount = 0
    this.persist()
  }
}

/**
 * Tier 2: DeepSeek API 流式提供方
 */
export class DeepSeekProvider implements BrainProvider {
  readonly id: string
  readonly tier: BrainTier = 2
  readonly name: string

  private apiKey: string
  private endpoint: string
  private model: string
  private timeoutMs: number
  private enabled: boolean
  private isManuallyAvailable = true
  readonly budgetGuard: DailyBudgetGuard

  private totalInvocations = 0
  private successCount = 0
  private failureCount = 0
  private consecutiveFailures = 0
  private estimatedLatencyMs = 1200

  private cachedBalance: DeepSeekBalanceInfo = {
    status: 'not-configured',
    available: false,
    totalBalance: 0,
    grantedBalance: 0,
    toppedUpBalance: 0,
    currency: 'CNY',
    checkedAt: 0,
    summary: '未配置密钥',
  }

  constructor(config: DeepSeekConfig = {}) {
    this.id = config.id || 'deepseek_sse'
    this.name = config.name || 'DeepSeek Chat (SSE)'
    this.apiKey = (config.apiKey || process.env.DEEPSEEK_API_KEY || '').trim()
    this.endpoint = (
      config.endpoint ||
      config.baseUrl ||
      process.env.DEEPSEEK_ENDPOINT ||
      'https://api.deepseek.com'
    ).replace(/\/$/, '')
    this.model = config.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
    this.timeoutMs = config.timeoutMs ?? 10000
    this.enabled = config.enabled ?? true

    this.budgetGuard = new DailyBudgetGuard(
      config.dailyBudgetCny ?? config.dailyBudgetLimit ?? 5.0,
      config.budgetStorePath || 'runtime/data/brain-budget.json'
    )

    if (this.getMaskedApiKey()) {
      this.cachedBalance.status = 'ready'
      this.cachedBalance.summary = '密钥已配置 (点击刷新或测试获取实时余额)'
    }
  }

  private getEffectiveKey(): string {
    return (this.apiKey || process.env.DEEPSEEK_API_KEY || '').trim()
  }

  setApiKey(key: string): void {
    this.apiKey = key.trim()
    if (!this.apiKey) {
      this.cachedBalance = {
        status: 'not-configured',
        available: false,
        totalBalance: 0,
        grantedBalance: 0,
        toppedUpBalance: 0,
        currency: 'CNY',
        checkedAt: Date.now(),
        summary: '未配置密钥',
      }
    } else {
      this.fetchAccountBalance(true).catch(() => {})
    }
  }

  getMaskedApiKey(): string {
    const key = this.getEffectiveKey()
    if (!key || key === 'sk-dummy-key' || key === 'test-key' || key === 'mock-key') return ''
    if (key.length <= 8) return 'sk-******'
    return `${key.slice(0, 5)}...${key.slice(-4)}`
  }

  getCachedBalance(): DeepSeekBalanceInfo {
    const key = this.getEffectiveKey()
    if (!key || key === 'sk-dummy-key') {
      return {
        status: 'not-configured',
        available: false,
        totalBalance: 0,
        grantedBalance: 0,
        toppedUpBalance: 0,
        currency: 'CNY',
        checkedAt: this.cachedBalance.checkedAt,
        summary: '未配置密钥',
      }
    }
    return { ...this.cachedBalance }
  }

  /**
   * 实时请求 DeepSeek 官方 /user/balance 接口查询账户真实余额
   */
  async fetchAccountBalance(force = false): Promise<DeepSeekBalanceInfo> {
    const key = this.getEffectiveKey()
    if (!key || key === 'sk-dummy-key' || key === 'test-key' || key === 'mock-key') {
      this.cachedBalance = {
        status: 'not-configured',
        available: false,
        totalBalance: 0,
        grantedBalance: 0,
        toppedUpBalance: 0,
        currency: 'CNY',
        checkedAt: Date.now(),
        summary: '未配置 DeepSeek API Key',
      }
      return this.cachedBalance
    }

    const now = Date.now()
    if (!force && this.cachedBalance.checkedAt > 0 && now - this.cachedBalance.checkedAt < 30_000) {
      return this.cachedBalance
    }

    const base = this.endpoint.replace(/\/(?:v1|anthropic)\/?$/, '').replace(/\/$/, '')
    const url = `${base}/user/balance`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
        },
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (!res.ok) {
        const isAuth = res.status === 401 || res.status === 403
        const errMsg = isAuth
          ? `密钥无效或已过期 (HTTP ${res.status})`
          : `余额接口请求失败 (HTTP ${res.status})`
        this.cachedBalance = {
          status: isAuth ? 'auth-error' : 'error',
          available: false,
          totalBalance: 0,
          grantedBalance: 0,
          toppedUpBalance: 0,
          currency: 'CNY',
          checkedAt: now,
          error: errMsg,
          summary: errMsg,
        }
        return this.cachedBalance
      }

      const body: any = await res.json()
      const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
      const row = infos.find((r: any) => r.currency === 'CNY') || infos[0] || {}

      const total = Number(row.total_balance ?? 0) || 0
      const granted = Number(row.granted_balance ?? 0) || 0
      const toppedUp = Number(row.topped_up_balance ?? 0) || 0
      const currency = row.currency || 'CNY'
      const sym = currency === 'USD' ? '$' : '¥'
      const available = Boolean(body?.is_available ?? total > 0)

      this.cachedBalance = {
        status: 'ready',
        available,
        totalBalance: total,
        grantedBalance: granted,
        toppedUpBalance: toppedUp,
        currency,
        checkedAt: now,
        summary: `${sym}${total.toFixed(2)} (充值 ${sym}${toppedUp.toFixed(2)} · 赠送 ${sym}${granted.toFixed(2)})`,
      }
      return this.cachedBalance
    } catch (err: any) {
      clearTimeout(timer)
      const msg = err?.name === 'AbortError' ? '查询余额超时 (8s)' : (err?.message || '网络异常')
      this.cachedBalance = {
        ...this.cachedBalance,
        status: 'error',
        checkedAt: now,
        error: msg,
        summary: `查询失败: ${msg}`,
      }
      return this.cachedBalance
    }
  }

  /**
   * 主动测试 DeepSeek 连通性与余额
   */
  async testConnectivity(): Promise<{
    ok: boolean
    latencyMs: number
    balance: DeepSeekBalanceInfo
    replySample?: string
    error?: string
  }> {
    const start = Date.now()
    const key = this.getEffectiveKey()
    const balance = await this.fetchAccountBalance(true)

    if (!key || key === 'sk-dummy-key') {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        balance,
        error: '尚未配置 DeepSeek API Key，请先输入 sk-... 并保存',
      }
    }

    if (balance.status === 'auth-error') {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        balance,
        error: balance.error || 'API Key 鉴权失败 (401/403)',
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)

    try {
      const chatStart = Date.now()
      const res = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: '用一句话俏皮回答：大肥鱼DeepSeek算力连通成功！' }],
          stream: false,
          max_tokens: 32,
          temperature: 0.6,
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      const latencyMs = Date.now() - chatStart

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return {
          ok: false,
          latencyMs,
          balance,
          error: `HTTP ${res.status}: ${text.slice(0, 120) || res.statusText}`,
        }
      }

      const data: any = await res.json()
      const replySample = String(data?.choices?.[0]?.message?.content || '连通正常').trim()
      if (data?.usage) {
        const hit = data.usage.prompt_cache_hit_tokens ?? 0
        const miss = data.usage.prompt_cache_miss_tokens ?? (data.usage.prompt_tokens ?? 0)
        const comp = data.usage.completion_tokens ?? 0
        this.budgetGuard.recordUsage(hit, miss, comp)
      }
      this.successCount++
      this.consecutiveFailures = 0
      this.estimatedLatencyMs = Math.round(0.3 * latencyMs + 0.7 * this.estimatedLatencyMs)

      return {
        ok: true,
        latencyMs,
        balance,
        replySample,
      }
    } catch (err: any) {
      clearTimeout(timer)
      return {
        ok: false,
        latencyMs: Date.now() - start,
        balance,
        error: err?.message || '连接 DeepSeek API 失败',
      }
    }
  }

  isAvailable(): boolean {
    if (!this.enabled || !this.isManuallyAvailable) return false
    const key = this.getEffectiveKey()
    if (!key || key === 'sk-dummy-key') return false
    if (this.budgetGuard.isBudgetExceeded()) return false
    return true
  }

  setAvailable(available: boolean): void {
    this.isManuallyAvailable = available
    if (available && !this.apiKey) {
      this.apiKey = 'test-key'
    }
  }

  addCost(cost: number): void {
    this.budgetGuard.addCost(cost)
  }

  getEstimatedLatencyMs(): number {
    return Math.round(this.estimatedLatencyMs)
  }

  getStatus(): ProviderStatusInfo {
    const cost = this.budgetGuard.getCost()
    const budget = this.budgetGuard.getBudget()
    const isExceeded = this.budgetGuard.isBudgetExceeded()
    const masked = this.getMaskedApiKey()
    const bal = this.getCachedBalance()

    return {
      id: this.id,
      tier: this.tier,
      name: this.name,
      state: !this.isAvailable() && !masked ? 'DISABLED' : (isExceeded ? 'EXHAUSTED' : 'READY'),
      totalInvocations: this.totalInvocations,
      successCount: this.successCount,
      failureCount: this.failureCount,
      consecutiveFailures: this.consecutiveFailures,
      estimatedLatencyMs: this.getEstimatedLatencyMs(),
      p50LatencyMs: this.getEstimatedLatencyMs(),
      p90LatencyMs: Math.round(this.estimatedLatencyMs * 1.4),
      lastError: isExceeded
        ? `DeepSeek daily budget exceeded: ¥${cost.toFixed(2)} >= ¥${budget}`
        : bal.error,
      maskedApiKey: masked,
      todayCostCny: Number(cost.toFixed(4)),
      dailyBudgetCny: budget,
      balance: bal,
    } as any
  }

  /**
   * 将 Prompt 分解为前缀缓存友好的 messages 结构
   */
  private buildMessages(promptInput: string | LayeredPrompt): Array<{ role: 'system' | 'user'; content: string }> {
    if (typeof promptInput !== 'string') {
      return [
        { role: 'system', content: promptInput.layerA },
        { role: 'user', content: `${promptInput.layerB}\n\n${promptInput.layerC}` },
      ]
    }

    const text = promptInput
    if (text.includes('[Layer A]') && text.includes('[Layer B]') && text.includes('[Layer C]')) {
      const idxA = text.indexOf('[Layer A]')
      const idxB = text.indexOf('[Layer B]')
      const idxC = text.indexOf('[Layer C]')

      const layerA = text.slice(idxA, idxB).trim()
      const layerB = text.slice(idxB, idxC).trim()
      const layerC = text.slice(idxC).trim()

      return [
        { role: 'system', content: layerA },
        { role: 'user', content: `${layerB}\n\n${layerC}` },
      ]
    }

    // 默认回退
    return [
      { role: 'system', content: '你是大肥鱼桌面伴侣。' },
      { role: 'user', content: text },
    ]
  }

  /**
   * SSE 流式生成
   */
  async *thinkStream(request: BrainRequest, options?: { timeoutMs?: number; abortSignal?: AbortSignal }): AsyncIterable<string> {
    this.totalInvocations++

    if (!this.isManuallyAvailable) {
      throw new Error('DeepSeek API service unavailable')
    }

    if (this.budgetGuard.isBudgetExceeded()) {
      const cost = this.budgetGuard.getCost()
      const budget = this.budgetGuard.getBudget()
      throw new Error(`DeepSeek daily budget exceeded: ¥${cost.toFixed(2)} >= ¥${budget}`)
    }

    const messages = this.buildMessages(request.prompt)
    const timeout = options?.timeoutMs ?? request.deadlineMs ?? this.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', () => controller.abort())
    }

    try {
      const res = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey || process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0.7,
          max_tokens: request.maxOutputTokens ?? 150,
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        throw new Error(`DeepSeek API error ${res.status}: ${bodyText || res.statusText}`)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No readable stream from DeepSeek API')

      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const dataStr = trimmed.slice(5).trim()
          if (dataStr === '[DONE]') return

          try {
            const parsed = JSON.parse(dataStr)
            const delta = parsed.choices?.[0]?.delta?.content
            if (delta) yield delta

            // 提取 usage 统计
            if (parsed.usage) {
              const hit = parsed.usage.prompt_cache_hit_tokens ?? 0
              const miss = parsed.usage.prompt_cache_miss_tokens ?? (parsed.usage.prompt_tokens ?? 0)
              const completion = parsed.usage.completion_tokens ?? 0
              this.budgetGuard.recordUsage(hit, miss, completion)
            }
          } catch (_) {}
        }
      }
    } catch (err: any) {
      clearTimeout(timer)
      this.failureCount++
      this.consecutiveFailures++
      throw err
    }
  }

  /**
   * 完整思考返回 BrainResult
   */
  async think(request: BrainRequest, options?: { timeoutMs?: number; abortSignal?: AbortSignal }): Promise<BrainResult> {
    const startTime = Date.now()
    let fullText = ''

    for await (const chunk of this.thinkStream(request, options)) {
      fullText += chunk
    }

    const duration = Date.now() - startTime
    this.successCount++
    this.consecutiveFailures = 0
    this.estimatedLatencyMs = 0.25 * duration + 0.75 * this.estimatedLatencyMs

    // 严密解析并彻底剥离 <meta .../>
    let clip = 'talking_normal'
    let tone = 'happy'
    let moodIntent = 0
    let fed = false
    let memory: string | undefined
    let replyIntent: ReturnType<typeof normalizeReplyIntent> = { intent: 'chat' }

    const metaMatch = fullText.match(/<meta\s+([^>]+)\/?>/i)
    if (metaMatch) {
      const parsedMeta = parseStreamingMeta(metaMatch[0])
      if (parsedMeta) {
        clip = parsedMeta.clip || clip
        tone = parsedMeta.tone || tone
        moodIntent = parsedMeta.moodIntent ?? moodIntent
        fed = Boolean(parsedMeta.fed)
        memory = parsedMeta.memory
        replyIntent = normalizeReplyIntent(parsedMeta)
      }
    }

    // 从文本中彻底剔除 <meta .../> 标签
    let cleanReply = fullText.replace(/<meta\s+[^>]+\/?>\s*/gi, '').trim()

    // 剔除 <mem> 记忆持久化标签
    const memMatch = cleanReply.match(/<mem(?:\s+imp="(\d+)")?>([\s\S]*?)<\/mem>/i)
    if (memMatch) {
      if (!memory) memory = memMatch[2].trim()
      cleanReply = cleanReply.replace(/<mem(?:\s+imp="\d+")?>[\s\S]*?<\/mem>/gi, '').trim()
    }

    const fallbackReply = (clip === 'success' || clip === 'dance') ? '老爸，大功告成啦！✨' : '诶嘿，本鱼随时待命哦~ 🐟'
    const reply = cleanReply || fallbackReply

    const output: BrainOutput = {
      reply,
      text: reply,
      clip,
      tone,
      moodIntent,
      fed,
      memory,
      ...replyIntent,
    }

    return {
      tier: this.tier,
      provider: 'deepseek_sse',
      providerId: this.id,
      output,
      result: output,
      durationMs: duration,
      latencyMs: duration,
    }
  }
}
