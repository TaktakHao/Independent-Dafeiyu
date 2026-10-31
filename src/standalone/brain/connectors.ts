/**
 * @file connectors.ts
 * 大肥鱼只读数据连接器：让她“看得见”宿主机上跑着的项目，但绝对摸不到开关。
 *
 * 安全原则：
 * 1. OkxDogConnector 只允许访问固定白名单内的 GET 接口，方法与路径均为硬编码常量，
 *    用户文本 / 大模型输出永远不会拼进 URL；下单、平仓、Panic、自动操盘开关等写接口一律不可达。
 * 2. DockerConnector 只执行固定参数的只读子命令 (ps / stats --no-stream)，不经过 shell。
 */

import * as childProcess from 'node:child_process'

export type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<any>
}>

/** okx-dog 只读白名单：key -> 固定 GET 路径 */
export const OKX_DOG_READONLY_ENDPOINTS = Object.freeze({
  positions: '/api/v1/trade/positions',
  balance: '/api/v1/trade/account/balance',
  autoPilot: '/api/v1/trade/auto-pilot/status',
  history: '/api/v1/trade/history',
  risk: '/api/v1/risk/status',
  health: '/api/v1/health',
} as const)

export type OkxDogEndpointKey = keyof typeof OKX_DOG_READONLY_ENDPOINTS

export interface OkxDogSnapshot {
  reachable: boolean
  isLiveMode?: boolean
  balance?: any
  positions?: any[]
  autoPilot?: any
  history?: any[]
  risk?: any
  errors: string[]
}

export interface OkxDogConnectorOptions {
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}

const num = (v: any, digits = 2): string => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '-'
  return String(Number(n.toFixed(digits)))
}

const signed = (v: any, digits = 2): string => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '-'
  return `${n > 0 ? '+' : ''}${num(n, digits)}`
}

const pct = (ratio: any): string => {
  const n = Number(ratio)
  if (!Number.isFinite(n)) return '-'
  return `${n > 0 ? '+' : ''}${(n * 100).toFixed(2)}%`
}

export class OkxDogConnector {
  private baseUrl: string
  private timeoutMs: number
  private fetchImpl: FetchLike

  constructor(options: OkxDogConnectorOptions = {}) {
    this.baseUrl = String(options.baseUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 5000
    this.fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as FetchLike)
  }

  /**
   * 读取单个白名单接口。仅接受白名单 key，方法恒为 GET。
   */
  async read(key: OkxDogEndpointKey): Promise<any> {
    const endpoint = OKX_DOG_READONLY_ENDPOINTS[key]
    if (!endpoint) throw new Error(`okx-dog 接口不在只读白名单内: ${String(key)}`)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method: 'GET',
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body && typeof body === 'object' && 'code' in body && body.code !== 0) {
        throw new Error(String(body.msg || `code ${body.code}`))
      }
      return body && typeof body === 'object' && 'data' in body ? body.data : body
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 并发拉取持仓 / 资产 / 自动操盘 / 风控 / 最近平仓的只读快照
   */
  async snapshot(): Promise<OkxDogSnapshot> {
    const keys: OkxDogEndpointKey[] = ['balance', 'positions', 'autoPilot', 'risk', 'history']
    const settled = await Promise.allSettled(keys.map((k) => this.read(k)))
    const snap: OkxDogSnapshot = { reachable: false, errors: [] }
    settled.forEach((r, i) => {
      const key = keys[i]
      if (r.status === 'fulfilled') {
        snap.reachable = true
        ;(snap as any)[key] = r.value
      } else {
        snap.errors.push(`${key}: ${r.reason?.message || String(r.reason)}`)
      }
    })
    if (Array.isArray(snap.positions) === false && snap.positions !== undefined) {
      snap.positions = Array.isArray((snap.positions as any)?.items) ? (snap.positions as any).items : []
    }
    if (Array.isArray(snap.history) === false && snap.history !== undefined) {
      snap.history = Array.isArray((snap.history as any)?.items) ? (snap.history as any).items : []
    }
    snap.isLiveMode = Boolean(snap.autoPilot?.is_live_mode ?? snap.balance?.is_live_mode ?? false)
    return snap
  }
}

