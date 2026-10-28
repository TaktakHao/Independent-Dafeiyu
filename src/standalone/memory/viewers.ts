/**
 * @file viewers.ts
 * Milestone M3: 观众画像持久化管理器、Unicode 码点级归一化与 Levenshtein 模糊去重合并引擎
 * 
 * 核心技术标准：
 * 1. 字段权威统一：物理层存储 uid, normalized_name, original_name, affinity, visit_count, gift_points, last_seen, topics。
 * 2. 契约兼容别名：模型层透出 nickname (-> original_name), gift_score (-> gift_points), tags (-> topics)。
 * 3. Unicode 码点级归一化：剥离零宽字符、全角转半角、多空格合并、转小写。
 * 4. 码点级 Levenshtein DP：Array.from 避免多字节 Emoji (如 🐟) 代理对撕裂，准确识别编辑距离 <= 1。
 * 5. 模糊合并安全策略：短昵称 (<2 字符) 防误伤保护，候选集长度差 <= 1 粗筛优化，好感度严格 clamp 在 [0, 100]。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { ViewerProfile, UpsertViewerOptions } from './types.ts'

/**
 * 观众昵称 Unicode 清洗与归一化
 * 1. 剔除零宽字符与格式控制符 (\u200B-\u200D, \uFEFF)
 * 2. 全角英数符号转半角 (\uFF01-\uFF5E -> 减 0xfee0)
 * 3. 全角空格 \u3000 转半角单空格
 * 4. 连续空白字符压缩为单一空格
 * 5. 首尾空白裁剪并统一小写
 */
export function normalizeViewerNickname(nickname: string): string {
  if (!nickname || typeof nickname !== 'string') return ''
  let s = nickname
  // 剔除零宽字符 (Zero-width space/non-joiner/joiner, BOM)
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '')
  // 全角 ASCII 符号与字母数字转半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  // 全角空格转半角单空格
  s = s.replace(/\u3000/g, ' ')
  // 过滤多余连续空白
  s = s.replace(/\s+/g, ' ')
  return s.trim().toLowerCase()
}

/**
 * 计算两个字符串基于 Unicode 码点 (Code Points) 的编辑距离 (Levenshtein Distance)
 * 使用 Array.from 拆分字符，确保 Emoji (如 🐟) 和复合字符被当作单个字形单位
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  const charsA = Array.from(a || '')
  const charsB = Array.from(b || '')

  const m = charsA.length
  const n = charsB.length

  if (m === 0) return n
  if (n === 0) return m

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = charsA[i - 1] === charsB[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,        // 删除
        dp[i][j - 1] + 1,        // 插入
        dp[i - 1][j - 1] + cost  // 替换
      )
    }
  }

  return dp[m][n]
}

/**
 * 将数据库原始记录转换为具备兼容别名的 ViewerProfile
 */
export function formatViewerRecord(row: any): ViewerProfile {
  let parsedTopics: string[] = []
  try {
    if (row.topics) {
      parsedTopics = typeof row.topics === 'string' ? JSON.parse(row.topics) : row.topics
    }
  } catch {
    parsedTopics = []
  }

  const originalName = row.original_name || row.nickname || ''
  const giftPoints = Number(row.gift_points ?? row.gift_score ?? 0)

  return {
    uid: String(row.uid),
    normalized_name: String(row.normalized_name),
    original_name: originalName,
    nickname: originalName, // 兼容别名
    alias: row.alias || null,
    affinity: Number(row.affinity ?? 10),
    visit_count: Number(row.visit_count ?? 1),
    gift_points: giftPoints,
    gift_score: giftPoints, // 兼容别名
    last_seen: Number(row.last_seen ?? Date.now()),
    topics: parsedTopics,
    tags: parsedTopics,     // 兼容别名
    first_seen: row.first_seen ? Number(row.first_seen) : undefined
  }
}

