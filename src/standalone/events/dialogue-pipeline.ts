/**
 * @file dialogue-pipeline.ts
 * 核心事件消费队列、对话推理管线与语音动作播报协调器
 *
 * 职责边界：
 * 1. 消费 PriorityEventQueue 事件，防重入调度
 * 2. 执行三阶段对话处理流水线：
 *    - 阶段 A：InputGuard 输入注入拦截与清洗
 *    - 阶段 B：EventRouter 零 Token 快速模板/触摸短路响应
 *    - 阶段 C：深度思考 (PromptBuilder 3-Layer 组装 + TieredBrainRouter 推理 + OutputGuard 脱敏 + 记忆/印象内化)
 * 3. 协调桌面动作 (RuntimeScheduler) 与 TTS 语音播报 (ITTSEngine)
 */

import * as path from 'node:path'
import type { StateManager } from '../core/state.ts'
import type { RuntimeScheduler } from '../core/scheduler.ts'
import type { MemoryStore } from '../memory/store.ts'
import type { ScopedWorkingMemory } from '../memory/working.ts'
import type { HostImpressionEngine } from '../memory/impression.ts'
import type { ContactImpressionEngine } from '../memory/contacts.ts'
import type { EmotionEngine } from '../persona/emotion.ts'
import type { InnerThoughtLoop } from '../persona/inner-thought.ts'
import type { InputGuard } from '../safety/input-guard.ts'
import type { OutputGuard } from '../safety/output-guard.ts'
import type { PriorityEventQueue } from './queue.ts'
import type { EventRouter } from './router.ts'
import type { StandardEvent } from './types.ts'
import type { TieredBrainRouter } from '../brain/router.ts'
import type { PromptBuilder } from '../brain/prompt-builder.ts'
import type { TaskExecutor } from '../brain/task-executor.ts'
import type { ITTSEngine } from '../brain/tts.ts'

export type EnrichedDialogueEvent = StandardEvent & {
  forceWorkMode?: boolean
  sessionKey?: string
  isOwner?: boolean
  targetRole?: string
  preferredTitle?: string
  groupId?: string
  isGroup?: boolean
  contactProfile?: any
  lastInteractionGapMin?: number
  homeGuardSummary?: string
}

export interface DialoguePipelineDeps {
  state: StateManager
  scheduler: RuntimeScheduler
  memory: MemoryStore
  scopedWorkingMemory: ScopedWorkingMemory
  impression: HostImpressionEngine
  contactImpression: ContactImpressionEngine
  emotion: EmotionEngine
  innerThought: InnerThoughtLoop
  inputGuard: InputGuard
  outputGuard: OutputGuard
  eventQueue: PriorityEventQueue
  eventRouter: EventRouter
  brain: TieredBrainRouter
  promptBuilder: PromptBuilder
  taskExecutor: TaskExecutor
  ttsEngine: ITTSEngine
  liveBlockKeywords?: string[]
  audioTempDir?: string
}

export class DialoguePipeline {
  private readonly deps: DialoguePipelineDeps
  private readonly audioTempDir: string
  private isProcessing = false

  constructor(deps: DialoguePipelineDeps) {
    this.deps = deps
    this.audioTempDir = deps.audioTempDir || 'runtime/temp/audio'
  }

  /**
   * 桌面语音合成与动作气泡同步播报
   */
  public async speakWithVoice(
    text: string,
    clip: string = 'idle',
    tone: string = 'happy'
  ): Promise<void> {
    const { scheduler, ttsEngine } = this.deps
    let cleanText = (text || '')
      .replace(/<meta\s+[^>]+\/?>\s*/gi, '')
      .replace(/<mem(?:\s+[^>]*)?>[\s\S]*?<\/mem>/gi, '')
      .replace(/\s*\|\s*/g, '，')
      .trim()

    if (!cleanText) {
      cleanText =
        clip === 'success' || clip === 'dance'
          ? '老爸，搞定啦！快夸我~ ✨'
          : '诶嘿，本鱼随时待命哦~ 🐟'
    }

    await scheduler.playClip({ clip, maxMs: 4000 })
    await scheduler.speakText({ text: cleanText, style: tone, typewriter: true })

    try {
      const audioId = `utt-${Date.now()}`
      const audioFile = path.resolve(process.cwd(), `${this.audioTempDir}/${audioId}.mp3`)
      await ttsEngine.synthesize(cleanText, audioFile)
      scheduler.playAudio(audioFile, { id: audioId, interrupt: true })
    } catch {
      // 容错降级
    }
  }