/**
 * 把 okx-dog 快照压缩成几行“人话”数据，供 QQ 回复与大模型总结使用
 */
export function formatOkxDogSnapshot(snap: OkxDogSnapshot): string {
  if (!snap.reachable) {
    return `okx-dog 后端连不上（${snap.errors[0] || '无响应'}），可能容器没在跑。`
  }
  const lines: string[] = []
  lines.push(`账户：${snap.isLiveMode ? '实盘' : '模拟盘'}`)

  const b = snap.balance
  if (b) {
    lines.push(
      `总权益 ${num(b.total_equity_usdt)} U｜可用 ${num(b.available_balance_usdt ?? b.available_margin_usdt)} U｜未实现 ${signed(b.unrealized_pnl_usdt)} U｜今日 ${signed(b.today_pnl_usdt)} U (${pct(b.today_pnl_ratio)})`
    )
  }

  const positions = Array.isArray(snap.positions) ? snap.positions : []
  if (positions.length === 0) {
    lines.push('持仓：空仓')
  } else {
    lines.push(`持仓 ${positions.length} 个：`)
    for (const p of positions.slice(0, 8)) {
      const inst = p.inst_id || p.instId || p.symbol || '?'
      const side = p.pos_side || p.posSide || p.side || ''
      const size = p.pos ?? p.size ?? p.qty ?? ''
      const upl = p.upl ?? p.unrealized_pnl ?? p.unrealized_pnl_usdt
      const uplRatio = p.upl_ratio ?? p.uplRatio ?? p.pnl_ratio
      const lever = p.lever ?? p.leverage
      const parts = [`• ${inst}`, side, size !== '' ? `${size}` : '', lever ? `${lever}x` : '']
        .filter(Boolean)
        .join(' ')
      lines.push(`${parts}｜浮盈 ${signed(upl)} U${uplRatio !== undefined ? ` (${pct(uplRatio)})` : ''}`)
    }
    if (positions.length > 8) lines.push(`…另有 ${positions.length - 8} 个`)
  }

  const ap = snap.autoPilot
  if (ap) {
    if (ap.is_running) {
      const hours = Number(ap.running_seconds) > 0 ? (Number(ap.running_seconds) / 3600).toFixed(1) : '-'
      lines.push(
        `自动操盘：运行中 ${hours}h｜累计 ${signed(ap.total_pnl_usdt)} U (${pct(ap.total_pnl_ratio)})｜${ap.total_trades_count ?? 0} 笔，胜率 ${pct(ap.win_rate).replace('+', '')}｜最大回撤 ${num(ap.max_drawdown_pct)}%`
      )
    } else {
      lines.push('自动操盘：已暂停')
    }
  }

  const r = snap.risk
  if (r) {
    lines.push(`风控：${r.is_circuit_broken ? `已熔断（${r.circuit_break_reason || '未知原因'}）` : r.risk_status || '正常'}`)
  }

  const history = Array.isArray(snap.history) ? snap.history : []
  if (history.length > 0) {
    const recent = history.slice(0, 3).map((h: any) => {
      const inst = h.inst_id || h.instId || h.symbol || '?'
      const pnl = h.realized_pnl ?? h.pnl ?? h.realized_pnl_usdt
      return `${inst} ${signed(pnl)} U`
    })
    lines.push(`最近平仓：${recent.join('，')}`)
  }

  return lines.join('\n')
}

// ==================== Docker 只读连接器 ====================

export type ExecFileLike = (file: string, args: string[], opts: { timeout: number }) => Promise<string>

const defaultExecFile: ExecFileLike = (file, args, opts) =>
  new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { timeout: opts.timeout, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout || ''))
    })
  })

export interface DockerContainerInfo {
  name: string
  image: string
  status: string
  ports: string
  cpu?: string
  mem?: string
}

export class DockerConnector {
  private execFileImpl: ExecFileLike
  private timeoutMs: number

  constructor(options: { execFileImpl?: ExecFileLike; timeoutMs?: number } = {}) {
    this.execFileImpl = options.execFileImpl || defaultExecFile
    this.timeoutMs = options.timeoutMs ?? 6000
  }

