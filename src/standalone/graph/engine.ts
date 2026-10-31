/**
 * @file engine.ts
 * 零外部臃肿依赖的轻量级 LangGraph-Lite 状态图微内核 (Zero-Dependency StateGraph Engine)
 *
 * 核心能力：
 * 1. 显式有向图编排：Nodes (计算节点)、Edges (确定性边)、ConditionalEdges (条件路由分支)
 * 2. 环路与自反思支持：图可以自回环 (Cyclic Graph)，内置 maxSteps 防死循环保护
 * 3. Human-in-the-Loop 挂起与断点恢复：支持在任意节点调用 interrupt(payload) 冻结状态，并在外部审核/输入后 resume 继续执行
 * 4. 状态持久化插槽：通过 Checkpointer 与原生 node:sqlite 无缝打通，实现全链路状态可观测与会话隔离
 */

export const START = '__START__'
export const END = '__END__'

export class InterruptSignal {
  public readonly payload: any
  constructor(payload: any) {
    this.payload = payload
  }
}

/**
 * 在图节点内部调用，触发 Human-in-the-Loop 挂起冻结当前状态
 */
export function interrupt(payload: any): never {
  throw new InterruptSignal(payload)
}

export interface Checkpoint<TState = any> {
  threadId: string
  checkpointId: string
  parentCheckpointId?: string | null
  nodeName: string
  state: TState
  interruptPayload?: any
  createdAt: number
}

export interface Checkpointer<TState = any> {
  save(checkpoint: Checkpoint<TState>): Promise<void> | void
  getLatest(threadId: string): Promise<Checkpoint<TState> | null> | Checkpoint<TState> | null
  deleteThread?(threadId: string): Promise<void> | void
}

export type NodeFn<TState, TContext = any> = (
  state: TState,
  context?: TContext
) => Promise<Partial<TState> | void> | Partial<TState> | void

export type ConditionEdgeFn<TState, TContext = any> = (
  state: TState,
  context?: TContext
) => Promise<string> | string

export interface GraphStepTrace {
  node: string
  step: number
  timestamp: number
}

export interface GraphRunResult<TState> {
  finalState: TState
  status: 'completed' | 'interrupted' | 'error'
  interruptedNode?: string
  interruptPayload?: any
  threadId?: string
  checkpointId?: string
  stepsExecuted: number
  trace: GraphStepTrace[]
  error?: Error
}

interface EdgeRule<TState> {
  type: 'direct' | 'conditional'
  to?: string
  condition?: ConditionEdgeFn<TState>
  pathMap?: Record<string, string>
}

export class StateGraph<TState extends Record<string, any>> {
  private nodes: Map<string, NodeFn<TState>> = new Map()
  private edges: Map<string, EdgeRule<TState>> = new Map()
  private entryPoint: string = START

  constructor() {}

  /**
   * 注册图节点
   */
  public addNode(name: string, fn: NodeFn<TState>): this {
    if (name === START || name === END) {
      throw new Error(`节点名称保留不可使用: ${name}`)
    }
    this.nodes.set(name, fn)
    return this
  }

  /**
   * 注册确定性单向边
   */
  public addEdge(from: string, to: string): this {
    this.edges.set(from, { type: 'direct', to })
    return this
  }

  /**
   * 注册动态条件分支边
   */
  public addConditionalEdges(
    from: string,
    condition: ConditionEdgeFn<TState>,
    pathMap?: Record<string, string>
  ): this {
    this.edges.set(from, { type: 'conditional', condition, pathMap })
    return this
  }

  /**
   * 设置图起始入口节点
   */
  public setEntryPoint(name: string): this {
    this.entryPoint = name
    return this
  }

  /**
   * 编译为可执行的状态图实例
   */
  public compile(options: { checkpointer?: Checkpointer<TState>; maxSteps?: number } = {}): CompiledGraph<TState> {
    return new CompiledGraph(
      this.nodes,
      this.edges,
      this.entryPoint,
      options.checkpointer,
      options.maxSteps ?? 25
    )
  }
}

export class CompiledGraph<TState extends Record<string, any>> {
  private nodes: Map<string, NodeFn<TState>>
  private edges: Map<string, EdgeRule<TState>>
  private entryPoint: string
  private checkpointer?: Checkpointer<TState>
  private maxSteps: number

  constructor(
    nodes: Map<string, NodeFn<TState>>,
    edges: Map<string, EdgeRule<TState>>,
    entryPoint: string,
    checkpointer?: Checkpointer<TState>,
    maxSteps = 25
  ) {
    this.nodes = new Map(nodes)
    this.edges = new Map(edges)
    this.entryPoint = entryPoint
    this.checkpointer = checkpointer
    this.maxSteps = maxSteps
  }

