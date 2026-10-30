/**
 * @file server.ts
 * 本地主播安全控制台：内置「深海赛博玻璃舱 (Deep-Sea Cyber-Glass Studio)」Web 控制面板与全量 RESTful 控制 API (http://127.0.0.1:7788)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StateManager } from '../core/state.ts'
import type { RuntimeScheduler } from '../core/scheduler.ts'
import type { MemoryStore } from '../memory/store.ts'
import type { HostImpressionEngine } from '../memory/impression.ts'
import type { ContactImpressionEngine } from '../memory/contacts.ts'
import type { PermissionGuard } from '../safety/permission-guard.ts'
import type { ApprovalManager, ApprovalRequest } from '../safety/approval-manager.ts'
import type { TaskExecutor } from '../brain/task-executor.ts'
import type { DiaryGenerator } from '../memory/diary.ts'
import type { WorkingMemory } from '../memory/working.ts'
import type { QuotaSensor } from '../sensors/quota.ts'
import type { OneBotGateway } from '../gateway/onebot-gateway.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(__dirname, 'ui')

export interface ConsoleServerExtras {
  memory?: MemoryStore
  impression?: HostImpressionEngine
  contactImpression?: ContactImpressionEngine
  permissionGuard?: PermissionGuard
  approvalManager?: ApprovalManager
  taskExecutor?: TaskExecutor
  diaryGenerator?: DiaryGenerator
  workingMemory?: WorkingMemory
  quotaSensor?: QuotaSensor
  onebotGateway?: OneBotGateway
  onResolveApproval?: (
    req: ApprovalRequest,
    action: 'approve' | 'reject'
  ) => Promise<{ executed: boolean; detailReport?: string; spokenReply?: string; rejected?: boolean; error?: string }>
}

export class ConsoleServer extends EventEmitter {
  private server: any = null
  private port: number
  private state: StateManager
  private scheduler: RuntimeScheduler
  private brain?: any
  private extras: ConsoleServerExtras

  constructor(
    port: number = 7788,
    state: StateManager,
    scheduler: RuntimeScheduler,
    brain?: any,
    extras: ConsoleServerExtras = {}
  ) {
    super()
    this.port = port
    this.state = state
    this.scheduler = scheduler
    this.brain = brain
    this.extras = extras
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
          }
          res.end(JSON.stringify({ error: err.message }))
        })
      })

      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[dsh-dafeiyu] 🎮 主播控制台已就绪: http://127.0.0.1:${this.port}`)
        resolve()
      })

      this.server.on('error', reject)
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      if (typeof this.server.closeAllConnections === 'function') {
        try {
          this.server.closeAllConnections()
        } catch {}
      }
      this.server.close(() => resolve())
    })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)

    // 跨域只允许本地
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // 1. 首页控制台 HTML 界面与解耦静态资源路由
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(this.renderHtml())
      return
    }

    if (req.method === 'GET' && url.pathname === '/ui/styles.css') {
      const cssPath = path.join(UI_DIR, 'styles.css')
      if (fs.existsSync(cssPath)) {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
        res.end(fs.readFileSync(cssPath, 'utf-8'))
        return
      }
    }

    if (req.method === 'GET' && url.pathname === '/ui/app.js') {
      const jsPath = path.join(UI_DIR, 'app.js')
      if (fs.existsSync(jsPath)) {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
        res.end(fs.readFileSync(jsPath, 'utf-8'))
        return
      }
    }

    // 2. 状态查询 API
    if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.state.getSnapshot()))
      return
    }

    // 3. 紧急急停 API
    if (req.method === 'POST' && url.pathname === '/api/emergency-stop') {
      await this.scheduler.emergencyStop()
      this.emit('emergency_stop')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, message: '已执行全链路急停并清空队列' }))
      return
    }

    // 4. 代她说 API (直接发往 Helper 气泡与发音)
    if (req.method === 'POST' && url.pathname === '/api/say') {
      const body = await this.readJsonBody(req)
      const text = String(body.text || '').trim()
      const clip = String(body.clip || 'success')
      if (text) {
        await this.scheduler.playClip({ clip, maxMs: 3000 })
        await this.scheduler.speakText({ text, typewriter: true })
        this.emit('host_say', { text, clip })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, text }))
      return
    }

    // 5. 模式切换 API (支持 companion 陪伴模式 / work 工作模式 / live 直播模式)
    if (req.method === 'POST' && url.pathname === '/api/mode') {
      const body = await this.readJsonBody(req)
      const mode = body.mode === 'live' ? 'live' : body.mode === 'work' ? 'work' : 'companion'
      this.state.setMode(mode)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, mode: this.state.getMode() }))
      return
    }

    // 6. 投喂 API
    if (req.method === 'POST' && url.pathname === '/api/feed') {
      this.state.updateStats({
        hunger: Math.min(100, this.state.getStats().hunger + 15),
        mood: Math.min(100, this.state.getStats().mood + 5),
      })
      if (this.extras.impression) {
        const p = this.extras.impression.getProfile()
        p.bondScore += 3
        this.extras.impression.saveProfile(p)
      }
      await this.scheduler.playClip({ clip: 'eat_token', maxMs: 3500 })
      await this.scheduler.speakText({ text: '嗷呜！投喂的小鱼干真香！饱食度增加啦~', typewriter: true })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, stats: this.state.getStats() }))
      return
    }

    // 6.1 灵动动作与复合神态执行演练 API
    if (req.method === 'POST' && url.pathname === '/api/action/play') {
      const body = await this.readJsonBody(req)
      const clip = String(body.clip || 'idle').trim()
      const customSpeech = typeof body.speech === 'string' ? body.speech.trim() : ''

      const macro = this.scheduler.motionEngine?.getMacro(clip)
      const speech = customSpeech || macro?.defaultSpeech || ''

      if (speech) {
        await this.scheduler.speakText({ text: speech, typewriter: true })
      }
      this.scheduler.play(clip, { maxMs: 5000, resumeState: 'IDLE' })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, clip, speech }))
      return
    }

    // 6.2 QQ (OneBot v11 / NapCatQQ) 网关状态查询与热配置 API（含唯一主人 ownerQq 绑定）
    if (url.pathname === '/api/config/onebot') {
      const gw = this.extras.onebotGateway
      const pg = this.extras.permissionGuard
      if (req.method === 'GET') {
        const status = gw ? gw.getStatus() : { enabled: false, connected: false, ownerQq: pg?.getOwnerQq() || '' }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, ...status }))
        return
      }
      if (req.method === 'POST') {
        const body = await this.readJsonBody(req)
        if (body.ownerQq !== undefined && pg) {
          pg.setOwnerQq(String(body.ownerQq).trim())
        }
        if (gw) {
          gw.updateConfig(body)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            message: 'QQ OneBot 配置与主人权限账号已更新并尝试重新连接！',
            ...(gw?.getStatus() || { ownerQq: pg?.getOwnerQq() || '' }),
          })
        )
        return
      }
    }

    // 6.3 QQ OneBot 手动触发重连 API
    if (req.method === 'POST' && url.pathname === '/api/onebot/reconnect') {
      const gw = this.extras.onebotGateway
      if (gw) {
        gw.connect()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, message: '已触发 QQ 网关重连！', ...(gw?.getStatus() || {}) }))
      return
    }

    // 6.4 QQ 消息主动测试推送 API
    if (req.method === 'POST' && url.pathname === '/api/onebot/send-test') {
      const body = await this.readJsonBody(req)
      const gw = this.extras.onebotGateway
      if (!gw) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'OneBot 网关未挂载' }))
        return
      }
      const status = gw.getStatus()
      const targetQq = String(body.targetQq || status.ownerQq || status.botQq || '').trim()
      if (!targetQq) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: '请先绑定主人 QQ 号或提供接收测试消息的 QQ 号' }))
        return
      }
      const testText =
        '老爸！大肥鱼从桌面上穿越到 QQ 找你啦~ ✨\nQQ WebSocket 直连网关与权限中心已经跑通，以后在私聊或群聊里 @大肥鱼，我都会秒回你并守护你的电脑安全哦！🐟'
      const sendRes = await gw.sendPrivateMsg(targetQq, testText)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, targetQq, result: sendRes }))
      return
    }

    // 6.5 多联系人印象墙查询与编辑 API (Milestone M1 & M3)
    if (req.method === 'GET' && url.pathname === '/api/contacts') {
      const search = url.searchParams.get('search') || undefined
      const role = (url.searchParams.get('role') as any) || undefined
      const ci = this.extras.contactImpression
      const ownerQq = this.extras.onebotGateway?.getOwnerQq() || this.extras.permissionGuard?.getOwnerQq() || ''
      const profiles = ci ? ci.listProfiles({ search, role, limit: 100 }) : []
      const enriched = profiles.map((p) => ({
        ...p,
        facts: ci ? ci.getContactFacts(p.uid).slice(0, 8) : [],
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, ownerQq, contacts: enriched }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/contacts/update') {
      const body = await this.readJsonBody(req)
      const ci = this.extras.contactImpression
      if (!ci) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'ContactImpressionEngine not initialized' }))
        return
      }
      const uid = String(body.uid || body.externalId || '').trim()
      if (!uid) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'uid is required' }))
        return
      }
      const updated = ci.updateProfile(uid, {
        preferredTitle: body.preferredTitle,
        role: body.role,
        affinity: body.affinity !== undefined ? Number(body.affinity) : undefined,
        impressionTags: Array.isArray(body.impressionTags) ? body.impressionTags : undefined,
      })
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Contact not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, profile: updated }))
      return
    }

    // 6.6 L1 危险操作实时审批队列查询与决议 API (Milestone M2 & M3)
    if (
      req.method === 'GET' &&
      (url.pathname === '/api/approvals' || url.pathname === '/api/security/approvals')
    ) {
      const am = this.extras.approvalManager
      const ownerQq = this.extras.onebotGateway?.getOwnerQq() || this.extras.permissionGuard?.getOwnerQq() || ''
      const pending = am ? am.listPendingRequests() : []
      const history = am ? am.listRecentHistory(30) : []
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          success: true,
          ownerQq,
          pendingCount: pending.length,
          pending,
          history,
        })
      )
      return
    }

    if (
      req.method === 'POST' &&
      (url.pathname === '/api/approvals/resolve' || url.pathname === '/api/security/approvals/decide')
    ) {
      const body = await this.readJsonBody(req)
      const am = this.extras.approvalManager
      if (!am) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'ApprovalManager not initialized' }))
        return
      }
      const codeOrId = String(body.code || body.id || '').trim()
      const rawAction = String(body.action || body.decision || 'approve').toLowerCase()
      const action: 'approve' | 'reject' = rawAction === 'reject' ? 'reject' : 'approve'

      const resolveRes = am.resolveRequest(codeOrId, action, 'owner:console')
      if (!resolveRes.success || !resolveRes.request) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            success: false,
            error: resolveRes.error || resolveRes.message || '审批单不存在或已失效',
          })
        )
        return
      }

      let executionResult: any = null
      if (this.extras.onResolveApproval) {
        try {
          executionResult = await this.extras.onResolveApproval(resolveRes.request, action)
        } catch (err: any) {
          executionResult = { executed: false, error: err?.message }
        }
      }
      this.emit('approval_resolved_console', { request: resolveRes.request, action, executionResult })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          success: true,
          message: resolveRes.message,
          request: resolveRes.request,
          executionResult,
        })
      )
      return
    }

    // 7. 测试弹幕注入
    if (req.method === 'POST' && url.pathname === '/api/danmaku') {
      const body = await this.readJsonBody(req)
      this.emit('danmaku_injected', body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, received: body }))
      return
    }

    // 8. 爸爸专属聊天与任务下达 API (与女儿直接对话，触发大脑思考/电脑操控并加固印象记忆)
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await this.readJsonBody(req)
      const message = String(body.message || '').trim()
      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Message cannot be empty' }))
        return
      }

      let responded = false
      const timeout = setTimeout(() => {
        if (!responded) {
          responded = true
          res.writeHead(504, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Daughter thinking timeout' }))
        }
      }, 60000)

      this.emit('chat_message', {
        text: message,
        forceWorkMode: Boolean(body.forceWorkMode) || this.state.getMode() === 'work',
        respond: (reply: any) => {
          if (!responded) {
            responded = true
            clearTimeout(timeout)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, reply }))
          }
        },
      })
      return
    }

    // 9. 大脑与 CLI 诊断状态查询 API（含 Google AI Pro 额度与 DeepSeek 余额）
    if (req.method === 'GET' && url.pathname === '/api/brain/status') {
      const status = typeof this.brain?.getAllStatus === 'function' ? this.brain.getAllStatus() : { providers: [] }
      const quota = this.extras.quotaSensor ? this.extras.quotaSensor.getReport() : null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...status, quota }))
      return
    }

    // 9.1 实时查询或强制刷新 Google AI Pro + DeepSeek 额度 API
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/brain/quota') {
      const force = req.method === 'POST'
      const report = this.extras.quotaSensor
        ? await this.extras.quotaSensor.refreshAll(force)
        : null
      if (report) {
        this.state.updateStats({ hunger: report.satietyPct })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, quota: report, stats: this.state.getStats() }))
      return
    }

    // 9.2 一键识别本地 CLI 工具并刷新额度 API
    if (req.method === 'POST' && url.pathname === '/api/brain/detect-cli') {
      const detected = typeof this.brain?.detectAllClis === 'function' ? this.brain.detectAllClis() : []
      const quota = this.extras.quotaSensor ? await this.extras.quotaSensor.refreshAll(true) : null
      if (quota) {
        this.state.updateStats({ hunger: quota.satietyPct })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, detected, quota }))
      return
    }

    // 9.3 主动测试指定大脑通道连通性 API (agy / cursor / deepseek_sse / local_llm)
    if (req.method === 'POST' && url.pathname === '/api/brain/test') {
      const body = await this.readJsonBody(req)
      const providerId = String(body.providerId || 'deepseek_sse').trim()
      const testRes =
        typeof this.brain?.testProviderConnectivity === 'function'
          ? await this.brain.testProviderConnectivity(providerId)
          : { ok: false, latencyMs: 0, error: 'Router not available' }

      if (this.extras.quotaSensor) {
        const report = this.extras.quotaSensor.getReport()
        this.state.updateStats({ hunger: report.satietyPct })
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, providerId, ...testRes }))
      return
    }

    // 10. DeepSeek API Key 在线热配置与即时余额校验 API
    if (req.method === 'POST' && url.pathname === '/api/config/deepseek') {
      const body = await this.readJsonBody(req)
      const apiKey = String(body.apiKey || '').trim()

      if (this.brain?.deepSeekProvider) {
        this.brain.deepSeekProvider.setApiKey(apiKey)
      }
      const p = this.brain?.providers?.find?.((x: any) => x.tier === 2)
      if (p && typeof p.setApiKey === 'function') {
        p.setApiKey(apiKey)
      }

      // 1. 持久化到不受 Git 覆盖的 runtime/data/secrets.json
      try {
        const secretsPath = path.resolve(process.cwd(), 'runtime/data/secrets.json')
        fs.mkdirSync(path.dirname(secretsPath), { recursive: true })
        let secrets: any = {}
        if (fs.existsSync(secretsPath)) {
          try {
            secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'))
          } catch {}
        }
        secrets.deepseekApiKey = apiKey
        secrets.updatedAt = new Date().toISOString()
        fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), 'utf-8')
      } catch (err) {
        console.warn('[dsh-dafeiyu] 写入 secrets.json 失败:', err)
      }

      // 2. 同步更新 config/daughter.config.json
      try {
        const cfgPath = path.resolve(process.cwd(), 'config/daughter.config.json')
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
          if (!cfg.brain) cfg.brain = {}
          if (!cfg.brain.deepseek) cfg.brain.deepseek = {}
          cfg.brain.deepseek.apiKey = apiKey
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8')
        }
      } catch (err) {
        console.warn('[dsh-dafeiyu] 持久化 DeepSeek Key 失败:', err)
      }

      // 3. 立即查询一次 DeepSeek 真实账户余额并同步饱食度 (非阻塞快速响应，最多等待 3000ms 窗口)
      let balance = null
      try {
        const fetchPromise = this.extras.quotaSensor
          ? this.extras.quotaSensor.refreshDeepSeekBalance(true)
          : p && typeof p.fetchAccountBalance === 'function'
          ? p.fetchAccountBalance(true)
          : null

        if (fetchPromise) {
          balance = await Promise.race([
            fetchPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
          ]).catch(() => null)
        }
      } catch (err) {
        console.warn('[dsh-dafeiyu] 快速查询余额异常:', err)
      }

      if (this.extras.quotaSensor) {
        const report = this.extras.quotaSensor.getReport()
        this.state.updateStats({ hunger: report.satietyPct })
      }

      const masked = p && typeof p.getMaskedApiKey === 'function' ? p.getMaskedApiKey() : ''
      const msg =
        balance && balance.status === 'ready'
          ? `DeepSeek 密钥已生效！当前账户余额: ${balance.summary}`
          : balance && balance.error
          ? `密钥已成功保存至密盒，但当前余额校验提示: ${balance.error}`
          : 'DeepSeek 密钥已安全保存至密盒，并在后台持续探测账户余额与连通性！'

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, maskedApiKey: masked, balance, message: msg }))
      return
    }

    // 11. 记忆、主人印象档案与已进化技能查询 API
    if (req.method === 'GET' && url.pathname === '/api/memories') {
      const rawMode = this.state.getMode()
      const memMode = rawMode === 'live' ? 'live' : 'companion'
      const profile = this.extras.impression?.getProfile() || null
      const facts = this.extras.memory?.queryFacts('host', memMode) || []
      const episodes = this.extras.memory?.queryEpisodes({ mode: memMode, limit: 12 }) || []
      const skills = this.extras.impression?.getLearnedSkills() || []
      const sessionSummary = rawMode === 'live' ? '' : this.extras.memory?.loadSessionSummary() || ''
      const recentDialogues = rawMode === 'live' ? [] : this.extras.workingMemory?.getRecentDialogues() || []

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          mode: rawMode,
          profile,
          facts,
          episodes,
          skills,
          sessionSummary,
          recentDialogues,
        })
      )
      return
    }

    // 12. 主动传授新事实或新技能 API (加固印象与技能学习)
    if (req.method === 'POST' && url.pathname === '/api/memories/teach') {
      const body = await this.readJsonBody(req)
      const type = body.type || 'fact'

      if (type === 'skill' && this.extras.impression) {
        const triggerPhrase = String(body.triggerPhrase || '').trim()
        const actionTemplate = String(body.actionTemplate || '').trim()
        const name = String(body.name || `专属口令: ${triggerPhrase}`).trim()
        const category = body.category || 'workflow'
        if (!triggerPhrase || !actionTemplate) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'triggerPhrase and actionTemplate are required' }))
          return
        }
        const skill = this.extras.impression.learnOrUpgradeSkill({
          name,
          triggerPhrase,
          category,
          description: `当老爸说“${triggerPhrase}”时，执行：${actionTemplate}`,
          actionTemplate,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, skill }))
        return
      }

      if (this.extras.impression) {
        const predicate = String(body.predicate || '主人偏好').trim()
        const object = String(body.object || '').trim()
        if (!object) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'object cannot be empty' }))
          return
        }
        const r = this.extras.impression.reinforceFact({
          category: 'manual_taught',
          predicate,
          object,
          baseConfidence: 0.95,
        })
        const p = this.extras.impression.getProfile()
        p.bondScore += 4
        this.extras.impression.saveProfile(p)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, factId: r.id, confidence: r.confidence }))
        return
      }

      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Impression engine not initialized' }))
      return
    }

    // 13. 触发每日日记复盘与记忆进化 API
    if (req.method === 'POST' && url.pathname === '/api/evolve') {
      const mode = this.state.getMode()
      if (this.extras.diaryGenerator) {
        const diary =
          mode === 'live'
            ? await this.extras.diaryGenerator.generateLiveDiary()
            : await this.extras.diaryGenerator.generateDiary()
        await this.scheduler.playClip({ clip: 'success', maxMs: 3200 })
        await this.scheduler.speakText({
          text: '哼，今天的记忆和技能本鱼都复盘整理进日记本啦！又变聪明了一点点~',
          typewriter: true,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, diary }))
        return
      }
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Diary generator not initialized' }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Endpoint not found' }))
  }

  private readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => (data += chunk))
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch {
          resolve({})
        }
      })
    })
  }

  private renderHtml(): string {
    const htmlPath = path.join(UI_DIR, 'index.html')
    if (fs.existsSync(htmlPath)) {
      return fs.readFileSync(htmlPath, 'utf-8')
    }
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>CyberFish Console</title></head><body>UI assets missing</body></html>'
  }
}
