/**
 * @file cli-pool.ts
 * Tier 1: 本地 Agent CLI (agy / cursor-agent) 独立沙箱进程池、状态机与熔断降级适配器
 */

import path from 'node:path'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import type {
  BrainProvider,
  BrainRequest,
  BrainResult,
  BrainOutput,
  BrainTier,
  ProviderState,
  ProviderStatusInfo,
} from './types.ts'

export const QUOTA_REGEX =
  /(quota|rate\s*limit|usage\s*limit|exceeded|429|额度|上限|insufficient_quota|tokens\s*exceeded)/i

export const AUTH_REGEX =
  /(login|unauthorized|auth|not\s*logged\s*in|token\s*expired|invalid_token|401|403|authentication\s*failed)/i

export interface CliConfig {
  id?: string
  name?: string
  command?: string
  args?: string[]
  sandboxDir?: string
  timeoutMs?: number
  enabled?: boolean
  cooldownOnExhaustedMs?: number
  probeIntervalMs?: number
  breakerThreshold?: number
  breakerCooldownMs?: number
  /** 自定义命令执行器 (便于单元测试注入或无真实 CLI 环境时使用) */
  executor?: (prompt: string, sandboxDir: string, options?: { timeoutMs?: number; abortSignal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/**
 * 健壮的多层 CLI 结构化输出解析器
 */
export function parseCliStructuredOutput(stdout: string, stderr: string = ''): BrainOutput {
  const fullText = (stdout || '').trim()
  if (!fullText) {
    if (stderr && QUOTA_REGEX.test(stderr)) {
      const err = new Error(`CLI quota exhausted: ${stderr}`)
      ;(err as any).code = 'EXHAUSTED'
      throw err
    }
    if (stderr && AUTH_REGEX.test(stderr)) {
      const err = new Error(`CLI authentication required: ${stderr}`)
      ;(err as any).code = 'NEEDS_AUTH'
      throw err
    }
    throw new Error('CLI returned empty stdout')
  }

  // 1. 尝试直接作为 JSON 解析
  let parsed: any = null
  try {
    parsed = JSON.parse(fullText)
  } catch (_) {
    // 2. 正则提取可能的 JSON 块或 Markdown 块 (```json ... ``` 或 {...})
    const jsonMatch = fullText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || fullText.match(/(\{[\s\S]*\})/)
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[1])
      } catch (_) {}
    }
  }

  // 3. 处理外层嵌套包装 (如 { result: "..." } 或 { content: "..." } 或 { response: "..." })
  if (parsed && typeof parsed === 'object') {
    const unwrapFields = ['result', 'content', 'response', 'message']
    for (const field of unwrapFields) {
      if (typeof parsed[field] === 'string') {
        try {
          const inner = JSON.parse(parsed[field])
          if (inner && typeof inner === 'object') {
            parsed = inner
            break
          }
        } catch (_) {}
      } else if (parsed[field] && typeof parsed[field] === 'object') {
        parsed = parsed[field]
        break
      }
    }
  }

  // 4. 规范提取 BrainOutput
  if (parsed && typeof parsed === 'object') {
    const replyText = String(parsed.reply ?? parsed.text ?? parsed.content ?? '').trim()
    if (replyText) {
      const mood =
        typeof parsed.moodIntent === 'number'
          ? Math.max(-2, Math.min(2, Math.round(parsed.moodIntent)))
          : 0
      return {
        reply: replyText,
        text: replyText,
        clip: typeof parsed.clip === 'string' ? parsed.clip : 'talking_normal',
        tone: typeof parsed.tone === 'string' ? parsed.tone : 'happy',
        moodIntent: mood,
        fed: Boolean(parsed.fed),
        memory: typeof parsed.memory === 'string' ? parsed.memory.trim() : undefined,
        to: typeof parsed.to === 'string' ? parsed.to.trim() : undefined,
      }
    }
  }

  // 5. 容错降级：如果完全无法提取合法 JSON，则清洗 markdown 标记后取纯文本为回复
  const cleanReply = fullText.replace(/```[\s\S]*?```/g, '').trim()
  if (cleanReply) {
    return {
      reply: cleanReply,
      text: cleanReply,
      clip: 'talking_normal',
      tone: 'happy',
      moodIntent: 0,
      fed: false,
    }
  }

  throw new Error('Failed to extract meaningful reply from CLI output')
}

/**
 * Tier 1: Agent CLI 进程适配器
 */
