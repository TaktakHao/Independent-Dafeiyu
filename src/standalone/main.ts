/**
 * @file main.ts
 * CyberFish Daughter (大肥鱼独立伴侣) — 依赖注入组装根与启动入口 (Composition Root)
 *
 * 架构分层：
 * - Core & Config:      `core/config-loader.ts`, `core/state.ts`, `core/scheduler.ts`
 * - Memory & Persona:   `memory/*`, `persona/emotion.ts`, `persona/inner-thought.ts`
 * - Brain & Meme:       `brain/router.ts`, `brain/prompt-builder.ts`, `brain/task-executor.ts`, `brain/meme-manager.ts`
 * - Safety & Guards:    `safety/input-guard.ts`, `safety/output-guard.ts`, `safety/permission-guard.ts`, `safety/approval-manager.ts`
 * - Orchestrators:      `events/dialogue-pipeline.ts`, `gateway/qq-orchestrator.ts`, `persona/companion-lifecycle.ts`
 */

import { fileURLToPath } from 'node:url'

import { StateManager } from './core/state.ts'
import { RuntimeScheduler } from './core/scheduler.ts'
import type { StandaloneConfig } from './core/types.ts'
import {
  getOwnerQq,
  loadConfig,
  loadOneBotSecrets,
  loadSensitiveWords,
  loadTemplates,
  parseCliArgs,
} from './core/config-loader.ts'

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
import { DockerConnector, OkxDogConnector } from './brain/connectors.ts'
import { MemeManager } from './brain/meme-manager.ts'
import { CompositeTTSEngine, type ITTSEngine } from './brain/tts.ts'

import { EmotionEngine } from './persona/emotion.ts'
import { InnerThoughtLoop } from './persona/inner-thought.ts'
import { CompanionLifecycleController } from './persona/companion-lifecycle.ts'

import { InputGuard } from './safety/input-guard.ts'
import { OutputGuard } from './safety/output-guard.ts'
import { PermissionGuard } from './safety/permission-guard.ts'
import { ApprovalManager } from './safety/approval-manager.ts'

import { PriorityEventQueue } from './events/queue.ts'
import { EventRouter } from './events/router.ts'
import { DialoguePipeline } from './events/dialogue-pipeline.ts'

import { ScreenDanmakuSensor } from './sensors/screen-danmaku.ts'
import { ScheduleClock } from './sensors/schedule.ts'
import { AntigravitySensor } from './sensors/antigravity.ts'
import { QuotaSensor } from './sensors/quota.ts'
import { HomeWatchdogSensor } from './sensors/home-watchdog.ts'
import { ReminderManager } from './sensors/reminder-manager.ts'
import { OneBotGateway } from './gateway/onebot-gateway.ts'
import { QqOrchestrator } from './gateway/qq-orchestrator.ts'
import { ConsoleServer } from './console/server.ts'
import { SQLiteCheckpointer } from './graph/sqlite-checkpointer.ts'
import { buildCompanionGraph, type CompanionGraphState } from './graph/companion-graph.ts'
import type { CompiledGraph } from './graph/engine.ts'

