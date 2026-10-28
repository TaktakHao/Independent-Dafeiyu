/**
 * @file db.ts
 * Milestone M3: SQLite 存储底座、连接生命周期管理、PRAGMA 优化与自动化数据库迁移
 * 
 * 核心技术标准：
 * 1. 采用 Node.js 原生 node:sqlite (DatabaseSync)，0 原生编译依赖，跨平台安全。
 * 2. 生产级 PRAGMA：WAL 模式、synchronous = NORMAL、外键级联检查、5000ms busy_timeout、内存临时表。
 * 3. 递归自愈建目录：在初始化磁盘数据库前自动创建父级目录，避免 SQLITE_CANTOPEN 错误。
 * 4. 原子迁移机制 (schema_migrations)：版本化幂等升级，表与索引一站式就绪。
 */

import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DatabaseOptions } from './types.ts'

export const DEFAULT_DB_PATH = 'runtime/data/daughter.db'

export interface Migration {
  version: number
  name: string
  up: (db: DatabaseSync) => void
}

/**
 * 核心数据库迁移脚本列表
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'm3_initial_schema',
    up: (db: DatabaseSync) => {
      // 1. L3 情景记忆表
      db.exec(`
        CREATE TABLE IF NOT EXISTS episodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          mode TEXT NOT NULL,
          scope TEXT NOT NULL,
          actor TEXT NOT NULL,
          text TEXT NOT NULL,
          tone TEXT,
          importance INTEGER DEFAULT 5,
          embedding TEXT,
          last_access INTEGER,
          access_cnt INTEGER DEFAULT 0,
          merged_into INTEGER DEFAULT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_episodes_mode_scope_created ON episodes(mode, scope, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_episodes_scope_importance ON episodes(scope, importance DESC);
        CREATE INDEX IF NOT EXISTS idx_episodes_actor ON episodes(actor);
        CREATE INDEX IF NOT EXISTS idx_episodes_importance ON episodes(importance DESC);
        CREATE INDEX IF NOT EXISTS idx_episodes_last_access ON episodes(last_access DESC);
      `)

      // 2. L4 语义记忆事实表
      db.exec(`
        CREATE TABLE IF NOT EXISTS facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT DEFAULT 'general',
          subject TEXT NOT NULL,
          predicate TEXT NOT NULL,
          object TEXT NOT NULL,
          confidence REAL DEFAULT 1.0,
          scope TEXT NOT NULL DEFAULT 'private',
          updated_at INTEGER NOT NULL,
          source_ids TEXT DEFAULT '[]'
        );

        CREATE INDEX IF NOT EXISTS idx_facts_subject_scope ON facts(subject, scope);
        CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate);
      `)

      // 3. 观众档案画像表 (规范字段与索引)
      db.exec(`
        CREATE TABLE IF NOT EXISTS viewers (
          uid TEXT PRIMARY KEY,
          normalized_name TEXT NOT NULL,
          original_name TEXT NOT NULL,
          affinity INTEGER NOT NULL DEFAULT 10,
          visit_count INTEGER NOT NULL DEFAULT 1,
          gift_points INTEGER NOT NULL DEFAULT 0,
          last_seen INTEGER NOT NULL,
          topics TEXT NOT NULL DEFAULT '[]'
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_viewers_normalized ON viewers(normalized_name);
        CREATE INDEX IF NOT EXISTS idx_viewers_last_seen ON viewers(last_seen DESC);
        CREATE INDEX IF NOT EXISTS idx_viewers_affinity ON viewers(affinity DESC);
      `)

      // 4. 全局数值与状态表
      db.exec(`
        CREATE TABLE IF NOT EXISTS state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_state_key ON state(key);
      `)
    }
  }
]

/**
 * 确保目录存在
 */
function ensureDirectoryExists(filePath: string): void {
  if (filePath === ':memory:' || filePath.startsWith('file::memory:')) {
    return
  }
  const dir = path.dirname(filePath)
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * 执行迁移逻辑
 */
export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)

  // 获取已应用的最高版本
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>
  const appliedVersions = new Set(rows.map((r) => r.version))

  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      db.exec('BEGIN IMMEDIATE')
      try {
        migration.up(db)
        const stmt = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        stmt.run(migration.version, migration.name, Date.now())
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw new Error(`数据库迁移失败 [v${migration.version} - ${migration.name}]: ${(err as Error).message}`)
      }
    }
  }
}

/**
 * 初始化并获取 SQLite 数据库实例
 * @param options 配置选项
 */
export function initDatabase(options: DatabaseOptions = {}): DatabaseSync {
  const dbPath = options.path || DEFAULT_DB_PATH
  const isMemory = dbPath === ':memory:' || dbPath.startsWith('file::memory:')

  if (!isMemory) {
    ensureDirectoryExists(dbPath)
  }

  const db = new DatabaseSync(dbPath)

  // 生产级 PRAGMA 配置
  if (!isMemory) {
    if (options.wal !== false) {
      db.exec('PRAGMA journal_mode = WAL;')
    }
    db.exec('PRAGMA synchronous = NORMAL;')
  }

  const timeoutMs = options.timeoutMs ?? 5000
  db.exec(`PRAGMA busy_timeout = ${Math.max(100, timeoutMs)};`)
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA temp_store = MEMORY;')

  // 运行原子迁移
  runMigrations(db)

  return db
}

/**
 * 安全关闭数据库连接
 */
export function closeDatabase(db: DatabaseSync): void {
  if (db) {
    try {
      db.close()
    } catch {
      // 容错处理已关闭连接
    }
  }
}