export class ViewerManager {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /**
   * 插入或更新观众画像 (支持 Unicode 码点 Levenshtein <= 1 模糊合并)
   */
  upsertViewer(options: UpsertViewerOptions): ViewerProfile {
    const {
      uid: rawUid,
      nickname,
      giftDelta = 0,
      affinityDelta = 1,
      topic,
      maxAffinity = 100,
      minAffinity = 0
    } = options

    const normalized = normalizeViewerNickname(nickname)
    const now = Date.now()

    // 1. 精确匹配：优先查 uid，其次查 normalized_name
    let existingRow: any = null
    if (rawUid) {
      existingRow = this.db.prepare('SELECT * FROM viewers WHERE uid = ?').get(rawUid)
    }

    if (!existingRow && normalized) {
      existingRow = this.db.prepare('SELECT * FROM viewers WHERE normalized_name = ?').get(normalized)
    }

    // 2. 模糊匹配：若精确未命中，且归一化长度 >= 2 (短昵称防误伤)，进行 Levenshtein <= 1 模糊匹配
    const normChars = Array.from(normalized)
    if (!existingRow && normChars.length >= 2) {
      // 候选集粗筛：按最近活跃查询前 100 名常客
      const candidates = this.db.prepare(`
        SELECT * FROM viewers
        ORDER BY last_seen DESC
        LIMIT 100
      `).all() as any[]

      for (const cand of candidates) {
        const candChars = Array.from(cand.normalized_name || '')
        // 长度差大于 1 则编辑距离必然大于 1，直接跳过
        if (Math.abs(candChars.length - normChars.length) > 1) {
          continue
        }
        const dist = levenshteinDistance(normalized, cand.normalized_name)
        if (dist <= 1) {
          existingRow = cand
          break
        }
      }
    }

    // 3. 执行更新或插入
    if (existingRow) {
      const currentAffinity = Number(existingRow.affinity ?? 10)
      const currentGiftPoints = Number(existingRow.gift_points ?? existingRow.gift_score ?? 0)
      const currentVisits = Number(existingRow.visit_count ?? 1)

      const newAffinity = Math.max(minAffinity, Math.min(maxAffinity, currentAffinity + affinityDelta))
      const newGiftPoints = Math.max(0, currentGiftPoints + giftDelta)
      const newVisits = currentVisits + 1

      let topics: string[] = []
      try {
        topics = existingRow.topics ? (typeof existingRow.topics === 'string' ? JSON.parse(existingRow.topics) : existingRow.topics) : []
      } catch {
        topics = []
      }
      if (topic && !topics.includes(topic)) {
        topics.push(topic)
      }

      this.db.prepare(`
        UPDATE viewers
        SET original_name = ?,
            normalized_name = ?,
            affinity = ?,
            visit_count = ?,
            gift_points = ?,
            last_seen = ?,
            topics = ?
        WHERE uid = ?
      `).run(
        nickname,
        normalized || existingRow.normalized_name,
        newAffinity,
        newVisits,
        newGiftPoints,
        now,
        JSON.stringify(topics),
        existingRow.uid
      )

      return formatViewerRecord({
        ...existingRow,
        original_name: nickname,
        normalized_name: normalized || existingRow.normalized_name,
        affinity: newAffinity,
        visit_count: newVisits,
        gift_points: newGiftPoints,
        last_seen: now,
        topics: JSON.stringify(topics)
      })
    } else {
      // 新建观众画像
      const finalUid = rawUid || `viewer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const initAffinity = Math.max(minAffinity, Math.min(maxAffinity, 10 + affinityDelta))
      const initGiftPoints = Math.max(0, giftDelta)
      const initVisits = 1
      const topics = topic ? [topic] : []

      this.db.prepare(`
        INSERT INTO viewers (uid, original_name, normalized_name, affinity, visit_count, gift_points, last_seen, topics)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        finalUid,
        nickname,
        normalized,
        initAffinity,
        initVisits,
        initGiftPoints,
        now,
        JSON.stringify(topics)
      )

      return formatViewerRecord({
        uid: finalUid,
        original_name: nickname,
        normalized_name: normalized,
        affinity: initAffinity,
        visit_count: initVisits,
        gift_points: initGiftPoints,
        last_seen: now,
        topics: JSON.stringify(topics)
      })
    }
  }

  /**
   * 根据 uid 或归一化昵称查询观众画像
   */
  getViewer(uidOrNormalized: string): ViewerProfile | null {
    if (!uidOrNormalized) return null
    const row = this.db.prepare(`
      SELECT * FROM viewers
      WHERE uid = ? OR normalized_name = ?
      LIMIT 1
    `).get(uidOrNormalized, normalizeViewerNickname(uidOrNormalized))

    return row ? formatViewerRecord(row) : null
  }

  /**
   * 获取按好感度或活跃排序的高频观众列表
   */
  listTopViewers(limit: number = 10): ViewerProfile[] {
    const rows = this.db.prepare(`
      SELECT * FROM viewers
      ORDER BY affinity DESC, last_seen DESC
      LIMIT ?
    `).all(Math.max(1, limit))

    return rows.map((r) => formatViewerRecord(r))
  }
}
