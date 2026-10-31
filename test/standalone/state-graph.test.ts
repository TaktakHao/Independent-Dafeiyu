/**
 * @file state-graph.test.ts
 * 零外部依赖轻量级微内核状态图 (StateGraph-Lite) 与大肥鱼业务图集成测试
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { StateGraph, END, interrupt } from '../../src/standalone/graph/engine.ts'
import { SQLiteCheckpointer } from '../../src/standalone/graph/sqlite-checkpointer.ts'
import { initDatabase, closeDatabase } from '../../src/standalone/memory/db.ts'
import { buildCompanionGraph, type CompanionGraphState } from '../../src/standalone/graph/companion-graph.ts'
import { StateManager } from '../../src/standalone/core/state.ts'
import { InputGuard } from '../../src/standalone/safety/input-guard.ts'
import { OutputGuard } from '../../src/standalone/safety/output-guard.ts'
import { PermissionGuard } from '../../src/standalone/safety/permission-guard.ts'
import { ApprovalManager } from '../../src/standalone/safety/approval-manager.ts'
import { TaskExecutor } from '../../src/standalone/brain/task-executor.ts'
import { MemeManager } from '../../src/standalone/brain/meme-manager.ts'
import { MemoryStore } from '../../src/standalone/memory/store.ts'
import { WorkingMemory, ScopedWorkingMemory } from '../../src/standalone/memory/working.ts'
import { HostImpressionEngine } from '../../src/standalone/memory/impression.ts'
import { ContactImpressionEngine } from '../../src/standalone/memory/contacts.ts'
import { PromptBuilder } from '../../src/standalone/brain/prompt-builder.ts'

describe('StateGraph-Lite 微内核核心逻辑测试', () => {
  it('1.1 顺序线性执行直达 END', async () => {
    interface SimpleState {
      count: number
      history: string[]
    }

    const graph = new StateGraph<SimpleState>()
    graph.addNode('step_a', (s) => ({
      count: s.count + 1,
      history: [...s.history, 'A'],
    }))
    graph.addNode('step_b', (s) => ({
      count: s.count * 2,
      history: [...s.history, 'B'],
    }))

    graph.setEntryPoint('step_a')
    graph.addEdge('step_a', 'step_b')
    graph.addEdge('step_b', END)

    const compiled = graph.compile()
    const result = await compiled.invoke({ count: 1, history: [] })

    assert.equal(result.status, 'completed')
    assert.equal(result.finalState.count, 4) // (1 + 1) * 2 = 4
    assert.deepEqual(result.finalState.history, ['A', 'B'])
    assert.equal(result.stepsExecuted, 2)
  })

  it('1.2 动态条件边路由流转', async () => {
    interface RouteState {
      val: number
      routeTaken: string
    }

    const graph = new StateGraph<RouteState>()
    graph.addNode('decide', (s) => s)
    graph.addNode('node_high', (s) => ({ routeTaken: 'HIGH' }))
    graph.addNode('node_low', (s) => ({ routeTaken: 'LOW' }))

    graph.setEntryPoint('decide')
    graph.addConditionalEdges('decide', (s) => (s.val >= 10 ? 'node_high' : 'node_low'))
    graph.addEdge('node_high', END)
    graph.addEdge('node_low', END)

    const compiled = graph.compile()

    const resHigh = await compiled.invoke({ val: 15, routeTaken: '' })
    assert.equal(resHigh.finalState.routeTaken, 'HIGH')

    const resLow = await compiled.invoke({ val: 5, routeTaken: '' })
    assert.equal(resLow.finalState.routeTaken, 'LOW')
  })

  it('1.3 死循环检测防护 (超过 maxSteps 报错阻断)', async () => {
    interface LoopState {
      loopCount: number
    }

    const graph = new StateGraph<LoopState>()
    graph.addNode('ping', (s) => ({ loopCount: s.loopCount + 1 }))
    graph.addNode('pong', (s) => ({ loopCount: s.loopCount + 1 }))

    graph.setEntryPoint('ping')
    graph.addEdge('ping', 'pong')
    graph.addEdge('pong', 'ping')

    const compiled = graph.compile({ maxSteps: 6 })
    const result = await compiled.invoke({ loopCount: 0 })

    assert.equal(result.status, 'error')
    assert.ok(result.error?.message.includes('超过最大步数限制'))
    assert.equal(result.stepsExecuted, 6)
  })

  it('1.4 Checkpointer 与 interrupt() 断点挂起及 resume 恢复执行', async () => {
    const memDb = initDatabase({ path: ':memory:' })
    const checkpointer = new SQLiteCheckpointer(memDb)

    interface HitlState {
      task: string
      status: string
      isApproved?: boolean
    }

    const graph = new StateGraph<HitlState>()
    graph.addNode('start_step', (s) => ({ status: 'pending_approval' }))
    graph.addNode('gate_step', (s) => {
      if (!s.isApproved) {
        interrupt({ reason: 'NEED_HUMAN_CONFIRMATION', item: s.task })
      }
      return { status: 'approved' }
    })
    graph.addNode('execute_step', (s) => ({ status: `executed_${s.task}` }))

    graph.setEntryPoint('start_step')
    graph.addEdge('start_step', 'gate_step')
    graph.addConditionalEdges('gate_step', (s) => (s.isApproved ? 'execute_step' : END))
    graph.addEdge('execute_step', END)

    const compiled = graph.compile({ checkpointer })
    const threadId = 'thread_test_001'

    // 第一次运行：触发 interrupt
    const run1 = await compiled.invoke({ task: 'delete_server', status: 'init' }, { threadId })
    assert.equal(run1.status, 'interrupted')
    assert.equal(run1.interruptedNode, 'gate_step')
    assert.equal((run1.interruptPayload as any)?.reason, 'NEED_HUMAN_CONFIRMATION')

    // 检查 Checkpoint 快照已落库
    const saved = await checkpointer.getLatest(threadId)
    assert.ok(saved)
    assert.equal(saved.nodeName, 'gate_step')
    assert.equal(saved.state.task, 'delete_server')

    // 第二次运行：外部人工审批放行后调用 resume 唤醒
    const run2 = await compiled.resume(threadId, { isApproved: true })
    assert.equal(run2.status, 'completed')
    assert.equal(run2.finalState.status, 'executed_delete_server')

    closeDatabase(memDb)
  })
})

describe('CompanionGraph 大肥鱼全景业务状态图测试', () => {
  it('2.1 快捷观赏动作直出 (quick_action -> format_output -> END)', async () => {
    const memDb = initDatabase({ path: ':memory:' })

    const state = new StateManager('companion')
    const inputGuard = new InputGuard([])
    const outputGuard = new OutputGuard()
    const permissionGuard = new PermissionGuard('10001')
    const approvalManager = new ApprovalManager(memDb)
    const taskExecutor = new TaskExecutor({} as any)
    taskExecutor.execute = async (intent: any) => ({
      spokenReply: '老爸批准啦，终端命令已经跑完咯！✨',
      detailReport: 'total 128\n-rw-r--r-- 1 wesson staff 1024 Oct 31 18:00 test.txt',
      clip: 'working_command',
      tone: 'happy',
    })
    const memeManager = new MemeManager({ templatesDir: '', customMemeDir: '' })
    const memory = new MemoryStore(memDb)
    const workingMemory = new WorkingMemory(memDb)
    const scopedWorkingMemory = new ScopedWorkingMemory(workingMemory)
    const impression = new HostImpressionEngine(memDb)
    const contactImpression = new ContactImpressionEngine(memDb)
    const promptBuilder = new PromptBuilder()

    const brainMock: any = {
      route: async () => ({ output: { text: '你好呀', clip: 'idle', tone: 'happy' } }),
    }

    const workflow = buildCompanionGraph({
      state,
      inputGuard,
      outputGuard,
      permissionGuard,
      approvalManager,
      taskExecutor,
      brain: brainMock,
      promptBuilder,
      memeManager,
      scopedWorkingMemory,
      impression,
      contactImpression,
      memory,
    })

    const checkpointer = new SQLiteCheckpointer(memDb)
    const compiled = workflow.compile({ checkpointer })

    const res = await compiled.invoke({
      threadId: 'test_thread_action',
      channel: 'qq',
      isGroup: false,
      userId: '10001',
      nickname: '老爸',
      rawText: '大肥鱼跳个舞看看',
      isOwner: true,
      role: 'owner',
      preferredTitle: '老爸',
      sessionKey: 'private:host',
      sanitizedText: '大肥鱼跳个舞看看',
      guardPassed: true,
      inferredRoute: 'chat',
      clip: 'idle',
      tone: 'normal',
      spokenReply: '',
    })

    assert.equal(res.status, 'completed')
    assert.equal(res.finalState.clip, 'dance')
    assert.ok(res.finalState.spokenReply.includes('摇摆舞'))
    assert.ok(res.finalState.chatPlan)
    assert.ok(res.finalState.chatPlan.immediateBubbles.length > 0)

    closeDatabase(memDb)
  })

  it('2.2 L1 受控宿主机操作触发审批挂起与断点恢复', async () => {
    const memDb = initDatabase({ path: ':memory:' })

    const state = new StateManager('companion')
    const inputGuard = new InputGuard([])
    const outputGuard = new OutputGuard()
    const permissionGuard = new PermissionGuard('10001')
    const approvalManager = new ApprovalManager(memDb)
    const taskExecutor = new TaskExecutor({} as any)
    taskExecutor.execute = async (intent: any) => ({
      spokenReply: '老爸批准啦，终端命令已经跑完咯！✨',
      detailReport: 'total 128\n-rw-r--r-- 1 wesson staff 1024 Oct 31 18:00 test.txt',
      clip: 'working_command',
      tone: 'happy',
    })
    const memeManager = new MemeManager({ templatesDir: '', customMemeDir: '' })
    const memory = new MemoryStore(memDb)
    const workingMemory = new WorkingMemory(memDb)
    const scopedWorkingMemory = new ScopedWorkingMemory(workingMemory)
    const impression = new HostImpressionEngine(memDb)
    const contactImpression = new ContactImpressionEngine(memDb)
    const promptBuilder = new PromptBuilder()

    const brainMock: any = {
      route: async () => ({ output: { text: '好', clip: 'idle', tone: 'happy' } }),
    }

    const workflow = buildCompanionGraph({
      state,
      inputGuard,
      outputGuard,
      permissionGuard,
      approvalManager,
      taskExecutor,
      brain: brainMock,
      promptBuilder,
      memeManager,
      scopedWorkingMemory,
      impression,
      contactImpression,
      memory,
    })

    const checkpointer = new SQLiteCheckpointer(memDb)
    const compiled = workflow.compile({ checkpointer })

    // 群友 20002 尝试让大肥鱼执行宿主机终端命令 (L1 级受控危险)
    const threadId = 'group:999888'
    const commandText = '帮我执行命令：ls -la'
    const res1 = await compiled.invoke(
      {
        threadId,
        channel: 'qq',
        isGroup: true,
        groupId: '999888',
        userId: '20002',
        nickname: '调皮群友',
        rawText: commandText,
        isOwner: false,
        role: 'member',
        preferredTitle: '调皮群友',
        sessionKey: threadId,
        sanitizedText: commandText,
        guardPassed: true,
        inferredRoute: 'chat',
        clip: 'idle',
        tone: 'normal',
        spokenReply: '',
      },
      { threadId }
    )

    // 判定：应进入 approval_gate_node 并且抛出 interrupt 挂起！
    assert.equal(res1.status, 'interrupted')
    assert.equal(res1.interruptedNode, 'approval_gate_node')
    const payload = res1.interruptPayload as any
    assert.ok(payload.code)
    assert.ok(payload.message.includes('老爸点头'))

    // 检查审批单是否由 ApprovalManager 正常签发
    const pending = approvalManager.getLatestPending()
    assert.ok(pending)
    assert.equal(pending.code, payload.code)

    // 外部老爸批准：调用 resume(threadId, { isApproved: true })
    const res2 = await compiled.resume(threadId, {
      isApproved: true,
      approvalCode: payload.code,
    })

    assert.equal(res2.status, 'completed')
    assert.ok(res2.finalState.spokenReply)
    assert.ok(res2.finalState.chatPlan)

    closeDatabase(memDb)
  })
})
