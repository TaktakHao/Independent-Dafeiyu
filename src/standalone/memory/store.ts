/**
 * @file store.ts
 * Milestone M3: 分层记忆统一持久化存储管理器 (MemoryStore)
 * 
 * 核心技术标准：
 * 1. 统一管理 L1-L5 存储：episodes (L3), facts (L4), state (L2 摘要与 RPG 数值), viewers (观众画像)。
 * 2. 物理级 SQL 隔离硬性红线：queryEpisodes 与 queryFacts 在 live 模式下强制注入 WHERE (scope IN ('live', 'public'))。
 * 3. RPG 数值状态原子读写与持久化，完美对齐 state 契约。
 * 4. 遗忘机制：cleanOldEpisodes 定期淘汰低重要度非热点事件。
 */

import type { DatabaseSync } from 'node:sqlite'
import type {
  EpisodeRecord,
  InsertEpisodeOptions,
  FactRecord,
  UpsertFactOptions,
  ViewerProfile,
  UpsertViewerOptions,
  RpgStateRecord,
  QueryMemoriesOptions,
  ScoredMemory,
  MemoryMode,
  MemoryScope
} from './types.ts'
import { ViewerManager } from './viewers.ts'
import { retrieveEpisodes, formatEpisodeRecord, cleanOldEpisodes } from './retrieval.ts'

export class MemoryStore {
  private db: DatabaseSync
  private viewersManager: ViewerManager

  constructor(db: DatabaseSync) {
    this.db = db
    this.viewersManager = new ViewerManager(this.db)
  }

  /**
   * 获取底层数据库实例
   */
  getDatabase(): DatabaseSync {
    return this.db
  }

  // =========================================================================
  // L3: 情景记忆 (Episodic Memory)
  // =========================================================================

