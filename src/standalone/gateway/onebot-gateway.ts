/**
 * @file onebot-gateway.ts
 * QQ 机器人直连网关 (基于 OneBot v11 / NapCatQQ / LLOneBot 标准正向 WebSocket 协议)
 * 支持私聊无感对话、群聊 @ 互动、动作声控与消息即时回复 (无需域名、无需备案、零公网穿透)
 */

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

export interface OneBotConfig {
  enabled: boolean
  wsUrl: string // 例如: "ws://127.0.0.1:3001"
  accessToken?: string // 鉴权 Token (若 NapCat 设置了 token 则填入)
  botQq?: string // 当前小号 QQ 号 (连接后自动拉取)
  botNickname?: string // 当前小号昵称 (连接后自动拉取)
  botName?: string // 触发别名，默认 "大肥鱼"
  allowPrivate: boolean // 允许私聊对话
  allowGroup: boolean // 允许群聊对话
  groupRequireAt: boolean // 群聊是否需要 @ 触发 (默认 true)
  ownerQq?: string // 👑 唯一绑定主人 QQ 号
}

export interface OneBotUserMessageEvent {
  source: 'qq_private' | 'qq_group'
  userId: string
  groupId?: string
  nickname: string
  text: string
  rawMessage: string
  reply: (replyText: string, clip?: string) => Promise<void>
}

export class OneBotGateway extends EventEmitter {
  private config: OneBotConfig
  private ws: any = null
  private isConnected: boolean = false
  private reconnectTimer: any = null
  private shouldReconnect: boolean = true
  private lastError: string = ''
  private totalReceived: number = 0
  private totalSent: number = 0
  private pendingEchos: Map<string, (data: any) => void> = new Map()

  constructor(initialConfig: Partial<OneBotConfig> = {}) {
    super()
    this.config = {
      enabled: initialConfig.enabled ?? true,
      wsUrl: initialConfig.wsUrl || 'ws://127.0.0.1:3001',
      accessToken: initialConfig.accessToken || '',
      botQq: initialConfig.botQq || '',
      botNickname: initialConfig.botNickname || '',
      botName: initialConfig.botName || '大肥鱼',
      allowPrivate: initialConfig.allowPrivate ?? true,
      allowGroup: initialConfig.allowGroup ?? true,
      groupRequireAt: initialConfig.groupRequireAt ?? true,
      ownerQq: String(initialConfig.ownerQq || '').trim(),
    }

    if (this.config.enabled) {
      this.connect()
    }
  }

