/**
 * @file qq-orchestrator.ts
 * QQ (OneBot v11 / NapCatQQ) 社交网关业务协调器
 *
 * 职责边界：
 * 1. 处理私聊与群聊消息路由、联系人建档与主人硬件级身份锚定
 * 2. 执行双通道主人审批口令 (同意/拒绝 #单号) 与 L0/L1/L2 分级权限拦截
 * 3. 协调 MemeManager 执行「图文 100% 物理分离」、「多气泡拟人打字连发」与「延迟追击碎碎念 (afterthought)」
 * 4. 衔接闲聊意图派生的只读连接器查询 (okx / docker / web) 与后台满血 Operator (agy) 异步任务执行
 * 5. 提供作息关怀与长时间冷场主动找老爸搭话能力
 */

import type { StateManager } from '../core/state.ts'
import type { ContactImpressionEngine } from '../memory/contacts.ts'
import type { OutputGuard } from '../safety/output-guard.ts'
import type { PermissionGuard } from '../safety/permission-guard.ts'
import type { ApprovalManager } from '../safety/approval-manager.ts'
import type { TaskExecutor } from '../brain/task-executor.ts'
import { isRiskyTask, resolveQueryTopic } from '../brain/connectors.ts'
import type { MemeManager } from '../brain/meme-manager.ts'
import type { OneBotGateway, OneBotUserMessageEvent } from './onebot-gateway.ts'
import type { DialoguePipeline, EnrichedDialogueEvent } from '../events/dialogue-pipeline.ts'
import { getOwnerQq } from '../core/config-loader.ts'
import type { HomeWatchdogSensor, WatchdogAlertEvent, WatchdogAlertSuggestion } from '../sensors/home-watchdog.ts'
import type { ReminderManager, ScheduledReminder } from '../sensors/reminder-manager.ts'
import type { TieredBrainRouter } from '../brain/router.ts'
import type { CompiledGraph } from '../graph/engine.ts'
import type { CompanionGraphState } from '../graph/companion-graph.ts'

export interface QqOrchestratorDeps {
  state: StateManager
  onebotGateway: OneBotGateway
  permissionGuard: PermissionGuard
  approvalManager: ApprovalManager
  contactImpression: ContactImpressionEngine
  outputGuard: OutputGuard
  taskExecutor: TaskExecutor
  memeManager: MemeManager
  dialoguePipeline: DialoguePipeline
  companionGraph?: CompiledGraph<CompanionGraphState>
  brain?: TieredBrainRouter
  homeWatchdog?: HomeWatchdogSensor
  reminderManager?: ReminderManager
  fileConfig?: any
  publicQueryTopics?: string[]
  maxConcurrentOperatorTasks?: number
}

