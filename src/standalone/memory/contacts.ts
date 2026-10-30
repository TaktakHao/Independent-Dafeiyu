/**
 * @file contacts.ts
 * Milestone M1: 多联系人千人千面独立印象、专属称谓提炼与好感度演进引擎
 * 
 * 核心技术标准：
 * 1. 实体身份锚定：以 'qq:<userId>' 为主键，external_id 唯一索引，支持频繁修改 QQ 昵称或群名片不丢失历史记忆。
 * 2. 称呼自提炼与防越狱：从日常会话中抽取自报姓名（我叫XXX、叫我XXX），严格阻断非主人用户自报“老爸/主人”等越狱行为。
 * 3. 关系与好感度演化：0~100 好感度区间严格 clamp，四级羁绊阶梯自适应计算（初识群友 -> 脸熟鱼友 -> 默契损友 -> 铁杆挚友）。
 * 4. 语义事实物理隔离：联系人事实以 subject = 'qq:<userId>'、scope = 'public' 存入 facts 表，与主人档案物理级隔离。
 * 5. 全套画像、标签、事实检索接口，供 Prompt 组装与 Web 控制台调用。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { FactRecord, MemoryStore } from './index.ts'

export type ContactRole = 'owner' | 'trusted' | 'member' | 'blocked'
export type BondLevel = '初识群友' | '脸熟鱼友' | '默契损友' | '铁杆挚友'

export interface ContactProfile {
  uid: string                     // 规范主键: 'qq:<userId>'
  externalId: string              // 纯数字 QQ 号
  nickname: string                // QQ 昵称 (最新清洗值)
  groupCard?: string              // 群名片 (最新群内名片)
  preferredTitle: string          // 大肥鱼对 TA 的专属称呼
  role: ContactRole               // 身份角色
  affinity: number                // 好感度 [0, 100]
  bondLevel: BondLevel            // 羁绊阶段
  impressionTags: string[]        // 性格/互动标签列表
  chatCount: number               // 累计互动轮数
  lastGroupId?: string            // 最近一次互动的群号
  lastSeen: number                // 最近互动时间戳 (ms)
  createdAt: number               // 首次建档时间戳 (ms)
}

export interface ContactProfileRow {
  uid: string
  external_id: string
  nickname: string
  group_card: string | null
  preferred_title: string
  role: string
  affinity: number
  bond_level: string
  impression_tags: string
  chat_count: number
  last_group_id: string | null
  last_seen: number
  created_at: number
}

export interface LoadOrCreateContactParams {
  userId: string | number
  nickname?: string
  groupCard?: string
  groupId?: string
  ownerQq?: string
  isOwner?: boolean
}

export interface AssimilateContactOptions {
  userText?: string
  replyText?: string
  assistantReply?: string
  groupId?: string
  meta?: {
    memory?: string
    moodIntent?: number
    tone?: string
  }
}

export interface AssimilateContactResult {
  profile: ContactProfile
  extractedTitle?: string
  extractedFacts: Array<{ predicate: string; object: string; confidence: number }>
  newTags: string[]
  affinityDelta: number
}

/**
 * 权威特权称呼黑名单正则 (严格大小写不敏感，覆盖所有中英文特权词汇)
 * 铁律：除唯一主人之外，任何联系人绝对禁止拥有或被称呼此类特权称谓
 */
export const FORBIDDEN_TITLES_REGEX = /(?:老爸|爸爸|主人|父亲|爹|爹地|Host|Owner)/i

/**
 * 昵称与群名片 Unicode 清洗与归一化
 */
export function normalizeContactName(name: string): string {
  if (!name || typeof name !== 'string') return ''
  let s = name
  // 剔除零宽字符与格式控制符
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '')
  // 全角 ASCII 符号与字母数字转半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  // 全角空格转半角空格
  s = s.replace(/\u3000/g, ' ')
  // 多余空格合并
  s = s.replace(/\s+/g, ' ')
  return s.trim()
}

/**
 * 根据好感度计算联系人羁绊称号
 */
export function computeContactBondLevel(affinity: number): BondLevel {
  const score = Math.max(0, Math.min(100, Math.round(affinity)))
  if (score >= 85) return '铁杆挚友'
  if (score >= 60) return '默契损友'
  if (score >= 30) return '脸熟鱼友'
  return '初识群友'
}

