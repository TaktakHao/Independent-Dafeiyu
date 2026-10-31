/**
 * @file companion-graph.ts
 * 基于 StateGraph 微内核构建的大肥鱼伴侣与看家管家全景业务图 (Companion & Steward StateGraph)
 *
 * 核心拓扑：
 * [START]
 *    │
 *    ▼
 * [guard_node] ──── (命中高危/违规) ──────────────────────────┐
 *    │                                                        │
 *    ▼                                                        │
 * [intent_router_node]                                         │
 *    │                                                        │
 *    ├── (需要审批 L1) ──► [approval_gate_node (interrupt)] ─┤
 *    │                            │ (审批通过)                 │
 *    ├── (指令/操控) ─────────────┼──────────────┐             │
 *    │                            ▼              │             │
 *    ├── (普通闲聊) ──► [chat_think_node]         │             │
 *    │                        │ (派生任务)       │             │
 *    │                        ▼                  ▼             │
 *    │                   [task_executor_node] ◄──┘             │
 *    │                            │                            │
 *    └── (快捷观赏) ──► [quick_action_node]                    │
 *                                 │                            │
 *                                 ▼                            ▼
 *                      [format_output_node] ◄──────────────────┘
 *                                 │
 *                                 ▼
 *                               [END]
 */

import { StateGraph, END, interrupt } from './engine.ts'
import type { TaskExecutor, TaskIntent, TaskExecutionResult } from '../brain/task-executor.ts'
import type { TieredBrainRouter } from '../brain/router.ts'
import type { PromptBuilder } from '../brain/prompt-builder.ts'
import type { InputGuard } from '../safety/input-guard.ts'
import type { OutputGuard } from '../safety/output-guard.ts'
import type { PermissionGuard } from '../safety/permission-guard.ts'
import type { ApprovalManager } from '../safety/approval-manager.ts'
import type { MemeManager, QqChatPlan } from '../brain/meme-manager.ts'
import type { StateManager } from '../core/state.ts'
import type { ScopedWorkingMemory } from '../memory/working.ts'
import type { HostImpressionEngine } from '../memory/impression.ts'
import type { ContactImpressionEngine } from '../memory/contacts.ts'
import type { MemoryStore } from '../memory/store.ts'
import { resolveQueryTopic } from '../brain/connectors.ts'

export interface CompanionGraphState {
  // 1. 基础上下文
  threadId: string
  channel: 'qq' | 'console' | 'douyin' | 'live'
  isGroup: boolean
  groupId?: string
  userId: string
  nickname: string
  rawText: string
  isOwner: boolean
  role: 'owner' | 'trusted' | 'member' | 'blocked' | string
  preferredTitle: string
  sessionKey: string
  lastInteractionGapMin?: number
  homeGuardSummary?: string
  contactProfile?: any

  // 2. 守卫与意图识别
  sanitizedText: string
  guardPassed: boolean
  securityReason?: string
  taskIntent?: TaskIntent
  inferredRoute: 'chat' | 'quick_action' | 'task' | 'approval_required' | 'blocked'

  // 3. 审批与挂起状态
  approvalCode?: string
  isApproved?: boolean

  // 4. 执行结果与台词
  clip: string
  tone: string
  spokenReply: string
  detailReport?: string
  screenshotBase64?: string

  // 5. 格式化输出 (多气泡、表情包与追击)
  chatPlan?: QqChatPlan
}

export interface CompanionGraphDeps {
  state: StateManager
  inputGuard: InputGuard
  outputGuard: OutputGuard
  permissionGuard: PermissionGuard
  approvalManager: ApprovalManager
  taskExecutor: TaskExecutor
  brain: TieredBrainRouter
  promptBuilder: PromptBuilder
  memeManager: MemeManager
  scopedWorkingMemory: ScopedWorkingMemory
  impression: HostImpressionEngine
  contactImpression: ContactImpressionEngine
  memory: MemoryStore
}

