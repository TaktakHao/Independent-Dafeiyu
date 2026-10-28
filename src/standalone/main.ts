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
import { TieredBrainRouter } from './brain/router.ts'
import { RuleFallbackProvider } from './brain/providers/rule-fallback.ts'
import { LocalLlmProvider } from './brain/providers/local-llm.ts'
import { DeepSeekProvider } from './brain/providers/deepseek.ts'
import { AgentCliProvider } from './brain/cli-pool.ts'
import { PromptBuilder } from './brain/prompt-builder.ts'

import { EmotionEngine } from './persona/emotion.ts'
import { InnerThoughtLoop } from './persona/inner-thought.ts'

import { InputGuard } from './safety/input-guard.ts'
import { OutputGuard } from './safety/output-guard.ts'

import { PriorityEventQueue } from './events/queue.ts'
import { EventRouter } from './events/router.ts'
import type { StandardEvent } from './events/types.ts'

import { ScreenDanmakuSensor } from './sensors/screen-danmaku.ts'
import { ScheduleClock } from './sensors/schedule.ts'
import { ConsoleServer } from './console/server.ts'
import { CompositeTTSEngine, type ITTSEngine } from './brain/tts.ts'

export interface FullAppInstance {
  state: StateManager
  scheduler: RuntimeScheduler
  memory: MemoryStore
  brain: TieredBrainRouter
  emotion: EmotionEngine
  innerThought: InnerThoughtLoop
  eventQueue: PriorityEventQueue
  eventRouter: EventRouter
  consoleServer: ConsoleServer
  danmakuSensor: ScreenDanmakuSensor
  scheduleClock: ScheduleClock
  ttsEngine: ITTSEngine
  stop: () => Promise<void>
}

/**
 * 加载本地配置文件
 */
