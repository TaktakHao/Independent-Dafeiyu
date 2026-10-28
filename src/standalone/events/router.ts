/**
 * @file router.ts
 * 事件路由器：0-Token 模板快速短路、快捷动作直发与 LLM 智能思考分流
 */

import type { StandardEvent } from './types.ts'

export interface RouteResolution {
  action: 'TEMPLATE' | 'QUICK_TOUCH' | 'LLM_THINK' | 'DROP'
  clip?: string
  text?: string
  tone?: string
  moodDelta?: number
  reason?: string
}

export class EventRouter {
  private templates: any

  constructor(templatesConfig: any = {}) {
    this.templates = templatesConfig
  }

  /**
   * 路由决策
   */
  route(event: StandardEvent): RouteResolution {
    const text = (event.text || '').trim()

    // 1. 快捷动作直发检测（摸摸头、戳一戳、揪尾巴、投喂）
    if (text.includes('摸头') || text.includes('摸摸头') || text.includes('顺毛')) {
      const t = this.templates.quick_touch?.head_pat ?? {
        clip: 'head_pat',
        text: '嘿嘿…发型都要被你摸乱啦~',
        tone: 'happy',
        moodDelta: 5,
      }
      return { action: 'QUICK_TOUCH', ...t }
    }

    if (text.includes('戳一戳') || text.includes('戳肚子') || text.includes('戳')) {
      const t = this.templates.quick_touch?.poke ?? {
        clip: 'poke',
        text: '呀！谁戳我肚子！再戳本鱼可咬人啦！',
        tone: 'tsundere',
        moodDelta: -2,
      }
      return { action: 'QUICK_TOUCH', ...t }
    }

    if (text.includes('揪尾巴') || text.includes('摸尾巴') || text.includes('尾巴')) {
      const t = this.templates.quick_touch?.tail ?? {
        clip: 'tail',
        text: '尾巴是敏感部位，不能随便碰的！哼！',
        tone: 'tsundere',
        moodDelta: -3,
      }
      return { action: 'QUICK_TOUCH', ...t }
    }

    if (text.includes('投喂') || text.includes('小鱼干') || text.includes('喂食')) {
      const t = this.templates.quick_touch?.feed ?? {
        clip: 'eat_token',
        text: '嗷呜嗷呜~ 小鱼干收到！大肥鱼饱食度大增！',
        tone: 'happy',
        moodDelta: 8,
      }
      return { action: 'QUICK_TOUCH', ...t }
    }

    // 2. 点赞事件 0-Token 模板直发
    if (event.kind === 'LIKE') {
      const list = this.templates.like || ['谢谢点赞~']
      const pick = list[Math.floor(Math.random() * list.length)].replace(
        '{{viewer}}',
        event.actor?.nickname || '好心观众'
      )
      return { action: 'TEMPLATE', clip: 'success', text: pick, tone: 'happy', moodDelta: 1 }
    }

    // 3. 进房事件 0-Token 模板直发
    if (event.kind === 'ENTER') {
      const list = this.templates.enter || ['欢迎来到直播间~']
      const pick = list[Math.floor(Math.random() * list.length)].replace(
        '{{viewer}}',
        event.actor?.nickname || '新朋友'
      )
      return { action: 'TEMPLATE', clip: 'idle', text: pick, tone: 'happy', moodDelta: 1 }
    }

    // 4. 普通小礼物 0-Token 模板直发
    if (event.kind === 'GIFT' && !event.gift?.isBig) {
      const list = this.templates.gift_small || ['谢谢投喂小礼物~']
      const pick = list[Math.floor(Math.random() * list.length)]
        .replace('{{viewer}}', event.actor?.nickname || '好心观众')
        .replace('{{giftName}}', event.gift?.name || '礼物')
      return { action: 'TEMPLATE', clip: 'eat_token', text: pick, tone: 'happy', moodDelta: 6 }
    }

    // 5. 大额礼物或有深度内容的弹幕，走大模型脑路由进行深度思考
    if (event.kind === 'GIFT' && event.gift?.isBig) {
      return { action: 'LLM_THINK', reason: 'BIG_GIFT' }
    }
    if (event.kind === 'DANMAKU' && text.length > 0) {
      return { action: 'LLM_THINK', reason: 'DANMAKU_CHAT' }
    }
    if (event.kind === 'HOST_TALK' || event.kind === 'PROACTIVE') {
      return { action: 'LLM_THINK', reason: 'HOST_OR_PROACTIVE' }
    }

    return { action: 'DROP', reason: 'UNMATCHED_EVENT' }
  }
}
