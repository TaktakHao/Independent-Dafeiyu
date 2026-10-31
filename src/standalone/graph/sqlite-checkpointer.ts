/**
 * @file sqlite-checkpointer.ts
 * 基于原生 node:sqlite 的状态图持久化检查点存储器 (SQLite Graph Checkpointer)
 */

import type { DatabaseSync } from 'node:sqlite'
import type { Checkpoint, Checkpointer } from './engine.ts'

export class SQLiteCheckpointer<TState = any> implements Checkpointer<TState> {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  public save(checkpoint: Checkpoint<TState>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO graph_checkpoints (
        thread_id, checkpoint_id, parent_checkpoint_id, node_name, state_json, interrupt_payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      checkpoint.threadId,
      checkpoint.checkpointId,
      checkpoint.parentCheckpointId || null,
      checkpoint.nodeName,
      JSON.stringify(checkpoint.state),
      checkpoint.interruptPayload ? JSON.stringify(checkpoint.interruptPayload) : null,
      checkpoint.createdAt
    )
  }

  public getLatest(threadId: string): Checkpoint<TState> | null {
    try {
      const row = this.db
        .prepare(`
          SELECT * FROM graph_checkpoints
          WHERE thread_id = ?
          ORDER BY created_at DESC, checkpoint_id DESC
          LIMIT 1
        `)
        .get(threadId) as any

      if (!row) return null

      return {
        threadId: row.thread_id,
        checkpointId: row.checkpoint_id,
        parentCheckpointId: row.parent_checkpoint_id,
        nodeName: row.node_name,
        state: JSON.parse(row.state_json),
        interruptPayload: row.interrupt_payload ? JSON.parse(row.interrupt_payload) : undefined,
        createdAt: Number(row.created_at),
      }
    } catch (err: any) {
      console.warn(`[SQLiteCheckpointer] 读取检查点失败 (threadId=${threadId}):`, err?.message || String(err))
      return null
    }
  }

  public deleteThread(threadId: string): void {
    try {
      this.db.prepare(`DELETE FROM graph_checkpoints WHERE thread_id = ?`).run(threadId)
    } catch {}
  }
}
