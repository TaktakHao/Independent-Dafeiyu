/**
 * @file db-harness.js
 * 基于 Node.js 22 内置 node:sqlite 构建的独立测试数据库管理器与 SQL 级隐私隔离执行器
 */

import { DatabaseSync } from 'node:sqlite'
import { normalizeViewerNickname } from './contract-validators.js'

export class DatabaseTestHarness {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath)
    this._initSchema()
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        mode TEXT NOT NULL,
        scope TEXT NOT NULL,
        actor TEXT NOT NULL,
        text TEXT NOT NULL,
        tone TEXT,
        importance INTEGER DEFAULT 5,
        embedding TEXT
      );

      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        scope TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS viewers (
        uid TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        affinity INTEGER DEFAULT 10,
        visit_count INTEGER DEFAULT 1,
        gift_score INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        last_seen INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  close() {
    this.db.close()
  }

  /**
   * 插入情景记忆
   */
  insertEpisode({ mode = 'companion', scope = 'private', actor = 'host', text, tone = 'neutral', importance = 5 }) {
    const stmt = this.db.prepare(`
      INSERT INTO episodes (created_at, mode, scope, actor, text, tone, importance)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(Date.now(), mode, scope, actor, text, tone, importance)
    return result.lastInsertRowid
  }

  /**
   * 记忆检索：严格执行直播模式 SQL 级物理隔离
   * 契约铁律: 当 mode === 'live' 时，强制注入 WHERE scope IN ('live', 'public')
   */
  queryEpisodes({ mode = 'live', queryKeyword = '', limit = 10 }) {
    let sql = 'SELECT * FROM episodes'
    const params = []

    if (mode === 'live') {
      // 物理隔离铁律：live 模式下绝不允许 private 记录离开数据库层
      sql += " WHERE scope IN ('live', 'public')"
      if (queryKeyword) {
        sql += ' AND text LIKE ?'
        params.push(`%${queryKeyword}%`)
      }
    } else {
      // 陪伴模式下可访问全部 private/live/public
      if (queryKeyword) {
        sql += ' WHERE text LIKE ?'
        params.push(`%${queryKeyword}%`)
      }
    }

    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'
    params.push(limit)

    const stmt = this.db.prepare(sql)
    return stmt.all(...params)
  }

  /**
   * 插入或更新观众画像
   */
  upsertViewer({ uid, nickname, giftDelta = 0, affinityDelta = 1 }) {
    const normalized = normalizeViewerNickname(nickname)
    const existing = this.db.prepare('SELECT * FROM viewers WHERE uid = ? OR normalized_name = ?').get(uid, normalized)

    const now = Date.now()
    if (existing) {
      const newAffinity = Math.min(100, (existing.affinity || 10) + affinityDelta)
      const newGifts = (existing.gift_score || 0) + giftDelta
      const newVisits = (existing.visit_count || 1) + 1

      this.db.prepare(`
        UPDATE viewers
        SET nickname = ?, normalized_name = ?, affinity = ?, visit_count = ?, gift_score = ?, last_seen = ?
        WHERE uid = ?
      `).run(nickname, normalized, newAffinity, newVisits, newGifts, now, existing.uid)

      return { ...existing, affinity: newAffinity, visit_count: newVisits, gift_score: newGifts }
    } else {
      this.db.prepare(`
        INSERT INTO viewers (uid, nickname, normalized_name, affinity, visit_count, gift_score, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(uid, nickname, normalized, 10 + affinityDelta, 1, giftDelta, now)

      return { uid, nickname, normalized_name: normalized, affinity: 10 + affinityDelta, visit_count: 1, gift_score: giftDelta }
    }
  }

  /**
   * 持久化与读取 RPG 数值状态
   */
  saveRpgState(hunger, mood, energy) {
    const now = Date.now()
    const stmt = this.db.prepare('INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, ?)')
    stmt.run('rpg_hunger', String(hunger), now)
    stmt.run('rpg_mood', String(mood), now)
    stmt.run('rpg_energy', String(energy), now)
  }

  loadRpgState() {
    const rows = this.db.prepare("SELECT key, value FROM state WHERE key LIKE 'rpg_%'").all()
    const result = { hunger: 80, mood: 80, energy: 80 }
    for (const r of rows) {
      if (r.key === 'rpg_hunger') result.hunger = parseFloat(r.value)
      if (r.key === 'rpg_mood') result.mood = parseFloat(r.value)
      if (r.key === 'rpg_energy') result.energy = parseFloat(r.value)
    }
    return result
  }
}