  async listContainers(): Promise<DockerContainerInfo[]> {
    const out = await this.execFileImpl(
      'docker',
      ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'],
      { timeout: this.timeoutMs }
    )
    const containers: DockerContainerInfo[] = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [name = '', image = '', status = '', ports = ''] = line.split('\t')
        return { name, image, status, ports }
      })

    try {
      const stats = await this.execFileImpl(
        'docker',
        ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'],
        { timeout: this.timeoutMs }
      )
      const byName = new Map<string, { cpu: string; mem: string }>()
      for (const line of stats.split('\n')) {
        const [name, cpu, mem] = line.trim().split('\t')
        if (name) byName.set(name, { cpu: cpu || '', mem: mem || '' })
      }
      for (const c of containers) {
        const s = byName.get(c.name)
        if (s) {
          c.cpu = s.cpu
          c.mem = s.mem
        }
      }
    } catch {
      // stats 失败不影响容器列表
    }
    return containers
  }
}

export function formatDockerContainers(containers: DockerContainerInfo[], focus?: string): string {
  if (containers.length === 0) return '现在没有在跑的 Docker 容器。'
  const needle = (focus || '').toLowerCase()
  const focused = needle ? containers.filter((c) => needle.includes(c.name.toLowerCase().split(/[-_]/)[0]) || c.name.toLowerCase().includes(needle)) : []
  const list = focused.length > 0 ? focused : containers
  return [
    `在跑 ${containers.length} 个容器${focused.length > 0 ? `（相关 ${focused.length} 个）` : ''}：`,
    ...list.slice(0, 10).map((c) => {
      const res = c.cpu || c.mem ? `｜CPU ${c.cpu || '-'} 内存 ${c.mem || '-'}` : ''
      return `• ${c.name}（${c.status}）${res}`
    }),
  ].join('\n')
}

// ==================== 主题识别与风险判定 ====================

const OKX_HINT = /okx|量化|持仓|仓位|盈亏|收益|浮盈|浮亏|爆仓|自动操盘|交易机器人|账户余额|权益|回撤|胜率|狗子项目|狗狗项目/i
const DOCKER_HINT = /docker|容器|镜像|compose/i
const WEB_HINT = /(?:搜|网上|电影|影视|电视剧|番剧|天气|新闻|百科|知乎|近期上映|热映|有哪些好看|有什么好)/i

export type QueryTopic = 'okx' | 'docker' | 'web' | 'computer' | 'other'

/**
 * 综合大模型给出的 topic 与原话关键词，确定查询落到哪个连接器（关键词优先，防止模型标错）
 */
export function resolveQueryTopic(topic: string | undefined, ...texts: Array<string | undefined>): QueryTopic {
  const joined = texts.filter(Boolean).join(' ')
  if (topic === 'okx' || OKX_HINT.test(joined)) return 'okx'
  if (topic === 'docker' || DOCKER_HINT.test(joined)) return 'docker'
  if (topic === 'web' || WEB_HINT.test(joined)) return 'web'
  if (topic === 'computer') return topic
  return 'other'
}

const RISKY_TASK_PATTERNS: RegExp[] = [
  /\brm\s+-/i,
  /\bsudo\b/i,
  /\b(?:mkfs|fdisk|diskutil\s+erase|dd\s+if=)/i,
  /\bkill(?:all)?\b/i,
  /\b(?:shutdown|reboot|halt)\b/i,
  /\bdocker\s+(?:rm|rmi|stop|kill|down|prune|system\s+prune|compose\s+down)\b/i,
  /\bgit\s+(?:push|reset\s+--hard|clean|branch\s+-D)\b/i,
  /删除|删掉|清空|清除|卸载|格式化|覆盖|抹掉|关机|重启|停掉|关掉容器|强制推送|永久/,
  /下单|平仓|撤单|开仓|买入|卖出|转账|提币|平掉|仓位/,
]

/**
 * 判定一个任务是否需要主人二次确认（可能造成数据丢失、不可逆或涉及资金）
 */
export function isRiskyTask(...texts: Array<string | undefined>): boolean {
  const joined = texts.filter(Boolean).join(' ')
  return RISKY_TASK_PATTERNS.some((p) => p.test(joined))
}
