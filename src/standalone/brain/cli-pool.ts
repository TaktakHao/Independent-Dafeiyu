/**
 * @file cli-pool.ts
 * Tier 1: 本地 Agent CLI (agy / cursor-agent) 独立沙箱进程池、状态机与熔断降级适配器
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import childProcess from 'node:child_process'
import { normalizeReplyIntent, parseStreamingMeta } from './streaming.ts'
import { FIXED_PERSONA_LAYER_A } from './prompt-builder.ts'
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
  /** 是否为 agy 启用常驻 stream-json 热进程复用与纯净环境隔离 */
  warmStream?: boolean
  cooldownOnExhaustedMs?: number
  probeIntervalMs?: number
  breakerThreshold?: number
  breakerCooldownMs?: number
  /** 自定义命令执行器 (便于单元测试注入或无真实 CLI 环境时使用) */
  executor?: (prompt: string, sandboxDir: string, options?: { timeoutMs?: number; abortSignal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/**
 * 构建大肥鱼专属的极速隔离沙箱与纯净 HOME 环境：
 * 1. 创建独立 .git 边界阻断向上遍历，彻底避免扫描父目录 AGENTS.md / .agents/skills
 * 2. 隔离 HOME/.gemini/config 为空目录，剥离 35+ 全局 Skills、4 个 MCP 服务与 NotchBuddy Hooks
 * 3. 挂载禁用写工具/子智能体/MCP 的轻量级 dafeiyu-chat 专属 Agent，将单次输入从 ~14,770 tokens 降至 ~3,300 tokens
 */
export function prepareIsolatedAgyEnvironment(baseDir: string = path.join(os.tmpdir(), 'dafeiyu-agy-fast-sandbox')): {
  workDir: string
  homeDir: string
} {
  const workDir = path.join(baseDir, 'work')
  const homeDir = path.join(baseDir, 'home')
  const gitDir = path.join(workDir, '.git')
  const agentDir = path.join(workDir, '.agents', 'agents', 'dafeiyu-chat')
  const cliConfigDir = path.join(homeDir, '.gemini', 'antigravity-cli')
  const globalConfigDir = path.join(homeDir, '.gemini', 'config')

  try {
    fs.mkdirSync(gitDir, { recursive: true })
    fs.mkdirSync(agentDir, { recursive: true })
    fs.mkdirSync(cliConfigDir, { recursive: true })
    fs.mkdirSync(globalConfigDir, { recursive: true })

    // 写入极简无工具 dafeiyu-chat Agent 定义（内嵌 Layer A 固定人设）
    const agentMdPath = path.join(agentDir, 'AGENT.md')
    const agentMdContent = `---
name: dafeiyu-chat
description: CyberFish Daughter (大肥鱼) pure lightweight companion chat persona without tools.
enable_write_tools: false
enable_subagent_tools: false
enable_mcp_tools: false
---
${FIXED_PERSONA_LAYER_A}

【极速响应硬性规定】：
严禁调用任何工具（禁止读取文件、禁止搜索、禁止执行命令），收到输入后必须直接输出首行 <meta .../> 标签与台词文本！
`
    if (!fs.existsSync(agentMdPath) || fs.readFileSync(agentMdPath, 'utf-8') !== agentMdContent) {
      fs.writeFileSync(agentMdPath, agentMdContent, 'utf-8')
    }

    // 软链宿主登录态凭证与 macOS Keychain，保证零重新登录
    const realHome = os.homedir()
    for (const file of ['jetski_state.pbtxt', 'installation_id']) {
      const src = path.join(realHome, '.gemini', 'antigravity-cli', file)
      const dest = path.join(cliConfigDir, file)
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        try {
          fs.symlinkSync(src, dest)
        } catch {}
      }
    }

    // 写入极简纯净 settings.json（不含 MCP 权限列表与外部 statusLine shell 脚本）
    const settingsPath = path.join(cliConfigDir, 'settings.json')
    const cleanSettings = JSON.stringify(
      {
        agentMode: 'accept-edits',
        enableTerminalSandbox: true,
        toolPermission: 'proceed-in-sandbox',
        trustedWorkspaces: [workDir],
      },
      null,
      2
    )
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, cleanSettings, 'utf-8')
    }

    // 软链 macOS Library Keychains 与 Application Support 以支持 OAuth Token 读取
    const libDir = path.join(homeDir, 'Library')
    fs.mkdirSync(libDir, { recursive: true })
    for (const sub of ['Keychains', 'Application Support']) {
      const src = path.join(realHome, 'Library', sub)
      const dest = path.join(libDir, sub)
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        try {
          fs.symlinkSync(src, dest)
        } catch {}
      }
    }
  } catch {
    // 容错降级
  }

  return { workDir, homeDir }
}

