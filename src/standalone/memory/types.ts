/**
 * @file types.ts
 * Milestone M3: 分层记忆系统核心领域类型定义与接口契约
 * 
 * 包含：
 * 1. 记忆隐私三级作用域 (private / live / public) 与运行模态 (companion / live)
 * 2. L1-L5 分层记忆数据模型 (工作记忆、会话摘要、情景记忆、语义事实、第一人称日记)
 * 3. 观众画像档案模型 (字段兼容别名映射)
 * 4. 检索评分模型与打分权重配置
 * 5. 全局状态与 RPG 数值模型
 */

/**
 * 记忆隐私作用域
 * - private: 主播私密心事、敏感信息、个人隐私等（直播模式物理级绝对隔离）
 * - live: 直播间互动、弹幕热梗、观众画像、打赏记录等（双模式可见）
 * - public: 虚拟女儿公开人设、公开喜好、通用知识等（双模式可见）
 */
export type MemoryScope = 'private' | 'live' | 'public'

/**
 * 运行模态
 * - companion: 伴侣模式（老爸桌面日常陪伴，全量记忆可用，默认产生 private 记忆）
 * - live: 直播模式（抖音直播双人在场，SQL 物理层强制隔离 private 记忆，默认产生 live 记忆）
 */
export type MemoryMode = 'companion' | 'live'
export type CompanionMode = MemoryMode

/**
 * L3 情景记忆实体记录 (episodes 表)
 */
export interface EpisodeRecord {
  id: number
  created_at: number               // 毫秒时间戳
  mode: MemoryMode                 // 产生时的模态
  scope: MemoryScope               // 隐私作用域
  actor: string                    // 主体: host | viewer:<uid> | daughter | system
  text: string                     // 情景描述与正文
  tone?: string | null             // 情绪色调: happy | tsundere | grumpy | sulking | sleepy | neutral 等
  importance: number               // 重要度评分: 1~10 (默认 5)
  embedding?: string | number[] | null // 向量表示 (JSON 字符串或数组)
  last_access?: number | null      // 最近一次被检索命中的时间戳
  access_cnt?: number              // 累计被检索召回的次数
  merged_into?: number | null      // 归档或合并指向的父级 episode ID
}

/**
 * 新增情景记忆参数选项
 */
export interface InsertEpisodeOptions {
  mode?: MemoryMode
  scope?: MemoryScope
  actor?: string
  text: string
  tone?: string | null
  importance?: number
  embedding?: string | number[] | null
  created_at?: number
}

/**
 * L4 语义记忆事实实体记录 (facts 表)
 */
export interface FactRecord {
  id: number
  category?: string                // 事实分类: preference | habit | profile | event 等
  subject: string                  // 事实主体: host | viewer:<uid> | self
  predicate: string                // 属性键: food.dislike | birthday | coding_habit 等
  object: string                   // 属性值: 香菜 | 10-24 | 喜欢写重构
  confidence?: number              // 置信度: 0.0 ~ 1.0 (默认 1.0)
  scope: MemoryScope               // 隐私作用域 (默认 private)
  updated_at: number               // 更新毫秒时间戳
  source_ids?: string | number[]   // 提炼来源 episode ID 数组
}

/**
 * 新增/更新语义事实参数选项
 */
export interface UpsertFactOptions {
  category?: string
  subject: string
  predicate: string
  object: string
  confidence?: number
  scope?: MemoryScope
  source_ids?: number[] | string
}

/**
 * 观众画像档案实体记录 (viewers 表与内存模型)
 */
export interface ViewerProfile {
  uid: string                      // 观众唯一标识
  normalized_name: string          // 归一化昵称 (全半角小写过滤特殊符号，用于唯一索引与去重)
  original_name: string            // 原始昵称
  nickname: string                 // 兼容别名 (指向 original_name)
  alias?: string | null            // 女儿给观众起的专属昵称
  affinity: number                 // 好感度: [0, 100] (默认初始分 10)
  visit_count: number              // 累计到访次数 (默认 1)
  gift_points: number              // 累计礼物分 (默认 0)
  gift_score: number               // 兼容别名 (指向 gift_points)
  last_seen: number                // 最近一次互动毫秒时间戳
  topics: string[]                 // 感兴趣的话题或弹幕偏好
  tags: string[]                   // 兼容别名 (指向 topics)
  first_seen?: number              // 首次来访时间戳
}

export type ViewerRecord = ViewerProfile

/**
 * 观众画像更新参数选项
 */
export interface UpsertViewerOptions {
  uid?: string                     // 若为空则根据昵称或时间戳兜底生成
  nickname: string                 // 观众昵称
  giftDelta?: number               // 本次礼物积分增量
  affinityDelta?: number           // 本次好感度增量 (默认 1)
  topic?: string                   // 本次对话涉及的话题
  maxAffinity?: number             // 好感度上限 (默认 100)
  minAffinity?: number             // 好感度下限 (默认 0)
}

/**
 * 全局持久化键值记录 (state 表)
 */
export interface StateRecord {
  key: string
  value: string
  updated_at: number
}

/**
 * RPG 三轴核心数值记录
 */
export interface RpgStateRecord {
  hunger: number                   // 饱食度: 0 ~ 100
  mood: number                     // 心情值: 0 ~ 100
  energy: number                   // 精力值: 0 ~ 100
  last_updated?: number            // 更新毫秒时间戳
}

/**
 * L1 工作记忆对话轮次
 */
export interface DialogueTurn {
  id: string                       // 唯一编号
  role: 'user' | 'assistant'       // 角色
  text: string                     // 对话文本
  actor?: string                   // 说话者标识 (host / viewer / daughter)
  timestamp: number                // 时间戳
  tokens: number                   // 估算 Token 数
}

/**
 * 检索评分结果项
 */
export interface ScoredMemory extends EpisodeRecord {
  finalScore: number               // 综合评分 (0.0 ~ 1.0)
  similarityScore: number          // 语义相似度得分 (0.0 ~ 1.0)
  recencyScore: number             // 6 天半衰期时效得分 (0.0 ~ 1.0)
  importanceScore: number          // 归一化重要度得分 (0.0 ~ 1.0)
}

/**
 * 记忆检索过滤与配置参数
 */
export interface QueryMemoriesOptions {
  mode: MemoryMode                 // 必传：当前模态 (live 强制 SQL 物理隔离)
  queryKeyword?: string            // 检索关键词
  queryVector?: number[]           // 语义检索向量 (512 维)
  scope?: MemoryScope              // 可选限定隐私域 (live 模式下传入 private 会被强制阻断)
  actor?: string                   // 筛选特定主体
  minImportance?: number           // 最低重要度阈值 (1~10)
  limit?: number                   // 返回记录上限 (默认 10)
  offset?: number                  // 分页偏移
  weights?: {                      // 综合打分权重 (合计为 1.0)
    similarity?: number            // 默认 0.4
    importance?: number            // 默认 0.3
    recency?: number               // 默认 0.3
  }
}

/**
 * 数据库初始化配置选项
 */
export interface DatabaseOptions {
  path?: string                    // 数据库路径 (默认 'runtime/data/daughter.db' 或 ':memory:')
  wal?: boolean                    // 是否开启 WAL 模式 (磁盘数据库默认 true)
  timeoutMs?: number               // busy_timeout 毫秒 (默认 5000)
}
