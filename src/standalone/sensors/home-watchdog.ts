/**
 * @file home-watchdog.ts
 * 闲置 Mac 家用守护哨兵传感器 (Home Watchdog & Anomaly Sentinel)
 *
 * 核心职责：
 * 1. 7×24 小时零 Token 静默巡检家里闲置 Mac 的四大生命体征：
 *    - Docker 容器存活状态与异常退出
 *    - okx-dog 量化交易后端存活与风控熔断 (circuit_break)
 *    - 电池供电状态与低电量断电预警 (< 25%)
 *    - 磁盘空间危机 (< 10GB 可用) 与内存极度匮乏
 * 2. 状态边沿触发 (Edge-Triggered) 与告警冷却降噪 (同类告警 60 分钟防刷屏)
 * 3. 伴随自愈建议 (Healing Suggestion)，供主人在手机 QQ 上一键授权执行修复
 */

import { EventEmitter } from 'node:events'
import * as os from 'node:os'
import * as childProcess from 'node:child_process'
import type { DockerConnector, DockerContainerInfo, OkxDogConnector, OkxDogSnapshot } from '../brain/connectors.ts'

export type WatchdogAlertCategory = 'docker' | 'okx_dog' | 'power' | 'storage' | 'memory'

export interface WatchdogAlertSuggestion {
  actionId: string
  label: string
  command?: string
  taskGoal?: string
}

export interface WatchdogAlertEvent {
  id: string
  category: WatchdogAlertCategory
  severity: 'warning' | 'critical'
  title: string
  message: string
  detail: string
  suggestedAction?: WatchdogAlertSuggestion
  timestamp: number
}

export interface HomeSystemSnapshot {
  timestamp: number
  power: {
    isAcPowered: boolean
    batteryPct?: number
    summary: string
  }
  storage: {
    freeGb: number
    usedPct: number
    summary: string
  }
  memory: {
    totalGb: number
    freeGb: number
    usedPct: number
  }
  docker: {
    available: boolean
    runningCount: number
    containers: DockerContainerInfo[]
    error?: string
  }
  okxDog: {
    reachable: boolean
    isCircuitBroken: boolean
    todayPnlUsdt?: number
    openPositionsCount: number
    error?: string
  }
}

export interface HomeWatchdogOptions {
  checkIntervalMs?: number
  alertCooldownMs?: number
  diskAlertThresholdGb?: number
  batteryAlertThresholdPct?: number
  dockerConnector?: DockerConnector
  okxDogConnector?: OkxDogConnector
}

export class HomeWatchdogSensor extends EventEmitter {
  private readonly checkIntervalMs: number
  private readonly alertCooldownMs: number
  private readonly diskAlertThresholdGb: number
  private readonly batteryAlertThresholdPct: number
  private readonly docker: DockerConnector
  private readonly okxDog: OkxDogConnector

  private timer: NodeJS.Timeout | null = null
  private isChecking = false

  // 状态历史与告警记忆
  private knownRunningContainers: Set<string> = new Set()
  private hadInitialDockerBaseline = false
  private wasOkxReachable: boolean | null = null
  private wasOkxCircuitBroken = false

  // 告警节流记录: alertKey -> lastAlertTimestamp
  private lastAlertTimes: Map<string, number> = new Map()
  private latestSnapshot: HomeSystemSnapshot | null = null

  constructor(options: HomeWatchdogOptions = {}) {
    super()
    this.checkIntervalMs = options.checkIntervalMs ?? 3 * 60 * 1000 // 默认 3 分钟
    this.alertCooldownMs = options.alertCooldownMs ?? 60 * 60 * 1000 // 默认 60 分钟冷却
    this.diskAlertThresholdGb = options.diskAlertThresholdGb ?? 10
    this.batteryAlertThresholdPct = options.batteryAlertThresholdPct ?? 25
    this.docker = options.dockerConnector as any
    this.okxDog = options.okxDogConnector as any
  }

