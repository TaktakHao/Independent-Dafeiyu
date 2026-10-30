/**
 * @file quota.ts
 * 赛博共生体算力与额度感知传感器 (Quota & Symbiotic Metabolism Sensor)
 * 负责实时感知：
 * 1. Google AI Pro / Antigravity 各模型池剩余额度百分比与重置倒计时 (5h 窗口 & Weekly 周度窗口)
 * 2. DeepSeek 账户真实余额 (/user/balance) 与今日预算剩余率
 * 3. 将 Antigravity 额度 + DeepSeek 额度融合映射为大肥鱼的「算力饱食度 (hunger)」
 */

import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as childProcess from 'node:child_process'
import type { DeepSeekProvider, DeepSeekBalanceInfo } from '../brain/providers/deepseek.ts'

export interface AntigravityQuotaItem {
  key: string
  label: string
  remainingFraction: number
  remainingPct: number
  resetTime?: string
  resetInSeconds: number
  resetInText: string
}

export interface AntigravityQuotaSnapshot {
  available: boolean
  planName: string
  modelName?: string
  updatedAt: number
  /** 综合算力剩余百分比 (0 ~ 100) */
  combinedPct: number
  /** 5小时高频池剩余百分比 */
  shortTermPct: number
  /** 周度长效池平均剩余百分比 */
  weeklyPct: number
  items: AntigravityQuotaItem[]
  summaryText: string
}

export interface CombinedQuotaReport {
  /** 最终映射给大肥鱼饱食度 (hunger) 的综合算力百分比 (0~100) */
  satietyPct: number
  /** 饱食度构成说明 */
  formulaNote: string
  antigravity: AntigravityQuotaSnapshot
  deepseek: DeepSeekBalanceInfo
  updatedAt: number
}

const QUOTA_LABEL_MAP: Record<string, string> = {
  'gemini-5h': 'Gemini 5小时高频池',
  'gemini-weekly': 'Gemini 周度总额度',
  'gemini-argon-wtu-weekly': 'Gemini 4 Argon 周额度',
  '3p-5h': 'Claude/3P 5小时池',
  '3p-weekly': 'Claude/3P 周度额度',
}

