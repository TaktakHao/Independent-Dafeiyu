/**
 * @file antigravity.ts
 * Antigravity 运行态实时感知传感器：监听本地 Antigravity 会话与任务活跃度
 */

import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export interface AntigravityActivity {
  isBusy: boolean
  lastActiveAt: number
  activeSessionId?: string
  statusMessage?: string
}

export class AntigravitySensor extends EventEmitter {
  private timer: any = null
  private pollIntervalMs: number
  private brainDir: string
  private isBusy: boolean = false
  private lastMtime: number = 0

  constructor(pollIntervalMs: number = 2000) {
    super()
    this.pollIntervalMs = pollIntervalMs
    this.brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain')
  }

  start(): void {
    if (this.timer) return
    this.checkActivity()
    this.timer = setInterval(() => this.checkActivity(), this.pollIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getStatus(): AntigravityActivity {
    return {
      isBusy: this.isBusy,
      lastActiveAt: this.lastMtime,
      statusMessage: this.isBusy ? 'Antigravity 正在施展魔法中 🪄……' : 'Antigravity 就绪待命 ✨',
    }
  }

  private checkActivity(): void {
    try {
      if (!fs.existsSync(this.brainDir)) return

      const entries = fs.readdirSync(this.brainDir, { withFileTypes: true })
      let maxMtime = 0
      let latestFolder = ''

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        try {
          const stat = fs.statSync(path.join(this.brainDir, entry.name))
          if (stat.mtimeMs > maxMtime) {
            maxMtime = stat.mtimeMs
            latestFolder = entry.name
          }
        } catch {}
      }

      const now = Date.now()
      // 若最近 4 秒内目录有变动，认为 Antigravity 正在思考或执行工具
      const newlyBusy = (now - maxMtime) < 4000

      if (newlyBusy !== this.isBusy) {
        this.isBusy = newlyBusy
        this.lastMtime = maxMtime
        this.emit('activity_change', {
          isBusy: this.isBusy,
          activeSessionId: latestFolder,
          statusMessage: this.isBusy ? 'Antigravity 正在施展魔法中 🪄……' : 'Antigravity 刚才的任务完成啦 ✨',
        })
      }
    } catch {}
  }
}