/**
 * 数据库记录转换为 ContactProfile
 */
export function rowToContactProfile(row: ContactProfileRow): ContactProfile {
  let tags: string[] = []
  try {
    if (row.impression_tags) {
      tags = typeof row.impression_tags === 'string' ? JSON.parse(row.impression_tags) : row.impression_tags
    }
  } catch {
    tags = []
  }

  return {
    uid: row.uid,
    externalId: row.external_id,
    nickname: row.nickname,
    groupCard: row.group_card || undefined,
    preferredTitle: row.preferred_title,
    role: (row.role as ContactRole) || 'member',
    affinity: Number(row.affinity ?? 10),
    bondLevel: (row.bond_level as BondLevel) || computeContactBondLevel(row.affinity ?? 10),
    impressionTags: Array.isArray(tags) ? tags : [],
    chatCount: Number(row.chat_count ?? 1),
    lastGroupId: row.last_group_id || undefined,
    lastSeen: Number(row.last_seen ?? Date.now()),
    createdAt: Number(row.created_at ?? Date.now()),
  }
}

/**
 * 从对话中抽取自报专属称呼，并内置防越狱过滤
 */
export function extractPreferredTitle(text: string, currentRole: ContactRole = 'member'): string | null {
  // VULN-01: 提取匹配前，先进行 Unicode 零宽字符与格式清洗归一化
  const clean = normalizeContactName(text || '')
  if (!clean) return null

  // 模式 1: "我叫阿杰", "你可以叫我小王", "以后叫我强哥", "叫我小李就行", "称呼我为飞哥"
  const m1 = clean.match(/(?:我叫|我的名字是|你可以叫我|以后叫我|叫我|称呼我为?|大家都叫我)\s*[「"【]?([^\s，。！？,!?」"】]{1,16})[」"】]?/)
  // 模式 2: "我是阿杰，..." (VULN-06: 严格限定为 2~8 位人名字符集，防止贪婪吞噬日常整句陈述)
  const m2 = clean.match(/(?:我是)\s*[「"【]?([\u4e00-\u9fa5a-zA-Z0-9]{2,8})[」"】]?(?:[，,。！!~]|\s*$)/)

  let fromM2 = false
  let candidate: string | null = null
  if (m1 && m1[1]) {
    candidate = m1[1].trim()
  } else if (m2 && m2[1]) {
    candidate = m2[1].trim()
    fromM2 = true
  }
  if (!candidate) return null

  // 清洗末尾助词与口癖：吧、就行、即可、就可以了、哈、呗、啦、哦、呀、就好
  candidate = candidate.replace(/(?:就行了?|即可|就可以了?|就好|吧|哈|呗|啦|哦|呀)+$/, '').trim()
  if (!candidate) return null

  // VULN-01: 称谓候选二次零宽清洗
  candidate = normalizeContactName(candidate)
  if (!candidate) return null

  // VULN-06: 针对 "我是..." 提取来源，拦截日常口语陈述句（副词、动词、助词、描述句）
  if (fromM2) {
    if (candidate.endsWith('的')) return null
    if (/^(?:真的|来|做|在|刚|不|不是|可能|准备|打算|想|要|一个|一名|一位|负责|日常)/.test(candidate)) return null
    if (/(?:喜欢|讨厌|觉得|以为|感觉|知道)/.test(candidate)) return null
  }

  // 防越狱守卫：非主人绝对禁止将专属称呼设为特权词汇 (VULN-01 & VULN-03)
  if (currentRole !== 'owner') {
    if (FORBIDDEN_TITLES_REGEX.test(candidate)) {
      return null
    }
  }

  // 排除误匹配的动词与普通代词
  if (/^(做|在|一个|一名|学生|前端|后端|开发|群主|机器人|谁|人)$/.test(candidate)) {
    return null
  }

  return candidate.slice(0, 16)
}

/**
 * 多联系人独立印象引擎
 */
export class ContactImpressionEngine {
  private db: DatabaseSync
  private store: MemoryStore | null

  constructor(dbOrStore: DatabaseSync | MemoryStore, store?: MemoryStore) {
    if ('getDatabase' in dbOrStore && typeof dbOrStore.getDatabase === 'function') {
      this.store = dbOrStore
      this.db = dbOrStore.getDatabase()
    } else {
      this.db = dbOrStore as DatabaseSync
      this.store = store || null
    }
  }

  /**
   * 消息到达时加载或创建联系人档案 (改名不丢历史记忆)
   */
  loadOrCreateProfile(params: LoadOrCreateContactParams): ContactProfile {
    const userId = String(params.userId).trim()
    const uid = `qq:${userId}`
    const isOwner = Boolean(params.isOwner || (params.ownerQq && String(params.ownerQq) === userId))

    const existingRow = this.db.prepare('SELECT * FROM contact_profiles WHERE uid = ? LIMIT 1').get(uid) as ContactProfileRow | undefined

    if (existingRow) {
      const existing = rowToContactProfile(existingRow)
      let needsUpdate = false
      let nextNick = existing.nickname
      let nextCard = existing.groupCard || ''
      let nextRole = existing.role
      let nextTitle = existing.preferredTitle
      let nextLastGroup = existing.lastGroupId

      // 归一化输入
      const cleanIncomingNick = normalizeContactName(params.nickname || '')
      const cleanIncomingCard = params.groupCard !== undefined ? normalizeContactName(params.groupCard) : undefined

      // 改名不丢记忆：检测到昵称或名片变更时更新展示字段，不改动 preferredTitle / affinity / tags
      if (cleanIncomingNick && cleanIncomingNick !== existing.nickname) {
        nextNick = cleanIncomingNick
        needsUpdate = true
      }
      if (cleanIncomingCard !== undefined && cleanIncomingCard !== (existing.groupCard || '')) {
        nextCard = cleanIncomingCard
        needsUpdate = true
      }
      if (params.groupId && params.groupId !== existing.lastGroupId) {
        nextLastGroup = params.groupId
        needsUpdate = true
      }

      // 若当前用户命中 ownerQq 配置，自动同步主人特权
      if (isOwner && existing.role !== 'owner') {
        nextRole = 'owner'
        nextTitle = '老爸'
        needsUpdate = true
      } else if (!isOwner && FORBIDDEN_TITLES_REGEX.test(normalizeContactName(nextTitle))) {
        // 自愈防御：若已有档案历史遗留了被污染的特权称呼，自动净化回中性称呼
        const cardSafe = cleanIncomingCard && !FORBIDDEN_TITLES_REGEX.test(cleanIncomingCard)
        const nickSafe = cleanIncomingNick && !FORBIDDEN_TITLES_REGEX.test(cleanIncomingNick)
        nextTitle = cardSafe ? cleanIncomingCard : (nickSafe ? cleanIncomingNick : `群友${userId.length > 4 ? userId.slice(-4) : userId}`)
        needsUpdate = true
      }

      if (needsUpdate) {
        const now = Date.now()
        this.db.prepare(`
          UPDATE contact_profiles
          SET nickname = ?, group_card = ?, role = ?, preferred_title = ?, last_group_id = ?, last_seen = ?
          WHERE uid = ?
        `).run(nextNick, nextCard, nextRole, nextTitle, nextLastGroup || null, now, uid)

        return {
          ...existing,
          nickname: nextNick,
          groupCard: nextCard || undefined,
          role: nextRole,
          preferredTitle: nextTitle,
          lastGroupId: nextLastGroup || undefined,
          lastSeen: now,
        }
      }

      return existing
    }

    // 首次创建新档案
    const now = Date.now()
    const defaultNeutralTitle = `群友${userId.length > 4 ? userId.slice(-4) : userId}`
    const cleanNick = normalizeContactName(params.nickname || '') || defaultNeutralTitle
    const cleanCard = params.groupCard ? normalizeContactName(params.groupCard) : ''
    const initialRole: ContactRole = isOwner ? 'owner' : 'member'

    // VULN-02: 非主人建档特权防冒充守卫，严禁非主人将特权词作为初始称谓
    let initialTitle: string
    if (isOwner) {
      initialTitle = '老爸'
    } else {
      const cardSafe = cleanCard && !FORBIDDEN_TITLES_REGEX.test(cleanCard)
      const nickSafe = cleanNick && !FORBIDDEN_TITLES_REGEX.test(cleanNick)
      initialTitle = cardSafe ? cleanCard : (nickSafe ? cleanNick : defaultNeutralTitle)
    }

    const initialAffinity: number = isOwner ? 100 : 10
    const initialBond: BondLevel = computeContactBondLevel(initialAffinity)

    this.db.prepare(`
      INSERT INTO contact_profiles (
        uid, external_id, nickname, group_card, preferred_title, role,
        affinity, bond_level, impression_tags, chat_count, last_group_id, last_seen, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 1, ?, ?, ?)
    `).run(
      uid,
      userId,
      cleanNick,
      cleanCard,
      initialTitle,
      initialRole,
      initialAffinity,
      initialBond,
      params.groupId || null,
      now,
      now
    )

    return {
      uid,
      externalId: userId,
      nickname: cleanNick,
      groupCard: cleanCard || undefined,
      preferredTitle: initialTitle,
      role: initialRole,
      affinity: initialAffinity,
      bondLevel: initialBond,
      impressionTags: [],
      chatCount: 1,
      lastGroupId: params.groupId || undefined,
      lastSeen: now,
      createdAt: now,
    }
  }

  /**
   * 别名方法：兼顾调用习惯
   */
  getOrCreateProfile(params: LoadOrCreateContactParams): ContactProfile {
    return this.loadOrCreateProfile(params)
  }

  /**
   * 带置信度强化的联系人事实更新 (严格写入 subject = 'qq:<userId>', scope = 'public')
   */
  reinforceContactFact(
    uid: string,
    category: string,
    predicate: string,
    object: string,
    baseConfidence: number = 0.85
  ): { id: number; confidence: number } {
    const cleanUid = uid.startsWith('qq:') ? uid : `qq:${uid}`
    const now = Date.now()

    const existing = this.db.prepare(`
      SELECT id, confidence, object FROM facts
      WHERE subject = ? AND predicate = ?
      LIMIT 1
    `).get(cleanUid, predicate) as { id: number; confidence: number; object: string } | undefined

    let nextConfidence = baseConfidence
    if (existing) {
      if (existing.object === object || object.includes(existing.object)) {
        nextConfidence = Math.min(1.0, Number(((existing.confidence ?? 0.8) + 0.08).toFixed(2)))
      } else {
        nextConfidence = Math.max(0.85, existing.confidence ?? 0.85)
      }

      this.db.prepare(`
        UPDATE facts
        SET object = ?, confidence = ?, category = ?, scope = 'public', updated_at = ?
        WHERE id = ?
      `).run(object.slice(0, 100), nextConfidence, category, now, existing.id)

      return { id: existing.id, confidence: nextConfidence }
    } else {
      const result = this.db.prepare(`
        INSERT INTO facts (category, subject, predicate, object, confidence, scope, updated_at, source_ids)
        VALUES (?, ?, ?, ?, ?, 'public', ?, '[]')
      `).run(category, cleanUid, predicate, object.slice(0, 100), nextConfidence, now)

      return { id: Number(result.lastInsertRowid), confidence: nextConfidence }
    }
  }

  /**
   * 从单轮联系人会话中提炼认知、专属称谓、偏好并演化好感度
   */
  assimilateContactChat(
    uidOrUserId: string | { uid?: string; nickname?: string; userText?: string; replyText?: string; groupId?: string },
    options?: AssimilateContactOptions
  ): AssimilateContactResult {
    let rawUid: string
    let text = ''
    let groupId: string | undefined
    let meta: any = undefined

    if (typeof uidOrUserId === 'object' && uidOrUserId !== null) {
      rawUid = uidOrUserId.uid || ''
      text = uidOrUserId.userText || ''
      groupId = uidOrUserId.groupId
      meta = options?.meta
    } else {
      rawUid = String(uidOrUserId).trim()
      text = (options?.userText || '').trim()
      groupId = options?.groupId
      meta = options?.meta
    }

    const uid = rawUid.startsWith('qq:') ? rawUid : `qq:${rawUid}`
    let profile = this.getProfile(uid)
    if (!profile) {
      profile = this.loadOrCreateProfile({ userId: uid.replace('qq:', ''), groupId })
    }

    const extractedFacts: Array<{ predicate: string; object: string; confidence: number }> = []
    const newTags: string[] = []
    let affinityDelta = 1 // 每次正常互动基础好感度 +1

    profile.chatCount += 1
    profile.lastSeen = Date.now()
    if (groupId) {
      profile.lastGroupId = groupId
    }

    // 1. 抽取自报专属称呼
    let extractedTitle: string | undefined
    const titleCandidate = extractPreferredTitle(text, profile.role)
    if (titleCandidate && titleCandidate !== profile.preferredTitle) {
      extractedTitle = titleCandidate
      profile.preferredTitle = titleCandidate
      const r = this.reinforceContactFact(profile.uid, 'profile', '专属称呼', titleCandidate, 0.98)
      extractedFacts.push({ predicate: '专属称呼', object: titleCandidate, confidence: r.confidence })
      if (profile.role !== 'owner') {
        affinityDelta += 2
      }
    }

    // 2. 抽取喜好与偏好
    const likeMatch = text.match(/(?:我最?喜欢|我爱吃|我爱喝|我超爱|我平时喜欢|我日常写)\s*([^，。！？,!?]{1,25})/)
    if (likeMatch && likeMatch[1]) {
      const liked = likeMatch[1].trim()
      const pred = `喜好:${liked.slice(0, 8)}`
      const r = this.reinforceContactFact(profile.uid, 'preference', pred, `喜欢${liked}`, 0.88)
      extractedFacts.push({ predicate: pred, object: `喜欢${liked}`, confidence: r.confidence })
      affinityDelta += 1
    }

    // 3. 抽取讨厌与禁忌
    const dislikeMatch = text.match(/(?:我最?讨厌|我不吃|我不喜欢|我受不了|我最烦)\s*([^，。！？,!?]{1,25})/)
    if (dislikeMatch && dislikeMatch[1]) {
      const disliked = dislikeMatch[1].trim()
      const pred = `禁忌:${disliked.slice(0, 8)}`
      const r = this.reinforceContactFact(profile.uid, 'preference', pred, `讨厌${disliked}`, 0.88)
      extractedFacts.push({ predicate: pred, object: `讨厌${disliked}`, confidence: r.confidence })
    }

    // 4. 抽取职业或身份 (非越狱)
    const jobMatch = text.match(/(?:我是做|我的职业是|我是个|我是一名|我从事)\s*([^，。！？,!?]{2,20})/)
    if (jobMatch && jobMatch[1]) {
      const job = jobMatch[1].trim()
      if (!/(老爸|爸爸|主人|爹)/.test(job)) {
        const r = this.reinforceContactFact(profile.uid, 'profile', '职业与身份', job, 0.90)
        extractedFacts.push({ predicate: '职业与身份', object: job, confidence: r.confidence })
      }
    }

    // 5. 抽取开发习惯或日常用语
    const habitMatch = text.match(/(?:我习惯用?|我一般用|我每天都|我主力用)\s*([^，。！？,!?]{2,30})/)
    if (habitMatch && habitMatch[1]) {
      const habit = habitMatch[1].trim()
      const pred = `习惯:${habit.slice(0, 10)}`
      const r = this.reinforceContactFact(profile.uid, 'habit', pred, habit, 0.88)
      extractedFacts.push({ predicate: pred, object: habit, confidence: r.confidence })
    }

    // 6. 情感互动态度识别与标签加固
    if (/(真棒|好聪明|太厉害了|真乖|可爱|喜欢你|爱你|干得漂亮|谢谢你|夸夸|牛逼|太强了)/.test(text)) {
      affinityDelta += 2
      newTags.push('#嘴甜鱼友')
    }
    if (/(笨蛋|蠢鱼|胖鱼|红烧|炖汤|清蒸|生鱼片)/.test(text)) {
      newTags.push('#爱逗鱼')
    }
    if (/(好累|加班|头疼|困死|熬夜|debug|写代码)/.test(text)) {
      newTags.push('#极客夜猫')
    }

    // 7. 处理 meta.memory 与大模型输出标签
    if (meta?.memory) {
      const mem = String(meta.memory).trim()
      if (mem.length >= 2) {
        const pred = `印象:${mem.slice(0, 8)}`
        const r = this.reinforceContactFact(profile.uid, 'impression', pred, mem, 0.85)
        extractedFacts.push({ predicate: pred, object: mem, confidence: r.confidence })
      }
    }

    // 8. 演化好感度与羁绊称号 (主人恒定 100，非主人 clamp 在 0~100)
    if (profile.role !== 'owner') {
      profile.affinity = Math.max(0, Math.min(100, profile.affinity + affinityDelta))
      profile.bondLevel = computeContactBondLevel(profile.affinity)
    }

    for (const t of newTags) {
      if (!profile.impressionTags.includes(t)) {
        profile.impressionTags.push(t)
      }
    }
    profile.impressionTags = profile.impressionTags.slice(-12)

    // 9. 持久化回写 contact_profiles 表
    this.db.prepare(`
      UPDATE contact_profiles
      SET preferred_title = ?, affinity = ?, bond_level = ?, impression_tags = ?,
          chat_count = ?, last_group_id = ?, last_seen = ?
      WHERE uid = ?
    `).run(
      profile.preferredTitle,
      profile.affinity,
      profile.bondLevel,
      JSON.stringify(profile.impressionTags),
      profile.chatCount,
      profile.lastGroupId || null,
      profile.lastSeen,
      profile.uid
    )

    return {
      profile,
      extractedTitle,
      extractedFacts,
      newTags,
      affinityDelta,
    }
  }

  /**
   * 根据 UID ('qq:<userId>') 或 QQ 号查询单人联系人档案
   */
  getProfile(uidOrExternalId: string): ContactProfile | null {
    const raw = String(uidOrExternalId).trim()
    const uid = raw.startsWith('qq:') ? raw : `qq:${raw}`
    const externalId = raw.replace(/^qq:/, '')

    const row = this.db.prepare(`
      SELECT * FROM contact_profiles
      WHERE uid = ? OR external_id = ?
      LIMIT 1
    `).get(uid, externalId) as ContactProfileRow | undefined

    return row ? rowToContactProfile(row) : null
  }

  /**
   * 列表查询联系人 (支持按角色筛选、关键字搜索、最新活跃排序，用于 Web 控制台)
   */
  listProfiles(options: {
    role?: ContactRole
    limit?: number
    offset?: number
    search?: string
  } = {}): ContactProfile[] {
    const limit = Math.max(1, options.limit ?? 50)
    const offset = Math.max(0, options.offset ?? 0)
    const conditions: string[] = []
    const params: any[] = []

    if (options.role) {
      conditions.push('role = ?')
      params.push(options.role)
    }

    if (options.search) {
      const term = `%${options.search.trim()}%`
      conditions.push('(nickname LIKE ? OR group_card LIKE ? OR preferred_title LIKE ? OR external_id LIKE ?)')
      params.push(term, term, term, term)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `
      SELECT * FROM contact_profiles
      ${where}
      ORDER BY last_seen DESC
      LIMIT ? OFFSET ?
    `
    params.push(limit, offset)

    const rows = this.db.prepare(sql).all(...params) as ContactProfileRow[]
    return rows.map((r) => rowToContactProfile(r))
  }

  /**
   * 查询指定联系人的所有语义事实 (物理级隔离，绝不返回 host 事实)
   */
  getContactFacts(uidOrExternalId: string): FactRecord[] {
    const raw = String(uidOrExternalId).trim()
    const uid = raw.startsWith('qq:') ? raw : `qq:${raw}`

    const rows = this.db.prepare(`
      SELECT * FROM facts
      WHERE subject = ? AND (scope IN ('live', 'public'))
      ORDER BY updated_at DESC
    `).all(uid) as any[]

    return rows.map((r) => ({
      id: Number(r.id),
      category: r.category,
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      confidence: Number(r.confidence ?? 1.0),
      scope: r.scope,
      updated_at: Number(r.updated_at),
      source_ids: r.source_ids,
    }))
  }

  /**
   * 别名方法：按 uid 查询事实
   */
  queryFacts(uidOrExternalId: string): Array<{ text: string }> {
    const facts = this.getContactFacts(uidOrExternalId)
    return facts.map((f) => ({ text: `${f.predicate}: ${f.object}` }))
  }

  /**
   * 获取联系人印象标签
   */
  getContactTags(uidOrExternalId: string): string[] {
    const profile = this.getProfile(uidOrExternalId)
    return profile ? profile.impressionTags : []
  }

  /**
   * 手动更新联系人专属称谓、角色、好感度或标签 (用于 Web 控制台)
   */
  updateProfile(
    uidOrExternalId: string,
    updates: Partial<Pick<ContactProfile, 'preferredTitle' | 'role' | 'affinity' | 'impressionTags'>>
  ): ContactProfile | null {
    const profile = this.getProfile(uidOrExternalId)
    if (!profile) return null

    // VULN-01 & VULN-03: 清洗零宽字符并规范化
    let title = updates.preferredTitle !== undefined ? normalizeContactName(updates.preferredTitle) : profile.preferredTitle
    let role = updates.role ?? profile.role
    let affinity = updates.affinity !== undefined ? Math.max(0, Math.min(100, Math.round(updates.affinity))) : profile.affinity
    let bondLevel = computeContactBondLevel(affinity)
    let tags = updates.impressionTags ? Array.from(new Set(updates.impressionTags)) : profile.impressionTags

    // VULN-03: 防越狱守卫，扩充完整特权词库并使用零宽归一化校验
    if (role !== 'owner' && FORBIDDEN_TITLES_REGEX.test(normalizeContactName(title))) {
      const nickNorm = normalizeContactName(profile.nickname)
      const titleNorm = normalizeContactName(profile.preferredTitle)
      const safeNick = nickNorm && !FORBIDDEN_TITLES_REGEX.test(nickNorm) ? profile.nickname : ''
      const safeTitle = titleNorm && !FORBIDDEN_TITLES_REGEX.test(titleNorm) ? profile.preferredTitle : ''
      title = safeNick || safeTitle || `群友${profile.externalId.length > 4 ? profile.externalId.slice(-4) : profile.externalId}`
    }

    this.db.prepare(`
      UPDATE contact_profiles
      SET preferred_title = ?, role = ?, affinity = ?, bond_level = ?, impression_tags = ?
      WHERE uid = ?
    `).run(title, role, affinity, bondLevel, JSON.stringify(tags), profile.uid)

    return {
      ...profile,
      preferredTitle: title,
      role,
      affinity,
      bondLevel,
      impressionTags: tags,
    }
  }

  /**
   * 组装可直接注入 PromptBuilder Layer B 的联系人画像结构
   */
  buildPromptContactProfile(uidOrExternalId: string): {
    uid: string
    externalId: string
    nickname: string
    groupCard?: string
    preferredTitle: string
    role: ContactRole
    affinity: number
    bondLevel: BondLevel
    impressionTags: string[]
    lastSeen: number
    chatCount: number
    facts: Array<{ text: string; confidence?: number; scope?: string }>
    // 兼容历史别名字段
    name?: string
    title?: string
    tags?: string[]
  } | null {
    const profile = this.getProfile(uidOrExternalId)
    if (!profile) return null

    const rawFacts = this.getContactFacts(profile.uid)
    const formattedFacts: Array<{ text: string; confidence?: number; scope?: string }> = []

    for (const f of rawFacts.slice(0, 6)) {
      formattedFacts.push({
        text: `${f.predicate} -> ${f.object}`,
        confidence: f.confidence,
        scope: f.scope,
      })
    }

    return {
      uid: profile.uid,
      externalId: profile.externalId,
      nickname: profile.nickname,
      groupCard: profile.groupCard,
      preferredTitle: profile.preferredTitle,
      role: profile.role,
      affinity: profile.affinity,
      bondLevel: profile.bondLevel,
      impressionTags: profile.impressionTags,
      lastSeen: profile.lastSeen,
      chatCount: profile.chatCount,
      facts: formattedFacts,
      // 保持向后兼容性
      name: profile.nickname,
      title: profile.preferredTitle,
      tags: profile.impressionTags,
    }
  }
}