function loadConfig(configPath: string = 'config/daughter.config.json'): any {
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8')
      return JSON.parse(content)
    }
  } catch (err) {
    console.warn('[dsh-dafeiyu] 加载配置文件失败，将使用默认配置:', (err as Error).message)
  }
  return {}
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

  // 1. 初始化 SQLite 存储底座与记忆管理器
  const dbPath = fileConfig.memory?.dbPath || 'runtime/data/daughter.db'
  const db = initDatabase({ path: dbPath })
  const memory = new MemoryStore(db)

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

  // 4. 初始化分级大脑路由器
  const ruleFallback = new RuleFallbackProvider()
  const localLlm = new LocalLlmProvider({
    baseUrl: fileConfig.brain?.local?.baseUrl ?? 'http://127.0.0.1:11434',
    model: fileConfig.brain?.local?.chatModel ?? 'qwen2.5:14b',
  })
  const deepseek = new DeepSeekProvider({
    apiKey: process.env.DEEPSEEK_API_KEY || 'sk-dummy-key',
    baseUrl: fileConfig.brain?.deepseek?.baseUrl ?? 'https://api.deepseek.com',
    model: fileConfig.brain?.deepseek?.model ?? 'deepseek-chat',
    dailyBudgetLimit: fileConfig.brain?.deepseek?.dailyBudgetCny ?? 5,
  })
  const cliProvider = new AgentCliProvider({
    command: fileConfig.brain?.cliPool?.[0]?.command ?? 'agy',
  })

  const brain = new TieredBrainRouter({
    providers: [cliProvider, deepseek, localLlm, ruleFallback],
    scheduler,
    latencyBudgets: fileConfig.brain?.latencyBudgetMs,
    hedgeAfterMs: fileConfig.brain?.hedgeAfterMs ?? 2500,
  })

  const promptBuilder = new PromptBuilder(fileConfig.prompt?.inputBudgetTokens ?? 2100)

  // 5. 初始化事件队列与事件路由分发器
  const eventQueue = new PriorityEventQueue(fileConfig.live?.staleEventMs ?? 20000)
  const eventRouter = new EventRouter(templates)

  // 6. 初始化感知传感器与语音引擎
  const danmakuSensor = new ScreenDanmakuSensor(fileConfig.live?.screen?.minConfidence ?? 0.5)
  const scheduleClock = new ScheduleClock(60000)
  const ttsEngine = new CompositeTTSEngine()
  const audioTempDir = 'runtime/temp/audio'

  const speakWithVoice = async (text: string, clip: string = 'idle', tone: string = 'happy') => {
    await scheduler.playClip({ clip, maxMs: 4000 })
    await scheduler.speakText({ text, style: tone, typewriter: true })
    try {
      const audioId = `utt-${Date.now()}`
      const audioFile = path.resolve(process.cwd(), `${audioTempDir}/${audioId}.mp3`)
      await ttsEngine.synthesize(text, audioFile)
      scheduler.playAudio(audioFile, { id: audioId, interrupt: true })
    } catch {
      // 容错降级
    }
  }

  // 7. 初始化主播安全控制台
  const consolePort = config.webPort ?? fileConfig.console?.port ?? 7788
  const consoleServer = new ConsoleServer(consolePort, state, scheduler)

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
  const handleEvent = async (event: StandardEvent) => {
    const isLive = state.getMode() === 'live'

    // A. 外部输入安全校验与注入拦截
    if (event.text) {
      const inspectRes = inputGuard.inspect(event.text)
      if (!inspectRes.passed) {
        console.warn(`[dsh-dafeiyu] 拦截不安全输入 (${inspectRes.reason}): ${event.text}`)
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

      if (resolution.moodDelta) {
        emotion.applyMoodIntent(resolution.moodDelta, event.actor?.uid, isLive)
        state.updateStats(emotion.getState(isLive).stats)
      }
      return
    }

    if (resolution.action === 'DROP') {
      return
    }

    // C. 深度思考 (LLM_THINK)
    if (resolution.action === 'LLM_THINK') {
      const promptText = inputGuard.wrapEventData(
        event.kind,
        event.text || '',
        event.actor?.nickname || '观众'
      )

      // 检索记忆
      const retrieved = memory.searchMemories({
        query: promptText,
        mode: state.getMode(),
        limit: 3,
      })

      const layeredPrompt = promptBuilder.build({
        mode: state.getMode(),
        stats: state.getStats(),
        emotionState: state.getEmotion(),
        retrievedMemories: retrieved.map((r) => ({ id: String(r.id), text: r.content, score: r.score })),
        event: {
          type: event.kind,
          viewer: event.actor?.nickname || '观众',
          content: event.text || '',
        },
      })

      const brainResult = await brain.route({
        eventType: event.kind === 'GIFT' ? 'GIFT_THANKS_LARGE' : 'DANMAKU',
        prompt: layeredPrompt,
        maxTokens: 120,
      })

      // 输出安全净化
      const sanitized = outputGuard.sanitize(
        brainResult.content,
        brainResult.meta?.clip || 'idle',
        brainResult.meta?.tone || 'tsundere',
        {
          liveMode: isLive,
          privacyKeywords: fileConfig.privacy?.liveBlockKeywords || [],
        }
      )

      if (!innerThought.isRepetitive(sanitized.text)) {
        innerThought.recordSpoken(sanitized.text)
        await speakWithVoice(sanitized.text, sanitized.clip, sanitized.tone)
      }

      // 更新好感度与记忆
      if (event.actor?.uid && event.actor?.nickname) {
        memory.upsertViewer({
          uid: event.actor.uid,
          nickname: event.actor.nickname,
          affinityDelta: 1,
        })
      }

      // 提取记忆沉淀
      if (brainResult.memory) {
        memory.addEpisode({
          content: brainResult.memory.note,
          importance: brainResult.memory.importance,
          scope: isLive ? 'live' : 'private',
          actor: event.actor?.nickname || '观众',
          mode: state.getMode(),
        })
      }
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
      await memory.generateDailyDiary(date, localLlm)
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

  // 绑定前台应用与专注时钟
  scheduler.on('front_app', (payload: any) => {
    state.setActiveApp(payload.bundleId, payload.name)
    const active = state.getActiveApp()
    if (active) {
      innerThought.onAppCategoryChanged(active.category)
    }
  })

  scheduler.on('user_touch', (payload: any) => {
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
      text: keyword,
      actor: { uid: 'host', nickname: '老爸' },
    })
    dispatchNextEvent()
  })

  // 启动服务
  await scheduler.start()
  await consoleServer.start()
  scheduleClock.start()

  // 启动周期性数值衰减定时器 (每 10 分钟一次)
  const decayTimer = setInterval(() => {
    emotion.decayTick(state.getMode() === 'live')
    state.updateStats(emotion.getState(state.getMode() === 'live').stats)
    const currentStats = state.getStats()
    memory.saveRpgState(currentStats.hunger, currentStats.mood, currentStats.energy)
  }, 600000)

  return {
    state,
    scheduler,
    memory,
    brain,
    emotion,
    innerThought,
    eventQueue,
    eventRouter,
    consoleServer,
    danmakuSensor,
    scheduleClock,
    ttsEngine,
    stop: async () => {
      clearInterval(decayTimer)
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