const APPROVE_CMD_REGEX = /^(?:同意|批准|准了|通过)(?:\s*#?([A-Z0-9]{4}))?$/i
const REJECT_CMD_REGEX = /^(?:拒绝|驳回|不行|不准)(?:\s*#?([A-Z0-9]{4}))?$/i
const MEME_REQ_PATTERNS =
  /(?:发|来|搜|找|要|发我|给我)\s*(?:一个|张|几张|个)?\s*(?:关于|带)?\s*(.+?)\s*(?:的)?\s*(?:表情包|表情|梗图|图片|图)/i

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve()
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

export class QqOrchestrator {
  private readonly deps: QqOrchestratorDeps
  private readonly publicQueryTopics: string[]
  private readonly maxConcurrentOperatorTasks: number
  private activeOperatorTasks = 0
  private lastQqInteractionAt = Date.now()
  private lastProactivePokeAt = Date.now()
  private readonly pendingAfterthoughtTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingWatchdogAction: WatchdogAlertSuggestion | null = null
  private activeNoticeChannel: { isGroup: boolean; targetId: string } | null = null

  constructor(deps: QqOrchestratorDeps) {
    this.deps = deps
    this.publicQueryTopics = deps.publicQueryTopics ?? ['okx', 'web']
    this.maxConcurrentOperatorTasks = Math.max(1, Number(deps.maxConcurrentOperatorTasks ?? 2))
  }

  /**
   * 绑定 OneBotGateway、哨兵、任务进度与计划任务监听
   */
  public bind(): void {
    const { onebotGateway, permissionGuard, homeWatchdog, taskExecutor, reminderManager } = this.deps

    onebotGateway.on('owner_updated', (newOwnerQq: string) => {
      permissionGuard.setOwnerQq(newOwnerQq)
    })

    onebotGateway.on('user_message', (msg: OneBotUserMessageEvent) => {
      this.handleUserMessage(msg).catch((err) => {
        console.error('[QqOrchestrator] 处理 user_message 未捕获异常:', err)
      })
    })

    // 1. 家用哨兵异常告警主动吹哨
    if (homeWatchdog) {
      homeWatchdog.on('alert', (alert: WatchdogAlertEvent) => {
        this.handleWatchdogAlert(alert).catch((err) => {
          console.error('[QqOrchestrator] 处理哨兵告警异常:', err)
        })
      })
    }

    // 2. 慢任务中途实况碎碎念转播
    taskExecutor.on('task_progress', ({ elapsedSec, message }: { elapsedSec: number; message: string }) => {
      if (this.activeNoticeChannel) {
        const { isGroup, targetId } = this.activeNoticeChannel
        const text = `⏳ [进度 ${elapsedSec}s] ${message}`
        if (isGroup) {
          onebotGateway.sendGroupMsg(targetId, text).catch(() => {})
        } else {
          onebotGateway.sendPrivateMsg(targetId, text).catch(() => {})
        }
      }
    })

    // 3. 自然语言定时提醒与计划任务触发
    if (reminderManager) {
      reminderManager.on('reminder_fired', (item: ScheduledReminder) => {
        this.handleReminderFired(item).catch((err) => {
          console.error('[QqOrchestrator] 处理定时任务触发异常:', err)
        })
      })
    }
  }

  /**
   * 若任务执行结果包含屏幕抓拍，单独发送一张高清 CQ 码图片
   */
  private async sendScreenshotIfPresent(
    targetId: string,
    isGroup: boolean,
    base64?: string
  ): Promise<void> {
    if (!base64) return
    await sleepMs(350)
    const cq = `[CQ:image,file=base64://${base64}]`
    if (isGroup) {
      await this.deps.onebotGateway.sendGroupMsg(targetId, cq)
    } else {
      await this.deps.onebotGateway.sendPrivateMsg(targetId, cq)
    }
  }

  /**
   * 处理哨兵异常吹哨与自愈建议
   */
  private async handleWatchdogAlert(alert: WatchdogAlertEvent): Promise<void> {
    const { onebotGateway, permissionGuard, state, memeManager } = this.deps
    const ownerQq = onebotGateway.getOwnerQq() || permissionGuard.getOwnerQq()
    if (!ownerQq || state.getMode() === 'live') return

    this.pendingWatchdogAction = alert.suggestedAction || null

    let text = `${alert.title}\n${alert.message}\n${alert.detail}`
    if (alert.suggestedAction) {
      text += `\n\n💡 自愈建议：回复【好】或【重启】让本鱼马上帮老爸【${alert.suggestedAction.label}】！`
    }

    const meme = memeManager.pickMemeForEmotion('error', 'sulking')
    const cq = meme ? memeManager.toCqCode(meme) : ''

    await onebotGateway.sendPrivateMsg(ownerQq, text)
    if (cq) {
      await sleepMs(500)
      await onebotGateway.sendPrivateMsg(ownerQq, cq)
    }
  }

  /**
   * 处理计划任务到点触发
   */
  private async handleReminderFired(item: ScheduledReminder): Promise<void> {
    const { onebotGateway, permissionGuard, taskExecutor, memeManager } = this.deps
    const ownerQq = onebotGateway.getOwnerQq() || permissionGuard.getOwnerQq()
    const targetQq = item.target_user_id === 'owner' ? ownerQq : item.target_user_id.replace(/^qq:/, '')
    if (!targetQq) return

    if (item.is_task) {
      // 任务型：自动由 TaskExecutor 执行后汇报
      const notice = `⏰ 计划任务到点啦！大肥鱼正在帮老爸执行：【${item.content}】~ 🪄`
      if (item.channel === 'group' && item.group_id) {
        await onebotGateway.sendGroupMsg(item.group_id, `[CQ:at,qq=${targetQq}] ${notice}`)
      } else {
        await onebotGateway.sendPrivateMsg(targetQq, notice)
      }

      const tIntent = taskExecutor.detectIntent(item.content, 'companion')
      const taskRes = await taskExecutor.execute(
        tIntent.isTask ? tIntent : taskExecutor.buildTaskIntent(item.content, item.content),
        'companion'
      )

      const report = `【定时任务汇报 · ${item.content}】\n${taskRes.spokenReply}\n\n${taskRes.detailReport}`
      if (item.channel === 'group' && item.group_id) {
        await onebotGateway.sendGroupMsg(item.group_id, `[CQ:at,qq=${targetQq}] ${report}`)
        await this.sendScreenshotIfPresent(item.group_id, true, taskRes.screenshotBase64)
      } else {
        await onebotGateway.sendPrivateMsg(targetQq, report)
        await this.sendScreenshotIfPresent(targetQq, false, taskRes.screenshotBase64)
      }
    } else {
      // 纯提醒型
      const lines = [
        `叮咚叮咚！⏰ 老爸设定的定时提醒来啦：`,
        `【${item.content}】`,
        `不要忘记啦！不许当拖延症患者哦~ 😤`,
      ]
      const text = lines.join('\n')
      const meme = memeManager.pickMemeForEmotion('poke', 'tsundere')
      const cq = meme ? memeManager.toCqCode(meme) : ''

      if (item.channel === 'group' && item.group_id) {
        await onebotGateway.sendGroupMsg(item.group_id, `[CQ:at,qq=${targetQq}] ${text}`)
        if (cq) {
          await sleepMs(450)
          await onebotGateway.sendGroupMsg(item.group_id, cq)
        }
      } else {
        await onebotGateway.sendPrivateMsg(targetQq, text)
        if (cq) {
          await sleepMs(450)
          await onebotGateway.sendPrivateMsg(targetQq, cq)
        }
      }
    }
  }

  /**
   * 取消指定会话尚未发出的延迟追击定时器
   */
  public cancelPendingAfterthought(sessionKey: string): void {
    const timer = this.pendingAfterthoughtTimers.get(sessionKey)
    if (timer) {
      clearTimeout(timer)
      this.pendingAfterthoughtTimers.delete(sessionKey)
    }
  }

  /**
   * 释放所有挂起定时器
   */
  public destroy(): void {
    for (const timer of this.pendingAfterthoughtTimers.values()) {
      clearTimeout(timer)
    }
    this.pendingAfterthoughtTimers.clear()
  }

  /**
   * 供主播控制台审批按钮回调使用
   */
  public readonly resolveApprovalFromConsole = async (
    req: any,
    action: 'approve' | 'reject'
  ): Promise<any> => {
    const { state, taskExecutor, outputGuard, onebotGateway } = this.deps

    if (this.deps.companionGraph) {
      const threadId =
        req.channel === 'group' && req.groupId
          ? `group:${req.groupId}`
          : `private:${req.userId || req.senderExternalId}`
      try {
        const resumeRes = await this.deps.companionGraph.resume(threadId, {
          isApproved: action === 'approve',
          approvalCode: req.code,
        })
        if (resumeRes.status === 'completed') {
          const st = resumeRes.finalState
          if (action === 'approve') {
            const finalReport = `报告！老爸已经在控制台批准你的请求啦~ ✨\n${st.spokenReply}\n\n${st.detailReport || ''}`.trim()
            if (req.channel === 'group' && req.groupId) {
              await onebotGateway.sendGroupMsg(
                req.groupId,
                `[CQ:at,qq=${req.senderExternalId}] ${finalReport}`
              )
              await this.sendScreenshotIfPresent(req.groupId, true, st.screenshotBase64)
            } else {
              await onebotGateway.sendPrivateMsg(req.senderExternalId, finalReport)
              await this.sendScreenshotIfPresent(req.senderExternalId, false, st.screenshotBase64)
            }
            return { executed: true, detailReport: st.detailReport, spokenReply: st.spokenReply }
          } else {
            const rejectNotice = st.spokenReply || '略略略，老爸说不准动他电脑！'
            if (req.channel === 'group' && req.groupId) {
              await onebotGateway.sendGroupMsg(
                req.groupId,
                `[CQ:at,qq=${req.senderExternalId}] ${rejectNotice}`
              )
            } else {
              await onebotGateway.sendPrivateMsg(req.senderExternalId, rejectNotice)
            }
            return { executed: false, rejected: true }
          }
        }
      } catch (err: any) {
        console.warn('[QqOrchestrator] 控制台恢复状态图异常，回退至传统执行:', err?.message)
      }
    }

    if (action === 'approve') {
      try {
        const taskRes = await taskExecutor.execute(req.intent, state.getMode() || 'companion')
        const cleanReply = outputGuard.sanitize(
          taskRes.spokenReply,
          taskRes.clip,
          taskRes.tone,
          { liveMode: false, targetRole: 'member', preferredTitle: req.senderName }
        ).text
        const finalReport = `报告！老爸已经在控制台批准你的请求啦~ ✨\n${cleanReply}\n\n${taskRes.detailReport}`
        if (req.channel === 'group' && req.groupId) {
          await onebotGateway.sendGroupMsg(
            req.groupId,
            `[CQ:at,qq=${req.senderExternalId}] ${finalReport}`
          )
          await this.sendScreenshotIfPresent(req.groupId, true, taskRes.screenshotBase64)
        } else {
          await onebotGateway.sendPrivateMsg(req.senderExternalId, finalReport)
          await this.sendScreenshotIfPresent(req.senderExternalId, false, taskRes.screenshotBase64)
        }
        return { executed: true, detailReport: taskRes.detailReport, spokenReply: cleanReply }
      } catch (err: any) {
        return { executed: false, error: err?.message || 'Task execution failed' }
      }
    } else {
      const rejectNotice = '略略略，老爸说不准动他电脑！'
      if (req.channel === 'group' && req.groupId) {
        await onebotGateway.sendGroupMsg(
          req.groupId,
          `[CQ:at,qq=${req.senderExternalId}] ${rejectNotice}`
        )
      } else {
        await onebotGateway.sendPrivateMsg(req.senderExternalId, rejectNotice)
      }
      return { executed: false, rejected: true }
    }
  }

  /**
   * 作息时钟触发时，结合家里 Mac 真实数据与快脑，动态生成问候气泡与独立表情包
   */
  public sendScheduleGreeting(text: string, scheduleType?: string): void {
    const run = async () => {
      const { onebotGateway, permissionGuard, state, memeManager, brain, homeWatchdog } = this.deps
      const ownerQq = onebotGateway.getOwnerQq() || permissionGuard.getOwnerQq()
      if (!ownerQq || state.getMode() !== 'companion') return

      this.lastQqInteractionAt = Date.now()
      this.lastProactivePokeAt = Date.now()

      let greetingText = text
      let memeClip = 'eat_token'

      if (scheduleType === 'morning') {
        memeClip = 'cheer'
        const snap = homeWatchdog?.getLatestSnapshot()
        if (brain && snap) {
          try {
            const prompt = `你是大肥鱼（自称本鱼，元气傲娇长鲸鱼尾巴的女儿管家）。现在是早晨，向老爸（主人）汇报早安与家里闲置Mac晨检简报。\nMac状态：电量${snap.power.summary}，磁盘可用${snap.storage.freeGb}G，Docker运行中${snap.docker.runningCount}个容器，okx-dog${snap.okxDog.reachable ? '稳定在线' : '离线'}。\n请用1~2句极口语化、不超过50字的元气话语向老爸汇报，首行带<meta clip="cheer" tone="happy"/>`
            const res = await brain.route({ eventType: 'HOST_COMMAND', prompt })
            const gen = (res.output?.text || res.output?.reply || '').replace(/<[^>]+>/g, '').trim()
            if (gen) greetingText = gen
          } catch {}
        }
      } else if (brain && (scheduleType === 'lunch' || scheduleType === 'dinner' || scheduleType === 'bedtime')) {
        memeClip = scheduleType === 'bedtime' ? 'sleep' : 'eat_token'
        try {
          const prompt = `你是大肥鱼（自称本鱼，元气傲娇女儿伴侣）。现在是${scheduleType === 'lunch' ? '午餐' : scheduleType === 'dinner' ? '晚餐' : '深夜睡觉'}时间。用1~2句口语化、不超过45字的话贴心提醒老爸${scheduleType === 'bedtime' ? '早点休息睡个好觉' : '按时吃饭不许饿肚子'}。首行带<meta clip="${memeClip}" tone="happy"/>`
          const res = await brain.route({ eventType: 'HOST_COMMAND', prompt })
          const gen = (res.output?.text || res.output?.reply || '').replace(/<[^>]+>/g, '').trim()
          if (gen) greetingText = gen
        } catch {}
      }

      const meme = memeManager.pickMemeForEmotion(memeClip, 'happy')
      const cq = meme ? memeManager.toCqCode(meme) : ''

      await onebotGateway.sendPrivateMsg(ownerQq, greetingText)
      if (cq) {
        await sleepMs(600)
        await onebotGateway.sendPrivateMsg(ownerQq, cq)
      }
    }

    run().catch(() => {})
  }

  /**
   * 周期性评估是否主动在 QQ 找老爸搭话（看家护院模式：锁屏依然正常活跃）
   */
  public trySendProactiveCompanionPoke(
    continuousWorkMin: number,
    activeApp?: { category?: string; name?: string }
  ): void {
    try {
      const { onebotGateway, permissionGuard, state, memeManager, homeWatchdog } = this.deps
      const isLive = state.getMode() === 'live'
      const ownerQq = onebotGateway.getOwnerQq() || permissionGuard.getOwnerQq()
      const now = Date.now()
      const hour = new Date().getHours()

      // 解除原有的 state.isScreenLocked() 拦截！家里闲置 Mac 锁屏是大肥鱼的主战场
      if (
        isLive ||
        !ownerQq ||
        hour < 9 ||
        hour > 23 ||
        now - this.lastProactivePokeAt < 40 * 60_000
      ) {
        return
      }

      // 场景 A：老爸有人在电脑前，且连续死磕代码满 50 分钟，主动催促休息
      if (!state.isScreenLocked() && continuousWorkMin >= 50) {
        this.lastProactivePokeAt = now
        this.lastQqInteractionAt = now
        const meme = memeManager.pickMemeForEmotion('idle_stretch', 'tsundere')
        const cq = meme ? memeManager.toCqCode(meme) : ''
        onebotGateway
          .sendPrivateMsg(ownerQq, '喂喂！老爸你已经连续盯屏幕写代码快一个小时啦！')
          .then(async () => {
            await sleepMs(550)
            await onebotGateway.sendPrivateMsg(
              ownerQq,
              '快跟本鱼一起伸个懒腰喝口水，不许当赛博铁人😤'
            )
            if (cq) {
              await sleepMs(500)
              await onebotGateway.sendPrivateMsg(ownerQq, cq)
            }
          })
          .catch(() => {})
        return
      }

      // 场景 B：老爸超过 38 分钟没在 QQ 理大肥鱼，主动找老爸搭话
      if (now - this.lastQqInteractionAt >= 38 * 60_000 && Math.random() < 0.4) {
        this.lastProactivePokeAt = now
        this.lastQqInteractionAt = now
        let line1 = '咕噜噜……老爸今天怎么这么安静呀🫧'
        let line2 = '本鱼在桌面角落吐泡泡都吐累了，快理理本鱼嘛~'
        let emoClip = 'poke'

        if (state.isScreenLocked() || !activeApp) {
          // 看家值守场景：结合后台哨兵数据进行真实汇报
          const snap = homeWatchdog?.getLatestSnapshot()
          line1 = '报告老爸！家里 Mac 正在锁屏值守中，本鱼看得妥妥当当~ 🏠'
          if (snap) {
            const dockerInfo = snap.docker.available ? `${snap.docker.runningCount}个容器运行` : '容器未起'
            const okxInfo = snap.okxDog.reachable ? 'okx-dog在跑' : 'okx-dog离线'
            line2 = `电量充足，${dockerInfo}，${okxInfo}，老爸在外面安心忙吧✨`
          } else {
            line2 = '一切指标都很健康，想查啥随时在手机 QQ 叫本鱼哦！'
          }
          emoClip = 'working'
        } else if (activeApp.category === 'code') {
          line1 = '盯——本鱼在屏幕角落看老爸敲半天代码了👀'
          line2 = '今天的代码这么难搞吗？要不要本鱼给你摇尾巴加个 Buff~'
          emoClip = 'working'
        } else if (activeApp.category === 'media' || activeApp.category === 'browser') {
          line1 = `好哇，抓包老爸在看 ${activeApp.name || '网页'} 摸鱼了！`
          line2 = '居然不带本鱼一起聊五毛钱的，快分本鱼一点小鱼干封口~'
          emoClip = 'eat_token'
        }

        const meme = memeManager.pickMemeForEmotion(emoClip, 'tsundere')
        const cq = meme ? memeManager.toCqCode(meme) : ''
        onebotGateway
          .sendPrivateMsg(ownerQq, line1)
          .then(async () => {
            await sleepMs(600)
            await onebotGateway.sendPrivateMsg(ownerQq, line2)
            if (cq) {
              await sleepMs(500)
              await onebotGateway.sendPrivateMsg(ownerQq, cq)
            }
          })
          .catch(() => {})
      }
    } catch {}
  }

  /**
   * 处理单条 QQ 私聊/群聊消息全链路
   */
  public async handleUserMessage(msg: OneBotUserMessageEvent): Promise<void> {
    const {
      state,
      onebotGateway,
      permissionGuard,
      approvalManager,
      contactImpression,
      outputGuard,
      taskExecutor,
      memeManager,
      dialoguePipeline,
      homeWatchdog,
      fileConfig,
    } = this.deps

    const isGroup = msg.source === 'qq_group'
    const groupId = isGroup ? String(msg.groupId || '') : undefined
    const userId = String(msg.userId || '').trim()

    // 硬件级身份锚定：判定发送者是否为唯一真主人
    const currentOwnerQq =
      onebotGateway.getOwnerQq() || permissionGuard.getOwnerQq() || getOwnerQq(fileConfig)
    const isOwner = permissionGuard.isOwner(userId)

    const sessionKey = isGroup
      ? `group:${groupId}`
      : isOwner
        ? 'private:host'
        : `private:${userId}`

    // 记录正在执行长任务的通知通道，便于中途实况碎碎念转播
    this.activeNoticeChannel = { isGroup, targetId: isGroup && groupId ? groupId : userId }

    // 计算距离老爸上次说话的时间差（时间体感）
    const lastInteractionGapMin = (Date.now() - this.lastQqInteractionAt) / 60000

    // 用户发来新消息时，立即取消该会话尚未发出的延迟追击，更新互动时间
    this.cancelPendingAfterthought(sessionKey)
    this.lastQqInteractionAt = Date.now()

    // 提炼或提取联系人档案 (改名不丢记忆)
    const contactProfile = contactImpression.loadOrCreateProfile({
      userId,
      nickname: msg.nickname,
      groupId,
      ownerQq: currentOwnerQq,
      isOwner,
    })

    const role = isOwner ? 'owner' : contactProfile?.role || 'member'
    const preferredTitle = isOwner
      ? '老爸'
      : contactProfile?.preferredTitle || msg.nickname || '你'

    // 1. 双通道主人审批口令极速拦截
    if (isOwner && (await this.tryHandleOwnerApprovalCommand(msg, userId))) {
      return
    }

    // 1.5 哨兵告警自愈一键口令处理 (若老爸回复“好/重启/修一下”)
    if (isOwner && this.pendingWatchdogAction) {
      const trimmed = (msg.text || '').trim()
      if (/^(?:好|重启|帮我修|处理|搞一下|执行|修复|准了|同意|可以)$/i.test(trimmed)) {
        const act = this.pendingWatchdogAction
        this.pendingWatchdogAction = null
        await msg.reply(`遵命！大肥鱼马上帮老爸执行自愈操作：【${act.label}】~ 🪄`)
        const goal = act.taskGoal || act.command || act.label
        const tIntent = taskExecutor.buildTaskIntent(goal, goal)
        try {
          const res = await taskExecutor.execute(tIntent, state.getMode() || 'companion')
          await msg.reply(`修复汇报：${res.spokenReply}\n\n${res.detailReport}`)
          await this.sendScreenshotIfPresent(userId, false, res.screenshotBase64)
        } catch (err: any) {
          await msg.reply(`唔…自愈操作失败了: ${err?.message || err}`)
        }
        return
      }
    }

    // 提取看家状况简报
    let homeGuardSummary: string | undefined
    if (isOwner && homeWatchdog) {
      const snap = homeWatchdog.getLatestSnapshot()
      if (snap) {
        const dInfo = snap.docker.available ? `Docker ${snap.docker.runningCount}容器` : 'Docker未运行'
        const okxInfo = snap.okxDog.reachable ? 'okx-dog在线' : 'okx-dog离线'
        homeGuardSummary = `电量${snap.power.summary} | 磁盘剩${snap.storage.freeGb}G | ${dInfo} | ${okxInfo}`
      }
    }

    // 2. 微内核状态图 (CompanionGraph) 全景流转
    if (this.deps.companionGraph) {
      const initialState: CompanionGraphState = {
        threadId: sessionKey,
        channel: 'qq',
        isGroup,
        groupId,
        userId,
        nickname: msg.nickname,
        rawText: msg.text,
        isOwner,
        role,
        preferredTitle,
        sessionKey,
        lastInteractionGapMin,
        homeGuardSummary,
        contactProfile,
        sanitizedText: msg.text,
        guardPassed: true,
        inferredRoute: 'chat',
        clip: 'idle',
        tone: 'normal',
        spokenReply: '',
      }

      const runRes = await this.deps.companionGraph.invoke(initialState, { threadId: sessionKey })

      if (runRes.status === 'interrupted') {
        const payload = runRes.interruptPayload as any
        const req = payload?.approvalRequest
        const code = payload?.code || req?.code || 'REQ'
        await msg.reply(`想动老爸电脑？这得老爸点头才行！本鱼去请示一下~ (单号 ${code})`)

        if (currentOwnerQq) {
          const senderDisplay = `[${preferredTitle}]`
          const srcDisplay = isGroup ? `在群[${groupId}]` : '私聊'
          const notice = `【审批请求 ${code}】群友${senderDisplay}${srcDisplay}请求执行: [${req?.intentLabel || '宿主机操作'}]。回复[同意 ${code}]放行，[拒绝 ${code}]驳回`
          await onebotGateway.sendPrivateMsg(currentOwnerQq, notice)
        }
        return
      }

      if (runRes.status === 'completed') {
        const st = runRes.finalState
        if (st.inferredRoute === 'blocked') {
          await msg.reply(st.spokenReply || st.securityReason || '请求受限，请稍候再试')
          return
        }

        if (st.chatPlan) {
          for (let i = 0; i < st.chatPlan.immediateBubbles.length; i++) {
            const b = st.chatPlan.immediateBubbles[i]
            if (b.delayMs > 0) {
              await sleepMs(b.delayMs)
            }
            await msg.reply(b.content, i === 0 ? st.clip : undefined, { skipAt: b.skipAt })
          }

          if (st.chatPlan.afterthought) {
            this.cancelPendingAfterthought(sessionKey)
            const followUp = st.chatPlan.afterthought
            const timer = setTimeout(async () => {
              this.pendingAfterthoughtTimers.delete(sessionKey)
              try {
                for (const b of followUp.bubbles) {
                  if (b.delayMs > 0) {
                    await sleepMs(b.delayMs)
                  }
                  await msg.reply(b.content, undefined, { skipAt: true })
                }
              } catch {}
            }, followUp.delayMs)
            timer.unref?.()
            this.pendingAfterthoughtTimers.set(sessionKey, timer)
          }
        } else if (st.spokenReply) {
          await msg.reply(st.spokenReply, st.clip)
        }

        if (st.detailReport) {
          await sleepMs(450)
          await msg.reply(st.detailReport, undefined, { skipAt: true })
        }

        await this.sendScreenshotIfPresent(
          isGroup && groupId ? groupId : userId,
          isGroup,
          st.screenshotBase64
        )
        return
      }

      if (runRes.status === 'error') {
        console.error('[QqOrchestrator] companionGraph 运行异常:', runRes.error)
        await msg.reply('呜…本鱼脑袋里的一根状态电路短路了，请稍候再试~')
        return
      }
    }

    // 2. 全局第一道防线：意图识别与风控决策矩阵（前置拦截所有 L2 越狱/密钥刺探/破坏指令）
    const taskIntent = taskExecutor.detectIntent(msg.text, state.getMode(), false, isOwner)
    const check = permissionGuard.evaluate(userId, msg.text, taskIntent)

    if (!check.allowed && check.level === 'L2') {
      await msg.reply(check.reason)
      return
    }

    if (taskIntent.isTask) {
      // 🟡 L1 受控危险级：非主人尝试宿主机操作
      if (!check.allowed && check.level === 'L1') {
        const createRes = approvalManager.createRequest({
          userId,
          nickname: preferredTitle,
          channel: isGroup ? 'group' : 'private',
          groupId,
          intent: taskIntent,
          intentLabel: approvalManager.humanReadableLabel(taskIntent),
          rawText: msg.text,
        })

        if (!createRes.success) {
          await msg.reply(createRes.error || (createRes as any).reason || '请求受限，请稍候再试')
          return
        }

        const req = createRes.request || (createRes as any)
        await msg.reply(`想动老爸电脑？这得老爸点头才行！本鱼去请示一下~ (单号 ${req.code})`)

        if (currentOwnerQq) {
          const senderDisplay = `[${preferredTitle}]`
          const srcDisplay = isGroup ? `在群[${groupId}]` : '私聊'
          const notice = `【审批请求 ${req.code}】群友${senderDisplay}${srcDisplay}请求执行: [${req.intentLabel}]。回复[同意 ${req.code}]放行，[拒绝 ${req.code}]驳回`
          await onebotGateway.sendPrivateMsg(currentOwnerQq, notice)
        }
        return
      }

      // 🟢 L0 开放安全级任务 (如 search:web 或主人的安全 macos 指令)
      if (check.allowed && check.level === 'L0') {
        const taskRes = await taskExecutor.execute(taskIntent, state.getMode() || 'companion')
        const cleanReply = outputGuard.sanitize(
          taskRes.spokenReply,
          taskRes.clip,
          taskRes.tone,
          { liveMode: false, targetRole: role, preferredTitle }
        ).text
        await msg.reply(cleanReply, taskRes.clip)
        if (taskRes.detailReport) {
          await sleepMs(450)
          await msg.reply(taskRes.detailReport, undefined, { skipAt: true })
        }
        await this.sendScreenshotIfPresent(isGroup && groupId ? groupId : userId, isGroup, taskRes.screenshotBase64)
        return
      }
    }

    // 2.6 专门索要/搜索表情包快捷处理（图文分开发送）
    const memeMatch = msg.text.match(MEME_REQ_PATTERNS)
    if (memeMatch) {
      const kw = memeMatch[1].trim()
      if (kw && !/(电脑|文件|代码|脚本|配置)/.test(kw)) {
        let matchedMeme = null
        if (/(自己|大肥鱼|女仆|尾巴|摸头|傲娇|干饭|吃小鱼干|困|睡觉|工作)/.test(kw)) {
          matchedMeme = memeManager.pickMemeForEmotion(
            kw.includes('摸头')
              ? 'head_pat'
              : kw.includes('吃')
                ? 'eat_token'
                : kw.includes('傲娇')
                  ? 'poke'
                  : 'idle',
            'happy'
          )
        }
        if (!matchedMeme) {
          matchedMeme = await memeManager.searchAndCollectMeme(kw)
        }

        if (matchedMeme) {
          const cq = memeManager.toCqCode(matchedMeme)
          const introLines = [
            `哼，看本鱼给你翻翻私藏的「${kw}」表情包~`,
            `来啦！接好本鱼精选的「${kw}」神图！`,
            `诶嘿，这张「${kw}」表情包超传神的，拿去用吧~`,
          ]
          const intro = introLines[Math.floor(Math.random() * introLines.length)]
          await msg.reply(intro)
          if (cq) {
            await sleepMs(450)
            await msg.reply(cq, undefined, { skipAt: true })
          }
          return
        }
      }
    }

    // 2.7 只读连接器快捷查询 (okx / web / docker)
    const quickTopic = resolveQueryTopic(undefined, msg.text)
    if (quickTopic === 'okx' || quickTopic === 'web' || (quickTopic === 'docker' && isOwner)) {
      const canExecute = isOwner || this.publicQueryTopics.includes(quickTopic)
      if (canExecute) {
        const queryRes = await taskExecutor.executeQuery({
          topic: quickTopic,
          question: msg.text,
          preferredTitle,
        })
        const cleanReply = outputGuard.sanitize(
          queryRes.spokenReply,
          queryRes.clip,
          queryRes.tone,
          { liveMode: false, targetRole: role, preferredTitle }
        ).text
        await msg.reply(cleanReply, queryRes.clip)
        if (queryRes.detailReport) {
          await sleepMs(450)
          await msg.reply(queryRes.detailReport, undefined, { skipAt: true })
        }
        return
      }
    }

    // 3. 纯观赏动作频控检测 (例如 "跳个舞" 30s 冷却)
    if (permissionGuard.isPetViewAction(msg.text)) {
      const petCheck = permissionGuard.checkPetActionCooldown()
      if (!petCheck.allowed) {
        await msg.reply(petCheck.reason!)
        return
      }
    }

    // 4. 进入核心对话管线并按拟人化多气泡序列回复
    const evt: EnrichedDialogueEvent = {
      id: `qq-${Date.now()}`,
      ts: Date.now(),
      priority: 'P0',
      kind: isOwner ? 'HOST_TALK' : 'DANMAKU',
      actor: { uid: `qq:${userId}`, nickname: msg.nickname },
      text: msg.text,
      forceWorkMode: false,
      isOwner,
      targetRole: role,
      preferredTitle,
      sessionKey,
      groupId,
      isGroup,
      contactProfile,
      lastInteractionGapMin,
      homeGuardSummary,
    }

    await dialoguePipeline.handleEvent(evt, async (res: any) => {
      try {
        const rawReply = res?.text || '好嘞，大肥鱼收到啦！'
        const cleanReply = rawReply
          .replace(/<meta[^>]*>/gi, '')
          .replace(/<\/meta>/gi, '')
          .replace(/<mem[^>]*>.*?<\/mem>/gi, '')
          .trim()
        const finalReply =
          cleanReply ||
          (res?.clip === 'dance' ? '看本鱼给你跳个开心的摇摆舞！💃' : '收到！大肥鱼随时待命哦~ 🐟')

        const parsedMeta = res?.parsedMeta
        const moodDelta = parsedMeta?.moodIntent ?? 0
        const inferredIntent = parsedMeta?.intent
        const inferredTopic = parsedMeta?.topic
        const inferredTask = parsedMeta?.task || msg.text

        // 拟人化气泡编排：图文物理分离、长句拆分为短气泡连发、规划延迟追击
        const chatPlan = memeManager.planQqChatSequence({
          text: finalReply,
          clip: res?.clip || parsedMeta?.clip,
          tone: res?.tone || parsedMeta?.tone,
          moodDelta,
          fed: Boolean(parsedMeta?.fed),
          userText: msg.text,
          isOwner,
          isGroup,
          preferredTitle,
          stats: state.getStats(),
          activeAppCategory: state.getActiveApp()?.category,
        })

        for (let i = 0; i < chatPlan.immediateBubbles.length; i++) {
          const b = chatPlan.immediateBubbles[i]
          if (b.delayMs > 0) {
            await sleepMs(b.delayMs)
          }
          await msg.reply(b.content, i === 0 ? res?.clip : undefined, { skipAt: b.skipAt })
        }

        // 若为日常闲聊且存在意犹未尽的追击气泡 (afterthought)，3~5 秒后若对方未发新消息则主动补刀
        if ((!inferredIntent || inferredIntent === 'chat') && chatPlan.afterthought) {
          this.cancelPendingAfterthought(sessionKey)
          const followUp = chatPlan.afterthought
          const timer = setTimeout(async () => {
            this.pendingAfterthoughtTimers.delete(sessionKey)
            try {
              for (const b of followUp.bubbles) {
                if (b.delayMs > 0) {
                  await sleepMs(b.delayMs)
                }
                await msg.reply(b.content, undefined, { skipAt: true })
              }
            } catch {}
          }, followUp.delayMs)
          timer.unref?.()
          this.pendingAfterthoughtTimers.set(sessionKey, timer)
        }

        // 5. 衔接闲聊大脑顺带判定出的 query / task 意图
        await this.dispatchInferredFollowUp({
          inferredIntent,
          inferredTopic,
          inferredTask,
          msg,
          userId,
          isOwner,
          isGroup,
          groupId,
          role,
          preferredTitle,
        })
      } catch (replyErr) {
        console.error('[QqOrchestrator] 发送消息回复异常:', replyErr)
      }
    })
  }

  /**
   * 处理主人在 QQ 发送的同意/拒绝审批口令
   */
  private async tryHandleOwnerApprovalCommand(
    msg: OneBotUserMessageEvent,
    userId: string
  ): Promise<boolean> {
    const { approvalManager, taskExecutor, state, outputGuard, onebotGateway } = this.deps
    const trimmedText = (msg.text || '').trim()

    const approveMatch = trimmedText.match(APPROVE_CMD_REGEX)
    if (approveMatch) {
      let code = approveMatch[1] ? `#${approveMatch[1].toUpperCase()}` : ''
      if (!code) {
        const latest = approvalManager.getLatestPending()
        if (latest) code = latest.code
      }
      if (!code) {
        await msg.reply('报告老爸，当前没有等待审批的请求哦~ 🐟')
        return true
      }

      const resolveRes = await approvalManager.approve(code, `owner:${userId}`)
      if (!resolveRes.success || !resolveRes.request) {
        await msg.reply(resolveRes.message || `单号 ${code} 不存在或已失效`)
        return true
      }

      const req = resolveRes.request

      if (this.deps.companionGraph) {
        const threadId =
          req.channel === 'group' && req.groupId
            ? `group:${req.groupId}`
            : `private:${req.userId || req.senderExternalId}`
        try {
          const resumeRes = await this.deps.companionGraph.resume(threadId, {
            isApproved: true,
            approvalCode: code,
          })
          if (resumeRes.status === 'completed') {
            const st = resumeRes.finalState
            const finalReport = `报告！老爸已经批准你的请求啦~ ✨\n${st.spokenReply}\n\n${st.detailReport || ''}`.trim()
            if (req.channel === 'group' && req.groupId) {
              await onebotGateway.sendGroupMsg(
                req.groupId,
                `[CQ:at,qq=${req.senderExternalId}] ${finalReport}`
              )
              await this.sendScreenshotIfPresent(req.groupId, true, st.screenshotBase64)
            } else {
              await onebotGateway.sendPrivateMsg(req.senderExternalId, finalReport)
              await this.sendScreenshotIfPresent(req.senderExternalId, false, st.screenshotBase64)
            }
            await msg.reply(`已遵命执行 ${code}，结果已回传原群~`)
            return true
          }
        } catch (resumeErr: any) {
          console.warn('[QqOrchestrator] companionGraph.resume 恢复异常，降级至传统执行:', resumeErr?.message)
        }
      }

      try {
        const taskRes = await taskExecutor.execute(req.intent, state.getMode() || 'companion')
        const cleanReply = outputGuard.sanitize(
          taskRes.spokenReply,
          taskRes.clip,
          taskRes.tone,
          { liveMode: false, targetRole: 'member', preferredTitle: req.senderName }
        ).text
        const finalReport = `报告！老爸已经批准你的请求啦~ ✨\n${cleanReply}\n\n${taskRes.detailReport}`

        if (req.channel === 'group' && req.groupId) {
          await onebotGateway.sendGroupMsg(
            req.groupId,
            `[CQ:at,qq=${req.senderExternalId}] ${finalReport}`
          )
          await this.sendScreenshotIfPresent(req.groupId, true, taskRes.screenshotBase64)
        } else {
          await onebotGateway.sendPrivateMsg(req.senderExternalId, finalReport)
          await this.sendScreenshotIfPresent(req.senderExternalId, false, taskRes.screenshotBase64)
        }
        await msg.reply(`已遵命执行 ${code}，结果已回传原群~`)
      } catch (execErr: any) {
        console.error('[QqOrchestrator] 执行批准任务异常:', execErr)
        await msg.reply(`执行 ${code} 时发生异常: ${execErr.message}`)
      }
      return true
    }

    const rejectMatch = trimmedText.match(REJECT_CMD_REGEX)
    if (rejectMatch) {
      let code = rejectMatch[1] ? `#${rejectMatch[1].toUpperCase()}` : ''
      if (!code) {
        const latest = approvalManager.getLatestPending()
        if (latest) code = latest.code
      }
      if (!code) {
        await msg.reply('报告老爸，当前没有等待审批的请求哦~ 🐟')
        return true
      }

      const resolveRes = await approvalManager.reject(code, `owner:${userId}`)
      if (!resolveRes.success || !resolveRes.request) {
        await msg.reply(resolveRes.message || `单号 ${code} 不存在或已失效`)
        return true
      }

      const req = resolveRes.request

      if (this.deps.companionGraph) {
        const threadId =
          req.channel === 'group' && req.groupId
            ? `group:${req.groupId}`
            : `private:${req.userId || req.senderExternalId}`
        try {
          await this.deps.companionGraph.resume(threadId, {
            isApproved: false,
            approvalCode: code,
          })
        } catch (resumeErr: any) {
          console.warn('[QqOrchestrator] companionGraph.resume 驳回异常:', resumeErr?.message)
        }
      }

      const rejectNotice = '略略略，老爸说不准动他电脑！'
      if (req.channel === 'group' && req.groupId) {
        await onebotGateway.sendGroupMsg(
          req.groupId,
          `[CQ:at,qq=${req.senderExternalId}] ${rejectNotice}`
        )
      } else {
        await onebotGateway.sendPrivateMsg(req.senderExternalId, rejectNotice)
      }
      await msg.reply(`已驳回请求 ${code}，已通知对方~`)
      return true
    }

    return false
  }

  /**
   * 衔接闲聊大脑推断出的 query / task 后续任务
   */
  private async dispatchInferredFollowUp(params: {
    inferredIntent?: string
    inferredTopic?: string
    inferredTask: string
    msg: OneBotUserMessageEvent
    userId: string
    isOwner: boolean
    isGroup: boolean
    groupId?: string
    role: 'owner' | 'member' | 'trusted' | string
    preferredTitle: string
  }): Promise<void> {
    const {
      inferredIntent,
      inferredTopic,
      inferredTask,
      msg,
      userId,
      isOwner,
      isGroup,
      groupId,
      role,
      preferredTitle,
    } = params
    const { taskExecutor, outputGuard, approvalManager, onebotGateway } = this.deps

    if (inferredIntent === 'query') {
      const topic = resolveQueryTopic(inferredTopic, inferredTask, msg.text)
      const canQuery = isOwner || this.publicQueryTopics.includes(topic)
      if (canQuery) {
        const queryRes = await taskExecutor.executeQuery({
          topic,
          question: msg.text,
          goal: inferredTask,
          preferredTitle,
        })
        const extraClean = outputGuard.sanitize(
          queryRes.spokenReply,
          queryRes.clip,
          queryRes.tone,
          { liveMode: false, targetRole: role as any, preferredTitle }
        ).text
        await msg.reply(extraClean, queryRes.clip, { skipAt: true })
        if (queryRes.detailReport) {
          await sleepMs(450)
          await msg.reply(queryRes.detailReport, undefined, { skipAt: true })
        }
      }
      return
    }

    if (inferredIntent === 'task' && isOwner) {
      if (isRiskyTask(inferredTask, msg.text)) {
        const tIntent = taskExecutor.buildTaskIntent(inferredTask, msg.text)
        const createRes = approvalManager.createRequest({
          userId,
          nickname: preferredTitle,
          channel: isGroup ? 'group' : 'private',
          groupId,
          intent: tIntent,
          intentLabel: approvalManager.humanReadableLabel(tIntent),
          rawText: msg.text,
        })
        if (createRes.success && createRes.request) {
          await msg.reply(
            `⚠️ 这项操作可能影响电脑文件或状态，老爸确认要执行吗？\n回复【同意 ${createRes.request.code}】本鱼马上开工，回复【拒绝】取消~`
          )
        }
      } else {
        if (this.activeOperatorTasks >= this.maxConcurrentOperatorTasks) {
          await msg.reply('呼——本鱼手头正在忙别的活呢，老爸等我片刻再派任务嘛~')
        } else {
          this.activeOperatorTasks++
          const tIntent = taskExecutor.buildTaskIntent(inferredTask, msg.text)
          taskExecutor
            .execute(tIntent, 'companion')
            .then(async (tRes) => {
              try {
                const clean = outputGuard.sanitize(tRes.spokenReply, tRes.clip, tRes.tone, {
                  liveMode: false,
                  targetRole: 'owner',
                  preferredTitle,
                }).text
                const report = tRes.success
                  ? `${clean}\n\n${tRes.detailReport}`
                  : `${clean}\n\n【失败详情】\n${tRes.detailReport}`
                if (isGroup && groupId) {
                  await onebotGateway.sendGroupMsg(groupId, `[CQ:at,qq=${userId}] ${report}`)
                  await this.sendScreenshotIfPresent(groupId, true, tRes.screenshotBase64)
                } else {
                  await onebotGateway.sendPrivateMsg(userId, report)
                  await this.sendScreenshotIfPresent(userId, false, tRes.screenshotBase64)
                }
              } catch (err) {
                console.error('[QqOrchestrator] 异步任务回执推送失败:', err)
              } finally {
                this.activeOperatorTasks--
              }
            })
            .catch((err) => {
              this.activeOperatorTasks--
              console.error('[QqOrchestrator] 后台任务执行异常:', err)
            })
        }
      }
    }
  }
}