export function formatDurationSeconds(sec: number): string {
  if (!sec || sec <= 0) return '即将刷新'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}h${m}m`
  return `${Math.max(1, m)}m`
}

export class QuotaSensor extends EventEmitter {
  private deepseek?: DeepSeekProvider
  private pollIntervalMs: number
  private timer: any = null
  private isProbingAgy = false

  private cacheFilePath: string
  private runtimeCachePath: string

  private lastAgSnapshot: AntigravityQuotaSnapshot = {
    available: false,
    planName: 'Google AI Pro (Antigravity)',
    updatedAt: 0,
    combinedPct: 80,
    shortTermPct: 100,
    weeklyPct: 60,
    items: [],
    summaryText: '正在同步 Google AI Pro 额度...',
  }

  private lastDsBalance: DeepSeekBalanceInfo = {
    status: 'not-configured',
    available: false,
    totalBalance: 0,
    grantedBalance: 0,
    toppedUpBalance: 0,
    currency: 'CNY',
    checkedAt: 0,
    summary: '未配置密钥',
  }

  constructor(options: { deepseek?: DeepSeekProvider; pollIntervalMs?: number } = {}) {
    super()
    this.deepseek = options.deepseek
    this.pollIntervalMs = options.pollIntervalMs ?? 180_000 // 默认每 3 分钟自动同步一次
    this.cacheFilePath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cache', 'latest_statusline.json')
    this.runtimeCachePath = path.resolve(process.cwd(), 'runtime/data/quota-cache.json')

    this.loadPersistedCache()
  }

  start(): void {
    if (this.timer) return
    // 启动后立即尝试读取缓存并后台刷新一次
    this.refreshAll(false).catch(() => {})
    this.timer = setInterval(() => {
      this.refreshAll(false).catch(() => {})
    }, this.pollIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private loadPersistedCache(): void {
    // 1. 优先尝试读取 runtime/data/quota-cache.json
    try {
      if (fs.existsSync(this.runtimeCachePath)) {
        const raw = JSON.parse(fs.readFileSync(this.runtimeCachePath, 'utf-8'))
        if (raw?.antigravity?.items?.length) {
          this.lastAgSnapshot = raw.antigravity
        }
        if (raw?.deepseek?.checkedAt) {
          this.lastDsBalance = raw.deepseek
        }
      }
    } catch {}

    // 2. 尝试读取 ~/.gemini/antigravity-cli/cache/latest_statusline.json
    this.tryReadStatuslineCacheFile()
  }

  private persistCache(): void {
    try {
      fs.mkdirSync(path.dirname(this.runtimeCachePath), { recursive: true })
      fs.writeFileSync(
        this.runtimeCachePath,
        JSON.stringify(
          {
            antigravity: this.lastAgSnapshot,
            deepseek: this.lastDsBalance,
            updatedAt: Date.now(),
          },
          null,
          2
        ),
        'utf-8'
      )
    } catch {}
  }

  /**
   * 解析 agy statusLine 吐出的原始 JSON
   */
  public parseAntigravityStatusJson(rawJson: any): AntigravityQuotaSnapshot | null {
    if (!rawJson || typeof rawJson !== 'object' || !rawJson.quota) {
      return null
    }

    const quotaObj = rawJson.quota as Record<string, any>
    const entries = Object.entries(quotaObj).filter(
      ([, val]) => val && typeof val.remaining_fraction === 'number'
    )
    if (entries.length === 0) return null

    const items: AntigravityQuotaItem[] = entries.map(([key, val]) => {
      const frac = Math.max(0, Math.min(1, Number(val.remaining_fraction)))
      const pct = Math.round(frac * 1000) / 10
      const resetSec = Number(val.reset_in_seconds || 0)
      return {
        key,
        label: QUOTA_LABEL_MAP[key] || key,
        remainingFraction: frac,
        remainingPct: pct,
        resetTime: val.reset_time,
        resetInSeconds: resetSec,
        resetInText: formatDurationSeconds(resetSec),
      }
    })

    // 区分 5h 短周期池与 weekly 周度池
    const shortItems = items.filter((i) => i.key.includes('5h'))
    const weeklyItems = items.filter((i) => i.key.includes('weekly'))

    const shortTermPct =
      shortItems.length > 0
        ? Math.round(shortItems.reduce((acc, i) => acc + i.remainingPct, 0) / shortItems.length)
        : 100

    const weeklyPct =
      weeklyItems.length > 0
        ? Math.round(weeklyItems.reduce((acc, i) => acc + i.remainingPct, 0) / weeklyItems.length)
        : shortTermPct

    // 综合得分：5h 当前可用性占 45%，周度持久池占 55%
    const combinedPct = Math.round(shortTermPct * 0.45 + weeklyPct * 0.55)

    const hasArgon = items.some((i) => i.key.includes('argon'))
    const planName = hasArgon ? 'Google AI Pro · Antigravity' : 'Antigravity AI Plan'
    const modelName = rawJson.model?.display_name || rawJson.model?.id || 'Gemini 3.8 / 4 Argon'

    const summaryParts = items.map((i) => `${i.label}: ${i.remainingPct}%`)
    const summaryText = `${planName} (5h池 ${shortTermPct}% · 周池均值 ${weeklyPct}%)`

    return {
      available: true,
      planName,
      modelName,
      updatedAt: Date.now(),
      combinedPct,
      shortTermPct,
      weeklyPct,
      items,
      summaryText: summaryParts.length > 0 ? summaryText : '额度正常',
    }
  }

  /**
   * 从本地缓存文件读取最新 statusline JSON
   */
  private tryReadStatuslineCacheFile(): boolean {
    try {
      if (!fs.existsSync(this.cacheFilePath)) return false
      const stat = fs.statSync(this.cacheFilePath)
      const content = fs.readFileSync(this.cacheFilePath, 'utf-8').trim()
      if (!content) return false
      const parsed = JSON.parse(content)
      const snap = this.parseAntigravityStatusJson(parsed)
      if (snap) {
        snap.updatedAt = stat.mtimeMs
        this.lastAgSnapshot = snap
        return true
      }
    } catch {}
    return false
  }

  /**
   * 通过轻量级 PTY 唤醒 agy 的 statusLine 钩子获取实时 Google AI Pro / Antigravity 额度
   */
  public async probeAntigravityQuota(force = false): Promise<AntigravityQuotaSnapshot> {
    const now = Date.now()
    // 若非强制且缓存文件在 90 秒内刚更新过，直接复用
    if (!force && this.tryReadStatuslineCacheFile() && now - this.lastAgSnapshot.updatedAt < 90_000) {
      return this.lastAgSnapshot
    }

    if (this.isProbingAgy) {
      return this.lastAgSnapshot
    }

    this.isProbingAgy = true
    const tempLog = path.join(os.tmpdir(), `dafeiyu-agy-quota-${process.pid}.log`)

    try {
      const pyScript = `
import pty, os, time, subprocess

log_file = ${JSON.stringify(tempLog)}
if os.path.exists(log_file):
    try: os.remove(log_file)
    except: pass

env = os.environ.copy()
env["STATUSLINE_LOG_FILE"] = log_file

