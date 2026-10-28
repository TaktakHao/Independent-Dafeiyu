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
import { parseStreamingMeta } from '../streaming.ts'

export interface DeepSeekConfig {
  id?: string
  name?: string
  apiKey?: string
  endpoint?: string
  model?: string
  dailyBudgetCny?: number
  budgetStorePath?: string
  timeoutMs?: number
  enabled?: boolean
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

  constructor(config: DeepSeekConfig = {}) {
    this.id = config.id || 'deepseek_sse'
    this.name = config.name || 'DeepSeek Chat (SSE)'
    this.apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY || ''
    this.endpoint = (config.endpoint || process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com').replace(/\/$/, '')
    this.model = config.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
    this.timeoutMs = config.timeoutMs ?? 10000
    this.enabled = config.enabled ?? true

    this.budgetGuard = new DailyBudgetGuard(
      config.dailyBudgetCny ?? 5.0,
      config.budgetStorePath || 'runtime/data/brain-budget.json'
    )
  }

  isAvailable(): boolean {
    if (!this.enabled || !this.isManuallyAvailable) return false
    if (!this.apiKey && !process.env.DEEPSEEK_API_KEY) return false
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

    return {
      id: this.id,
      tier: this.tier,
      name: this.name,
      state: isExceeded ? 'EXHAUSTED' : 'READY',
      totalInvocations: this.totalInvocations,
      successCount: this.successCount,
      failureCount: this.failureCount,
      consecutiveFailures: this.consecutiveFailures,
      estimatedLatencyMs: this.getEstimatedLatencyMs(),
      p50LatencyMs: this.getEstimatedLatencyMs(),
      p90LatencyMs: Math.round(this.estimatedLatencyMs * 1.4),
      lastError: isExceeded ? `DeepSeek daily budget exceeded: ¥${cost.toFixed(2)} >= ¥${budget}` : undefined,
    }
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

    // 解析流式首行 <meta .../>
    let clip = 'talking_normal'
    let tone = 'happy'
    let moodIntent = 0
    let fed = false
    let memory: string | undefined
    let reply = fullText.trim()

    const firstNewline = fullText.indexOf('\n')
    if (firstNewline !== -1) {
      const firstLine = fullText.slice(0, firstNewline).trim()
      const parsedMeta = parseStreamingMeta(firstLine)
      if (parsedMeta) {
        clip = parsedMeta.clip || clip
        tone = parsedMeta.tone || tone
        moodIntent = parsedMeta.moodIntent ?? moodIntent
        fed = Boolean(parsedMeta.fed)
        memory = parsedMeta.memory
        reply = fullText.slice(firstNewline + 1).trim()
      }
    }

    const output: BrainOutput = {
      reply,
      text: reply,
      clip,
      tone,
      moodIntent,
      fed,
      memory,
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
