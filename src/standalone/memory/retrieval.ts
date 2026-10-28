/**
 * @file retrieval.ts
 * Milestone M3: 记忆检索器、物理级 SQL 隐私隔离、6 天半衰期衰减与双轨复合打分引擎
 * 
 * 核心技术标准：
 * 1. 物理级 SQL 隐私隔离硬性红线：
 *    - 当 mode === 'live' 时，底层 SQL 强制注入 WHERE (scope IN ('live', 'public'))。
 *    - 严禁全量查出后在 JS 内存中过滤！
 *    - 100% 参数化绑定（?），彻底杜绝各类 SQL 注入与穿透攻击。
 *    - 管道末端设立 Defense-in-Depth（深度防御）熔断拦截断言。
 * 2. 6 天半衰期时效衰减模型：
 *    - recency = Math.pow(0.5, deltaMs / (6 * 24 * 3600 * 1000))。时钟微偏或回拨安全 clamp 为 1.0。
 * 3. 语义相似度双轨模型：
 *    - 主轨：纯 JS 512 维余弦向量相似度 (Cosine Similarity)，零外部编译依赖；
 *    - 降级轨：中英文字符 / N-gram 词元重叠度 (Lexical Matcher)，保证 100% 离线高可用。
 * 4. 复合打分公式：
 *    - finalScore = 0.4 * similarity + 0.3 * (importance / 10) + 0.3 * recency
 */

import type { DatabaseSync } from 'node:sqlite'
import type { EpisodeRecord, ScoredMemory, QueryMemoriesOptions, MemoryMode } from './types.ts'

// 半衰期：6 天 = 144 小时 = 518,400,000 毫秒
export const HALF_LIFE_MS = 6 * 24 * 3600 * 1000

/**
 * 计算 6 天半衰期时效得分 (0.0 ~ 1.0)
 * @param createdAt 记忆创建时间戳
 * @param now 当前时间戳，默认 Date.now()
 */
export function calculateRecencyScore(createdAt: number, now: number = Date.now()): number {
  const deltaMs = now - createdAt
  if (deltaMs <= 0) {
    // 应对 NTP 时钟微偏或同刻入库
    return 1.0
  }
  const score = Math.pow(0.5, deltaMs / HALF_LIFE_MS)
  return Math.max(0.0, Math.min(1.0, score))
}

/**
 * 纯 JS 计算两个向量的余弦相似度 (Cosine Similarity)
 * 映射至 [0.0, 1.0]
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
    return 0
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i]
    const b = vecB[i]
    dotProduct += a * b
    normA += a * a
    normB += b * b
  }

  if (normA <= 0 || normB <= 0) {
    return 0
  }

  const sim = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  // clamp 至 [0, 1]
  return Math.max(0.0, Math.min(1.0, sim))
}

/**
 * 关键词与 N-gram 字符级相似度 (离线降级轨)
 */
export function lexicalSimilarity(query: string, text: string): number {
  if (!query || !text) return 0
  const q = query.trim().toLowerCase()
  const t = text.trim().toLowerCase()

  if (t.includes(q)) {
    // 命中完整连续子串，获得较高基准匹配分
    return Math.min(1.0, 0.7 + 0.3 * (q.length / Math.max(q.length, t.length)))
  }

  // 提取查询字词元 (CJK 单字或英文单词)
  const qTokens = new Set<string>()
  for (const ch of q) {
    if (ch.trim()) qTokens.add(ch)
  }

  if (qTokens.size === 0) return 0

  let hits = 0
  for (const token of qTokens) {
    if (t.includes(token)) {
      hits++
    }
  }

  return hits / qTokens.size * 0.7
}

/**
 * 将数据库 Episode 原始行转换为 EpisodeRecord
 */
export function formatEpisodeRecord(row: any): EpisodeRecord {
  return {
    id: Number(row.id),
    created_at: Number(row.created_at),
    mode: row.mode as MemoryMode,
    scope: row.scope,
    actor: String(row.actor),
    text: String(row.text),
    tone: row.tone || null,
    importance: Number(row.importance ?? 5),
    embedding: row.embedding ? (typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding) : null,
    last_access: row.last_access ? Number(row.last_access) : null,
    access_cnt: Number(row.access_cnt ?? 0),
    merged_into: row.merged_into ? Number(row.merged_into) : null
  }
}

/**
 * 核心检索执行器：物理级 SQL 隔离与复合打分
 */
