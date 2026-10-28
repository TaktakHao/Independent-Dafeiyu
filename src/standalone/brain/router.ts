/**
 * @file router.ts
 * 延迟预算分级大脑路由器 (TieredBrainRouter)
 * 支持多级优先级级联降级、EWMA 延迟感知、2.5s 对冲并发与思考动作/语气词掩盖
 */

import { EventEmitter } from 'node:events'
import type {
  BrainEventType,
  BrainProvider,
  BrainRequest,
  BrainResult,
  BrainTier,
} from './types.ts'
import { AgentCliProvider } from './cli-pool.ts'
import { DeepSeekProvider } from './providers/deepseek.ts'
import { LocalLlmProvider } from './providers/local-llm.ts'
import { RuleFallbackProvider } from './providers/rule-fallback.ts'

export const DEFAULT_LATENCY_BUDGETS: Record<string, number> = {
  GIFT_THANKS_LARGE: 2500,
  DANMAKU: 4000,
  HOST_COMMAND: 8000,
  COMPANION_CHAT: 15000,
  PROACTIVE_SPEECH: 20000,
  SCHEDULED_TASK: 30000,
}

export const THINKING_FILLERS = [
  '让我想想呢…',
  '唔，这个嘛…',
  '稍微等我一下下哦~',
  '哼，让本鱼琢磨一下！',
]

export interface RouterOptions {
  providers?: BrainProvider[]
  cliPool?: any
  deepSeekProvider?: DeepSeekProvider
  localLlmProvider?: LocalLlmProvider
  ruleFallbackProvider?: RuleFallbackProvider
  scheduler?: any
  latencyBudgets?: Record<string, number>
  hedgeAfterMs?: number
  deepSeekDailyBudget?: number
}

/**
 * 分级大脑路由器核心实现
 */
export class TieredBrainRouter extends EventEmitter {
  private providers: BrainProvider[] = []
  private latencyBudgets: Record<string, number>
  private hedgeAfterMs: number
  private scheduler?: any

  // 内部标准提供方引用
  public cliProvider?: BrainProvider
  public deepSeekProvider?: DeepSeekProvider
  public localLlmProvider?: LocalLlmProvider
  public ruleFallbackProvider?: RuleFallbackProvider

  constructor(options: BrainProvider[] | RouterOptions = {}) {
    super()

    let opts: RouterOptions = {}
    if (Array.isArray(options)) {
      opts = { providers: options }
    } else {
      opts = options
    }

    this.latencyBudgets = { ...DEFAULT_LATENCY_BUDGETS, ...(opts.latencyBudgets || {}) }
    this.hedgeAfterMs = opts.hedgeAfterMs ?? 2500
    this.scheduler = opts.scheduler

    if (opts.providers && opts.providers.length > 0) {
      this.providers = [...opts.providers]
      this.cliProvider = this.providers.find((p) => p.tier === 1)
      this.deepSeekProvider = this.providers.find((p) => p.tier === 2) as DeepSeekProvider
      this.localLlmProvider = this.providers.find((p) => p.tier === 3) as LocalLlmProvider
      this.ruleFallbackProvider = this.providers.find((p) => p.tier === 4) as RuleFallbackProvider
    } else {
      // 默认初始化 4 级提供方
      if (opts.cliPool) {
        // 兼容传入的 cliPool (如 AgentCliSandboxMock 或真实 AgentCliProvider)
        this.cliProvider = opts.cliPool.think
          ? opts.cliPool
          : {
              id: 'agent_cli',
              tier: 1 as BrainTier,
              name: 'Agent CLI',
              isAvailable: () => opts.cliPool.isAvailable(),
              getEstimatedLatencyMs: () => 1500,
              getStatus: () => ({
                id: 'agent_cli',
                tier: 1 as BrainTier,
                name: 'Agent CLI',
                state: opts.cliPool.isAvailable() ? 'READY' : 'EXHAUSTED',
                totalInvocations: 0,
                successCount: 0,
                failureCount: 0,
                consecutiveFailures: 0,
                estimatedLatencyMs: 1500,
                p50LatencyMs: 1500,
                p90LatencyMs: 2000,
              }),
              think: async (req: BrainRequest, o?: any) => {
                const promptText = typeof req.prompt === 'string' ? req.prompt : req.prompt.fullText
                const res = await opts.cliPool.execute(promptText, '/tmp/sandbox', o)
                return {
                  tier: 1 as BrainTier,
                  provider: 'agent_cli',
                  providerId: 'agent_cli',
                  output: { reply: res.text || res.reply, text: res.text || res.reply, ...res },
                  result: { reply: res.text || res.reply, text: res.text || res.reply, ...res },
                  durationMs: 100,
                  latencyMs: 100,
                }
              },
            }
      } else {
        this.cliProvider = new AgentCliProvider({ id: 'agent_cli' })
      }

      this.deepSeekProvider =
        opts.deepSeekProvider ||
        new DeepSeekProvider({ dailyBudgetCny: opts.deepSeekDailyBudget ?? 5.0 })

      this.localLlmProvider = opts.localLlmProvider || new LocalLlmProvider()
      this.ruleFallbackProvider = opts.ruleFallbackProvider || new RuleFallbackProvider()

      this.providers = [
        this.cliProvider,
        this.deepSeekProvider,
        this.localLlmProvider,
        this.ruleFallbackProvider,
      ]
    }

    // 按 Tier 严格升序排序: Tier 1 -> Tier 2 -> Tier 3 -> Tier 4
    this.providers.sort((a, b) => a.tier - b.tier)
  }