  /**
   * 驱动优先级事件队列消费主循环
   */
  public readonly dispatchNextEvent = async (): Promise<void> => {
    const { eventQueue } = this.deps
    if (this.isProcessing || eventQueue.isEmpty()) return
    const event = eventQueue.dequeue()
    if (!event) return

    this.isProcessing = true
    try {
      await this.handleEvent(event)
    } catch (err) {
      console.error('[DialoguePipeline] 事件处理异常:', err)
    } finally {
      this.isProcessing = false
      if (!eventQueue.isEmpty()) {
        setImmediate(this.dispatchNextEvent)
      }
    }
  }

  /**
   * 单个对话/互动事件全链路处理
   */
  public readonly handleEvent = async (
    event: EnrichedDialogueEvent,
    onReply?: (res: { text: string; clip: string; tone: string; [key: string]: any }) => void
  ): Promise<void> => {
    const {
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
      eventRouter,
      brain,
      promptBuilder,
      taskExecutor,
      liveBlockKeywords = [],
    } = this.deps

    const isLive = state.getMode() === 'live'

    // 提取会话与身份上下文
    const isOwner =
      event.isOwner !== undefined ? event.isOwner : !isLive && event.kind === 'HOST_TALK'
    const targetRole = (event.targetRole || (isOwner ? 'owner' : 'member')) as
      | 'owner'
      | 'member'
      | 'trusted'
    const preferredTitle =
      event.preferredTitle || (isOwner ? '老爸' : event.actor?.nickname || '你')
    const isGroup =
      event.isGroup ?? Boolean(event.groupId || event.sessionKey?.startsWith('group:'))
    const sessionKey = event.sessionKey || (isOwner ? 'console:host' : 'default:session')

    // A. 外部输入安全校验与注入拦截
    if (event.text) {
      const inspectRes = inputGuard.inspect(event.text)
      if (!inspectRes.passed) {
        console.warn(`[DialoguePipeline] 拦截不安全输入 (${inspectRes.reason}): ${event.text}`)
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

      if (!innerThought.isRepetitive(text)) {
        innerThought.recordSpoken(text)
        await this.speakWithVoice(text, clip, tone)
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
      const forceWork = Boolean(event.forceWorkMode) || currentMode === 'work'
      const memoryMode = isLive ? 'live' : 'companion'

      // C1. 若为伴侣模式或工作模式下主人的指令，优先检测是否触发电脑操控 / 搜索 / Antigravity 任务 / 技能教学
      if (!isLive && isOwner && event.text) {
        const taskIntent = taskExecutor.detectIntent(event.text, currentMode, forceWork, isOwner)
        if (taskIntent.isTask) {
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

          const taskRes = await taskExecutor.execute(taskIntent, currentMode)

          const sanitizedTaskReply = outputGuard.sanitize(
            taskRes.spokenReply,
            taskRes.clip,
            taskRes.tone,
            { liveMode: isLive, targetRole, preferredTitle }
          )

          scopedWorkingMemory.addTurn(sessionKey, {
            role: 'user',
            text: event.text,
            actor: 'host',
          })
          scopedWorkingMemory.addTurn(sessionKey, {
            role: 'assistant',
            text: sanitizedTaskReply.text,
            actor: 'daughter',
          })

          await this.speakWithVoice(
            sanitizedTaskReply.text,
            sanitizedTaskReply.clip,
            sanitizedTaskReply.tone
          )
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
          })
          return
        }
      }

      const promptText = inputGuard.wrapEventData(event.kind, event.text || '', preferredTitle)

      // VULN-07: 检索相关历史情景记忆（群聊或非主人场景强制采用 live 模式或 public 过滤，从数据库底层物理杜绝私密记忆召回）
      const episodicMode = isLive || isGroup || !isOwner ? 'live' : memoryMode
      const retrieved = memory.recallRelevantMemories({
        queryText: event.text || promptText,
        mode: episodicMode,
        limit: 3,
        ...(isGroup ? { scope: 'public' as const } : {}),
      })

      const recentDialogue = isLive ? [] : scopedWorkingMemory.getRecentDialogues(sessionKey)

      // 区分主人 vs 联系人的档案与事实
      let promptHostProfile: any = undefined
      let promptContactProfile: any = undefined
      let contactFacts: Array<{ text: string }> = []

      if (isOwner) {
        promptHostProfile = isGroup
          ? impression.buildPromptHostProfile('live')
          : impression.buildPromptHostProfile(memoryMode)
      } else {
        promptContactProfile =
          event.contactProfile ||
          (event.actor?.uid ? contactImpression.getProfile(event.actor.uid) : undefined)
        if (event.actor?.uid) {
          contactFacts = contactImpression.queryFacts(event.actor.uid)
        }
      }

      const activeAppInfo = state.getActiveApp()
      const sessionSummary = isLive ? '' : memory.loadSessionSummary() || ''

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
        lastInteractionGapMin: event.lastInteractionGapMin,
        homeGuardSummary: event.homeGuardSummary,
        // 防社死：仅在主人私聊或控制台下注入活跃桌面窗口；群聊或非主人绝不外泄！
        activeApp:
          isOwner && !isGroup && activeAppInfo
            ? { category: activeAppInfo.category, name: activeAppInfo.name, durationMin: 1 }
            : undefined,
        recentDialogue,
        // VULN-07: 严格透传 scope 属性
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
        eventType:
          event.kind === 'GIFT' ? 'GIFT_THANKS_LARGE' : isOwner ? 'HOST_TALK' : 'DANMAKU',
        prompt: layeredPrompt,
        maxTokens: 120,
      })

