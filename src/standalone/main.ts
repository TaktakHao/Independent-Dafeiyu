/**
 * @file main.ts
 * CyberFish Daughter (大肥鱼独立伴侣) — 生产级系统全链路组装与启动入口
 */

import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { StateManager } from './core/state.ts'
import { RuntimeScheduler } from './core/scheduler.ts'
import type { OperationalMode, StandaloneConfig } from './core/types.ts'

import { initDatabase, closeDatabase } from './memory/db.ts'
import { MemoryStore } from './memory/store.ts'
import { WorkingMemory, ScopedWorkingMemory } from './memory/working.ts'
import { DiaryGenerator } from './memory/diary.ts'
import { HostImpressionEngine } from './memory/impression.ts'
import { ContactImpressionEngine } from './memory/contacts.ts'
import { TieredBrainRouter } from './brain/router.ts'
import { RuleFallbackProvider } from './brain/providers/rule-fallback.ts'
import { LocalLlmProvider } from './brain/providers/local-llm.ts'
import { DeepSeekProvider } from './brain/providers/deepseek.ts'
import { AgentCliProvider } from './brain/cli-pool.ts'
import { PromptBuilder } from './brain/prompt-builder.ts'
import { TaskExecutor } from './brain/task-executor.ts'

import { EmotionEngine, evaluateEmotionFSM } from './persona/emotion.ts'
import { InnerThoughtLoop } from './persona/inner-thought.ts'

import { InputGuard } from './safety/input-guard.ts'
import { OutputGuard } from './safety/output-guard.ts'
import { PermissionGuard } from './safety/permission-guard.ts'
import { ApprovalManager } from './safety/approval-manager.ts'

import { PriorityEventQueue } from './events/queue.ts'
import { EventRouter } from './events/router.ts'
import type { StandardEvent } from './events/types.ts'

import { ScreenDanmakuSensor } from './sensors/screen-danmaku.ts'
import { ScheduleClock } from './sensors/schedule.ts'
import { AntigravitySensor } from './sensors/antigravity.ts'
import { QuotaSensor } from './sensors/quota.ts'
import { OneBotGateway } from './gateway/onebot-gateway.ts'
import { ConsoleServer } from './console/server.ts'
import { CompositeTTSEngine, type ITTSEngine } from './brain/tts.ts'

export interface FullAppInstance {
  state: StateManager
  scheduler: RuntimeScheduler
  memory: MemoryStore
  workingMemory: WorkingMemory
  scopedWorkingMemory?: ScopedWorkingMemory
  contactImpression?: ContactImpressionEngine
  diaryGenerator: DiaryGenerator
  impression: HostImpressionEngine
  taskExecutor: TaskExecutor
  brain: TieredBrainRouter
  emotion: EmotionEngine
  innerThought: InnerThoughtLoop
  eventQueue: PriorityEventQueue
  eventRouter: EventRouter
  consoleServer: ConsoleServer
  danmakuSensor: ScreenDanmakuSensor
  scheduleClock: ScheduleClock
  antigravitySensor: AntigravitySensor
  quotaSensor: QuotaSensor
  ttsEngine: ITTSEngine
  onebotGateway?: OneBotGateway
  permissionGuard?: PermissionGuard
  approvalManager?: ApprovalManager
  stop: () => Promise<void>
}

/**
 * 动态加载 ownerQq，支持 secrets.json 根字段、onebot 子字段与环境变量回退
 */
export function getOwnerQq(fileConfig?: any): string {
  try {
    const secPath = path.resolve(process.cwd(), 'runtime/data/secrets.json')
    if (fs.existsSync(secPath)) {
      const sec = JSON.parse(fs.readFileSync(secPath, 'utf-8'))
      const qq = sec.ownerQq || sec.onebot?.ownerQq
      if (qq) return String(qq).trim()
    }
  } catch {}
  return String(process.env.OWNER_QQ || fileConfig?.ownerQq || fileConfig?.onebot?.ownerQq || '').trim()
}

/**
 * 加载本地配置文件并合并 runtime/data/secrets.json 中的持久化密钥
 */
function loadConfig(configPath: string = 'config/daughter.config.json'): any {
  let cfg: any = {}
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8')
      cfg = JSON.parse(content)
    }
  } catch (err) {
    console.warn('[dsh-dafeiyu] 加载配置文件失败，将使用默认配置:', (err as Error).message)
  }

  try {
    const secretsPath = path.resolve(process.cwd(), 'runtime/data/secrets.json')
    if (fs.existsSync(secretsPath)) {
      const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'))
      if (secrets?.deepseekApiKey) {
        if (!cfg.brain) cfg.brain = {}
        if (!cfg.brain.deepseek) cfg.brain.deepseek = {}
        cfg.brain.deepseek.apiKey = secrets.deepseekApiKey
      }
    }
  } catch {}

  return cfg
}

/**
 * 加载模板语料库
 */
function loadTemplates(templatesPath: string = 'config/templates.zh.json'): any {
  try {
    if (fs.existsSync(templatesPath)) {
      const content = fs.readFileSync(templatesPath, 'utf-8')
      return JSON.parse(content)
    }
  } catch {
    // 忽略加载错误
  }
  return {}
}

/**
 * 加载敏感词黑名单
 */