try:
    master, slave = pty.openpty()
    proc = subprocess.Popen(
        ["agy"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        close_fds=True
    )
    os.close(slave)
    start = time.time()
    while time.time() - start < 7.5:
        if os.path.exists(log_file) and os.path.getsize(log_file) > 120:
            break
        time.sleep(0.25)
    try:
        os.write(master, b"\\x04\\x04")
    except:
        pass
    proc.terminate()
    os.close(master)
except Exception as e:
    pass
`
      await new Promise<void>((resolve) => {
        const child = childProcess.spawn('python3', ['-c', pyScript], {
          stdio: 'ignore',
          timeout: 9000,
        })
        child.on('close', () => resolve())
        child.on('error', () => resolve())
      })

      if (fs.existsSync(tempLog)) {
        const logContent = fs.readFileSync(tempLog, 'utf-8')
        const lines = logContent.split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          const idx = lines[i].indexOf('INPUT JSON:')
          if (idx !== -1) {
            const jsonStr = lines[i].slice(idx + 'INPUT JSON:'.length).trim()
            try {
              const rawObj = JSON.parse(jsonStr)
              // 同步写入缓存文件方便下次秒读
              try {
                fs.mkdirSync(path.dirname(this.cacheFilePath), { recursive: true })
                fs.writeFileSync(this.cacheFilePath, jsonStr, 'utf-8')
              } catch {}
              const snap = this.parseAntigravityStatusJson(rawObj)
              if (snap) {
                this.lastAgSnapshot = snap
                this.persistCache()
              }
            } catch {}
            break
          }
        }
        try {
          fs.unlinkSync(tempLog)
        } catch {}
      } else {
        this.tryReadStatuslineCacheFile()
      }
    } catch {
      this.tryReadStatuslineCacheFile()
    } finally {
      this.isProbingAgy = false
    }

    return this.lastAgSnapshot
  }

  /**
   * 刷新 DeepSeek 真实账户余额
   */
  public async refreshDeepSeekBalance(force = false): Promise<DeepSeekBalanceInfo> {
    if (!this.deepseek) {
      return this.lastDsBalance
    }
    const bal = await this.deepseek.fetchAccountBalance(force)
    this.lastDsBalance = bal
    this.persistCache()
    return bal
  }

  /**
   * 全量刷新 Antigravity (Google AI Pro) 额度 + DeepSeek 余额，并计算融合饱食度
   */
  public async refreshAll(force = false): Promise<CombinedQuotaReport> {
    const [ag, ds] = await Promise.all([
      this.probeAntigravityQuota(force),
      this.refreshDeepSeekBalance(force),
    ])

    const report = this.getReport()
    this.emit('quota_updated', report)
    return report
  }

  /**
   * 计算当前的融合额度报告与赛博饱食度 (0 ~ 100)
   * - 若同时启用了 Antigravity 与 DeepSeek：Antigravity 综合额度占 65% + DeepSeek 余额充裕度占 35%
   * - 若仅启用 Antigravity：100% 映射自 Antigravity 综合额度
   * - 若仅启用 DeepSeek：100% 映射自 DeepSeek 余额充裕度
   */
  public getReport(): CombinedQuotaReport {
    const ag = this.lastAgSnapshot
    const ds = this.deepseek ? this.deepseek.getCachedBalance() : this.lastDsBalance

    // 计算 DeepSeek 额度健康分 (0~100)
    let dsScore: number | null = null
    if (ds.status === 'ready') {
      // 假设 20 元以上为满仓 100%，0~20 元按比例映射（保底有余额则 >= 25%）
      const balanceRatio =
        ds.totalBalance >= 20
          ? 100
          : ds.totalBalance > 0
          ? Math.round(25 + (ds.totalBalance / 20) * 75)
          : 0
      // 结合今日预算剩余比例
      const dailyBudget = this.deepseek?.budgetGuard.getBudget() || 5
      const todayCost = this.deepseek?.budgetGuard.getCost() || 0
      const dailyRemPct = Math.max(0, Math.min(100, Math.round(((dailyBudget - todayCost) / dailyBudget) * 100)))
      dsScore = Math.round(balanceRatio * 0.7 + dailyRemPct * 0.3)
    } else if (this.deepseek?.isAvailable()) {
      // 配置了 Key 但余额接口尚未返回时，用今日预算剩余率
      const dailyBudget = this.deepseek.budgetGuard.getBudget() || 5
      const todayCost = this.deepseek.budgetGuard.getCost() || 0
      dsScore = Math.max(0, Math.min(100, Math.round(((dailyBudget - todayCost) / dailyBudget) * 100)))
    }

    const agScore = ag.available ? ag.combinedPct : null

    let satietyPct = 80
    let formulaNote = '默认算力基线'

    if (agScore !== null && dsScore !== null) {
      satietyPct = Math.round(agScore * 0.65 + dsScore * 0.35)
      formulaNote = `Google AI Pro (${agScore}%) × 65% + DeepSeek (${dsScore}%, 余额 ¥${ds.totalBalance.toFixed(2)}) × 35%`
    } else if (agScore !== null) {
      satietyPct = agScore
      formulaNote = `Google AI Pro 实时剩余算力 (${ag.summaryText})`
    } else if (dsScore !== null) {
      satietyPct = dsScore
      formulaNote = `DeepSeek 剩余额度 (${ds.summary})`
    }

    satietyPct = Math.max(5, Math.min(100, satietyPct))

    return {
      satietyPct,
      formulaNote,
      antigravity: ag,
      deepseek: ds,
      updatedAt: Date.now(),
    }
  }
}