  /**
   * 插入单条情景记忆
   */
  insertEpisode(options: InsertEpisodeOptions): number {
    const mode = options.mode || 'companion'
    // 默认作用域：伴侣模式默认为 private，直播模式默认为 live
    const scope = options.scope || (mode === 'live' ? 'live' : 'private')
    const actor = options.actor || 'host'
    const text = options.text
    const tone = options.tone || null
    const importance = Math.max(1, Math.min(10, options.importance ?? 5))
    const createdAt = options.created_at ?? Date.now()

    let embeddingStr: string | null = null
    if (options.embedding) {
      embeddingStr = typeof options.embedding === 'string' ? options.embedding : JSON.stringify(options.embedding)
    }

    const stmt = this.db.prepare(`
      INSERT INTO episodes (created_at, mode, scope, actor, text, tone, importance, embedding, last_access, access_cnt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const result = stmt.run(createdAt, mode, scope, actor, text, tone, importance, embeddingStr, createdAt, 0)
    return Number(result.lastInsertRowid)
  }

  /**
   * 根据 ID 查询单条情景记忆
   */
  getEpisode(id: number): EpisodeRecord | null {
    const row = this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id)
    return row ? formatEpisodeRecord(row) : null
  }

  /**
   * 基础查询情景记忆 (强制执行直播模式 SQL 级物理隔离)
   */
  queryEpisodes(filter: {
    mode?: MemoryMode
    scope?: MemoryScope
    queryKeyword?: string
    actor?: string
    limit?: number
  } = {}): EpisodeRecord[] {
    const mode = filter.mode || 'companion'
    const limit = Math.max(1, filter.limit ?? 10)
    const conditions: string[] = []
    const params: any[] = []

    // 物理级隔离铁律
    if (mode === 'live') {
      conditions.push("(scope IN ('live', 'public'))")
    } else if (filter.scope) {
      conditions.push('scope = ?')
      params.push(filter.scope)
    }

    if (filter.actor) {
      conditions.push('actor = ?')
      params.push(filter.actor)
    }

    if (filter.queryKeyword) {
      conditions.push('text LIKE ?')
      params.push(`%${filter.queryKeyword}%`)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `
      SELECT * FROM episodes
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as any[]

    // 深度防御拦截
    if (mode === 'live') {
      const leaked = rows.some((r) => r.scope === 'private')
      if (leaked) {
        console.error('[CRITICAL] 深度防御拦截：直播模式查询返回了私密记录，强制清空！')
        return []
      }
    }

    return rows.map((r) => formatEpisodeRecord(r))
  }

  /**
   * 复合评分与 6 天半衰期向量/关键词双轨记忆检索
   */
  searchMemories(options: QueryMemoriesOptions): ScoredMemory[] {
    return retrieveEpisodes(this.db, options)
  }

  /**
   * 清理过期低重要度情景记忆
   */
  cleanOldEpisodes(retentionDays: number = 7, maxImportance: number = 2): number {
    return cleanOldEpisodes(this.db, retentionDays, maxImportance)
  }

  // =========================================================================
  // L4: 语义记忆事实库 (Semantic Facts)
  // =========================================================================

  /**
   * 写入或更新语义事实
   */
  upsertFact(fact: UpsertFactOptions): number {
    const category = fact.category || 'general'
    const confidence = fact.confidence ?? 1.0
    const scope = fact.scope || 'private'
    const now = Date.now()

    let sourceIdsStr = '[]'
    if (fact.source_ids) {
      sourceIdsStr = typeof fact.source_ids === 'string' ? fact.source_ids : JSON.stringify(fact.source_ids)
    }

    // 检查是否存在相同主体与谓词的事实
    const existing = this.db.prepare(`
      SELECT id FROM facts
      WHERE subject = ? AND predicate = ?
      LIMIT 1
    `).get(fact.subject, fact.predicate) as { id: number } | undefined

    if (existing) {
      this.db.prepare(`
        UPDATE facts
        SET object = ?, confidence = ?, scope = ?, category = ?, updated_at = ?, source_ids = ?
        WHERE id = ?
      `).run(fact.object, confidence, scope, category, now, sourceIdsStr, existing.id)
      return existing.id
    } else {
      const result = this.db.prepare(`
        INSERT INTO facts (category, subject, predicate, object, confidence, scope, updated_at, source_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(category, fact.subject, fact.predicate, fact.object, confidence, scope, now, sourceIdsStr)
      return Number(result.lastInsertRowid)
    }
  }

  /**
   * 查询语义事实库 (直播模式物理隔离私密事实)
   */
  queryFacts(subject?: string, mode: MemoryMode = 'companion', scope?: MemoryScope): FactRecord[] {
    const conditions: string[] = []
    const params: any[] = []

    if (subject) {
      conditions.push('subject = ?')
      params.push(subject)
    }

    if (mode === 'live') {
      conditions.push("(scope IN ('live', 'public'))")
    } else if (scope) {
      conditions.push('scope = ?')
      params.push(scope)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `
      SELECT * FROM facts
      ${whereClause}
      ORDER BY updated_at DESC
    `

    const rows = this.db.prepare(sql).all(...params) as any[]
    return rows.map((r) => ({
      id: Number(r.id),
      category: r.category,
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      confidence: Number(r.confidence ?? 1.0),
      scope: r.scope as MemoryScope,
      updated_at: Number(r.updated_at),
      source_ids: r.source_ids
    }))
  }

  /**
   * 删除事实
   */
  deleteFact(id: number): boolean {
    const result = this.db.prepare('DELETE FROM facts WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  // =========================================================================
  // 观众画像管理代理 (Viewer Profiles)
  // =========================================================================

  upsertViewer(options: UpsertViewerOptions): ViewerProfile {
    return this.viewersManager.upsertViewer(options)
  }

  getViewer(uidOrNormalized: string): ViewerProfile | null {
    return this.viewersManager.getViewer(uidOrNormalized)
  }

  listTopViewers(limit: number = 10): ViewerProfile[] {
    return this.viewersManager.listTopViewers(limit)
  }

  // =========================================================================
  // L2 摘要与全局状态持久化 (State)
  // =========================================================================

  /**
   * 保存通用状态键值
   */
  saveState(key: string, value: string): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT OR REPLACE INTO state (key, value, updated_at)
      VALUES (?, ?, ?)
    `).run(key, String(value), now)
  }

  /**
   * 读取通用状态键值
   */
  loadState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined
    return row ? row.value : null
  }

  /**
   * 保存 L2 滚动会话摘要
   */
  saveSessionSummary(summary: string): void {
    this.saveState('session_summary', summary)
  }

  /**
   * 读取 L2 滚动会话摘要
   */
  loadSessionSummary(): string | null {
    return this.loadState('session_summary')
  }

  /**
   * 保存 RPG 核心数值 (饥饿、心情、精力)
   */
  saveRpgState(hunger: number, mood: number, energy: number): void {
    const now = Date.now()
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO state (key, value, updated_at)
      VALUES (?, ?, ?)
    `)

    stmt.run('rpg_hunger', String(hunger), now)
    stmt.run('rpg_mood', String(mood), now)
    stmt.run('rpg_energy', String(energy), now)
    stmt.run('rpg_last_updated', String(now), now)
  }

  /**
   * 读取 RPG 核心数值
   */
  loadRpgState(): RpgStateRecord {
    const rows = this.db.prepare("SELECT key, value FROM state WHERE key LIKE 'rpg_%'").all() as Array<{ key: string; value: string }>
    const result: RpgStateRecord = {
      hunger: 80,
      mood: 80,
      energy: 80,
      last_updated: Date.now()
    }

    for (const r of rows) {
      if (r.key === 'rpg_hunger') result.hunger = parseFloat(r.value)
      if (r.key === 'rpg_mood') result.mood = parseFloat(r.value)
      if (r.key === 'rpg_energy') result.energy = parseFloat(r.value)
      if (r.key === 'rpg_last_updated') result.last_updated = parseInt(r.value, 10)
    }

    return result
  }
}