  // 快捷配置方法
  setDeepSeekAvailable(available: boolean): void {
    if (this.deepSeekProvider) {
      this.deepSeekProvider.setAvailable(available)
    }
  }

  setLocalLlmAvailable(available: boolean): void {
    if (this.localLlmProvider) {
      this.localLlmProvider.setAvailable(available)
    }
  }

  addDeepSeekCost(cost: number): void {
    if (this.deepSeekProvider) {
      this.deepSeekProvider.addCost(cost)
    }
  }

  async *streamDeepSeek(prompt: string, options: any = {}): AsyncIterable<string> {
    if (!this.deepSeekProvider) {
      throw new Error('DeepSeek provider not configured')
    }
    const req: BrainRequest = {
      prompt,
      eventType: 'DANMAKU',
      mode: 'companion',
    }
    yield* this.deepSeekProvider.thinkStream(req, options)
  }

  /**
   * 路由仲裁入口
   */
  async route(
    promptOrRequest: string | BrainRequest,
    context: { latencyBudgetMs?: number; mode?: 'companion' | 'live' } = {}
  ): Promise<BrainResult> {
    const request: BrainRequest =
      typeof promptOrRequest === 'string'
        ? {
            prompt: promptOrRequest,
            eventType: 'DANMAKU',
            mode: context.mode || 'companion',
          }
        : promptOrRequest

    const eventType = request.eventType || 'DANMAKU'
    const totalBudget =
      context.latencyBudgetMs ??
      request.deadlineMs ??
      this.latencyBudgets[eventType] ??
      4000
    const deadline = Date.now() + totalBudget
    const startTime = Date.now()

    // 1. 思考动作与语气词掩盖机制
    let toneTimer: any = null
    if (this.scheduler) {
      this.scheduler.play('thinking', { maxMs: 10000, resumeState: 'IDLE' })
      toneTimer = setTimeout(() => {
        const filler = THINKING_FILLERS[Math.floor(Math.random() * THINKING_FILLERS.length)]
        this.emit('thinking_tone', { tone: 'thinking', text: filler })
        this.scheduler.speak(filler, { typewriter: false, holdMs: 1500 })
      }, 1200)
      toneTimer.unref?.()
    }

    try {
      // 2. 逐级仲裁与级联降级
      for (let i = 0; i < this.providers.length; i++) {
        const provider = this.providers[i]
        const remainingTime = deadline - Date.now()

        // 若时间耗尽且非兜底层，跳过
        if (remainingTime <= 50 && provider.tier < 4) {
          continue
        }

        // 检查可用性 (额度、认证、熔断)
        if (!provider.isAvailable()) {
          const nextTier = this.providers[i + 1]?.tier ?? 4
          this.emit('fallback', {
            fromTier: provider.tier,
            toTier: nextTier,
            fromProvider: provider.id,
            reason: `${provider.name} is not available (quota/auth/circuit)`,
            elapsedMs: Date.now() - startTime,
          })
          continue
        }

        // 延迟预算门禁 (非兜底层且预估明显超时则安全跳过)
        if (provider.tier < 4) {
          const estimatedP90 = provider.getEstimatedLatencyMs()
          if (estimatedP90 > remainingTime + 200) {
            const nextTier = this.providers[i + 1]?.tier ?? 4
            this.emit('skipped_budget', {
              providerId: provider.id,
              tier: provider.tier,
              estimatedMs: estimatedP90,
              remainingMs: remainingTime,
            })
            this.emit('fallback', {
              fromTier: provider.tier,
              toTier: nextTier,
              fromProvider: provider.id,
              reason: `Estimated latency ${estimatedP90}ms exceeds budget ${remainingTime}ms`,
              elapsedMs: Date.now() - startTime,
            })
            continue
          }
        }

        // Tier 1 对冲并发机制 (2.5s 对冲)
        if (provider.tier === 1 && this.providers.some((p) => p.tier === 2 && p.isAvailable())) {
          try {
            const result = await this.executeWithHedging(provider, request, remainingTime)
            return this.finalizeResult(result, toneTimer)
          } catch (err: any) {
            const nextTier = this.providers[i + 1]?.tier ?? 2
            this.emit('fallback', {
              fromTier: provider.tier,
              toTier: nextTier,
              fromProvider: provider.id,
              reason: (err as any)?.message || String(err ?? 'Unknown error'),
              elapsedMs: Date.now() - startTime,
            })
            continue
          }
        }

        // 常规单提供方执行
        const timeoutForThis = Math.max(300, remainingTime)
        try {
          const result = await provider.think(request, { timeoutMs: timeoutForThis })
          return this.finalizeResult(result, toneTimer)
        } catch (err: any) {
          const nextTier = this.providers[i + 1]?.tier ?? (provider.tier + 1)
          this.emit('fallback', {
            fromTier: provider.tier,
            toTier: nextTier,
            fromProvider: provider.id,
            reason: (err as any)?.message || String(err ?? 'Unknown error'),
            elapsedMs: Date.now() - startTime,
          })
        }
      }

      // 3. 终极兜底：无条件执行 Tier 4 规则库 (保证 100% 成功，绝无死锁)
      const ruleFallback = this.providers.find((p) => p.tier === 4) || new RuleFallbackProvider()
      const fallbackResult = await ruleFallback.think(request)
      return this.finalizeResult(fallbackResult, toneTimer)
    } catch (outerErr) {
      // 终极保护：即使仲裁过程中发生非预期严重异常，也绝不崩溃，统一降级至 Tier 4 规则库
      const ruleFallback = this.providers.find((p) => p.tier === 4) || new RuleFallbackProvider()
      const fallbackResult = await ruleFallback.think(request)
      return this.finalizeResult(fallbackResult, toneTimer)
    } finally {
      if (toneTimer) clearTimeout(toneTimer)
    }
  }