export function retrieveEpisodes(db: DatabaseSync, options: QueryMemoriesOptions): ScoredMemory[] {
  const {
    mode,
    queryKeyword,
    queryVector,
    scope,
    actor,
    minImportance = 1,
    limit = 10,
    offset = 0,
    weights = { similarity: 0.4, importance: 0.3, recency: 0.3 }
  } = options

  // 构建 WHERE 条件与参数数组
  const conditions: string[] = []
  const params: any[] = []

  // 1. 物理级 SQL 隔离硬性红线 (SQL-level Physical Isolation)
  if (mode === 'live') {
    // 直播模式下，强制锁定作用域为 live 或 public，绝不把 private 数据拉出数据库层！
    conditions.push("(scope IN ('live', 'public'))")
  } else if (scope) {
    // 伴侣模式下，若外部显式指定了 scope
    conditions.push('scope = ?')
    params.push(scope)
  }

  // 2. 重要度阈值参数化过滤
  if (minImportance > 1) {
    conditions.push('importance >= ?')
    params.push(Math.max(1, Math.min(10, minImportance)))
  }

  // 3. 主体过滤
  if (actor) {
    conditions.push('actor = ?')
    params.push(actor)
  }

  // 4. 关键词初筛 (若无向量检索时，用 LIKE 初筛以利用索引提升性能)
  if (queryKeyword && !queryVector) {
    conditions.push('text LIKE ?')
    params.push(`%${queryKeyword}%`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // 粗筛拉取候选集 (默认拉取 3 倍 limit 供复合打分精排)
  const candidateLimit = Math.max(limit * 3, 50)
  const sql = `
    SELECT * FROM episodes
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `
  params.push(candidateLimit, offset)

  const stmt = db.prepare(sql)
  const rows = stmt.all(...params) as any[]

  // 5. 深度防御 (Defense-in-Depth) 末端安全拦截断言
  if (mode === 'live') {
    const leakCheck = rows.find((r) => r.scope === 'private')
    if (leakCheck) {
      // 触发严重安全告警，立即清空结果集
      console.error(`[CRITICAL SECURITY ALERT] 检测到私密记忆渗透泄露风险，已实施紧急阻断！Episode ID: ${leakCheck.id}`)
      return []
    }
  }

  const now = Date.now()
  const scoredMemories: ScoredMemory[] = []

  // 权重归一化校验
  const wSim = weights.similarity ?? 0.4
  const wImp = weights.importance ?? 0.3
  const wRec = weights.recency ?? 0.3

  for (const row of rows) {
    const ep = formatEpisodeRecord(row)

    // 1) 时效得分 (6 天半衰期)
    const recencyScore = calculateRecencyScore(ep.created_at, now)

    // 2) 重要度得分 (归一化至 0~1)
    const importanceScore = Math.max(1, Math.min(10, ep.importance)) / 10

    // 3) 语义相似度得分
    let similarityScore = 0
    if (queryVector && Array.isArray(ep.embedding)) {
      similarityScore = cosineSimilarity(queryVector, ep.embedding as number[])
    } else if (queryKeyword) {
      similarityScore = lexicalSimilarity(queryKeyword, ep.text)
    } else {
      // 无查询条件时，相似度视为中性
      similarityScore = 0.5
    }

    // 综合加权评分
    const finalScore = wSim * similarityScore + wImp * importanceScore + wRec * recencyScore

    scoredMemories.push({
      ...ep,
      finalScore: Number(finalScore.toFixed(4)),
      similarityScore: Number(similarityScore.toFixed(4)),
      recencyScore: Number(recencyScore.toFixed(4)),
      importanceScore: Number(importanceScore.toFixed(4))
    })
  }

  // 6. 按综合评分倒序排序，截取 Top-K
  scoredMemories.sort((a, b) => b.finalScore - a.finalScore)
  const results = scoredMemories.slice(0, limit)

  // 7. 异步更新检索命中热度 (last_access, access_cnt)
  if (results.length > 0) {
    try {
      const ids = results.map((r) => r.id)
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`
        UPDATE episodes
        SET last_access = ?, access_cnt = access_cnt + 1
        WHERE id IN (${placeholders})
      `).run(now, ...ids)
    } catch {
      // 忽略热度更新异常
    }
  }

  return results
}

/**
 * 清理超期低重要度情景记忆 (遗忘淘汰机制)
 * @param retentionDays 留存天数 (默认 7 天)
 * @param maxImportance 待清理的最高重要度 (默认 <= 2，重要度 >= 8 永久保留)
 */
export function cleanOldEpisodes(db: DatabaseSync, retentionDays: number = 7, maxImportance: number = 2): number {
  const cutoffTime = Date.now() - retentionDays * 24 * 3600 * 1000
  const stmt = db.prepare(`
    DELETE FROM episodes
    WHERE importance <= ?
      AND COALESCE(last_access, created_at) < ?
  `)
  const result = stmt.run(maxImportance, cutoffTime)
  return Number(result.changes)
}
