/**
 * @file local-llm.ts
 * Tier 3: 本地大模型 HTTP 客户端 (支持 Ollama / MLX-LM / llama.cpp 常驻服务)
 */

import type {
  BrainProvider,
  BrainRequest,
  BrainResult,
  BrainOutput,
  BrainTier,
  ProviderStatusInfo,
} from '../types.ts'

export interface LocalLlmConfig {
  id?: string
  name?: string
  endpoint?: string
  model?: string
  timeoutMs?: number
  enabled?: boolean
  probeTimeoutMs?: number
}

export class LocalLlmProvider implements BrainProvider {
  readonly id: string
  readonly tier: BrainTier = 3
  readonly name: string

  private endpoint: string
  private model: string
  private timeoutMs: number
  private enabled: boolean
  private probeTimeoutMs: number
  private isHealthy = true
  private lastProbeTime = 0

  private totalInvocations = 0
  private successCount = 0
  private failureCount = 0
  private consecutiveFailures = 0
  private estimatedLatencyMs = 600

  constructor(config: LocalLlmConfig = {}) {
    this.id = config.id || 'local_llm'
    this.name = config.name || 'Local LLM (Ollama/MLX)'
    this.endpoint = (config.endpoint || process.env.LOCAL_LLM_ENDPOINT || 'http://127.0.0.1:11434').replace(/\/$/, '')
    this.model = config.model || process.env.LOCAL_LLM_MODEL || 'qwen2.5:7b'
    this.timeoutMs = config.timeoutMs ?? 8000
    this.enabled = config.enabled ?? true
    this.probeTimeoutMs = config.probeTimeoutMs ?? 800
  }

  isAvailable(): boolean {
    if (!this.enabled) return false
    return this.isHealthy
  }

  setAvailable(available: boolean): void {
    this.isHealthy = available
    this.enabled = available
  }

  getEstimatedLatencyMs(): number {
    return Math.round(this.estimatedLatencyMs)
  }

  getStatus(): ProviderStatusInfo {
    return {
      id: this.id,
      tier: this.tier,
      name: this.name,
      state: this.isHealthy ? 'READY' : 'EXHAUSTED',
      totalInvocations: this.totalInvocations,
      successCount: this.successCount,
      failureCount: this.failureCount,
      consecutiveFailures: this.consecutiveFailures,
      estimatedLatencyMs: this.getEstimatedLatencyMs(),
      p50LatencyMs: this.getEstimatedLatencyMs(),
      p90LatencyMs: Math.round(this.estimatedLatencyMs * 1.5),
    }
  }

  /**
   * 800ms 快速探活嗅探
   */
  async probeHealth(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs)
      const res = await fetch(`${this.endpoint}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      }).catch(() => null)
      clearTimeout(timer)

      if (res && res.ok) {
        this.isHealthy = true
        return true
      }

      // 尝试 Ollama 原生接口
      const controller2 = new AbortController()
      const timer2 = setTimeout(() => controller2.abort(), this.probeTimeoutMs)
      const res2 = await fetch(`${this.endpoint}/api/tags`, {
        method: 'GET',
        signal: controller2.signal,
      }).catch(() => null)
      clearTimeout(timer2)

      this.isHealthy = Boolean(res2 && res2.ok)
      return this.isHealthy
    } catch (_) {
      this.isHealthy = false
      return false
    }
  }

  async think(request: BrainRequest, options?: { timeoutMs?: number; abortSignal?: AbortSignal }): Promise<BrainResult> {
    this.totalInvocations++
    const promptText = typeof request.prompt === 'string' ? request.prompt : request.prompt.fullText
    const startTime = Date.now()
    const timeout = options?.timeoutMs ?? request.deadlineMs ?? this.timeoutMs

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', () => controller.abort())
    }

    try {
      // 优先调用 OpenAI 兼容接口 /v1/chat/completions
      const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: '你是大肥鱼桌面伴侣。输出请简短元气。' },
            { role: 'user', content: promptText },
          ],
          temperature: 0.7,
          max_tokens: 150,
          stream: false,
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (!res.ok) {
        throw new Error(`Local LLM responded with HTTP ${res.status}: ${res.statusText}`)
      }

      const data = await res.json() as any
      const content = data.choices?.[0]?.message?.content || ''
      const duration = Date.now() - startTime

      this.successCount++
      this.consecutiveFailures = 0
      this.estimatedLatencyMs = 0.25 * duration + 0.75 * this.estimatedLatencyMs

      const output: BrainOutput = {
        reply: content.trim() || '（本地模型思考中）收到老爸指令，离线任务已处理完毕！',
        text: content.trim() || '（本地模型思考中）收到老爸指令，离线任务已处理完毕！',
        clip: 'talking_normal',
        tone: 'neutral',
        moodIntent: 0,
      }

      return {
        tier: this.tier,
        provider: 'local_ollama',
        providerId: this.id,
        output,
        result: output,
        durationMs: duration,
        latencyMs: duration,
      }
    } catch (err: any) {
      clearTimeout(timer)
      this.failureCount++
      this.consecutiveFailures++
      this.isHealthy = false
      throw err
    }
  }

  async *thinkStream(request: BrainRequest, options?: { timeoutMs?: number; abortSignal?: AbortSignal }): AsyncIterable<string> {
    this.totalInvocations++
    const promptText = typeof request.prompt === 'string' ? request.prompt : request.prompt.fullText
    const timeout = options?.timeoutMs ?? request.deadlineMs ?? this.timeoutMs

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    if (options?.abortSignal) {
      options.abortSignal.addEventListener('abort', () => controller.abort())
    }

    try {
      const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: promptText }],
          temperature: 0.7,
          max_tokens: 150,
          stream: true,
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (!res.ok) {
        throw new Error(`Local LLM stream responded with HTTP ${res.status}`)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No readable stream from Local LLM')

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
          } catch (_) {}
        }
      }
    } catch (err: any) {
      clearTimeout(timer)
      this.failureCount++
      this.consecutiveFailures++
      this.isHealthy = false
      throw err
    }
  }
}