  /**
   * 从头执行状态图
   */
  public async invoke(
    initialState: TState,
    options: { threadId?: string; context?: any } = {}
  ): Promise<GraphRunResult<TState>> {
    const threadId = options.threadId || `thread_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    return this.runLoop({
      currentState: { ...initialState },
      currentNode: this.entryPoint,
      threadId,
      parentCheckpointId: null,
      context: options.context,
    })
  }

  /**
   * 从被 interrupt 挂起的断点处恢复执行 (Human-in-the-Loop)
   */
  public async resume(
    threadId: string,
    resumeStatePatch: Partial<TState> = {},
    options: { context?: any } = {}
  ): Promise<GraphRunResult<TState>> {
    if (!this.checkpointer) {
      throw new Error('未配置 Checkpointer，无法从挂起断点恢复执行')
    }

    const latest = await this.checkpointer.getLatest(threadId)
    if (!latest) {
      throw new Error(`未找到 threadId=${threadId} 的断点快照`)
    }

    const mergedState: TState = {
      ...latest.state,
      ...resumeStatePatch,
    }

    // 从挂起节点的后续边继续往下流转
    const nextNode = await this.resolveNextNode(latest.nodeName, mergedState, options.context)

    return this.runLoop({
      currentState: mergedState,
      currentNode: nextNode,
      threadId,
      parentCheckpointId: latest.checkpointId,
      context: options.context,
    })
  }

  /**
   * 获取指定会话线程的最新状态快照
   */
  public async getState(threadId: string): Promise<Checkpoint<TState> | null> {
    if (!this.checkpointer) return null
    return this.checkpointer.getLatest(threadId)
  }

  private async runLoop(params: {
    currentState: TState
    currentNode: string
    threadId: string
    parentCheckpointId: string | null
    context?: any
  }): Promise<GraphRunResult<TState>> {
    const { threadId, context } = params
    let state = { ...params.currentState }
    let nodeName = params.currentNode
    let parentChkId = params.parentCheckpointId

    const trace: GraphStepTrace[] = []
    let steps = 0

    while (nodeName && nodeName !== END) {
      if (steps >= this.maxSteps) {
        const err = new Error(`状态图执行超过最大步数限制 (${this.maxSteps} 步)，已终止防止环路死循环`)
        return {
          finalState: state,
          status: 'error',
          stepsExecuted: steps,
          threadId,
          trace,
          error: err,
        }
      }

      const nodeFn = this.nodes.get(nodeName)
      if (!nodeFn) {
        throw new Error(`未找到已注册的图节点: ${nodeName}`)
      }

      steps++
      trace.push({ node: nodeName, step: steps, timestamp: Date.now() })

      try {
        const nodeOutput = await nodeFn(state, context)
        if (nodeOutput && typeof nodeOutput === 'object') {
          state = { ...state, ...nodeOutput }
        }

        // 保存正常节点快照
        const chkId = `chk_${Date.now()}_${steps}`
        if (this.checkpointer) {
          await this.checkpointer.save({
            threadId,
            checkpointId: chkId,
            parentCheckpointId: parentChkId,
            nodeName,
            state,
            createdAt: Date.now(),
          })
          parentChkId = chkId
        }

        // 决定下一跳节点
        nodeName = await this.resolveNextNode(nodeName, state, context)
      } catch (err: any) {
        if (err instanceof InterruptSignal) {
          // 捕获节点内部触发的挂起信号
          const chkId = `chk_interrupted_${Date.now()}`
          if (this.checkpointer) {
            await this.checkpointer.save({
              threadId,
              checkpointId: chkId,
              parentCheckpointId: parentChkId,
              nodeName,
              state,
              interruptPayload: err.payload,
              createdAt: Date.now(),
            })
          }

          return {
            finalState: state,
            status: 'interrupted',
            interruptedNode: nodeName,
            interruptPayload: err.payload,
            threadId,
            checkpointId: chkId,
            stepsExecuted: steps,
            trace,
          }
        }

        return {
          finalState: state,
          status: 'error',
          stepsExecuted: steps,
          threadId,
          trace,
          error: err,
        }
      }
    }

    return {
      finalState: state,
      status: 'completed',
      threadId,
      stepsExecuted: steps,
      trace,
    }
  }

  private async resolveNextNode(currentNode: string, state: TState, context?: any): Promise<string> {
    const edge = this.edges.get(currentNode)
    if (!edge) {
      // 若无显式边，默认流向 END
      return END
    }

    if (edge.type === 'direct') {
      return edge.to || END
    }

    if (edge.type === 'conditional' && edge.condition) {
      const conditionValue = await edge.condition(state, context)
      if (edge.pathMap && edge.pathMap[conditionValue]) {
        return edge.pathMap[conditionValue]
      }
      return conditionValue || END
    }

    return END
  }
}