/**
 * 剥离在 dafeiyu-chat Agent.md 中已固化的 [Layer A] 文本，减少每轮重复 Token 传输
 */
function stripRedundantLayerA(promptText: string): string {
  const layerBIdx = promptText.indexOf('[Layer B]')
  if (layerBIdx !== -1) {
    return promptText.slice(layerBIdx).trim()
  }
  const layerCIdx = promptText.indexOf('[Layer C]')
  if (layerCIdx !== -1) {
    return promptText.slice(layerCIdx).trim()
  }
  return promptText
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
    let rawReplyText = String(
      parsed.reply ?? parsed.text ?? parsed.content ?? parsed.response ?? ''
    ).trim()

    if (rawReplyText) {
      // 提取并剥离嵌入的 <meta .../> 标签
      const metaParsed = parseStreamingMeta(rawReplyText)
      const clip = typeof parsed.clip === 'string' ? parsed.clip : (metaParsed?.clip ?? 'talking_normal')
      const tone = typeof parsed.tone === 'string' ? parsed.tone : (metaParsed?.tone ?? 'happy')
      const rawMood = typeof parsed.moodIntent === 'number' ? parsed.moodIntent : (metaParsed?.moodIntent ?? 0)
      const mood = Math.max(-2, Math.min(2, Math.round(rawMood)))
      const fed = typeof parsed.fed === 'boolean' ? parsed.fed : Boolean(metaParsed?.fed)
      let memory = typeof parsed.memory === 'string' ? parsed.memory.trim() : metaParsed?.memory

      // 剔除 <meta .../> 标签
      let cleanText = rawReplyText.replace(/<meta\s+[^>]+\/?>\s*/gi, '').trim()

      // 剔除并提取 <mem ...>...</mem> 标签
      const memMatch = cleanText.match(/<mem(?:\s+imp="(\d+)")?>([\s\S]*?)<\/mem>/i)
      if (memMatch) {
        if (!memory) memory = memMatch[2].trim()
        cleanText = cleanText.replace(/<mem(?:\s+imp="\d+")?>[\s\S]*?<\/mem>/gi, '').trim()
      }

      // 绝不回退至含有 <meta> 的 rawReplyText，若剔除后为空则填充元气台词
      const fallbackReply = (clip === 'success' || clip === 'dance') ? '老爸，大功告成啦！✨' : '诶嘿，本鱼随时待命哦~ 🐟'
      const finalReply = cleanText || fallbackReply

      return {
        reply: finalReply,
        text: finalReply,
        clip,
        tone,
        moodIntent: mood,
        fed,
        memory,
        to: typeof parsed.to === 'string' ? parsed.to.trim() : undefined,
        ...normalizeReplyIntent({
          intent: parsed.intent ?? metaParsed?.intent,
          topic: parsed.topic ?? metaParsed?.topic,
          task: parsed.task ?? metaParsed?.task,
        }),
      }
    }
  }

  // 5. 容错降级：如果完全无法提取合法 JSON，则清洗 markdown 标记后取纯文本为回复
  let cleanReply = fullText.replace(/```[\s\S]*?```/g, '').trim()
  const metaParsed = parseStreamingMeta(cleanReply)
  cleanReply = cleanReply.replace(/<meta\s+[^>]+\/?>\s*/gi, '').trim()
  const fallbackReply = (metaParsed?.clip === 'success') ? '老爸，任务搞定啦！✨' : '诶嘿，本鱼随时待命哦~ 🐟'
  const finalReply = cleanReply || fallbackReply

  return {
    reply: finalReply,
    text: finalReply,
    clip: metaParsed?.clip || 'talking_normal',
    tone: metaParsed?.tone || 'happy',
    moodIntent: metaParsed?.moodIntent || 0,
    fed: Boolean(metaParsed?.fed),
    ...normalizeReplyIntent(metaParsed),
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

  // 常驻 stream-json 热守护进程状态
  private warmProc: childProcess.ChildProcess | null = null
  private warmReady: boolean = false
  private warmInitPromise: Promise<void> | null = null
  private warmTurnCount: number = 0
  private warmStdoutBuffer: string = ''
  private activeStreamRequest: {
    resolve: (output: BrainOutput) => void
    reject: (err: Error) => void
    startTime: number
    timer: any
  } | null = null

  constructor(options: CliConfig = {}) {
    this.id = options.id || 'agent_cli'
    this.name = options.name || (options.command === 'cursor-agent' ? 'cursor-agent' : 'agy')
    const cmd = options.command || (this.name.includes('cursor') ? 'cursor-agent' : 'agy')

    this.config = {
      id: this.id,
      name: this.name,
      command: cmd,
      args: options.args || (cmd === 'cursor-agent'
        ? ['-p', '{{PROMPT}}', '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled', '--trust']
        : ['-p', '{{PROMPT}}', '--output-format', 'json', '--agent', 'dafeiyu-chat', '--model', 'gemini-3.8-flash-low', '--effort', 'low', '--sandbox', '--disable-slash-commands', '--print-timeout', '45s']),
      sandboxDir: options.sandboxDir || `runtime/sandbox/agent-cli/${this.name}`,
      timeoutMs: options.timeoutMs ?? 45000,
      enabled: options.enabled ?? true,
      warmStream: options.warmStream ?? false,
      cooldownOnExhaustedMs: options.cooldownOnExhaustedMs ?? 3600_000, // 1小时
      probeIntervalMs: options.probeIntervalMs ?? 900_000,              // 15分钟探针
      breakerThreshold: options.breakerThreshold ?? 3,                 // 3次失败触发熔断
      breakerCooldownMs: options.breakerCooldownMs ?? 60_000,          // 60秒冷却
      executor: options.executor,
    }
  }

  /**
   * 后台预热常驻 agy stream-json 守护进程，消除每次提问 ~7.5s 的进程冷启动耗时
   */
  warmup(): Promise<void> {
    if (this.config.executor || this.config.command !== 'agy' || !this.config.enabled) {
      return Promise.resolve()
    }
    if (this.warmProc && this.warmReady) {
      return Promise.resolve()
    }
    if (this.warmInitPromise) {
      return this.warmInitPromise
    }

    this.warmInitPromise = new Promise<void>((resolve) => {
      const { workDir, homeDir } = prepareIsolatedAgyEnvironment()
      const streamArgs = [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--agent',
        'dafeiyu-chat',
        '--model',
        'gemini-3.8-flash-low',
        '--effort',
        'low',
        '--sandbox',
        '--disable-slash-commands',
        '-p',
        '',
      ]

      let initSettled = false
      const settleInit = () => {
        if (!initSettled) {
          initSettled = true
          this.warmInitPromise = null
          resolve()
        }
      }

      try {
        const proc = childProcess.spawn(this.config.command, streamArgs, {
          cwd: workDir,
          env: {
            ...process.env,
            HOME: homeDir,
            GIT_DIR: undefined,
            GIT_WORK_TREE: undefined,
          },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        proc.unref?.()

        this.warmProc = proc
        this.warmReady = false
        this.warmTurnCount = 0
        this.warmStdoutBuffer = ''

        const initTimer = setTimeout(() => {
          settleInit()
        }, 12000)
        initTimer.unref?.()

        proc.stdout?.on('data', (chunk: Buffer) => {
          this.warmStdoutBuffer += chunk.toString('utf-8')
          let newlineIdx: number
          while ((newlineIdx = this.warmStdoutBuffer.indexOf('\n')) !== -1) {
            const line = this.warmStdoutBuffer.slice(0, newlineIdx).trim()
            this.warmStdoutBuffer = this.warmStdoutBuffer.slice(newlineIdx + 1)
            if (!line || !line.startsWith('{')) continue
            try {
              const evt = JSON.parse(line)
              if (evt.event === 'init') {
                this.warmReady = true
                clearTimeout(initTimer)
                settleInit()
              } else if (evt.event === 'result' && this.activeStreamRequest) {
                const req = this.activeStreamRequest
                this.activeStreamRequest = null
                clearTimeout(req.timer)

                if (evt.result?.status === 'ERROR' || evt.result?.error) {
                  const errMsg = String(evt.result?.error || 'Warm stream turn error')
                  this.recordFailure(errMsg)
                  req.reject(new Error(errMsg))
                } else {
                  try {
                    const rawResp = String(evt.result?.response || '')
                    const output = parseCliStructuredOutput(rawResp)
                    this.recordSuccess(Date.now() - req.startTime)
                    req.resolve(output)
                  } catch (parseErr: any) {
                    this.recordFailure(parseErr.message)
                    req.reject(parseErr)
                  }
                }

                // 每满 8 轮自动在后台轮换新会话，防止多轮历史累积拖慢推理
                this.warmTurnCount++
                if (this.warmTurnCount >= 8) {
                  this.stopWarmDaemon()
                  this.warmup().catch(() => {})
                }
              }
            } catch {
              // 忽略非 JSON 行
            }
          }
        })

        const handleExit = () => {
          clearTimeout(initTimer)
          if (this.warmProc === proc) {
            this.warmProc = null
            this.warmReady = false
          }
          if (this.activeStreamRequest) {
            const req = this.activeStreamRequest
            this.activeStreamRequest = null
            clearTimeout(req.timer)
            req.reject(new Error('Warm agy stream process exited unexpectedly'))
          }
          settleInit()
        }

        proc.on('error', handleExit)
        proc.on('close', handleExit)
      } catch {
        settleInit()
      }
    })

    return this.warmInitPromise
  }

  /**
   * 停止并清理常驻热进程
   */
  stopWarmDaemon(): void {
    if (this.warmProc) {
      try {
        this.warmProc.kill('SIGTERM')
      } catch {}
      this.warmProc = null
      this.warmReady = false
      this.warmInitPromise = null
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

  /**
   * 自动在系统 PATH 及常见 macOS 用户目录中检索 CLI 二进制路径
   */
  public resolveBinPath(): string {
    const cmd = this.config.command
    if (path.isAbsolute(cmd) && fs.existsSync(cmd)) {
      return cmd
    }
    try {
      const found = childProcess
        .execSync(`which ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] })
        .trim()
      if (found) return found
    } catch {}

    const candidateDirs = [
      path.join(os.homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      path.join(os.homedir(), '.cargo', 'bin'),
    ]
    for (const dir of candidateDirs) {
      const candidate = path.join(dir, cmd)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
    return ''
  }

  /**
   * 一键探测 CLI 安装状态、重置异常熔断并更新路径
   */
  public detectAndRefresh(): {
    id: string
    name: string
    command: string
    installed: boolean
    binPath: string
    state: ProviderState
  } {
    const binPath = this.resolveBinPath()
    if (binPath) {
      this.config.enabled = true
      if (this.state === 'CIRCUIT_BROKEN' || this.state === 'EXHAUSTED' || this.state === 'DISABLED') {
        this.resetCircuitBreaker()
      }
    }
    return {
      id: this.id,
      name: this.name,
      command: this.config.command,
      installed: Boolean(binPath),
      binPath,
      state: binPath ? this.state : ('DISABLED' as ProviderState),
    }
  }

  /**
   * 主动测试该 CLI 通道的推理连通性与真实响应耗时
   */
  public async testConnectivity(): Promise<{
    ok: boolean
    latencyMs: number
    binPath: string
    replySample?: string
    error?: string
  }> {
    const start = Date.now()
    const binPath = this.resolveBinPath()
    if (!binPath) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        binPath: '',
        error: `未在系统中检测到命令 "${this.config.command}"，请检查安装路径`,
      }
    }

    try {
      this.resetCircuitBreaker()
      const output = await this.execute(
        '[Layer C]\n请直接用一句话俏皮回答：本鱼的CLI大脑通道测试连通成功！',
        undefined,
        { timeoutMs: 25000 }
      )
      return {
        ok: true,
        latencyMs: Date.now() - start,
        binPath,
        replySample: output.reply || output.text || 'CLI 响应正常',
      }
    } catch (err: any) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        binPath,
        error: err?.message || 'CLI 执行测试失败',
      }
    }
  }

  getStatus(): ProviderStatusInfo {
    const binPath = this.resolveBinPath()

    return {
      id: this.id,
      tier: this.tier,
      name: this.name,
      state: binPath ? this.state : 'DISABLED',
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

    // 5. 若为 agy 且开启了常驻热流模式 (warmStream)，优先走零冷启动的常驻进程管道
    const isAgy = this.config.command === 'agy'
    if (isAgy && this.config.warmStream && !this.activeStreamRequest) {
      await this.warmup()
      if (this.warmProc && this.warmReady && this.warmProc.stdin?.writable) {
        const compactPrompt = stripRedundantLayerA(promptText)
        return new Promise<BrainOutput>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this.activeStreamRequest) {
              this.activeStreamRequest = null
              this.stopWarmDaemon()
              this.warmup().catch(() => {})
              const err = new Error(`Warm CLI execution timed out after ${timeout}ms`)
              this.recordFailure(err.message)
              reject(err)
            }
          }, timeout)

          if (options?.abortSignal) {
            options.abortSignal.addEventListener('abort', () => {
              if (this.activeStreamRequest) {
                clearTimeout(this.activeStreamRequest.timer)
                this.activeStreamRequest = null
                this.stopWarmDaemon()
                this.warmup().catch(() => {})
                reject(new Error('CLI execution aborted by caller'))
              }
            })
          }

          this.activeStreamRequest = {
            resolve,
            reject,
            startTime,
            timer,
          }

          const payload = JSON.stringify({
            event: 'user',
            message: { content: compactPrompt },
          })
          this.warmProc!.stdin!.write(`${payload}\n`)
        })
      }
    }

    // 6. 原生子进程沙箱执行（若为 agy 则使用纯净隔离环境与 dafeiyu-chat 轻量级 Agent）
    let effectiveCwd = resolvedSandbox
    let effectiveEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
    }
    let effectivePrompt = promptText

    if (isAgy) {
      const { workDir, homeDir } = prepareIsolatedAgyEnvironment()
      effectiveCwd = workDir
      effectiveEnv = {
        ...effectiveEnv,
        HOME: homeDir,
      }
      effectivePrompt = stripRedundantLayerA(promptText)
    }

    const baseArgs = [...this.config.args]
    if (isAgy && !baseArgs.includes('--agent')) {
      baseArgs.push('--agent', 'dafeiyu-chat')
    }

    const finalArgs = baseArgs.map((arg) => (arg === '{{PROMPT}}' ? effectivePrompt : arg))
    if (!baseArgs.includes('{{PROMPT}}')) {
      finalArgs.push('-p', effectivePrompt)
    }

    return new Promise<BrainOutput>((resolve, reject) => {
      let stdoutData = ''
      let stderrData = ''
      let isSettled = false

      const child = childProcess.spawn(this.config.command, finalArgs, {
        cwd: effectiveCwd,
        env: effectiveEnv,
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
