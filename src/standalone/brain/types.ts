/**
 * @file types.ts
 * 分级大脑路由器、提供方与流式语音管线核心契约与类型定义
 */

/**
 * 思考层级定义
 * Tier 1: 本地 Agent CLI (agy, cursor-agent)
 * Tier 2: 在线 DeepSeek API (deepseek-chat SSE 流式)
 * Tier 3: 本地模型 (Ollama / MLX-LM HTTP 常驻)
 * Tier 4: 离线规则语料库 (确定性零死锁兜底)
 */
export type BrainTier = 1 | 2 | 3 | 4

/**
 * 提供方运行状态
 */
export type ProviderState =
  | 'READY'          // 就绪健康
  | 'BUSY'           // 正在推理
  | 'EXHAUSTED'      // 额度耗尽 (冷却中)
  | 'NEEDS_AUTH'     // 认证失效 (需人工介入)
  | 'CIRCUIT_BROKEN' // 连续失败熔断 (60秒冷却)
  | 'HALF_OPEN'      // 熔断后单次试探

/**
 * 思考触发事件类型
 */
export type BrainEventType =
  | 'DANMAKU'           // 普通弹幕 (延迟预算 ~4000ms)
  | 'GIFT_THANKS_LARGE' // 大额礼物感谢 (延迟预算 ~2500ms)
  | 'HOST_COMMAND'      // 主播控制台指令/对话 (延迟预算 ~8000ms)
  | 'COMPANION_CHAT'    // 桌面伴侣日常闲聊 (延迟预算 ~15000ms)
  | 'PROACTIVE_SPEECH'  // 内心独白/主动搭话 (延迟预算 ~20000ms)
  | 'SCHEDULED_TASK'    // 定时日程/记忆总结 (延迟预算 ~30000ms)
  | string

/**
 * 3 层前缀缓存友好提示词结构
 */
export interface LayeredPrompt {
  /** [Layer A] 逐字完全固化的系统人设、Few-shot 与动作安全规范 (KV Cache 命中的生命线) */
  layerA: string
  /** [Layer B] 半静态事实与近况滚动摘要 */
  layerB: string
  /** [Layer C] 动态事件、最近台词、<event> 标签 */
  layerC: string
  /** 组装后的完整文本 */
  fullText: string
  /** 估算的 Token 数 (按 Math.ceil(length * 1.1) 计算) */
  estimatedTokens?: number
}

/**
 * 大脑标准化结构化输出
 */
export interface BrainOutput {
  /** 最终说出的台词正文 (非空) */
  reply: string
  /** 兼容别名: 台词正文 */
  text: string
  /** 关联动画动作剪辑名 (如 eat_token, head_pat, poke, thinking, idle 等) */
  clip?: string
  /** 语气风格 (happy, tsundere, grumpy, sulking, sleepy, angry, sad, calm 等) */
  tone?: string
  /** 心情增减倾向 (严格 clamp 至 -2 ~ +2) */
  moodIntent?: number
  /** 是否涉及食物或投喂 */
  fed?: boolean
  /** 沉淀的事实或记忆点 */
  memory?: string
  /** 针对的受众 (用户或观众 ID/昵称) */
  to?: string
  /** 原始提取的元数据标签字符串 (如 <meta .../>) */
  rawMeta?: string
}

/**
 * 大脑思考请求入参
 */
export interface BrainRequest {
  id?: string
  eventType?: BrainEventType
  /** 兼容别名: 事件类型 */
  type?: string
  /** 伴侣模式 / 直播模式 */
  mode?: 'companion' | 'live'
  /** 3-Layer 提示词或原始字符串 */
  prompt: string | LayeredPrompt
  /** 附带元数据 (如观众信息、礼物明细、当前活动应用等) */
  meta?: Record<string, any>
  /** 显式覆盖的截止时限 (ms) */
  deadlineMs?: number
  /** 取消信号 */
  abortSignal?: AbortSignal
  /** 最大输出 Token 数 */
  maxOutputTokens?: number
}

/**
 * 大脑思考返回结果
 */
export interface BrainResult {
  tier: BrainTier
  provider: string
  providerId: string
  output: BrainOutput
  /** 兼容属性: 指向 output */
  result: BrainOutput
  durationMs: number
  latencyMs: number
  stream?: AsyncIterable<string>
}

/**
 * 提供方运行状态统计信息
 */
export interface ProviderStatusInfo {
  id: string
  tier: BrainTier
  name: string
  state: ProviderState
  totalInvocations: number
  successCount: number
  failureCount: number
  consecutiveFailures: number
  estimatedLatencyMs: number
  p50LatencyMs: number
  p90LatencyMs: number
  exhaustedUntil?: number
  circuitBrokenUntil?: number
  lastError?: string
}

/**
 * 大脑提供方标准接口
 */
export interface BrainProvider {
  readonly id: string
  readonly tier: BrainTier
  readonly name: string
  isAvailable(): boolean
  getEstimatedLatencyMs(): number
  getStatus(): ProviderStatusInfo
  think(request: BrainRequest, options?: { timeoutMs?: number; abortSignal?: AbortSignal }): Promise<BrainResult>
  thinkStream?(request: BrainRequest, options?: { timeoutMs?: number; abortSignal?: AbortSignal }): AsyncIterable<string>
}