  public connect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      const oldWs = this.ws
      this.ws = null
      try {
        // 先卸载旧连接的事件回调，防止旧连接异步触发 onclose 把新建立的 this.ws 覆写为 null
        oldWs.onopen = null
        oldWs.onmessage = null
        oldWs.onerror = null
        oldWs.onclose = null
        oldWs.close()
      } catch {}
    }

    if (!this.config.enabled || !this.config.wsUrl) {
      this.isConnected = false
      return
    }

    this.shouldReconnect = true

    const targetUrl = this.config.accessToken
      ? `${this.config.wsUrl}?access_token=${encodeURIComponent(this.config.accessToken)}`
      : this.config.wsUrl

    try {
      // Node 22+ / 26 原生自带全局 WebSocket
      const WSClient = (globalThis as any).WebSocket
      if (!WSClient) {
        this.lastError = '当前运行环境未检测到全局 WebSocket 支持'
        console.warn(`[OneBotGateway] ${this.lastError}`)
        return
      }

      const currentWs = new WSClient(targetUrl)
      this.ws = currentWs

      currentWs.onopen = () => {
        if (this.ws !== currentWs) return
        this.isConnected = true
        this.lastError = ''
        console.log(`[OneBotGateway] 🟢 成功连入 QQ OneBot 服务: ${this.config.wsUrl}`)

        // 连接建立后拉取自身登录号信息
        this.sendAction('get_login_info', {}, (data) => {
          if (data && data.status === 'ok' && data.data) {
            this.config.botQq = String(data.data.user_id || '')
            this.config.botNickname = String(data.data.nickname || '大肥鱼')
            console.log(`[OneBotGateway] 🤖 识别到 QQ 小号: ${this.config.botNickname} (${this.config.botQq})`)
            this.persistConfig()
          }
        })

        this.emit('connected')
      }

      currentWs.onmessage = (event: any) => {
        if (this.ws !== currentWs) return
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString()
          const payload = JSON.parse(raw)
          this.handlePayload(payload)
        } catch (err: any) {
          console.warn('[OneBotGateway] 解析消息异常:', err.message)
        }
      }

      currentWs.onerror = (err: any) => {
        if (this.ws !== currentWs) return
        this.lastError = err?.message || 'WebSocket 连接异常'
        this.isConnected = false
      }

      currentWs.onclose = () => {
        if (this.ws !== currentWs) return
        const wasConnected = this.isConnected
        this.isConnected = false
        this.ws = null
        if (wasConnected) {
          console.log('[OneBotGateway] ⚪ 与 QQ OneBot 服务断开连接')
          this.emit('disconnected')
        }
        this.scheduleReconnect()
      }
    } catch (err: any) {
      this.lastError = err.message
      this.isConnected = false
      this.scheduleReconnect()
    }
  }

  public disconnect(): void {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      const oldWs = this.ws
      this.ws = null
      try {
        oldWs.onopen = null
        oldWs.onmessage = null
        oldWs.onerror = null
        oldWs.onclose = null
        oldWs.close()
      } catch {}
    }
    this.isConnected = false
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || !this.config.enabled) return
    if (this.reconnectTimer) return

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.config.enabled && !this.isConnected) {
        this.connect()
      }
    }, 5000)
    this.reconnectTimer.unref?.()
  }

  private handlePayload(payload: any): void {
    // 1. 处理 echo 异步回调
    if (payload.echo && this.pendingEchos.has(payload.echo)) {
      const cb = this.pendingEchos.get(payload.echo)
      this.pendingEchos.delete(payload.echo)
      cb?.(payload)
      return
    }

    // 2. 消息上报 (post_type === 'message')
    if (payload.post_type === 'message') {
      this.totalReceived++
      const msgType = payload.message_type // 'private' | 'group'
      const rawText = String(payload.raw_message || payload.message || '').trim()
      const senderNick = payload.sender?.card || payload.sender?.nickname || '神秘好友'
      const senderId = String(payload.user_id || '')

      // 忽略自己发送的消息，防循环回复
      if (this.config.botQq && senderId === this.config.botQq) {
        return
      }

      // 私聊消息处理 (含好友私聊与群临时会话)
      if (msgType === 'private' && this.config.allowPrivate) {
        const cleanText = this.cleanCqCode(rawText)
        if (!cleanText) return
        const tempGroupId = payload.sender?.group_id || payload.group_id

        this.emit('user_message', {
          source: 'qq_private',
          userId: senderId,
          nickname: senderNick,
          text: cleanText,
          rawMessage: rawText,
          reply: async (replyText: string, _clip?: string) => {
            await this.sendPrivateMsg(payload.user_id, replyText, tempGroupId)
          },
        } as OneBotUserMessageEvent)
        return
      }

      // 群聊消息处理
      if (msgType === 'group' && this.config.allowGroup) {
        const groupId = String(payload.group_id || '')
        const botQq = this.config.botQq || ''
        const botName = this.config.botName || '大肥鱼'

        let isTriggered = !this.config.groupRequireAt
        let cleanText = rawText

        // 检查是否 @ 了当前机器人
        const atCq = `[CQ:at,qq=${botQq}]`
        if (botQq && rawText.includes(atCq)) {
          isTriggered = true
          cleanText = cleanText.replace(atCq, '')
        }

        // 检查是否在正文中以大肥鱼名称打招呼开头 (如: "大肥鱼，跳个舞")
        if (cleanText.includes(`@${botName}`) || cleanText.startsWith(botName) || cleanText.startsWith(`@${botName}`)) {
          isTriggered = true
          cleanText = cleanText.replace(`@${botName}`, '').replace(new RegExp(`^${botName}[，,\\s]*`), '')
        }

        cleanText = this.cleanCqCode(cleanText).trim()

        if (isTriggered && cleanText) {
          this.emit('user_message', {
            source: 'qq_group',
            groupId,
            userId: senderId,
            nickname: senderNick,
            text: cleanText,
            rawMessage: rawText,
            reply: async (replyText: string, _clip?: string) => {
              // 群内回复，自动带上 @ 发起者
              const fullReply = `[CQ:at,qq=${senderId}] ${replyText}`
              await this.sendGroupMsg(payload.group_id, fullReply)
            },
          } as OneBotUserMessageEvent)
        }
      }
    }
  }

  /**
   * 剥离 CQ 码与多余格式
   */
  private cleanCqCode(text: string): string {
    return text.replace(/\[CQ:[^\]]+\]/g, '').trim()
  }

  public sendAction(action: string, params: any = {}, callback?: (data: any) => void): void {
    if (!this.ws || !this.isConnected) {
      console.warn(`[OneBotGateway] ⚠️ 无法执行 ${action}: WebSocket 未连接 (isConnected=${this.isConnected}, hasWs=${Boolean(this.ws)})`)
      callback?.({ status: 'failed', retcode: -1, error: 'WebSocket 未连接' })
      return
    }

    const echo = `echo_${Date.now()}_${Math.floor(Math.random() * 10000)}`
    if (callback) {
      this.pendingEchos.set(echo, callback)
    }

    const payload = JSON.stringify({ action, params, echo })
    try {
      this.ws.send(payload)
      this.totalSent++
    } catch (err: any) {
      console.warn('[OneBotGateway] 发送消息异常:', err.message)
      callback?.({ status: 'failed', retcode: -1, error: err.message })
    }
  }

  public async sendPrivateMsg(userId: number | string, message: string, groupId?: number | string): Promise<any> {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          resolve({ status: 'timeout', retcode: -2 })
        }
      }, 3000)
      timer.unref?.()

      const params: Record<string, any> = {
        user_id: Number(userId),
        message,
      }
      if (groupId) {
        params.group_id = Number(groupId)
      }

      this.sendAction(
        'send_private_msg',
        params,
        (data) => {
          if (data?.status === 'failed') {
            console.warn(`[OneBotGateway] ❌ 私聊回复发送失败 (user=${userId}):`, JSON.stringify(data))
          }
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve(data)
          }
        }
      )
    })
  }

  public async sendGroupMsg(groupId: number | string, message: string): Promise<any> {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          resolve({ status: 'timeout', retcode: -2 })
        }
      }, 3000)
      timer.unref?.()

      this.sendAction(
        'send_group_msg',
        {
          group_id: Number(groupId),
          message,
        },
        (data) => {
          if (data?.status === 'failed') {
            console.warn(`[OneBotGateway] ❌ 群聊回复发送失败 (group=${groupId}):`, JSON.stringify(data))
          }
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve(data)
          }
        }
      )
    })
  }

  public getOwnerQq(): string {
    return (this.config.ownerQq || '').trim()
  }

  public setOwnerQq(ownerQq: string): void {
    this.config.ownerQq = String(ownerQq || '').trim()
    this.persistConfig()
    this.emit('owner_updated', this.config.ownerQq)
  }

  public updateConfig(newConfig: Partial<OneBotConfig>): void {
    const needReconnect =
      newConfig.wsUrl !== undefined && newConfig.wsUrl !== this.config.wsUrl ||
      newConfig.accessToken !== undefined && newConfig.accessToken !== this.config.accessToken ||
      newConfig.enabled !== undefined && newConfig.enabled !== this.config.enabled ||
      (Boolean(newConfig.enabled ?? this.config.enabled) && (!this.ws || !this.isConnected))

    this.config = { ...this.config, ...newConfig }
    if (newConfig.ownerQq !== undefined) {
      this.config.ownerQq = String(newConfig.ownerQq || '').trim()
    }
    this.persistConfig()

    if (needReconnect) {
      this.shouldReconnect = Boolean(this.config.enabled)
      if (this.config.enabled) {
        this.connect()
      } else {
        this.disconnect()
      }
    }
  }

  public getConfig(): OneBotConfig {
    return { ...this.config }
  }

  public getStatus() {
    return {
      enabled: this.config.enabled,
      connected: Boolean(this.isConnected && this.ws),
      wsUrl: this.config.wsUrl,
      botQq: this.config.botQq,
      botNickname: this.config.botNickname,
      botName: this.config.botName,
      ownerQq: this.config.ownerQq || '',
      allowPrivate: this.config.allowPrivate,
      allowGroup: this.config.allowGroup,
      groupRequireAt: this.config.groupRequireAt,
      totalReceived: this.totalReceived,
      totalSent: this.totalSent,
      lastError: this.lastError,
    }
  }

  private persistConfig(): void {
    try {
      const secretsPath = path.resolve(process.cwd(), 'runtime/data/secrets.json')
      let secrets: any = {}
      if (fs.existsSync(secretsPath)) {
        try {
          secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'))
        } catch {}
      }

      // 双写持久化：根字段与 onebot 字段均同步，实现最大向下兼容
      secrets.ownerQq = this.config.ownerQq || ''
      secrets.onebot = {
        ...(secrets.onebot || {}),
        enabled: this.config.enabled,
        wsUrl: this.config.wsUrl,
        accessToken: this.config.accessToken || '',
        botQq: this.config.botQq || '',
        botNickname: this.config.botNickname || '',
        botName: this.config.botName || '大肥鱼',
        allowPrivate: this.config.allowPrivate,
        allowGroup: this.config.allowGroup,
        groupRequireAt: this.config.groupRequireAt,
        ownerQq: this.config.ownerQq || '',
        updatedAt: new Date().toISOString(),
      }

      const dir = path.dirname(secretsPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[OneBotGateway] 持久化 QQ OneBot 配置失败:', err)
    }
  }
}