export class AgentCliProvider implements BrainProvider {
  readonly id: string
  readonly tier: BrainTier = 1
  readonly name: string
  private config: Required<Omit<CliConfig, 'executor'>> & { executor?: CliConfig['executor'] }

  private state: ProviderState = 'READY'
  private totalInvocations = 0
  private successCount = 0
  private failureCount = 0
  private consecutiveFailures = 0
  private circuitBrokenUntil = 0
  private exhaustedUntil = 0
  private lastProbeTime = 0
  private lastError?: string

  // 延迟估算 (EWMA)
  private estimatedLatencyMs = 2000
  private latencySamples: number[] = [2000]

  constructor(options: CliConfig = {}) {
    this.id = options.id || 'agent_cli'
    this.name = options.name || (options.command === 'cursor-agent' ? 'cursor-agent' : 'agy')
    const cmd = options.command || (this.name.includes('cursor') ? 'cursor-agent' : 'agy')

    this.config = {
      id: this.id,
      name: this.name,
      command: cmd,
      args: options.args || (cmd === 'cursor-agent'
        ? ['-p', '{{PROMPT}}', '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled']
        : ['-p', '{{PROMPT}}', '--output-format', 'json', '--effort', 'low', '--sandbox', '--disable-slash-commands', '--print-timeout', '20s']),
      sandboxDir: options.sandboxDir || `runtime/sandbox/agent-cli/${this.name}`,
      timeoutMs: options.timeoutMs ?? 20000,
      enabled: options.enabled ?? true,
      cooldownOnExhaustedMs: options.cooldownOnExhaustedMs ?? 3600_000, // 1小时
      probeIntervalMs: options.probeIntervalMs ?? 900_000,              // 15分钟探针
      breakerThreshold: options.breakerThreshold ?? 3,                 // 3次失败触发熔断
      breakerCooldownMs: options.breakerCooldownMs ?? 60_000,          // 60秒冷却
      executor: options.executor,
    }
  }

  /**
   * 检查提供方可用性
   */
  isAvailable(): boolean {
    if (!this.config.enabled) return false
    if (this.state === 'NEEDS_AUTH') return false

    const now = Date.now()

    // 检查熔断状态
    if (this.state === 'CIRCUIT_BROKEN') {
      if (now < this.circuitBrokenUntil) {
        return false
      }
      // 冷却时间已过，进入半开试探状态
      this.state = 'HALF_OPEN'
      return true
    }

    // 检查额度耗尽状态
    if (this.state === 'EXHAUSTED') {
      if (now >= this.exhaustedUntil) {
        this.state = 'READY'
        return true
      }
      // 探针机制：每隔 probeIntervalMs 允许放行单次探测
      if (now - this.lastProbeTime >= this.config.probeIntervalMs) {
        return true
      }
      return false
    }

    return this.state === 'READY' || this.state === 'HALF_OPEN'
  }

  getEstimatedLatencyMs(): number {
    return Math.round(this.estimatedLatencyMs)
  }

