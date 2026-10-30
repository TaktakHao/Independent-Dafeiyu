/**
 * @file antigravity.ts
 * Antigravity 运行态实时感知传感器：监听本地 Antigravity 会话与任务活跃度
 */

import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export type AntigravityCompanionState = 'IDLE' | 'THINKING' | 'WORKING' | 'WAITING'
export type AntigravitySubActivity = 'searching' | 'commanding' | 'editing' | 'testing' | 'using-tool'

export interface AntigravityActivity {
  isBusy: boolean
  lastActiveAt: number
  activeSessionId?: string
  companionState?: AntigravityCompanionState
  activity?: AntigravitySubActivity
  clip?: string
  statusMessage?: string
}

export class AntigravitySensor extends EventEmitter {
  private timer: any = null
  private pollIntervalMs: number
  private brainDir: string
  private isBusy: boolean = false
  private lastMtime: number = 0
  private activeSessionId: string = ''
  private companionState: AntigravityCompanionState = 'IDLE'
  private activity: AntigravitySubActivity | undefined = undefined
  private clip: string = 'idle'
  private statusMessage: string = 'Antigravity 就绪待命 ✨'

  constructor(pollIntervalMs: number = 1500, customBrainDir?: string) {
    super()
    this.pollIntervalMs = pollIntervalMs
    this.brainDir = customBrainDir || path.join(os.homedir(), '.gemini', 'antigravity', 'brain')
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
      activeSessionId: this.activeSessionId || undefined,
      companionState: this.companionState,
      activity: this.activity,
      clip: this.clip,
      statusMessage: this.statusMessage,
    }
  }

  /**
   * 读取文件末尾指定字节并解析最后一行 JSON（零大内存开销）
   */
  private readLastJsonLine(filePath: string, maxBytes: number = 16384): any | null {
    let fd: number | null = null
    try {
      const stat = fs.statSync(filePath)
      if (stat.size === 0) return null
      fd = fs.openSync(filePath, 'r')
      const readSize = Math.min(stat.size, maxBytes)
      const buffer = Buffer.alloc(readSize)
      fs.readSync(fd, buffer, 0, readSize, stat.size - readSize)
      const content = buffer.toString('utf-8')
      const lines = content.trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line || !line.startsWith('{')) continue
        try {
          return JSON.parse(line)
        } catch {
          // 若截断在半行则继续尝试上一行
        }
      }
    } catch {
      // 忽略读取异常
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {}
      }
    }
    return null
  }

  private checkActivity(): void {
    try {
      if (!fs.existsSync(this.brainDir)) return

      const entries = fs.readdirSync(this.brainDir, { withFileTypes: true })
      let maxMtime = 0
      let latestFolder = ''
      let latestTranscriptPath = ''
      let latestTranscriptMtime = 0

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const sessionDir = path.join(this.brainDir, entry.name)
        try {
          const dirStat = fs.statSync(sessionDir)
          let folderMaxMtime = dirStat.mtimeMs

          const transcriptPath = path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl')
          let tMtime = 0
          if (fs.existsSync(transcriptPath)) {
            try {
              const tStat = fs.statSync(transcriptPath)
              tMtime = tStat.mtimeMs
              if (tMtime > folderMaxMtime) folderMaxMtime = tMtime
            } catch {}
          }

          const fullTranscriptPath = path.join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl')
          if (fs.existsSync(fullTranscriptPath)) {
            try {
              const tfStat = fs.statSync(fullTranscriptPath)
              if (tfStat.mtimeMs > folderMaxMtime) folderMaxMtime = tfStat.mtimeMs
            } catch {}
          }

          if (folderMaxMtime > maxMtime) {
            maxMtime = folderMaxMtime
            latestFolder = entry.name
            latestTranscriptPath = transcriptPath
            latestTranscriptMtime = tMtime
          }
        } catch {}
      }

      const now = Date.now()
      const ageMs = now - maxMtime

      let newlyBusy = false
      let nextState: AntigravityCompanionState = 'IDLE'
      let nextActivity: AntigravitySubActivity | undefined = undefined
      let nextClip = 'idle'
      let nextMessage = 'Antigravity 就绪待命 ✨'

      if (latestTranscriptPath && latestTranscriptMtime > 0) {
        const lastStep = this.readLastJsonLine(latestTranscriptPath)
        if (lastStep) {
          const toolCalls = Array.isArray(lastStep.tool_calls) ? lastStep.tool_calls : []
          const isTurnDone =
            lastStep.type === 'PLANNER_RESPONSE' &&
            toolCalls.length === 0 &&
            lastStep.status === 'DONE'

          if (!isTurnDone && ageMs < 90000) {
            newlyBusy = true
            if (lastStep.type === 'PLANNER_RESPONSE' && toolCalls.length > 0) {
              const lastTool = toolCalls[toolCalls.length - 1]
              const rawName = String(
                lastTool?.name || lastTool?.function?.name || lastTool?.ToolName || ''
              ).toLowerCase()

              if (rawName.includes('command') || rawName.includes('task')) {
                nextState = 'WORKING'
                nextActivity = 'commanding'
                nextClip = 'working_command'
                nextMessage = 'Antigravity 正在执行终端命令 ⚡……'
              } else if (
                rawName.includes('read') ||
                rawName.includes('search') ||
                rawName.includes('list') ||
                rawName.includes('grep') ||
                rawName.includes('find')
              ) {
                nextState = 'WORKING'
                nextActivity = 'searching'
                nextClip = 'working_search'
                nextMessage = 'Antigravity 正在检索代码与资料 🔍……'
              } else if (rawName.includes('edit') || rawName.includes('write')) {
                nextState = 'WORKING'
                nextActivity = 'editing'
                nextClip = 'working'
                nextMessage = 'Antigravity 正在奋笔疾书改代码 ✍️……'
              } else if (rawName.includes('ask')) {
                nextState = 'WAITING'
                nextActivity = undefined
                nextClip = 'waiting'
                nextMessage = 'Antigravity 正在等你确认问题 👀……'
              } else {
                nextState = 'WORKING'
                nextActivity = 'using-tool'
                nextClip = 'working'
                nextMessage = 'Antigravity 正在施展魔法中 🪄……'
              }
            } else {
              // USER_INPUT 或 GENERIC (工具刚返回结果，模型正在思考生成下一步)
              nextState = 'THINKING'
              nextActivity = undefined
              nextClip = 'thinking'
              nextMessage = 'Antigravity 正在深度思考中 🧠……'
            }
          } else if (ageMs < 3500 && maxMtime > latestTranscriptMtime) {
            newlyBusy = true
            nextState = 'WORKING'
            nextActivity = 'editing'
            nextClip = 'working'
            nextMessage = 'Antigravity 正在整理产物文档 📝……'
          } else {
            newlyBusy = false
            nextState = 'IDLE'
            nextActivity = undefined
            nextClip = 'idle'
            nextMessage = 'Antigravity 刚才的任务完成啦 ✨'
          }
        }
      } else if (maxMtime > 0 && ageMs < 10000) {
        // 兜底：无 transcript 文件但目录最近 10 秒有变动
        newlyBusy = true
        nextState = 'WORKING'
        nextActivity = 'editing'
        nextClip = 'working'
        nextMessage = 'Antigravity 正在施展魔法中 🪄……'
      }

      const stateChanged =
        newlyBusy !== this.isBusy ||
        (newlyBusy && (nextState !== this.companionState || nextActivity !== this.activity))

      this.lastMtime = maxMtime
      this.activeSessionId = latestFolder

      if (stateChanged) {
        this.isBusy = newlyBusy
        this.companionState = nextState
        this.activity = nextActivity
        this.clip = nextClip
        this.statusMessage = nextMessage

        this.emit('activity_change', {
          isBusy: this.isBusy,
          lastActiveAt: this.lastMtime,
          activeSessionId: latestFolder,
          companionState: this.companionState,
          activity: this.activity,
          clip: this.clip,
          statusMessage: this.statusMessage,
        } satisfies AntigravityActivity)
      }
    } catch {}
  }
}