export { getOwnerQq }

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
  homeWatchdog?: HomeWatchdogSensor
  reminderManager?: ReminderManager
  ttsEngine: ITTSEngine
  onebotGateway?: OneBotGateway
  permissionGuard?: PermissionGuard
  approvalManager?: ApprovalManager
  companionGraph?: CompiledGraph<CompanionGraphState>
  checkpointer?: SQLiteCheckpointer
  stop: () => Promise<void>
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

  // 1. 存储底座、工作记忆、主人与联系人印象引擎及日记生成器
  const dbPath = fileConfig.memory?.dbPath || 'runtime/data/daughter.db'
  const db = initDatabase({ path: dbPath })
  const memory = new MemoryStore(db)
  const diaryGenerator = new DiaryGenerator(memory)
  const impression = new HostImpressionEngine(memory)
  const contactImpression = new ContactImpressionEngine(db, memory)

  const scopedWorkingMemory = new ScopedWorkingMemory({
    defaultTokenBudget: fileConfig.memory?.workingTokens ?? 500,
    groupTokenBudget: 400,
    privateTokenBudget: 300,
  })
  const workingMemory = scopedWorkingMemory.getMemory('console:host')

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

  state.updateStats(memory.loadRpgState())

  // 2. 安全风控守卫与三轴情感引擎
  const inputGuard = new InputGuard(sensitiveWords)
  const outputGuard = new OutputGuard()
  const emotion = new EmotionEngine(
    fileConfig.emotion?.baselineMood ?? 60,
    fileConfig.emotion?.perViewerMoodCapPerMin ?? 6,
    fileConfig.emotion?.totalMoodCapPerMin ?? 15
  )
  const innerThought = new InnerThoughtLoop(30, 0.85)

  // 3. 分级大脑路由器、连接器与表情包引擎
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
  const operatorConfig = fileConfig.operator || {}
  const connectorConfig = fileConfig.connectors || {}
  const reminderManager = new ReminderManager(db, 10000)
  const dockerConnector = new DockerConnector()
  const okxDogConnector = new OkxDogConnector({ baseUrl: connectorConfig.okxDog?.baseUrl })

  const taskExecutor = new TaskExecutor({
    brain,
    impression,
    reminderManager,
    operator: operatorConfig,
    okxDog: okxDogConnector,
    docker: dockerConnector,
  })

  const homeWatchdog = new HomeWatchdogSensor({
    checkIntervalMs: fileConfig.watchdog?.checkIntervalMs ?? 3 * 60 * 1000,
    alertCooldownMs: fileConfig.watchdog?.alertCooldownMs ?? 60 * 60 * 1000,
    diskAlertThresholdGb: fileConfig.watchdog?.diskAlertThresholdGb ?? 10,
    batteryAlertThresholdPct: fileConfig.watchdog?.batteryAlertThresholdPct ?? 25,
    dockerConnector,
    okxDogConnector,
  })

  const memeManager = new MemeManager()
  memeManager.initDesktopMemes().catch(() => {})

  // 4. 事件队列、感知传感器与语音引擎
  const eventQueue = new PriorityEventQueue(fileConfig.live?.staleEventMs ?? 20000)
  const eventRouter = new EventRouter(templates)
  const danmakuSensor = new ScreenDanmakuSensor(fileConfig.live?.screen?.minConfidence ?? 0.5)
  const scheduleClock = new ScheduleClock(60000)
  const antigravitySensor = new AntigravitySensor(1500)
  const quotaSensor = new QuotaSensor({ deepseek, pollIntervalMs: 180000 })
  const ttsEngine = new CompositeTTSEngine()

  // 5. 核心对话推理管线 (DialoguePipeline)
  const dialoguePipeline = new DialoguePipeline({
    state,
    scheduler,
    memory,
    scopedWorkingMemory,
    impression,
    contactImpression,
    emotion,
    innerThought,
    inputGuard,
    outputGuard,
    eventQueue,
    eventRouter,
    brain,
    promptBuilder,
    taskExecutor,
    ttsEngine,
    liveBlockKeywords: fileConfig.privacy?.liveBlockKeywords || [],
  })

  // 6. 权限网关、微内核状态图 (CompanionGraph) 与 QQ 业务协调器 (QqOrchestrator)
  const initialOwnerQq = getOwnerQq(fileConfig)
  const permissionGuard = new PermissionGuard(initialOwnerQq)
  const approvalManager = new ApprovalManager(db)
  const onebotGateway = new OneBotGateway(loadOneBotSecrets(initialOwnerQq, config.headless))

  const checkpointer = new SQLiteCheckpointer(db)
  const companionWorkflow = buildCompanionGraph({
    state,
    inputGuard,
    outputGuard,
    permissionGuard,
    approvalManager,
    taskExecutor,
    brain,
    promptBuilder,
    memeManager,
    scopedWorkingMemory,
    impression,
    contactImpression,
    memory,
  })
  const companionGraph = companionWorkflow.compile({ checkpointer })

  const publicQueryTopics: string[] = Array.isArray(connectorConfig.publicQueryTopics)
    ? connectorConfig.publicQueryTopics
    : ['okx', 'web']

  const qqOrchestrator = new QqOrchestrator({
    state,
    onebotGateway,
    permissionGuard,
    approvalManager,
    contactImpression,
    outputGuard,
    taskExecutor,
    memeManager,
    dialoguePipeline,
    companionGraph,
    brain,
    homeWatchdog,
    reminderManager,
    fileConfig,
    publicQueryTopics,
    maxConcurrentOperatorTasks: Number(operatorConfig.maxConcurrent ?? 2),
  })
  qqOrchestrator.bind()

  // 7. 主播安全控制台与桌面共生生命周期控制器 (CompanionLifecycleController)
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
    onResolveApproval: qqOrchestrator.resolveApprovalFromConsole,
  })

  const lifecycleController = new CompanionLifecycleController({
    state,
    scheduler,
    memory,
    diaryGenerator,
    emotion,
    innerThought,
    eventQueue,
    dialoguePipeline,
    danmakuSensor,
    scheduleClock,
    antigravitySensor,
    quotaSensor,
    consoleServer,
    qqOrchestrator,
  })
  lifecycleController.start()

  // 8. 启动全链路运行时服务
  await scheduler.start()
  await consoleServer.start()
  scheduleClock.start()
  antigravitySensor.start()
  homeWatchdog.start()
  reminderManager.start()
  if (!config.headless) {
    quotaSensor.start()
    cliAgy.warmup().catch(() => {})
  }

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
    homeWatchdog,
    reminderManager,
    ttsEngine,
    onebotGateway,
    permissionGuard,
    approvalManager,
    companionGraph,
    checkpointer,
    stop: async () => {
      lifecycleController.stop()
      homeWatchdog.stop()
      reminderManager.stop()
      qqOrchestrator.destroy()
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

async function main() {
  const { mode, headless } = parseCliArgs(process.argv.slice(2))

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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('[dsh-dafeiyu] Fatal runtime error:', err)
    process.exit(1)
  })
}