  getP90LatencyMs(): number {
    if (this.latencySamples.length === 0) return this.estimatedLatencyMs
    const sorted = [...this.latencySamples].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))
    return sorted[idx]
  }

  getStatus(): ProviderStatusInfo {
    let binPath = ''
    try {
      binPath = childProcess.execSync(`which ${this.config.command}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    } catch {}

    return {
      id: this.id,
      tier: this.tier,
      name: this.name,
      state: this.state,
      totalInvocations: this.totalInvocations,
      successCount: this.successCount,
      failureCount: this.failureCount,
      consecutiveFailures: this.consecutiveFailures,
      estimatedLatencyMs: this.getEstimatedLatencyMs(),
      p50LatencyMs: this.getEstimatedLatencyMs(),
      p90LatencyMs: this.getP90LatencyMs(),
      exhaustedUntil: this.exhaustedUntil || undefined,
      circuitBrokenUntil: this.circuitBrokenUntil || undefined,
      lastError: this.lastError,
      installed: Boolean(binPath),
      binPath,
    } as any
  }

  /**
   * 记录失败并驱动熔断状态机
   */
  private recordFailure(errorMessage: string): void {
    this.failureCount++
    this.lastError = errorMessage
    const now = Date.now()

    // 额度耗尽匹配
    if (QUOTA_REGEX.test(errorMessage)) {
      this.state = 'EXHAUSTED'
      this.exhaustedUntil = now + this.config.cooldownOnExhaustedMs
      this.lastProbeTime = now
      this.consecutiveFailures = 0
      return
    }
    // 认证失效匹配
    else if (AUTH_REGEX.test(errorMessage)) {
      this.state = 'NEEDS_AUTH'
      this.consecutiveFailures = 0
      return
    }

    // 若当前已处于额度耗尽冷却期或需登录状态，绝不被临时错误降级为更短的 60 秒熔断器
    if (this.state === 'EXHAUSTED' && now < this.exhaustedUntil) {
      return
    }
    if (this.state === 'NEEDS_AUTH') {
      return
    }

    // 仅普通临时失败（超时、网络断开、非 0 退出码等）累加连续失败计数并在达到阈值时触发熔断
    this.consecutiveFailures++
    if (this.consecutiveFailures >= this.config.breakerThreshold) {
      this.state = 'CIRCUIT_BROKEN'
      this.circuitBrokenUntil = now + this.config.breakerCooldownMs
    }
  }

  /**
   * 记录成功并恢复状态
   */
  private recordSuccess(durationMs: number): void {
    this.successCount++
    this.consecutiveFailures = 0
    this.state = 'READY'
    this.circuitBrokenUntil = 0
    this.exhaustedUntil = 0

    // 更新 EWMA 延迟估算 (alpha = 0.25)
    this.estimatedLatencyMs = 0.25 * durationMs + 0.75 * this.estimatedLatencyMs
    this.latencySamples.push(durationMs)
    if (this.latencySamples.length > 20) {
      this.latencySamples.shift()
    }
  }

  /**
   * 手动重置熔断器 (用于测试或人工恢复)
   */
  resetCircuitBreaker(): void {
    this.consecutiveFailures = 0
    this.circuitBrokenUntil = 0
    this.exhaustedUntil = 0
    this.state = 'READY'
    this.lastError = undefined
  }

  /**
   * 标记额度耗尽 (便于测试模拟)
   */
  setQuotaExhausted(exhausted = true): void {
    if (exhausted) {
      this.state = 'EXHAUSTED'
      this.exhaustedUntil = Date.now() + this.config.cooldownOnExhaustedMs
      this.lastProbeTime = Date.now()
      this.lastError = 'Manual quota exhausted'
    } else {
      this.state = 'READY'
      this.exhaustedUntil = 0
    }
  }

  /**
   * 标记认证失效 (便于测试模拟)
   */
  setAuthRequired(required = true): void {
    if (required) {
      this.state = 'NEEDS_AUTH'
      this.lastError = 'Manual auth required'
    } else {
      this.state = 'READY'
    }
  }

  /**
   * 执行原生命令并在隔离沙箱中运行
   */
  async execute(
    promptText: string,
    customSandboxDir?: string,
    options?: { timeoutMs?: number; abortSignal?: AbortSignal }
  ): Promise<BrainOutput> {
    this.totalInvocations++
    const now = Date.now()

    // 1. 检查熔断状态
    if (now < this.circuitBrokenUntil) {
      const remainingMs = this.circuitBrokenUntil - now
      throw new Error(`Circuit breaker is OPEN. Cooldown remaining: ${remainingMs}ms`)
    }

    // 2. 检查额度状态 (仅在无自定义执行器时短路拦截)
    if (!this.config.executor && this.state === 'EXHAUSTED' && now < this.exhaustedUntil) {
      if (now - this.lastProbeTime < this.config.probeIntervalMs) {
        this.recordFailure('[EXHAUSTED] API quota limit exceeded')
        const err = new Error('Process exited with 1: [EXHAUSTED] [rate limit] API quota limit exceeded (429), 额度已达上限')
        ;(err as any).code = 'EXHAUSTED'
        throw err
      }
      this.lastProbeTime = now // 本次作为探针试探
    }

    // 3. 准备隔离沙箱目录
    const resolvedSandbox = path.resolve(process.cwd(), customSandboxDir || this.config.sandboxDir)
    try {
      fs.mkdirSync(resolvedSandbox, { recursive: true })
    } catch (_) {}

    const timeout = options?.timeoutMs ?? this.config.timeoutMs
    const startTime = Date.now()

    // 4. 若提供了自定义执行器 (如单元测试注入)，直接使用
    if (this.config.executor) {
      try {
        const { stdout, stderr, exitCode } = await this.config.executor(promptText, resolvedSandbox, {
          timeoutMs: timeout,
          abortSignal: options?.abortSignal,
        })
        if (exitCode !== 0) {
          let prefix = ''
          const errText = stderr || stdout
          if (QUOTA_REGEX.test(errText)) {
            prefix = '[EXHAUSTED] '
          } else if (AUTH_REGEX.test(errText)) {
            prefix = '[NEEDS_AUTH] '
          }
          const errMsg = `Process exited with ${exitCode}: ${prefix}${errText}`
          const err = new Error(errMsg)
          if (QUOTA_REGEX.test(errMsg)) (err as any).code = 'EXHAUSTED'
          if (AUTH_REGEX.test(errMsg)) (err as any).code = 'NEEDS_AUTH'
          throw err
        }
        const output = parseCliStructuredOutput(stdout, stderr)
        this.recordSuccess(Date.now() - startTime)
        return output
      } catch (err: any) {
        if (err.name !== 'AbortError' && !err.message?.includes('aborted by caller')) {
          this.recordFailure(err.message)
        }
        throw err
      }
    }

    // 5. 原生子进程沙箱执行
    const finalArgs = this.config.args.map((arg) => (arg === '{{PROMPT}}' ? promptText : arg))
    if (!this.config.args.includes('{{PROMPT}}')) {
      finalArgs.push('-p', promptText)
    }

    return new Promise<BrainOutput>((resolve, reject) => {
      let stdoutData = ''
      let stderrData = ''
      let isSettled = false

      const child = childProcess.spawn(this.config.command, finalArgs, {
        cwd: resolvedSandbox,
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const timer = setTimeout(() => {
        if (isSettled) return
        isSettled = true
        try {
          child.kill('SIGTERM')
          setTimeout(() => {
            try { child.kill('SIGKILL') } catch (_) {}
          }, 500)
        } catch (_) {}
        const err = new Error(`CLI execution timed out after ${timeout}ms`)
        this.recordFailure(err.message)
        reject(err)
      }, timeout)

      if (options?.abortSignal) {
        options.abortSignal.addEventListener('abort', () => {
          if (isSettled) return
          isSettled = true
          clearTimeout(timer)
          try { child.kill('SIGKILL') } catch (_) {}
          reject(new Error('CLI execution aborted by caller'))
        })
      }

      child.stdout?.on('data', (d) => {
        stdoutData += d.toString()
      })
      child.stderr?.on('data', (d) => {
        stderrData += d.toString()
      })

      child.on('error', (err: any) => {
        if (isSettled) return
        isSettled = true
        clearTimeout(timer)
        // ENOENT 表示未安装该 CLI，优雅标记
        if (err.code === 'ENOENT') {
          this.config.enabled = false
          this.state = 'NEEDS_AUTH'
        }
        this.recordFailure(err.message)
        reject(err)
      })

      child.on('close', (code) => {
        if (isSettled) return
        isSettled = true
        clearTimeout(timer)

        if (code !== 0) {
          let prefix = ''
          const errText = stderrData || stdoutData
          if (QUOTA_REGEX.test(errText)) {
            prefix = '[EXHAUSTED] '
          } else if (AUTH_REGEX.test(errText)) {
            prefix = '[NEEDS_AUTH] '
          }
          const errMsg = `Process exited with ${code}: ${prefix}${errText}`
          this.recordFailure(errMsg)
          const err = new Error(errMsg)
          if (QUOTA_REGEX.test(errMsg)) (err as any).code = 'EXHAUSTED'
          if (AUTH_REGEX.test(errMsg)) (err as any).code = 'NEEDS_AUTH'
          return reject(err)
        }

        try {
          const output = parseCliStructuredOutput(stdoutData, stderrData)
          this.recordSuccess(Date.now() - startTime)
          resolve(output)
        } catch (parseErr: any) {
          this.recordFailure(parseErr.message)
          reject(parseErr)
        }
      })
    })
  }

  /**
   * 实现 BrainProvider think 接口
   */
  async think(request: BrainRequest, options?: { timeoutMs?: number; abortSignal?: AbortSignal }): Promise<BrainResult> {
    const promptText = typeof request.prompt === 'string' ? request.prompt : request.prompt.fullText
    const startTime = Date.now()

    const output = await this.execute(promptText, undefined, {
      timeoutMs: options?.timeoutMs ?? request.deadlineMs,
      abortSignal: options?.abortSignal ?? request.abortSignal,
    })

    const duration = Date.now() - startTime
    return {
      tier: this.tier,
      provider: 'agent_cli',
      providerId: this.id,
      output,
      result: output,
      durationMs: duration,
      latencyMs: duration,
    }
  }
}