export function buildCompanionGraph(deps: CompanionGraphDeps): StateGraph<CompanionGraphState> {
  const {
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
  } = deps

  const workflow = new StateGraph<CompanionGraphState>()

  // ==================== 节点 1: 安全守卫检测 ====================
  workflow.addNode('guard_node', (s) => {
    // 文本注入与敏感词检测
    const inspectRes = inputGuard.inspect(s.rawText)
    if (!inspectRes.passed) {
      return {
        guardPassed: false,
        sanitizedText: s.rawText,
        securityReason: inspectRes.reason || '包含敏感内容',
        spokenReply: '唔…这句话好像不太合适呢，大肥鱼不可以听哦~ 🐟',
        clip: 'idle',
        tone: 'tsundere',
        inferredRoute: 'blocked',
      }
    }

    const sanitizedText = inspectRes.sanitizedText
    const isOwner = s.isOwner
    const taskIntent = taskExecutor.detectIntent(sanitizedText, state.getMode(), false, isOwner)
    const perm = permissionGuard.evaluate(s.userId, sanitizedText, taskIntent)

    if (!perm.allowed && perm.level === 'L2') {
      return {
        guardPassed: false,
        sanitizedText,
        taskIntent,
        securityReason: perm.reason,
        spokenReply: perm.reason || '哼，这种危险的事本鱼才不干！',
        clip: 'error',
        tone: 'tsundere',
        inferredRoute: 'blocked',
      }
    }

    return {
      guardPassed: true,
      sanitizedText,
      taskIntent,
    }
  })

  // ==================== 节点 2: 意图动态分流 ====================
  workflow.addNode('intent_router_node', (s) => {
    if (!s.guardPassed) {
      return { inferredRoute: 'blocked' }
    }

    const taskIntent = s.taskIntent
    const sanitizedText = s.sanitizedText
    const isOwner = s.isOwner

    // A. 纯观赏动作
    if (permissionGuard.isPetViewAction(sanitizedText)) {
      return { inferredRoute: 'quick_action' }
    }

    // B. 行动脑任务
    if (taskIntent?.isTask) {
      const perm = permissionGuard.evaluate(s.userId, sanitizedText, taskIntent)
      // 若为非主人的受控危险级 (L1)，导向挂起审批
      if (!perm.allowed && perm.level === 'L1') {
        return { inferredRoute: 'approval_required' }
      }
      return { inferredRoute: 'task' }
    }

    // C. 只读快速查询 (okx / web)
    const quickTopic = resolveQueryTopic(undefined, sanitizedText)
    if (quickTopic === 'okx' || quickTopic === 'web') {
      return { inferredRoute: 'task' }
    }

    // D. 默认闲聊
    return { inferredRoute: 'chat' }
  })

  // ==================== 节点 3: 审批挂起门禁 (Human-in-the-Loop) ====================
  workflow.addNode('approval_gate_node', async (s) => {
    // 若尚未发起审批单，先创建并挂起
    if (!s.approvalCode) {
      const createRes = approvalManager.createRequest({
        userId: s.userId,
        nickname: s.preferredTitle,
        channel: s.isGroup ? 'group' : 'private',
        groupId: s.groupId,
        intent: s.taskIntent!,
        intentLabel: approvalManager.humanReadableLabel(s.taskIntent!),
        rawText: s.rawText,
      })

      if (!createRes.success || !createRes.request) {
        return {
          spokenReply: createRes.error || '请求受限，请稍候再试',
          clip: 'error',
          tone: 'sulking',
          inferredRoute: 'blocked',
        }
      }

      const req = createRes.request
      s.approvalCode = req.code
      // 挂起状态图等待外部恢复 (老爸回复「同意」或控制台批准)
      interrupt({
        code: req.code,
        message: `想动老爸电脑？这得老爸点头才行！本鱼去请示一下~ (单号 ${req.code})`,
        approvalRequest: req,
      })
    }

    // 被 resume 唤醒后检查是否批准
    if (s.isApproved) {
      return { inferredRoute: 'task' }
    } else {
      return {
        spokenReply: '略略略，老爸说不准动他电脑！',
        clip: 'poke',
        tone: 'tsundere',
        inferredRoute: 'blocked',
      }
    }
  })

  // ==================== 节点 4: 快脑对话推理 (LLM) ====================
  workflow.addNode('chat_think_node', async (s) => {
    const isLive = state.getMode() === 'live'
    const episodicMode = isLive || s.isGroup || !s.isOwner ? 'live' : 'companion'

    const retrieved = memory.recallRelevantMemories({
      queryText: s.sanitizedText,
      mode: episodicMode,
      limit: 3,
      ...(s.isGroup ? { scope: 'public' as const } : {}),
    })

    const recentDialogue = isLive ? [] : scopedWorkingMemory.getRecentDialogues(s.sessionKey)
    const promptHostProfile = s.isOwner
      ? impression.buildPromptHostProfile(s.isGroup ? 'live' : 'companion')
      : undefined
    const promptContactProfile = !s.isOwner
      ? s.contactProfile || contactImpression.getProfile(s.userId)
      : undefined
    const contactFacts = !s.isOwner ? contactImpression.queryFacts(s.userId) : []

    const layeredPrompt = promptBuilder.fitToBudget({
      mode: isLive ? 'live' : 'companion',
      stats: state.getStats(),
      emotionState: state.getEmotion(),
      channel: s.channel,
      isGroup: s.isGroup,
      speakerIdentity: {
        isOwner: s.isOwner,
        role: s.role,
        preferredTitle: s.preferredTitle,
        isGroup: s.isGroup,
        groupId: s.groupId,
      },
      hostProfile: promptHostProfile,
      contactProfile: promptContactProfile,
      contactFacts,
      sessionSummary: memory.loadSessionSummary?.() || '',
      yesterdayDiary: (memory as any).loadYesterdayDiary?.() || '',
      lastInteractionGapMin: s.lastInteractionGapMin,
      homeGuardSummary: s.homeGuardSummary,
      retrievedMemories: retrieved.map((r) => ({
        id: String(r.id),
        text: r.text,
        score: r.finalScore,
        scope: r.scope,
      })),
      recentDialogue,
      event: {
        type: s.isOwner ? 'HOST_TALK' : 'DANMAKU',
        viewer: s.preferredTitle,
        content: s.sanitizedText,
      },
    })

    const brainRes = await brain.route({
      eventType: s.isOwner ? 'HOST_TALK' : 'DANMAKU',
      prompt: layeredPrompt,
      maxTokens: 120,
    })

    const rawReply =
      brainRes.output?.text || brainRes.output?.reply || brainRes.result?.text || brainRes.result?.reply || ''
    const clip = brainRes.output?.clip || brainRes.result?.clip || 'idle'
    const tone = brainRes.output?.tone || brainRes.result?.tone || 'tsundere'

    const sanitized = outputGuard.sanitize(rawReply, clip, tone, {
      liveMode: isLive,
      targetRole: s.role as any,
      preferredTitle: s.preferredTitle,
    })

    // 记录对话轮次
    scopedWorkingMemory.addTurn(s.sessionKey, {
      role: 'user',
      text: s.sanitizedText,
      actor: s.isOwner ? 'host' : s.preferredTitle,
      speakerName: s.preferredTitle,
    })
    scopedWorkingMemory.addTurn(s.sessionKey, {
      role: 'assistant',
      text: sanitized.text.replace(/\s*\|\s*/g, '，'),
      actor: 'daughter',
    })

    // 检查 meta 中是否有派生意图
    const metaMatch = rawReply.match(/<meta\s+([^>]+)\/?>/i)
    let derivedTask: string | undefined
    if (metaMatch) {
      const attrs = metaMatch[1]
      const intentMatch = attrs.match(/intent=["']([^"']+)["']/i)
      const taskMatch = attrs.match(/task=["']([^"']+)["']/i)
      if (intentMatch && (intentMatch[1] === 'task' || intentMatch[1] === 'query')) {
        derivedTask = taskMatch ? taskMatch[1] : s.sanitizedText
      }
    }

    if (derivedTask && s.isOwner) {
      const derivedIntent = taskExecutor.detectIntent(derivedTask, state.getMode(), false, true)
      return {
        spokenReply: sanitized.text,
        clip: sanitized.clip,
        tone: sanitized.tone,
        taskIntent: derivedIntent,
        inferredRoute: 'task',
      }
    }

    return {
      spokenReply: sanitized.text,
      clip: sanitized.clip,
      tone: sanitized.tone,
    }
  })

  // ==================== 节点 5: 真实任务执行 (Action & Operator) ====================
  workflow.addNode('task_executor_node', async (s) => {
    let taskRes: TaskExecutionResult

    if (s.taskIntent?.isTask) {
      taskRes = await taskExecutor.execute(s.taskIntent, state.getMode() || 'companion')
    } else {
      // 只读快捷查询
      const topic = resolveQueryTopic(undefined, s.sanitizedText)
      taskRes = await taskExecutor.executeQuery({
        topic,
        question: s.sanitizedText,
        preferredTitle: s.preferredTitle,
      })
    }

    const cleanReply = outputGuard.sanitize(taskRes.spokenReply, taskRes.clip, taskRes.tone, {
      liveMode: state.getMode() === 'live',
      targetRole: s.role as any,
      preferredTitle: s.preferredTitle,
    }).text

    const combinedReply =
      s.spokenReply && s.spokenReply !== cleanReply
        ? `${s.spokenReply}\n${cleanReply}`
        : cleanReply

    return {
      spokenReply: combinedReply,
      detailReport: taskRes.detailReport,
      clip: taskRes.clip,
      tone: taskRes.tone,
      screenshotBase64: taskRes.screenshotBase64,
    }
  })

  // ==================== 节点 6: 0-Token 快捷动作响应 ====================
  workflow.addNode('quick_action_node', (s) => {
    const text = s.sanitizedText
    if (text.includes('跳舞') || text.includes('跳个舞')) {
      return {
        spokenReply: '看好啦！本鱼独创的元气摇摆舞来咯，哒哒哒~ 💃',
        clip: 'dance',
        tone: 'happy',
      }
    }
    if (text.includes('伸懒腰')) {
      return {
        spokenReply: '使劲伸直鱼鳍，舒舒服服舒展一下大懒腰~ 🤸',
        clip: 'idle_stretch',
        tone: 'happy',
      }
    }
    return {
      spokenReply: '诶嘿，本鱼随时在老爸桌面待命哦~ 🐟',
      clip: 'idle',
      tone: 'happy',
    }
  })

  // ==================== 节点 7: 格式化多气泡与表情包输出 ====================
  workflow.addNode('format_output_node', (s) => {
    if (s.channel === 'qq') {
      const plan = memeManager.planQqChatSequence({
        text: s.spokenReply,
        clip: s.clip,
        tone: s.tone,
        moodDelta: 0,
        userText: s.sanitizedText,
        isOwner: s.isOwner,
        isGroup: s.isGroup,
        preferredTitle: s.preferredTitle,
        stats: state.getStats(),
      })
      return { chatPlan: plan }
    }
    return {}
  })

  // ==================== 拓扑连线与分支配置 ====================
  workflow.setEntryPoint('guard_node')

  workflow.addConditionalEdges('guard_node', (s) => {
    return s.guardPassed ? 'intent_router_node' : 'format_output_node'
  })

  workflow.addConditionalEdges('intent_router_node', (s) => {
    if (s.inferredRoute === 'approval_required') return 'approval_gate_node'
    if (s.inferredRoute === 'task') return 'task_executor_node'
    if (s.inferredRoute === 'quick_action') return 'quick_action_node'
    if (s.inferredRoute === 'chat') return 'chat_think_node'
    return 'format_output_node'
  })

  workflow.addConditionalEdges('approval_gate_node', (s) => {
    return s.isApproved ? 'task_executor_node' : 'format_output_node'
  })

  workflow.addConditionalEdges('chat_think_node', (s) => {
    return s.inferredRoute === 'task' ? 'task_executor_node' : 'format_output_node'
  })
  workflow.addEdge('task_executor_node', 'format_output_node')
  workflow.addEdge('quick_action_node', 'format_output_node')
  workflow.addEdge('format_output_node', END)

  return workflow
}