      const replyText =
        brainResult.output?.text ||
        brainResult.output?.reply ||
        brainResult.result?.text ||
        brainResult.result?.reply ||
        ''
      const replyClip = brainResult.output?.clip || brainResult.result?.clip || 'idle'
      const replyTone = brainResult.output?.tone || brainResult.result?.tone || 'tsundere'

      const sanitized = outputGuard.sanitize(replyText, replyClip, replyTone, {
        liveMode: isLive,
        privacyKeywords: liveBlockKeywords,
        targetRole,
        preferredTitle,
      })

      if (!innerThought.isRepetitive(sanitized.text)) {
        innerThought.recordSpoken(sanitized.text)
        await this.speakWithVoice(sanitized.text, sanitized.clip, sanitized.tone)
      }

      // 对话轮次记录到 ScopedWorkingMemory
      const userSpeaker = isGroup ? `[${preferredTitle}]` : isOwner ? 'host' : preferredTitle
      scopedWorkingMemory.addTurn(sessionKey, {
        role: 'user',
        text: event.text || '',
        actor: userSpeaker,
        speakerName: preferredTitle,
      })
      scopedWorkingMemory.addTurn(sessionKey, {
        role: 'assistant',
        text: sanitized.text.replace(/\s*\|\s*/g, '，'),
        actor: 'daughter',
      })

      // 提取记忆沉淀与聊天印象加固
      const memoryOutput = brainResult.output?.memory || brainResult.result?.memory
      const rawNote = typeof memoryOutput === 'string' ? memoryOutput : memoryOutput?.note || ''
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
        if (event.actor?.uid && event.actor?.nickname) {
          memory.upsertViewer({
            uid: event.actor.uid,
            nickname: event.actor.nickname,
            affinityDelta: 1,
          })
        }
        if (rawNote) {
          const importance =
            typeof memoryOutput === 'object' && memoryOutput.importance
              ? memoryOutput.importance
              : 5
          memory.insertEpisode({
            text: rawNote,
            importance,
            scope: 'public',
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
        parsedMeta: brainResult.output,
      })
    }
  }
}
