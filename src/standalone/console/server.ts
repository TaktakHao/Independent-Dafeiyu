/**
 * @file server.ts
 * 本地主播安全控制台：内置极简高质感暗黑 Web 控制面板与 RESTful 控制 API (http://127.0.0.1:7788)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { StateManager } from '../core/state.ts'
import type { RuntimeScheduler } from '../core/scheduler.ts'

export class ConsoleServer extends EventEmitter {
  private server: any = null
  private port: number
  private state: StateManager
  private scheduler: RuntimeScheduler
  private brain?: any

  constructor(
    port: number = 7788,
    state: StateManager,
    scheduler: RuntimeScheduler,
    brain?: any
  ) {
    super()
    this.port = port
    this.state = state
    this.scheduler = scheduler
    this.brain = brain
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
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

    // 1. 首页控制台 HTML 界面
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(this.renderHtml())
      return
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

    // 5. 模式切换 API
    if (req.method === 'POST' && url.pathname === '/api/mode') {
      const body = await this.readJsonBody(req)
      const mode = body.mode === 'live' ? 'live' : 'companion'
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
      await this.scheduler.playClip({ clip: 'eat_token', maxMs: 3500 })
      await this.scheduler.speakText({ text: '嗷呜！投喂的小鱼干真香！饱食度增加啦~', typewriter: true })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, stats: this.state.getStats() }))
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

    // 8. 爸爸专属聊天 API (与女儿直接对话，触发大脑思考并保留私密记忆)
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
      }, 15000)

      this.emit('chat_message', {
        text: message,
        respond: (reply: { text: string; clip: string; tone: string }) => {
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

    // 9. 大脑与 CLI 诊断状态查询 API
    if (req.method === 'GET' && url.pathname === '/api/brain/status') {
      const status = typeof this.brain?.getAllStatus === 'function' ? this.brain.getAllStatus() : { providers: [] }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status))
      return
    }

    // 10. DeepSeek API Key 在线热配置 API
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

      // 持久化到 config/daughter.config.json
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

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, message: 'DeepSeek API Key 已更新' }))
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
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>🐋 CyberFish 大肥鱼桌面伴侣终端</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: #0f1117;
      --card-bg: #1a1d27;
      --border: #2a2e3d;
      --text: #e6e8ee;
      --accent: #3b82f6;
      --danger: #ef4444;
      --success: #10b981;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 24px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .header h1 { font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: bold;
      background: #2563eb33;
      color: #60a5fa;
      border: 1px solid #3b82f644;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
    }
    .card h2 { font-size: 15px; margin-bottom: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
    .btn {
      cursor: pointer;
      padding: 10px 16px;
      border-radius: 8px;
      border: none;
      font-weight: 600;
      font-size: 14px;
      transition: all 0.2s;
    }
    .btn-danger { background: var(--danger); color: #fff; width: 100%; margin-bottom: 12px; }
    .btn-danger:hover { background: #dc2626; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: #2563eb; }
    .input-box {
      width: 100%;
      background: #090a0f;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      color: #fff;
      font-size: 14px;
      margin-bottom: 10px;
    }
    .stats-bar { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; }
    .progress { height: 8px; border-radius: 4px; background: #242938; overflow: hidden; margin-bottom: 12px; }
    .progress-fill { height: 100%; transition: width 0.3s; }
    .chat-container {
      height: 220px;
      overflow-y: auto;
      background: #090a0f;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .chat-msg {
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.4;
    }
    .chat-msg.user {
      align-self: flex-end;
      background: #1e3a8a;
      color: #bfdbfe;
    }
    .chat-msg.daughter {
      align-self: flex-start;
      background: #242938;
      color: #e2e8f0;
      border: 1px solid #334155;
    }
    .chat-meta {
      font-size: 10px;
      color: #94a3b8;
      margin-bottom: 2px;
    }
    .provider-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .provider-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-radius: 6px;
      background: #090a0f;
      border: 1px solid var(--border);
      font-size: 13px;
    }
    .tag {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
    }
    .tag-ready { background: #065f46; color: #a7f3d0; }
    .tag-busy { background: #854d0e; color: #fde047; }
    .tag-disabled { background: #374151; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🐋 大肥鱼桌面伴侣终端</h1>
    <span class="badge" id="modeBadge">陪伴模式</span>
  </div>

  <div class="grid">
    <!-- 伴侣即时对话 -->
    <div class="card" style="grid-column: 1 / -1;">
      <h2>💬 伴侣即时对话 (驱动桌面动作与拟人语音)</h2>
      <div class="chat-container" id="chatLogs">
        <div class="chat-msg daughter">
          <div class="chat-meta">🐋 大肥鱼</div>
          你来啦！今天在 Antigravity 和 Cursor 里写什么好玩的代码呢？快跟我讲讲~
        </div>
      </div>
      <div style="display: flex; gap: 8px;">
        <input type="text" id="chatInput" class="input-box" style="margin-bottom: 0;" placeholder="输入对话内容... (按 Enter 发送)" onkeydown="if(event.key==='Enter') sendChat()" />
        <button class="btn btn-primary" style="white-space: nowrap;" id="sendBtn" onclick="sendChat()">发送</button>
      </div>
    </div>

    <!-- 急停与风控 -->
    <div class="card">
      <h2>🚨 紧急安全风控</h2>
      <button class="btn btn-danger" onclick="emergencyStop()">⚡ 一键紧急停嘴 (清空全部队列)</button>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-primary" style="flex: 1;" onclick="toggleMode('companion')">切换为陪伴模式</button>
        <button class="btn btn-primary" style="flex: 1; background: var(--warning);" onclick="toggleMode('live')">切换为直播模式</button>
      </div>
    </div>

    <!-- 状态监控 -->
    <div class="card">
      <h2>📊 伴侣当前身体状态</h2>
      <div class="stats-bar"><span>🍙 饱食度</span><span id="hungerVal">--%</span></div>
      <div class="progress"><div class="progress-fill" id="hungerFill" style="background: #f59e0b; width: 0%;"></div></div>

      <div class="stats-bar"><span>❤️ 心情值</span><span id="moodVal">--</span></div>
      <div class="progress"><div class="progress-fill" id="moodFill" style="background: #ec4899; width: 0%;"></div></div>

      <div class="stats-bar"><span>⚡ 精力值</span><span id="energyVal">--%</span></div>
      <div class="progress"><div class="progress-fill" id="energyFill" style="background: #3b82f6; width: 0%;"></div></div>

      <button class="btn btn-primary" style="width: 100%;" onclick="feed()">🐟 给大肥鱼喂小鱼干 (+15)</button>
    </div>

    <!-- 代她说 (人工插话) -->
    <div class="card">
      <h2>🗣️ 人工代发言 (快捷插话)</h2>
      <input type="text" id="sayInput" class="input-box" placeholder="输入要代大肥鱼说的话..." />
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-primary" style="flex: 1;" onclick="hostSay('success')">欢呼说出</button>
        <button class="btn btn-primary" style="flex: 1; background: #64748b;" onclick="hostSay('idle')">平常说出</button>
      </div>
    </div>

    <!-- 思考大脑与 CLI 实时诊断 -->
    <div class="card" style="grid-column: 1 / -1;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h2>🧠 阶梯思考大脑与 CLI 实时状态</h2>
        <span class="badge" id="activeTierBadge">当前生效: Tier 1</span>
      </div>
      <div class="provider-list" id="providerList">
        <div style="font-size: 13px; color: #94a3b8;">正在探测本地 CLI 与 API 连通性...</div>
      </div>
    </div>

    <!-- DeepSeek API Key 在线配置 -->
    <div class="card" style="grid-column: 1 / -1;">
      <h2>⚙️ DeepSeek API 密钥在线配置 (热生效)</h2>
      <div style="display: flex; gap: 8px; align-items: center;">
        <input type="password" id="deepseekKeyInput" class="input-box" style="margin-bottom: 0;" placeholder="sk-********************************" />
        <button class="btn btn-primary" style="white-space: nowrap;" onclick="saveDeepSeekKey()">保存并立即生效</button>
      </div>
      <div style="font-size: 11px; color: #94a3b8; margin-top: 6px;" id="keyHintText">
        当前状态: 正在读取密钥...
      </div>
    </div>
  </div>

  <script>
    async function refreshStatus() {
      try {
        const res = await fetch('/api/status')
        const data = await res.json()
        document.getElementById('modeBadge').innerText = data.mode === 'live' ? '🔴 直播中' : '🟢 陪伴中'
        document.getElementById('hungerVal').innerText = data.stats.hunger + '%'
        document.getElementById('hungerFill').style.width = data.stats.hunger + '%'
        document.getElementById('moodVal').innerText = data.stats.mood + ' (' + data.emotion + ')'
        document.getElementById('moodFill').style.width = data.stats.mood + '%'
        document.getElementById('energyVal').innerText = data.stats.energy + '%'
        document.getElementById('energyFill').style.width = data.stats.energy + '%'
      } catch (e) {}
    }

    async function emergencyStop() {
      await fetch('/api/emergency-stop', { method: 'POST' })
      alert('已触发急停！')
      refreshStatus()
    }

    async function toggleMode(mode) {
      await fetch('/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
      refreshStatus()
    }

    async function feed() {
      await fetch('/api/feed', { method: 'POST' })
      refreshStatus()
    }

    async function hostSay(clip) {
      const text = document.getElementById('sayInput').value
      if (!text) return
      await fetch('/api/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, clip }) })
      document.getElementById('sayInput').value = ''
      refreshStatus()
    }

    async function sendChat() {
      const input = document.getElementById('chatInput')
      const text = input.value.trim()
      if (!text) return
      input.value = ''

      const logs = document.getElementById('chatLogs')
      const userMsg = document.createElement('div')
      userMsg.className = 'chat-msg user'
      userMsg.innerHTML = '<div class="chat-meta">👨‍💻 我</div>' + escapeHtml(text)
      logs.appendChild(userMsg)
      logs.scrollTop = logs.scrollHeight

      const daughterMsg = document.createElement('div')
      daughterMsg.className = 'chat-msg daughter'
      daughterMsg.innerHTML = '<div class="chat-meta">🐋 大肥鱼</div><i>思考中...</i>'
      logs.appendChild(daughterMsg)
      logs.scrollTop = logs.scrollHeight

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text })
        })
        const data = await res.json()
        if (data.reply) {
          daughterMsg.innerHTML = '<div class="chat-meta">🐋 大肥鱼 (' + (data.reply.clip || '开心') + ')</div>' + escapeHtml(data.reply.text)
        } else {
          daughterMsg.innerHTML = '<div class="chat-meta">🐋 大肥鱼</div>(哼，本鱼暂时不想理你或者走神啦)'
        }
      } catch (err) {
        daughterMsg.innerHTML = '<div class="chat-meta">🐋 大肥鱼</div>(脑瓜短路了，请检查网络或模型配置)'
      }
      logs.scrollTop = logs.scrollHeight
      refreshStatus()
    }

    async function refreshBrainStatus() {
      try {
        const res = await fetch('/api/brain/status')
        const data = await res.json()
        const list = document.getElementById('providerList')
        const badge = document.getElementById('activeTierBadge')
        if (badge) {
          badge.innerText = '当前首选生效: Tier ' + data.activeTier
        }
        if (list && Array.isArray(data.providers)) {
          let html = ''
          for (const p of data.providers) {
            const isReady = p.available && p.state === 'READY'
            const tagClass = isReady ? 'tag-ready' : (p.state === 'EXHAUSTED' || p.state === 'CIRCUIT_BROKEN' ? 'tag-busy' : 'tag-disabled')
            const tagLabel = isReady ? '就绪' : (p.state === 'EXHAUSTED' ? '额度超限冷却' : (p.state === 'DISABLED' ? '未配置' : p.state || '离线'))
            
            let extra = ''
            if (p.binPath) extra = ' · ' + p.binPath
            else if (p.maskedApiKey) extra = ' · 密钥已就绪 (' + p.maskedApiKey + ')'
            else if (p.todayCostCny !== undefined) extra = ' · 今日消耗: ¥' + p.todayCostCny
            
            html += '<div class="provider-row">'
            html += '<div><strong>Tier ' + p.tier + ': ' + escapeHtml(p.name || p.id) + '</strong>'
            html += '<span style="font-size: 11px; color: #64748b; margin-left: 8px;">' + escapeHtml(extra) + '</span></div>'
            html += '<span class="tag ' + tagClass + '">' + tagLabel + '</span>'
            html += '</div>'

            if (p.tier === 2 && p.maskedApiKey) {
              const hint = document.getElementById('keyHintText')
              if (hint) {
                hint.innerText = '当前配置密钥: ' + p.maskedApiKey + ' (今日已用: ¥' + (p.todayCostCny || 0) + ' / 限额 ¥' + (p.dailyBudgetCny || 5) + ')'
              }
            }
          }
          list.innerHTML = html
        }
      } catch (e) {}
    }

    async function saveDeepSeekKey() {
      const input = document.getElementById('deepseekKeyInput')
      const key = input.value.trim()
      if (!key) {
        alert('请输入有效的 DeepSeek API Key (以 sk- 开头)')
        return
      }
      try {
        const res = await fetch('/api/config/deepseek', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key })
        })
        const data = await res.json()
        alert(data.message || '配置已生效')
        input.value = ''
        refreshBrainStatus()
      } catch (e) {
        alert('保存失败: ' + e.message)
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    }

    setInterval(refreshStatus, 2000)
    setInterval(refreshBrainStatus, 3000)
    refreshStatus()
    refreshBrainStatus()
  </script>
</body>
</html>`
  }
}