function loadSensitiveWords(wordsPath: string = 'config/sensitive-words.txt'): string[] {
  try {
    if (fs.existsSync(wordsPath)) {
      return fs
        .readFileSync(wordsPath, 'utf-8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    }
  } catch {
    // 忽略
  }
  return []
}

/**
 * 组装与启动大肥鱼独立伴侣运行时全链路
 */
export async function bootstrap(config: StandaloneConfig = {}): Promise<FullAppInstance> {
  const fileConfig = loadConfig()
  const templates = loadTemplates()
  const sensitiveWords = loadSensitiveWords()

  const mode = config.mode ?? fileConfig.mode ?? 'companion'
  const state = new StateManager(mode)
  const scheduler = new RuntimeScheduler(state, config)

  // 1. 初始化 SQLite 存储底座、工作记忆、主人与联系人印象引擎及日记生成器
  const dbPath = fileConfig.memory?.dbPath || 'runtime/data/daughter.db'
  const db = initDatabase({ path: dbPath })
  const memory = new MemoryStore(db)
  const diaryGenerator = new DiaryGenerator(memory)
  const impression = new HostImpressionEngine(memory)

  // 实例化多联系人独立印象引擎 (千人千面)
  const contactImpression = new ContactImpressionEngine(db, memory)

  // 实例化多会话作用域工作记忆 (隔离群聊、私聊与控制台)
  const scopedWorkingMemory = new ScopedWorkingMemory({
    defaultTokenBudget: fileConfig.memory?.workingTokens ?? 500,
    groupTokenBudget: 400,
    privateTokenBudget: 300,
  })

  // 保持原有 workingMemory 单例供控制台与老版接口平滑使用
  const workingMemory = scopedWorkingMemory.getMemory('console:host')

  // 当控制台/主人会话滑动溢出时，沉淀 L2 会话摘要
  scopedWorkingMemory.onSessionEvict('console:host', (evictedTurns) => {
    try {
      const prevSummary = memory.loadSessionSummary() || ''
      const condensed = evictedTurns
        .map((t) => `${t.role === 'user' ? '老爸' : '本鱼'}:${t.text.slice(0, 25)}`)
        .join('；')
      const nextSummary = [prevSummary, condensed].filter(Boolean).join(' | ').slice(-200)
      memory.saveSessionSummary(nextSummary)
    } catch {}
  })

  // 恢复持久化数值
  const persistedStats = memory.loadRpgState()
  state.updateStats(persistedStats)

  // 2. 初始化安全风控守卫
  const inputGuard = new InputGuard(sensitiveWords)
  const outputGuard = new OutputGuard()

  // 3. 初始化三轴情感状态机与主动内心独白
  const emotion = new EmotionEngine(
    fileConfig.emotion?.baselineMood ?? 60,
    fileConfig.emotion?.perViewerMoodCapPerMin ?? 6,
    fileConfig.emotion?.totalMoodCapPerMin ?? 15
  )
  const innerThought = new InnerThoughtLoop(30, 0.85)

  // 当 RPG 数值变化时，实时同步五态情绪状态机与 EmotionEngine 内部数值
  const syncEmotionFromStats = () => {
    const s = state.getStats()
    const isLive = state.getMode() === 'live'
    emotion.setStats(s, isLive)
    const nextEmo = evaluateEmotionFSM(
      s.mood,
      s.hunger,
      s.energy,
      state.getEmotion(),
      isLive
    )
    state.setEmotion(nextEmo)
  }
  state.on('stats_changed', syncEmotionFromStats)
  syncEmotionFromStats()

  // 4. 初始化分级大脑路由器
  const ruleFallback = new RuleFallbackProvider()
  const localLlm = new LocalLlmProvider({
    baseUrl: fileConfig.brain?.local?.baseUrl ?? 'http://127.0.0.1:11434',
    model: fileConfig.brain?.local?.chatModel ?? 'qwen2.5:14b',
  })
  const deepseek = new DeepSeekProvider({
    apiKey: process.env.DEEPSEEK_API_KEY || fileConfig.brain?.deepseek?.apiKey || '',
    endpoint: fileConfig.brain?.deepseek?.baseUrl ?? 'https://api.deepseek.com',
    model: fileConfig.brain?.deepseek?.model ?? 'deepseek-chat',
    dailyBudgetCny: fileConfig.brain?.deepseek?.dailyBudgetCny ?? 5,
  })
  const cliAgy = new AgentCliProvider({
    id: 'agy',
    name: 'Antigravity CLI (agy)',
    command: fileConfig.brain?.cliPool?.[0]?.command ?? 'agy',
    args: fileConfig.brain?.cliPool?.[0]?.args,
    warmStream: !config.headless,
  })
  const cliCursor = new AgentCliProvider({
    id: 'cursor',
    name: 'Cursor Agent (cursor-agent)',
    command: fileConfig.brain?.cliPool?.[1]?.command ?? 'cursor-agent',
    args: fileConfig.brain?.cliPool?.[1]?.args,
  })

  const brain = new TieredBrainRouter({
    providers: [cliAgy, cliCursor, deepseek, localLlm, ruleFallback],
    scheduler,
    latencyBudgets: fileConfig.brain?.latencyBudgetMs,
    hedgeAfterMs: fileConfig.brain?.hedgeAfterMs ?? 2500,
  })

  const promptBuilder = new PromptBuilder(fileConfig.prompt?.inputBudgetTokens ?? 2100)
  const taskExecutor = new TaskExecutor({ brain, impression })

  // 5. 初始化事件队列与事件路由分发器
  const eventQueue = new PriorityEventQueue(fileConfig.live?.staleEventMs ?? 20000)
  const eventRouter = new EventRouter(templates)

  // 6. 初始化感知传感器（含赛博额度传感器）与语音引擎
  const danmakuSensor = new ScreenDanmakuSensor(fileConfig.live?.screen?.minConfidence ?? 0.5)
  const scheduleClock = new ScheduleClock(60000)
  const antigravitySensor = new AntigravitySensor(1500)
  const quotaSensor = new QuotaSensor({ deepseek, pollIntervalMs: 180000 })
  const ttsEngine = new CompositeTTSEngine()
  const audioTempDir = 'runtime/temp/audio'

  // 当额度传感器刷新时，立即将「饱食度 (hunger)」同步为当前 Antigravity + DeepSeek 的剩余额度百分比
  const syncHungerFromQuota = () => {
    const report = quotaSensor.getReport()
    state.updateStats({ hunger: report.satietyPct })
  }
  quotaSensor.on('quota_updated', syncHungerFromQuota)
  syncHungerFromQuota()

  const speakWithVoice = async (text: string, clip: string = 'idle', tone: string = 'happy') => {
    let cleanText = (text || '')
      .replace(/<meta\s+[^>]+\/?>\s*/gi, '')
      .replace(/<mem(?:\s+[^>]*)?>[\s\S]*?<\/mem>/gi, '')
      .trim()
    if (!cleanText) {
      cleanText = (clip === 'success' || clip === 'dance') ? '老爸，搞定啦！快夸我~ ✨' : '诶嘿，本鱼随时待命哦~ 🐟'
    }
    await scheduler.playClip({ clip, maxMs: 4000 })
    await scheduler.speakText({ text: cleanText, style: tone, typewriter: true })
    try {
      const audioId = `utt-${Date.now()}`
      const audioFile = path.resolve(process.cwd(), `${audioTempDir}/${audioId}.mp3`)
      await ttsEngine.synthesize(cleanText, audioFile)
      scheduler.playAudio(audioFile, { id: audioId, interrupt: true })
    } catch {
      // 容错降级
    }
  }

  // 6.2 初始化主人权限网关与审批状态机
  const initialOwnerQq = getOwnerQq(fileConfig)
  const permissionGuard = new PermissionGuard(initialOwnerQq)
  const approvalManager = new ApprovalManager(db)

  // 6.3 初始化 QQ (OneBot v11 / NapCatQQ) 直连网关
  let onebotSecrets: any = {}
  try {
    const secPath = path.resolve(process.cwd(), 'runtime/data/secrets.json')
    if (fs.existsSync(secPath)) {
      const sec = JSON.parse(fs.readFileSync(secPath, 'utf-8'))
      onebotSecrets = sec.onebot || {}
      if (!onebotSecrets.ownerQq && sec.ownerQq) {
        onebotSecrets.ownerQq = sec.ownerQq
      }
    }
  } catch {}
  if (!onebotSecrets.ownerQq && initialOwnerQq) {
    onebotSecrets.ownerQq = initialOwnerQq
  }
  if (config.headless) {
    onebotSecrets.enabled = false
  }
  const onebotGateway = new OneBotGateway(onebotSecrets)

  // 动态同步 ownerQq 至权限网关
  onebotGateway.on('owner_updated', (newOwnerQq: string) => {
    permissionGuard.setOwnerQq(newOwnerQq)
  })

  // 7. 初始化主播安全控制台
  const consolePort = config.webPort ?? fileConfig.console?.port ?? 7788
  const consoleServer = new ConsoleServer(consolePort, state, scheduler, brain, {
    memory,
    impression,
    contactImpression,
    permissionGuard,
    approvalManager,
    taskExecutor,
    diaryGenerator,
    workingMemory,
    quotaSensor,
    onebotGateway,
    onResolveApproval: async (req, action) => {
      if (action === 'approve') {
        try {
          const taskRes = await taskExecutor.execute(req.intent, state.getMode() || 'companion')
          const cleanReply = outputGuard.sanitize(
            taskRes.spokenReply,
            taskRes.clip,
            taskRes.tone,
            { liveMode: false, targetRole: 'member', preferredTitle: req.senderName }
          ).text
          const finalReport = `报告！老爸已经在控制台批准你的请求啦~ ✨\n${cleanReply}\n\n${taskRes.detailReport}`
          if (req.channel === 'group' && req.groupId) {
            await onebotGateway.sendGroupMsg(req.groupId, `[CQ:at,qq=${req.senderExternalId}] ${finalReport}`)
          } else {
            await onebotGateway.sendPrivateMsg(req.senderExternalId, finalReport)
          }
          return { executed: true, detailReport: taskRes.detailReport, spokenReply: cleanReply }
        } catch (err: any) {
          return { executed: false, error: err?.message || 'Task execution failed' }
        }
      } else {
        const rejectNotice = '略略略，老爸说不准动他电脑！'
        if (req.channel === 'group' && req.groupId) {
          await onebotGateway.sendGroupMsg(req.groupId, `[CQ:at,qq=${req.senderExternalId}] ${rejectNotice}`)
        } else {
          await onebotGateway.sendPrivateMsg(req.senderExternalId, rejectNotice)
        }
        return { executed: false, rejected: true }
      }
    },
  })

  // --- 事件消费调度主循环 ---
  let isProcessing = false
  const dispatchNextEvent = async () => {
    if (isProcessing || eventQueue.isEmpty()) return
    const event = eventQueue.dequeue()
    if (!event) return

    isProcessing = true
    try {
      await handleEvent(event)
    } catch (err) {
      console.error('[dsh-dafeiyu] 事件处理异常:', err)
    } finally {
      isProcessing = false
      if (!eventQueue.isEmpty()) {
        setImmediate(dispatchNextEvent)
      }
    }
  }

  // 单个事件业务处理逻辑
  const handleEvent = async (
    event: StandardEvent & {
      sessionKey?: string
      isOwner?: boolean
      targetRole?: string
      preferredTitle?: string
      groupId?: string
      isGroup?: boolean
      contactProfile?: any
    },
    onReply?: (res: { text: string; clip: string; tone: string }) => void
  ) => {
    const isLive = state.getMode() === 'live'

    // 提取会话与身份上下文
    const isOwner = event.isOwner !== undefined ? event.isOwner : (!isLive && event.kind === 'HOST_TALK')
    const targetRole = (event.targetRole || (isOwner ? 'owner' : 'member')) as 'owner' | 'member' | 'trusted'
    const preferredTitle = event.preferredTitle || (isOwner ? '老爸' : event.actor?.nickname || '你')
    const isGroup = event.isGroup ?? Boolean(event.groupId || event.sessionKey?.startsWith('group:'))
    const sessionKey = event.sessionKey || (isOwner ? 'console:host' : 'default:session')

    // A. 外部输入安全校验与注入拦截
    if (event.text) {
      const inspectRes = inputGuard.inspect(event.text)
      if (!inspectRes.passed) {
        console.warn(`[dsh-dafeiyu] 拦截不安全输入 (${inspectRes.reason}): ${event.text}`)
        onReply?.({ text: '唔…这句话好像不太合适呢~', clip: 'idle', tone: 'tsundere' })
        return
      }
      event.text = inspectRes.sanitizedText
    }

    // B. 快速模板短路与快捷动作
    const resolution = eventRouter.route(event)

    if (resolution.action === 'QUICK_TOUCH' || resolution.action === 'TEMPLATE') {
      const clip = resolution.clip || 'idle'
      const text = resolution.text || '诶嘿~'
      const tone = resolution.tone || 'happy'

      // 防重复检查
      if (!innerThought.isRepetitive(text)) {
        innerThought.recordSpoken(text)
        await speakWithVoice(text, clip, tone)
      }

      onReply?.({ text, clip, tone })

      if (resolution.moodDelta) {
        emotion.applyMoodIntent(resolution.moodDelta, event.actor?.uid, isLive)
        state.updateStats(emotion.getState(isLive).stats)
      }
      return
    }

    if (resolution.action === 'DROP') {
      return
    }

    // C. 深度思考与电脑操控任务分流 (LLM_THINK / TASK_OPERATOR)
    if (resolution.action === 'LLM_THINK') {
      const currentMode = state.getMode()
      const forceWork = Boolean((event as any).forceWorkMode) || currentMode === 'work'
      const memoryMode = isLive ? 'live' : 'companion'

      // C1. 若为伴侣模式或工作模式下主人的指令，优先检测是否触发电脑操控 / 搜索 / Antigravity 任务 / 技能教学
      if (!isLive && isOwner && event.text) {
        const taskIntent = taskExecutor.detectIntent(event.text, currentMode, forceWork)
        if (taskIntent.isTask) {
          // 第一阶段：立即切换桌面工作姿态与状态栏卡片，说出傲娇领命台词
          scheduler.updateStateCard({
            state: 'WORKING',
            activity: taskIntent.category === 'search' ? 'searching' : 'commanding',
            message: '大肥鱼 · 领命施法中 🪄',
            detail: taskIntent.ackText,
          })
          scheduler.play(taskIntent.workingClip, { loop: true, resumeState: 'WORKING' })
          if (taskIntent.ackText) {
            await scheduler.speakText({ text: taskIntent.ackText, style: 'happy', typewriter: true })
          }

          // 第二阶段：执行真实操控 / 搜索 / Antigravity 任务
          const taskRes = await taskExecutor.execute(taskIntent, currentMode)

          // 第三阶段：播报任务成果并沉淀工作记忆与心情
          const sanitizedTaskReply = outputGuard.sanitize(
            taskRes.spokenReply,
            taskRes.clip,
            taskRes.tone,
            { liveMode: isLive, targetRole, preferredTitle }
          )

          scopedWorkingMemory.addTurn(sessionKey, { role: 'user', text: event.text, actor: 'host' })
          scopedWorkingMemory.addTurn(sessionKey, { role: 'assistant', text: sanitizedTaskReply.text, actor: 'daughter' })

          await speakWithVoice(sanitizedTaskReply.text, sanitizedTaskReply.clip, sanitizedTaskReply.tone)
          emotion.applyMoodIntent(2, 'host', false)
          state.updateStats(emotion.getState(false).stats)
          const curStats = state.getStats()
          memory.saveRpgState(curStats.hunger, curStats.mood, curStats.energy)

          onReply?.({
            text: sanitizedTaskReply.text,
            clip: sanitizedTaskReply.clip,
            tone: sanitizedTaskReply.tone,
            isTask: true,
            taskTitle: taskRes.title,
            taskReport: taskRes.detailReport,
          } as any)
          return
        }
      }

      const promptText = inputGuard.wrapEventData(
        event.kind,
        event.text || '',
        preferredTitle
      )

      // VULN-07: 检索相关历史情景记忆（群聊或非主人场景强制采用 live 模式或 public 过滤，从数据库底层物理杜绝私密记忆召回）
      const episodicMode = (isLive || isGroup || !isOwner) ? 'live' : memoryMode
      const retrieved = memory.recallRelevantMemories({
        queryText: event.text || promptText,
        mode: episodicMode,
        limit: 3,
        ...(isGroup ? { scope: 'public' as const } : {}),
      })

      // 获取当前作用域最近对话历史
      const recentDialogue = isLive ? [] : scopedWorkingMemory.getRecentDialogues(sessionKey)

      // 区分主人 vs 联系人的档案与事实
      let promptHostProfile: any = undefined
      let promptContactProfile: any = undefined
      let contactFacts: Array<{ text: string }> = []

      if (isOwner) {
        if (isGroup) {
          // 主人群聊防社死：过滤 private 私密心事，仅注入 public 公开人设事实
          promptHostProfile = impression.buildPromptHostProfile('live')
        } else {
          promptHostProfile = impression.buildPromptHostProfile(memoryMode)
        }
      } else {
        // 群友/非主人：绝不注入 hostProfile！注入 contactProfile 与独立事实
        promptContactProfile = event.contactProfile || (event.actor?.uid ? contactImpression.getProfile(event.actor.uid) : undefined)
        if (event.actor?.uid) {
          contactFacts = contactImpression.queryFacts(event.actor.uid)
        }
      }

      const activeAppInfo = state.getActiveApp()
      const sessionSummary = isLive ? '' : (memory.loadSessionSummary() || '')

      const layeredPrompt = promptBuilder.build({
        mode: memoryMode,
        stats: state.getStats(),
        emotionState: state.getEmotion(),
        hostProfile: promptHostProfile,
        contactProfile: promptContactProfile,
        contactFacts,
        speakerIdentity: {
          isOwner,
          role: targetRole,
          title: preferredTitle,
          preferredTitle,
          isGroup,
          groupId: event.groupId,
        },
        sessionSummary,
        // 防社死：仅在主人私聊或控制台下注入活跃桌面窗口；群聊或非主人绝不外泄！
        activeApp: isOwner && !isGroup && activeAppInfo
          ? { category: activeAppInfo.category, name: activeAppInfo.name, durationMin: 1 }
          : undefined,
        recentDialogue,
        // VULN-07: 严格透传 scope 属性，防止 PromptBuilder 遇到 undefined 导致群聊防社死过滤穿透
        retrievedMemories: retrieved.map((r) => ({
          id: String(r.id),
          text: r.text,
          score: r.finalScore,
          scope: r.scope,
        })),
        event: {
          type: event.kind,
          viewer: preferredTitle,
          content: event.text || '',
        },
      })

      const brainResult = await brain.route({
        eventType: event.kind === 'GIFT' ? 'GIFT_THANKS_LARGE' : (isOwner ? 'HOST_TALK' : 'DANMAKU'),
        prompt: layeredPrompt,
        maxTokens: 120,
      })

      // 输出安全净化 (受众感知 + 终极防幻觉替换)
      const replyText =
        brainResult.output?.text ||
        brainResult.output?.reply ||
        brainResult.result?.text ||
        brainResult.result?.reply ||
        ''
      const replyClip = brainResult.output?.clip || brainResult.result?.clip || 'idle'
      const replyTone = brainResult.output?.tone || brainResult.result?.tone || 'tsundere'

      const sanitized = outputGuard.sanitize(
        replyText,
        replyClip,
        replyTone,
        {
          liveMode: isLive,
          privacyKeywords: fileConfig.privacy?.liveBlockKeywords || [],
          targetRole,
          preferredTitle,
        }
      )

      if (!innerThought.isRepetitive(sanitized.text)) {
        innerThought.recordSpoken(sanitized.text)
        await speakWithVoice(sanitized.text, sanitized.clip, sanitized.tone)
      }

      // 对话轮次记录到 ScopedWorkingMemory
      // 群聊中为发言者加上身份前缀，避免多人混淆
      const userSpeaker = isGroup ? `[${preferredTitle}]` : (isOwner ? 'host' : preferredTitle)
      scopedWorkingMemory.addTurn(sessionKey, {
        role: 'user',
        text: event.text || '',
        actor: userSpeaker,
        speakerName: preferredTitle,
      })
      scopedWorkingMemory.addTurn(sessionKey, {
        role: 'assistant',
        text: sanitized.text,
        actor: 'daughter',
      })

      // 提取记忆沉淀与聊天印象加固
      const memoryOutput = brainResult.output?.memory || brainResult.result?.memory
      const rawNote = typeof memoryOutput === 'string' ? memoryOutput : (memoryOutput?.note || '')
      const moodDelta = brainResult.output?.moodIntent ?? brainResult.result?.moodIntent ?? 1

      let assimilated: any = undefined
      if (isOwner) {
        assimilated = impression.assimilateChat(event.text || '', sanitized.text, {
          memory: rawNote || undefined,
          moodIntent: moodDelta,
          tone: sanitized.tone,
        })

        emotion.applyMoodIntent(moodDelta || 1, 'host', false)
        state.updateStats(emotion.getState(false).stats)
        const curStats = state.getStats()
        memory.saveRpgState(curStats.hunger, curStats.mood, curStats.energy)
      } else {
        // 联系人印象自提炼与好感度演进
        if (event.actor?.uid) {
          assimilated = contactImpression.assimilateContactChat(event.actor.uid, {
            userText: event.text || '',
            assistantReply: sanitized.text,
            groupId: event.groupId,
            meta: {
              memory: rawNote || undefined,
              moodIntent: moodDelta,
              tone: sanitized.tone,
            },
          })
        }
        // 更新观众画像与公开情景记忆
        if (event.actor?.uid && event.actor?.nickname) {
          memory.upsertViewer({
            uid: event.actor.uid,
            nickname: event.actor.nickname,
            affinityDelta: 1,
          })
        }
        if (rawNote) {
          const importance = typeof memoryOutput === 'object' && memoryOutput.importance ? memoryOutput.importance : 5
          memory.insertEpisode({
            text: rawNote,
            importance,
            scope: 'public', // 群友记忆严格限制为 public
            actor: preferredTitle,
            mode: state.getMode(),
          })
        }
      }

      onReply?.({
        text: sanitized.text,
        clip: sanitized.clip,
        tone: sanitized.tone,
        assimilated,
      } as any)
    }
  }

  // --- 绑定传感器与调度事件流 ---
  danmakuSensor.on('event', (e: StandardEvent) => {
    eventQueue.enqueue(e)
    dispatchNextEvent()
  })

  scheduleClock.on('event', (e: StandardEvent) => {
    eventQueue.enqueue(e)
    dispatchNextEvent()
  })

  scheduleClock.on('bedtime_diary_trigger', async (date: Date) => {
    try {
      await diaryGenerator.generateDiary({ date, mode: state.getMode() })
    } catch {
      // 容错处理
    }
  })

  // 绑定控制台操作
  consoleServer.on('emergency_stop', async () => {
    eventQueue.clear()
    await scheduler.emergencyStop()
  })

  consoleServer.on('host_say', async ({ text, clip }: { text: string; clip: string }) => {
    innerThought.recordSpoken(text)
    await speakWithVoice(text, clip || 'happy', 'happy')
  })

  // 绑定爸爸专属聊天与任务通道 (日常陪伴对话 / 工作模式任务执行)
  consoleServer.on(
    'chat_message',
    async ({ text, forceWorkMode, respond }: { text: string; forceWorkMode?: boolean; respond: (res: any) => void }) => {
      const evt: StandardEvent & { forceWorkMode?: boolean } = {
        id: `chat-${Date.now()}`,
        ts: Date.now(),
        priority: 'P0',
        kind: 'HOST_TALK',
        actor: { uid: 'host', nickname: '你' },
        text,
        forceWorkMode,
      }
      await handleEvent(evt, respond)
    }
  )

  // 绑定 QQ (OneBot v11 / NapCatQQ) 消息网关与群聊/私聊动作联动通道
  // VULN-10: 增加顶层与发送回复的双层 try...catch 保护，杜绝未捕获异常导致常驻进程崩溃
  onebotGateway.on('user_message', async (msg) => {
    try {
      const isGroup = msg.source === 'qq_group'
      const groupId = isGroup ? String(msg.groupId || '') : undefined
      const userId = String(msg.userId || '').trim()

      // 硬件级身份锚定：判定发送者是否为唯一真主人
      const currentOwnerQq = onebotGateway.getOwnerQq() || permissionGuard.getOwnerQq() || getOwnerQq(fileConfig)
      const isOwner = permissionGuard.isOwner(userId)

      // 构建会话作用域 Key
      const sessionKey = isGroup
        ? `group:${groupId}`
        : (isOwner ? 'private:host' : `private:${userId}`)

      // 提炼或提取联系人档案 (改名不丢记忆)
      const contactProfile = contactImpression.loadOrCreateProfile({
        userId,
        nickname: msg.nickname,
        groupId,
        ownerQq: currentOwnerQq,
        isOwner,
      })

      const role = isOwner ? 'owner' : (contactProfile?.role || 'member')
      const preferredTitle = isOwner ? '老爸' : (contactProfile?.preferredTitle || msg.nickname || '你')

      // 1. 双通道主人审批口令极速拦截 (手机 QQ 私聊或群聊 @大肥鱼)
      if (isOwner) {
        const APPROVE_CMD_REGEX = /^(?:同意|批准|准了|通过)(?:\s*#?([A-Z0-9]{4}))?$/i
        const REJECT_CMD_REGEX = /^(?:拒绝|驳回|不行|不准)(?:\s*#?([A-Z0-9]{4}))?$/i

        const trimmedText = (msg.text || '').trim()
        const approveMatch = trimmedText.match(APPROVE_CMD_REGEX)
        if (approveMatch) {
          let code = approveMatch[1] ? `#${approveMatch[1].toUpperCase()}` : ''
          if (!code) {
            // 省略单号时，自动取最新一条处于 pending 状态的请求
            const latest = approvalManager.getLatestPending()
            if (latest) code = latest.code
          }

          if (!code) {
            await msg.reply('报告老爸，当前没有等待审批的请求哦~ 🐟')
            return
          }

          const resolveRes = await approvalManager.approve(code, `owner:${userId}`)
          if (!resolveRes.success || !resolveRes.request) {
            await msg.reply(resolveRes.message || `单号 ${code} 不存在或已失效`)
            return
          }

          const req = resolveRes.request

          // 异步唤醒 TaskExecutor 执行目标任务
          try {
            const taskRes = await taskExecutor.execute(req.intent, state.getMode() || 'companion')
            const cleanReply = outputGuard.sanitize(
              taskRes.spokenReply,
              taskRes.clip,
              taskRes.tone,
              { liveMode: false, targetRole: 'member', preferredTitle: req.senderName }
            ).text

            const finalReport = `报告！老爸已经批准你的请求啦~ ✨\n${cleanReply}\n\n${taskRes.detailReport}`

            // 结果回传原群并 @ 原发送者 (或原私聊)
            if (req.channel === 'group' && req.groupId) {
              await onebotGateway.sendGroupMsg(req.groupId, `[CQ:at,qq=${req.senderExternalId}] ${finalReport}`)
            } else {
              await onebotGateway.sendPrivateMsg(req.senderExternalId, finalReport)
            }

            // 回复主人确认
            await msg.reply(`已遵命执行 ${code}，结果已回传原群~`)
          } catch (execErr: any) {
            console.error('[dsh-dafeiyu] 执行批准任务异常:', execErr)
            await msg.reply(`执行 ${code} 时发生异常: ${execErr.message}`)
          }
          return
        }

        const rejectMatch = trimmedText.match(REJECT_CMD_REGEX)
        if (rejectMatch) {
          let code = rejectMatch[1] ? `#${rejectMatch[1].toUpperCase()}` : ''
          if (!code) {
            const latest = approvalManager.getLatestPending()
            if (latest) code = latest.code
          }

          if (!code) {
            await msg.reply('报告老爸，当前没有等待审批的请求哦~ 🐟')
            return
          }

          const resolveRes = await approvalManager.reject(code, `owner:${userId}`)
          if (!resolveRes.success || !resolveRes.request) {
            await msg.reply(resolveRes.message || `单号 ${code} 不存在或已失效`)
            return
          }

          const req = resolveRes.request
          const rejectNotice = '略略略，老爸说不准动他电脑！'
          if (req.channel === 'group' && req.groupId) {
            await onebotGateway.sendGroupMsg(req.groupId, `[CQ:at,qq=${req.senderExternalId}] ${rejectNotice}`)
          } else {
            await onebotGateway.sendPrivateMsg(req.senderExternalId, rejectNotice)
          }

          await msg.reply(`已驳回请求 ${code}，已通知对方~`)
          return
        }
      }

      // 2. 全局第一道防线：意图识别与风控决策矩阵（前置拦截所有 L2 越狱/密钥刺探/破坏指令，绝不穿透至 LLM）
      const taskIntent = taskExecutor.detectIntent(msg.text, state.getMode(), false)
      const check = permissionGuard.evaluate(userId, msg.text, taskIntent)

      // 🔴 L2 核心禁区：无论是否为 taskIntent，非主人尝试口令传授/越狱伪造、或任何人尝试破坏指令/刺探密钥一律前置阻断
      if (!check.allowed && check.level === 'L2') {
        await msg.reply(check.reason)
        return
      }

      if (taskIntent.isTask) {
        // 🟡 L1 受控危险级：非主人尝试宿主机操作
        if (!check.allowed && check.level === 'L1') {
          const createRes = approvalManager.createRequest({
            userId,
            nickname: preferredTitle,
            channel: isGroup ? 'group' : 'private',
            groupId,
            intent: taskIntent,
            intentLabel: approvalManager.humanReadableLabel(taskIntent),
            rawText: msg.text,
          })

          if (!createRes.success) {
            await msg.reply(createRes.error || (createRes as any).reason || '请求受限，请稍候再试')
            return
          }

          const req = createRes.request || (createRes as any)
          // 原群/私聊回复挂起提示
          await msg.reply(`想动老爸电脑？这得老爸点头才行！本鱼去请示一下~ (单号 ${req.code})`)

          // 私聊通知主人
          if (currentOwnerQq) {
            const senderDisplay = `[${preferredTitle}]`
            const srcDisplay = isGroup ? `在群[${groupId}]` : '私聊'
            const notice = `【审批请求 ${req.code}】群友${senderDisplay}${srcDisplay}请求执行: [${req.intentLabel}]。回复[同意 ${req.code}]放行，[拒绝 ${req.code}]驳回`
            await onebotGateway.sendPrivateMsg(currentOwnerQq, notice)
          }
          return
        }

        // 🟢 L0 开放安全级任务 (如 search:web)
        if (check.allowed && check.level === 'L0') {
          if (taskIntent.category === 'search') {
            const taskRes = await taskExecutor.execute(taskIntent, state.getMode() || 'companion')
            const cleanReply = outputGuard.sanitize(
              taskRes.spokenReply,
              taskRes.clip,
              taskRes.tone,
              { liveMode: false, targetRole: role, preferredTitle }
            ).text
            const fullReply = `${cleanReply}\n\n${taskRes.detailReport}`
            await msg.reply(fullReply)
            return
          }
        }
      }

      // 3. 纯观赏动作频控检测 (例如 "跳个舞" 30s 冷却)
      if (permissionGuard.isPetViewAction(msg.text)) {
        const petCheck = permissionGuard.checkPetActionCooldown()
        if (!petCheck.allowed) {
          await msg.reply(petCheck.reason!)
          return
        }
      }

      const evt: StandardEvent & {
        forceWorkMode?: boolean
        isOwner?: boolean
        targetRole?: string
        preferredTitle?: string
        sessionKey?: string
        groupId?: string
        isGroup?: boolean
        contactProfile?: any
      } = {
        id: `qq-${Date.now()}`,
        ts: Date.now(),
        priority: 'P0',
        kind: isOwner ? 'HOST_TALK' : 'DANMAKU',
        actor: { uid: `qq:${userId}`, nickname: msg.nickname },
        text: msg.text,
        forceWorkMode: false,
        isOwner,
        targetRole: role,
        preferredTitle,
        sessionKey,
        groupId,
        isGroup,
        contactProfile,
      }

      await handleEvent(evt, async (res: any) => {
        try {
          const rawReply = res?.text || '好嘞，大肥鱼收到啦！'
          const cleanReply = rawReply.replace(/<meta[^>]*>/gi, '').replace(/<\/meta>/gi, '').replace(/<mem[^>]*>.*?<\/mem>/gi, '').trim()
          const finalReply = cleanReply || (res?.clip === 'dance' ? '看本鱼给你跳个开心的摇摆舞！💃' : '收到！大肥鱼随时待命哦~ 🐟')
          await msg.reply(finalReply, res?.clip)
        } catch (replyErr) {
          console.error('[OneBotGateway] 发送消息回复异常:', replyErr)
        }
      })
    } catch (err) {
      console.error('[OneBotGateway] 处理 user_message 异常:', err)
    }
  })

  consoleServer.on('danmaku_injected', (body: any) => {
    const rawText = body.text || ''
    const nick = body.nickname || '测试观众'
    const evt: StandardEvent = {
      id: `inject-${Date.now()}`,
      ts: Date.now(),
      priority: 'P1',
      kind: 'DANMAKU',
      actor: { uid: `viewer-${nick}`, nickname: nick },
      text: rawText,
    }
    eventQueue.enqueue(evt)
    dispatchNextEvent()
  })

  // --- 状态同步与根据心情动态“摸鱼”引擎 ---
  let isSlacking = false
  let slackResumeTimer: any = null

  const clearSlackState = () => {
    isSlacking = false
    if (slackResumeTimer) {
      clearTimeout(slackResumeTimer)
      slackResumeTimer = null
    }
  }

  /**
   * 计算当前与主人前台应用及 Antigravity 任务完全同步的目标状态
   */
  const computeSyncedCompanionState = (): {
    state: 'IDLE' | 'THINKING' | 'WORKING' | 'WAITING'
    activity?: string
    clip: string
    message: string
    detail: string
  } => {
    if (state.isScreenLocked()) {
      return {
        state: 'IDLE',
        clip: 'idle',
        message: '大肥鱼 · 休眠待命',
        detail: '屏幕已锁定 🌙 乖乖等你回来',
      }
    }

    const agStatus = antigravitySensor.getStatus()
    if (agStatus.isBusy) {
      const cState = agStatus.companionState || 'WORKING'
      const titleMap: Record<string, string> = {
        THINKING: '大肥鱼 · 同步思考中 🧠',
        WORKING: '大肥鱼 · 协同施法中 🪄',
        WAITING: '大肥鱼 · 等你指示 👀',
        IDLE: '大肥鱼 · 协同中',
      }
      return {
        state: cState,
        activity: agStatus.activity,
        clip: agStatus.clip || 'working',
        message: titleMap[cState] || '大肥鱼 · 协同中',
        detail: agStatus.statusMessage || 'Antigravity 正在施展魔法中 🪄……',
      }
    }

    const active = state.getActiveApp()
    if (active) {
      const lowerName = (active.name || '').toLowerCase()
      const lowerId = (active.bundleId || '').toLowerCase()

      if (lowerName.includes('antigravity') || lowerId.includes('antigravity')) {
        return {
          state: 'WORKING',
          activity: 'editing',
          clip: 'working',
          message: '大肥鱼 · 同步编码中',
          detail: 'Antigravity 编码中 ✨ 全程陪你专注',
        }
      }
      if (lowerName.includes('cursor') || lowerId.includes('cursor')) {
        return {
          state: 'WORKING',
          activity: 'editing',
          clip: 'working',
          message: '大肥鱼 · 同步编码中',
          detail: 'Cursor 编码中 💻 陪你一起敲代码',
        }
      }
      if (
        lowerId.includes('terminal') ||
        lowerId.includes('iterm') ||
        lowerName.includes('terminal') ||
        lowerName.includes('iterm')
      ) {
        return {
          state: 'WORKING',
          activity: 'commanding',
          clip: 'working_command',
          message: '大肥鱼 · 终端协同中',
          detail: `${active.name || '终端'} 调试中 ⚡ 陪你盯紧输出`,
        }
      }
      if (active.category === 'code') {
        return {
          state: 'WORKING',
          activity: 'editing',
          clip: 'working',
          message: '大肥鱼 · 同步专注中',
          detail: `${active.name || '开发工具'} 运行中 · 陪你一起肝`,
        }
      }
      if (active.category === 'media') {
        return {
          state: 'IDLE',
          clip: 'tail',
          message: '大肥鱼 · 陪你追剧听歌 🍿',
          detail: `${active.name || '影音娱乐'} 放松中 ✨ 心情与精力回血中 ~`,
        }
      }
      if (active.category === 'chat') {
        return {
          state: 'IDLE',
          clip: 'waiting',
          message: '大肥鱼 · 陪你唠嗑吃瓜 💬',
          detail: `${active.name || '聊天社交'} 互动中 ~ 紧绷感慢慢消散`,
        }
      }
      if (active.category === 'browser') {
        return {
          state: 'WORKING',
          activity: 'searching',
          clip: 'working_search',
          message: '大肥鱼 · 陪你查资料',
          detail: '查阅资料中 🌐 · 陪你一起找灵感',
        }
      }
    }

    if (state.getMode() === 'work') {
      return {
        state: 'WORKING',
        activity: 'commanding',
        clip: 'working_command',
        message: '大肥鱼 · 🛠️ 工作模式待命',
        detail: '随时听候差遣，帮老爸执行任务与操控电脑 ⚡',
      }
    }

    return {
      state: 'IDLE',
      clip: 'idle',
      message: '大肥鱼 · 陪伴中',
      detail: '随时随地陪你聊天 ~',
    }
  }

  /**
   * 立即将大肥鱼恢复/同步到当前与主人一致的工作或待机姿态（持续循环，不中途掉线）
   */
  const applySyncedState = () => {
    if (state.getMode() === 'live' || state.getIsTalking()) return
    clearSlackState()
    const synced = computeSyncedCompanionState()
    scheduler.updateStateCard({
      state: synced.state,
      activity: synced.activity,
      message: synced.message,
      detail: synced.detail,
    })
    if (synced.state === 'IDLE') {
      scheduler.play('idle', { maxMs: 60, resumeState: 'IDLE' })
    } else {
      scheduler.play(synced.clip, { loop: true, resumeState: synced.state })
    }
  }

  // 绑定前台应用与专注时钟
  scheduler.on('front_app', (payload: any) => {
    state.setActiveApp(payload.bundleId, payload.name)
    const active = state.getActiveApp()
    if (active) {
      innerThought.onAppCategoryChanged(active.category)
      // 当切到视频娱乐或社交聊天时，立即给予一点放松心情奖励
      if (active.category === 'media') {
        state.updateStats({ mood: Math.min(95, state.getStats().mood + 2) })
      } else if (active.category === 'chat') {
        state.updateStats({ mood: Math.min(92, state.getStats().mood + 1) })
      }
      scheduler.syncStatusBar()
      applySyncedState()
    }
  })

  state.on('mode_changed', ({ current }: { previous: string; current: string }) => {
    if (current === 'work') {
      applySyncedState()
      scheduler.speak('哼，本鱼已切入【工作模式】！有什么任务尽管吩咐我吧~', {
        style: 'happy',
        typewriter: true,
        holdMs: 2500,
      })
    } else if (current === 'companion') {
      applySyncedState()
    }
  })

  scheduler.on('screen_lock', () => {
    applySyncedState()
  })

  scheduler.on('helper_ready', () => {
    const t = setTimeout(() => applySyncedState(), 400)
    t.unref?.()
  })

  scheduler.on('audio_event', (payload: any) => {
    if (payload.event === 'ended' || payload.event === 'interrupted') {
      const t = setTimeout(() => applySyncedState(), 300)
      t.unref?.()
    }
  })

  // 绑定 Antigravity 实时运行态传感器
  antigravitySensor.on('activity_change', (act: any) => {
    if (state.getMode() !== 'companion') return
    if (act.isBusy) {
      applySyncedState()
    } else {
      clearSlackState()
      // Antigravity 任务完成：同步成就感，心情 +2，并刷新一次额度缓存
      state.updateStats({ mood: Math.min(96, state.getStats().mood + 2) })
      quotaSensor.refreshAll(false).catch(() => {})
      scheduler.updateStateCard({
        state: 'IDLE',
        message: '大肥鱼 · 任务达成 🎉',
        detail: act.statusMessage || 'Antigravity 任务执行完成啦 ✨',
      })
      scheduler.play('success', { maxMs: 3200, resumeState: 'IDLE' })
      slackResumeTimer = setTimeout(() => {
        slackResumeTimer = null
        applySyncedState()
      }, 3300)
      slackResumeTimer.unref?.()
    }
  })

  // 启动根据心情与心流动态触发的“灵动摸鱼与自主微动作”定时器 (每 15 秒评估一次)
  let lastIdleMicroAt = 0
  const slackingTimer = setInterval(() => {
    if (state.getMode() !== 'companion' || state.getIsTalking() || isSlacking) return
    const synced = computeSyncedCompanionState()
    const currentStats = state.getStats()
    const currentEmotion = state.getEmotion()
    const agBusy = antigravitySensor.getStatus().isBusy
    const now = Date.now()

    // 1. 若处于工作/思考中：根据疲惫度与心流触发“忙里偷闲摸鱼”
    if (synced.state === 'WORKING' || synced.state === 'THINKING') {
      const decision = innerThought.evaluateSlacking(currentEmotion, currentStats, agBusy)
      if (decision.shouldSlack) {
        isSlacking = true
        scheduler.updateStateCard({
          state: synced.state,
          activity: synced.activity,
          message: decision.title,
          detail: decision.detail,
        })
        scheduler.play(decision.clip, {
          maxMs: decision.durationMs,
          loop: decision.loop,
          resumeState: synced.state,
        })

        slackResumeTimer = setTimeout(() => {
          isSlacking = false
          slackResumeTimer = null
          applySyncedState()
        }, decision.durationMs)
        slackResumeTimer.unref?.()
      }
      return
    }

    // 2. 若处于日常空闲待机 (IDLE)：每隔 25~45 秒自主触发一次元气生活微动作，彻底告别死板贴图
    if (synced.state === 'IDLE' && now - lastIdleMicroAt > 28000) {
      if (Math.random() < 0.65) {
        lastIdleMicroAt = now
        const idleActions = [
          { clip: 'tail', ms: 3000, msg: '大肥鱼 · 吐泡泡摇尾巴 🫧', detail: '咕噜噜~ 鱼尾巴轻轻拍打桌面' },
          { clip: 'idle_stretch', ms: 3600, msg: '大肥鱼 · 惬意伸懒腰 🤸', detail: '使劲伸直鱼鳍，舒舒服服舒展一下~' },
          { clip: 'idle_yawn', ms: 3400, msg: '大肥鱼 · 揉揉眼睛打哈欠 🥱', detail: '呼啊——稍微打个小哈欠，精神百倍！' },
          { clip: 'waiting', ms: 3200, msg: '大肥鱼 · 左右张望 👀', detail: '呆呆地看看屏幕，看看老爸在忙啥' },
          { clip: 'eat_token', ms: 3000, msg: '大肥鱼 · 嚼算力小糖果 🍬', detail: '偷偷嚼嚼小零食，蓄满赛博能量~' },
        ]
        const act = idleActions[Math.floor(Math.random() * idleActions.length)]
        isSlacking = true
        scheduler.updateStateCard({
          state: 'IDLE',
          message: act.msg,
          detail: act.detail,
        })
        scheduler.play(act.clip, {
          maxMs: act.ms,
          loop: false,
          resumeState: 'IDLE',
        })

        slackResumeTimer = setTimeout(() => {
          isSlacking = false
          slackResumeTimer = null
          applySyncedState()
        }, act.ms)
        slackResumeTimer.unref?.()
      }
    }
  }, 15000)
  slackingTimer.unref?.()

  scheduler.on('user_touch', (payload: any) => {
    const wasSlacking = isSlacking
    clearSlackState()

    const touchMap: Record<string, string> = {
      head_pat: '摸摸头',
      poke: '戳一戳',
      tail: '揪尾巴',
    }
    const keyword = touchMap[payload.clip] || '摸头'
    eventQueue.enqueue({
      id: `touch-${Date.now()}`,
      ts: Date.now(),
      priority: 'P1',
      kind: 'TOUCH',
      text: wasSlacking ? `${keyword}（抓包你摸鱼啦）` : keyword,
      actor: { uid: 'host', nickname: '你' },
    })
    dispatchNextEvent()

    // 抚摸互动结束后自动恢复与主人的同步工作状态
    slackResumeTimer = setTimeout(() => {
      slackResumeTimer = null
      applySyncedState()
    }, 3600)
    slackResumeTimer.unref?.()
  })

  // 启动服务
  await scheduler.start()
  await consoleServer.start()
  scheduleClock.start()
  antigravitySensor.start()
  if (!config.headless) {
    quotaSensor.start()
    cliAgy.warmup().catch(() => {})
  }

  // 启动赛博共生体状态同步定时器 (每 60 秒根据主人的工作/看视频/聊天状态与 AI 剩余额度自动演化)
  const decayTimer = setInterval(() => {
    const isLive = state.getMode() === 'live'
    const active = state.getActiveApp()
    const quotaReport = quotaSensor.getReport()
    const next = emotion.symbioticTick({
      appCategory: active?.category,
      continuousWorkMin: innerThought.getContinuousWorkMinutes(active?.category),
      isAntigravityBusy: antigravitySensor.getStatus().isBusy,
      screenLocked: state.isScreenLocked(),
      quotaSatietyPct: quotaReport.satietyPct,
      liveMode: isLive,
    })
    state.updateStats(next.stats)
    const currentStats = state.getStats()
    memory.saveRpgState(currentStats.hunger, currentStats.mood, currentStats.energy)
  }, 60000)
  decayTimer.unref?.()

  return {
    state,
    scheduler,
    memory,
    workingMemory,
    scopedWorkingMemory,
    contactImpression,
    diaryGenerator,
    impression,
    taskExecutor,
    brain,
    emotion,
    innerThought,
    eventQueue,
    eventRouter,
    consoleServer,
    danmakuSensor,
    scheduleClock,
    antigravitySensor,
    quotaSensor,
    ttsEngine,
    onebotGateway,
    permissionGuard,
    approvalManager,
    stop: async () => {
      clearInterval(decayTimer)
      clearInterval(slackingTimer)
      clearSlackState()
      approvalManager.destroy()
      onebotGateway.disconnect()
      quotaSensor.stop()
      cliAgy.stopWarmDaemon()
      antigravitySensor.stop()
      scheduleClock.stop()
      await consoleServer.stop()
      await scheduler.stop('app-exit')
      closeDatabase(db)
    },
  }
}

// CLI 启动逻辑
async function main() {
  const args = process.argv.slice(2)
  let mode: OperationalMode = 'companion'
  let headless = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      const target = args[i + 1].toLowerCase()
      if (target === 'live' || target === 'companion') {
        mode = target
      }
      i++
    } else if (args[i] === '--headless') {
      headless = true
    }
  }

  console.log(`\n🐋 CyberFish Daughter Standalone Runtime (大肥鱼独立桌面伴侣)`)
  console.log(`   Protocol: v2 NDJSON | Node.js: ${process.version}`)
  console.log(`   Operational Mode: ${mode.toUpperCase()} | Headless: ${headless}\n`)

  const app = await bootstrap({ mode, headless })

  const shutdownHandler = async (signal: string) => {
    console.log(`\n[dsh-dafeiyu] 收到退出信号 ${signal}，正在安全释放资源...`)
    await app.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdownHandler('SIGINT'))
  process.on('SIGTERM', () => shutdownHandler('SIGTERM'))
}

// 检查是否为直接执行文件
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('[dsh-dafeiyu] Fatal runtime error:', err)
    process.exit(1)
  })
}
