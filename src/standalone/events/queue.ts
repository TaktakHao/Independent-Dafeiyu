/**
 * @file queue.ts
 * 三级优先级事件调度队列（P0 礼物与急停 > P1 弹幕互动 > P2 日常自言自语）
 */

import { EventEmitter } from 'node:events'
import type { StandardEvent } from './types.ts'

export class PriorityEventQueue extends EventEmitter {
  private p0Queue: StandardEvent[] = []
  private p1Queue: StandardEvent[] = []
  private p2Queue: StandardEvent[] = []
  private staleTtlMs: number

  constructor(staleTtlMs: number = 20000) {
    super()
    this.staleTtlMs = staleTtlMs
  }

  /**
   * 推送事件入队
   */
  enqueue(event: StandardEvent): void {
    switch (event.priority) {
      case 'P0':
        this.p0Queue.push(event)
        this.emit('p0_arrived', event)
        break
      case 'P1':
        this.p1Queue.push(event)
        break
      case 'P2':
      default:
        this.p2Queue.push(event)
        break
    }
    this.emit('enqueued', event)
  }

  /**
   * 取出下一个最高优先级的有效事件（自动剔除过期事件）
   */
  dequeue(): StandardEvent | null {
    const now = Date.now()

    // 1. 处理 P0 最高优先队列
    while (this.p0Queue.length > 0) {
      const e = this.p0Queue.shift()!
      if (now - e.ts <= this.staleTtlMs * 2) {
        return e
      }
    }

    // 2. 处理 P1 弹幕与互动队列
    while (this.p1Queue.length > 0) {
      const e = this.p1Queue.shift()!
      if (now - e.ts <= this.staleTtlMs) {
        return e
      }
    }

    // 3. 处理 P2 日常队列
    while (this.p2Queue.length > 0) {
      const e = this.p2Queue.shift()!
      if (now - e.ts <= this.staleTtlMs * 3) {
        return e
      }
    }

    return null
  }

  isEmpty(): boolean {
    return this.p0Queue.length === 0 && this.p1Queue.length === 0 && this.p2Queue.length === 0
  }

  clear(): void {
    this.p0Queue = []
    this.p1Queue = []
    this.p2Queue = []
    this.emit('cleared')
  }

  getQueueSizes(): { p0: number; p1: number; p2: number; total: number } {
    return {
      p0: this.p0Queue.length,
      p1: this.p1Queue.length,
      p2: this.p2Queue.length,
      total: this.p0Queue.length + this.p1Queue.length + this.p2Queue.length,
    }
  }
}