  public start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.probe().catch((err) => {
        console.warn('[HomeWatchdogSensor] 巡检未捕获异常:', err?.message || String(err))
      })
    }, this.checkIntervalMs)

    // 延迟 5 秒后首次自检（避开启动争抢）
    const initialTimer = setTimeout(() => {
      this.probe().catch(() => {})
    }, 5000)
    initialTimer.unref?.()
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  public getLatestSnapshot(): HomeSystemSnapshot | null {
    return this.latestSnapshot
  }

  /**
   * 立即执行一次看家巡检，收集系统快照并触发边沿告警
   */
  public async probe(): Promise<HomeSystemSnapshot> {
    if (this.isChecking) {
      if (this.latestSnapshot) return this.latestSnapshot
    }
    this.isChecking = true

    try {
      // 1. 采集电源指标
      const powerInfo = this.checkPower()
      // 2. 采集磁盘与内存指标
      const storageInfo = this.checkStorage()
      const memoryInfo = this.checkMemory()

      // 3. 采集 Docker 指标
      let dockerContainers: DockerContainerInfo[] = []
      let dockerErr: string | undefined
      let dockerAvailable = true
      try {
        if (this.docker) {
          dockerContainers = await this.docker.listContainers()
        }
      } catch (err: any) {
        dockerAvailable = false
        dockerErr = err?.message || String(err)
      }

      // 4. 采集 okx-dog 状态
      let okxSnap: OkxDogSnapshot | null = null
      let okxErr: string | undefined
      try {
        if (this.okxDog) {
          okxSnap = await this.okxDog.snapshot()
        }
      } catch (err: any) {
        okxErr = err?.message || String(err)
      }

      const snapshot: HomeSystemSnapshot = {
        timestamp: Date.now(),
        power: powerInfo,
        storage: storageInfo,
        memory: memoryInfo,
        docker: {
          available: dockerAvailable,
          runningCount: dockerContainers.length,
          containers: dockerContainers,
          error: dockerErr,
        },
        okxDog: {
          reachable: Boolean(okxSnap?.reachable),
          isCircuitBroken: Boolean(okxSnap?.risk?.is_circuit_broken),
          todayPnlUsdt: Number(okxSnap?.balance?.today_pnl_usdt ?? 0),
          openPositionsCount: Array.isArray(okxSnap?.positions) ? okxSnap.positions.length : 0,
          error: okxErr || okxSnap?.errors?.[0],
        },
      }

      this.latestSnapshot = snapshot
      this.emit('snapshot_updated', snapshot)

      // 5. 边沿检测与异常告警派发
      this.evaluateAlerts(snapshot)

      return snapshot
    } finally {
      this.isChecking = false
    }
  }

  /**
   * 边沿检测逻辑
   */
  private evaluateAlerts(snap: HomeSystemSnapshot): void {
    const now = Date.now()

    // A. 电源与低电量检测：未接电源且电量不足
    if (
      !snap.power.isAcPowered &&
      snap.power.batteryPct !== undefined &&
      snap.power.batteryPct <= this.batteryAlertThresholdPct
    ) {
      this.fireAlert('power_low', {
        id: `alert-power-${now}`,
        category: 'power',
        severity: snap.power.batteryPct <= 10 ? 'critical' : 'warning',
        title: '⚠️ 家里 Mac 电量告急断电风险',
        message: `家里 Mac 目前正依靠电池供电，电量仅剩 ${snap.power.batteryPct}%！请注意接通电源防止意外休眠或关机。`,
        detail: `电源状态: ${snap.power.summary}`,
        timestamp: now,
      })
    }

    // B. 磁盘可用空间检测
    if (snap.storage.freeGb > 0 && snap.storage.freeGb <= this.diskAlertThresholdGb) {
      this.fireAlert('disk_low', {
        id: `alert-disk-${now}`,
        category: 'storage',
        severity: snap.storage.freeGb <= 3 ? 'critical' : 'warning',
        title: '💾 根分区磁盘空间严重不足',
        message: `家里 Mac 根目录剩余空间仅剩 ${snap.storage.freeGb} GB，已跌破安全红线 (${this.diskAlertThresholdGb} GB)！`,
        detail: `磁盘占用: ${snap.storage.summary}`,
        suggestedAction: {
          actionId: 'clean_cache',
          label: '清理 ~/Downloads 与系统缓存',
          taskGoal: '帮我排查并清理 Mac 临时缓存与下载目录的旧文件',
        },
        timestamp: now,
      })
    }

    // C. Docker 容器掉线检测
    if (snap.docker.available) {
      const currentRunning = new Set(
        snap.docker.containers
          .filter((c) => (c.status || '').toLowerCase().startsWith('up'))
          .map((c) => c.name)
      )

      if (this.hadInitialDockerBaseline) {
        // 找出之前在跑但现在停掉的容器
        const missingContainers: string[] = []
        for (const name of this.knownRunningContainers) {
          if (!currentRunning.has(name)) {
            missingContainers.push(name)
          }
        }

        if (missingContainers.length > 0) {
          const namesStr = missingContainers.join('、')
          const primaryName = missingContainers[0]
          this.fireAlert(`docker_exited_${primaryName}`, {
            id: `alert-docker-${now}`,
            category: 'docker',
            severity: 'critical',
            title: `🐳 Docker 容器意外停止: ${namesStr}`,
            message: `巡检发现原本在运行的容器 [${namesStr}] 意外退出了！`,
            detail: `当前运行中容器数: ${currentRunning.size} 个`,
            suggestedAction: {
              actionId: `docker_restart_${primaryName}`,
              label: `重启容器 ${primaryName}`,
              command: `docker restart ${primaryName}`,
              taskGoal: `帮我重启 Docker 容器 ${primaryName}`,
            },
            timestamp: now,
          })
        }
      }

      this.knownRunningContainers = currentRunning
      this.hadInitialDockerBaseline = true
    }

    // D. okx-dog 量化后端异常与熔断检测
    if (this.wasOkxReachable !== null) {
      // 1. 从连得上变为连不上
      if (this.wasOkxReachable && !snap.okxDog.reachable) {
        this.fireAlert('okx_unreachable', {
          id: `alert-okx-unreachable-${now}`,
          category: 'okx_dog',
          severity: 'critical',
          title: '🚨 okx-dog 量化交易后端失联',
          message: '大肥鱼无法连通本地 okx-dog 服务，后端可能已崩溃或容器未运行！',
          detail: `错误详情: ${snap.okxDog.error || '无响应'}`,
          suggestedAction: {
            actionId: 'docker_restart_okx',
            label: '重启 okx-dog 容器',
            command: 'docker restart okx-dog',
            taskGoal: '检查并重启 okx-dog 容器',
          },
          timestamp: now,
        })
      }

      // 2. 触发风控熔断
      if (!this.wasOkxCircuitBroken && snap.okxDog.isCircuitBroken) {
        this.fireAlert('okx_circuit_broken', {
          id: `alert-okx-circuit-${now}`,
          category: 'okx_dog',
          severity: 'critical',
          title: '⚡ okx-dog 触发硬风控熔断！',
          message: '注意！okx-dog 后端刚触发了风控熔断，自动操盘已暂停下单！',
          detail: '请及时打开控制台或在手机 QQ 查问最新持仓与风控原因。',
          timestamp: now,
        })
      }
    }

    this.wasOkxReachable = snap.okxDog.reachable
    this.wasOkxCircuitBroken = snap.okxDog.isCircuitBroken
  }

  /**
   * 触发单项告警（带冷却防刷屏）
   */
  private fireAlert(alertKey: string, event: WatchdogAlertEvent): void {
    const lastTime = this.lastAlertTimes.get(alertKey) || 0
    if (Date.now() - lastTime < this.alertCooldownMs) {
      // 冷却中跳过
      return
    }

    this.lastAlertTimes.set(alertKey, Date.now())
    this.emit('alert', event)
  }

  private checkPower(): { isAcPowered: boolean; batteryPct?: number; summary: string } {
    let isAc = true
    let batteryPct: number | undefined
    let summary = '电源适配器供电'

    try {
      const pmOut = childProcess.execSync('pmset -g batt', { encoding: 'utf-8', timeout: 3000 })
      const pctMatch = pmOut.match(/(\d+)%/)
      if (pctMatch) {
        batteryPct = parseInt(pctMatch[1], 10)
      }
      if (pmOut.includes('AC Power')) {
        isAc = true
        summary = `已插电 (${batteryPct !== undefined ? batteryPct + '%' : '100%'})`
      } else if (pmOut.includes('Battery Power')) {
        isAc = false
        summary = `电池供电 (剩余 ${batteryPct !== undefined ? batteryPct + '%' : '未知'})`
      }
    } catch {
      // 非 Mac 或不支持 pmset 时默认视为接电
    }

    return { isAcPowered: isAc, batteryPct, summary }
  }

  private checkStorage(): { freeGb: number; usedPct: number; summary: string } {
    let freeGb = 999
    let usedPct = 0
    let summary = '正常'

    try {
      const dfOut = childProcess.execSync('df -k /', { encoding: 'utf-8', timeout: 3000 })
      const lines = dfOut.trim().split('\n')
      if (lines.length >= 2) {
        const cols = lines[1].split(/\s+/)
        // df -k: cols[3] 为 1024-blocks available
        const availKb = parseInt(cols[3], 10)
        if (!Number.isNaN(availKb)) {
          freeGb = Number((availKb / 1024 / 1024).toFixed(1))
        }
        const capacityMatch = cols[4]?.match(/(\d+)%/)
        if (capacityMatch) {
          usedPct = parseInt(capacityMatch[1], 10)
        }
        summary = `可用 ${freeGb} GB (已用 ${usedPct}%)`
      }
    } catch {}

    return { freeGb, usedPct, summary }
  }

  private checkMemory(): { totalGb: number; freeGb: number; usedPct: number } {
    const totalBytes = os.totalmem()
    const freeBytes = os.freemem()
    const totalGb = Number((totalBytes / 1024 ** 3).toFixed(1))
    const freeGb = Number((freeBytes / 1024 ** 3).toFixed(1))
    const usedPct = Math.round(((totalBytes - freeBytes) / totalBytes) * 100)
    return { totalGb, freeGb, usedPct }
  }
}