  /**
   * 2.5s 对冲并发执行
   */
  private async executeWithHedging(
    tier1Provider: BrainProvider,
    request: BrainRequest,
    totalRemainingMs: number
  ): Promise<BrainResult> {
    const tier2Provider = this.providers.find((p) => p.tier === 2 && p.isAvailable())
    if (!tier2Provider) {
      return await tier1Provider.think(request, { timeoutMs: totalRemainingMs })
    }

    const t1Controller = new AbortController()
    const t2Controller = new AbortController()

    let hedgeFired = false
    let hedgeTimer: NodeJS.Timeout | null = null

    try {
      const t1Promise = tier1Provider.think(request, {
        timeoutMs: totalRemainingMs,
        abortSignal: t1Controller.signal,
      })

      // 创建对冲 Promise：单个 hedgeTimer 在到期后才启动 Tier 2，句柄受严格生命周期纳管
      const hedgePromise = new Promise<{ winner: 'tier2'; result: BrainResult }>((resolve, reject) => {
        hedgeTimer = setTimeout(async () => {
          hedgeFired = true
          try {
            const res = await tier2Provider.think(request, {
              timeoutMs: Math.max(500, totalRemainingMs - this.hedgeAfterMs),
              abortSignal: t2Controller.signal,
            })
            resolve({ winner: 'tier2', result: res })
          } catch (err) {
            reject(err)
          }
        }, this.hedgeAfterMs)
        hedgeTimer.unref?.()
      })

      const raceResult = await Promise.race([
        t1Promise.then((res) => ({ winner: 'tier1' as const, result: res })),
        hedgePromise,
      ])

      if (raceResult.winner === 'tier1') {
        t2Controller.abort()
        if (hedgeFired) {
          this.emit('hedge_won', { winner: 'tier1', loser: 'tier2' })
        }
        return raceResult.result
      } else {
        t1Controller.abort()
        this.emit('hedge_won', { winner: 'tier2', loser: 'tier1' })
        return raceResult.result
      }
    } finally {
      if (hedgeTimer) {
        clearTimeout(hedgeTimer)
        hedgeTimer = null
      }
    }
  }

  private finalizeResult(result: BrainResult, toneTimer?: any): BrainResult {
    if (toneTimer) clearTimeout(toneTimer)
    if (this.scheduler && result.output.clip) {
      this.scheduler.play(result.output.clip, { resumeState: 'IDLE' })
    }
    return result
  }

  getAllStatus(): {
    activeTier: number
    providers: any[]
  } {
    const list = this.providers.map((p) => {
      const status = typeof p.getStatus === 'function' ? p.getStatus() : { id: p.id, tier: p.tier, name: p.name }
      return {
        ...status,
        available: p.isAvailable(),
      }
    })
    const currentActive = this.providers.find((p) => p.isAvailable())
    return {
      activeTier: currentActive ? currentActive.tier : 4,
      providers: list,
    }
  }
}
