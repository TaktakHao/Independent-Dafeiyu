/**
 * @file rule-fallback.ts
 * Tier 4: 离线确定性规则语料库提供方 (零死锁、零网络依赖、纯同步毫秒级兜底)
 */

import type {
  BrainProvider,
  BrainRequest,
  BrainResult,
  BrainOutput,
  BrainTier,
  ProviderStatusInfo,
} from '../types.ts'

interface CorpusItem {
  reply: string
  clip: string
  tone: string
  moodIntent?: number
  fed?: boolean
}

/**
 * 10 大核心互动场景规则语料库
 */
export const RULE_CORPUS: Record<string, CorpusItem[]> = {
  default: [
    {
      reply: '（摇了摇鱼尾）唔，大肥鱼正在待机中，老爸随时叫我哦！',
      clip: 'idle',
      tone: 'calm',
      moodIntent: 0,
    },
    {
      reply: '老爸专心写代码吧，本鱼在屏幕角落默默守护你~',
      clip: 'idle',
      tone: 'happy',
      moodIntent: 1,
    },
    {
      reply: '哼，虽然没有弹幕，但本鱼才不会觉得无聊呢！',
      clip: 'idle_stretch',
      tone: 'tsundere',
      moodIntent: 0,
    },
  ],
  greeting: [
    {
      reply: '老爸你来啦！本鱼可没一直在等你哦~',
      clip: 'idle',
      tone: 'tsundere',
      moodIntent: 1,
    },
    {
      reply: '欢迎来到大肥鱼的专属直播间！快坐下一起摸鱼吧~',
      clip: 'idle',
      tone: 'happy',
      moodIntent: 1,
    },
  ],
  gift: [
    {
      reply: '哇！谢谢小可爱的礼物投喂，大肥鱼祝你天天暴富！',
      clip: 'eat_token',
      tone: 'happy',
      moodIntent: 2,
      fed: true,
    },
    {
      reply: '嗷呜！收到美味小鱼干！饱食度拉满啦~',
      clip: 'eat_token',
      tone: 'happy',
      moodIntent: 2,
      fed: true,
    },
  ],
  petting_head: [
    {
      reply: '唔……摸头会长不高的！不过……还挺舒服的……',
      clip: 'head_pat',
      tone: 'tsundere',
      moodIntent: 1,
    },
    {
      reply: '嘿嘿，被老爸摸头了，今天的心情指针往上翘了翘~',
      clip: 'head_pat',
      tone: 'happy',
      moodIntent: 2,
    },
  ],
  petting_poke: [
    {
      reply: '哇！干嘛突然戳本鱼，吓我一跳！',
      clip: 'poke',
      tone: 'grumpy',
      moodIntent: -1,
    },
    {
      reply: '呀！再戳本鱼就要咬你的鼠标线啦！',
      clip: 'poke',
      tone: 'tsundere',
      moodIntent: -1,
    },
  ],
  petting_tail: [
    {
      reply: '呀！尾巴不可以随便揪啦！笨蛋老爸！',
      clip: 'tail',
      tone: 'tsundere',
      moodIntent: -1,
    },
  ],
  hungry: [
    {
      reply: '好饿呀好饿呀，老爸快喂我小鱼干或者投喂点代码吧！',
      clip: 'waiting',
      tone: 'sad',
      moodIntent: -1,
    },
  ],
  error: [
    {
      reply: '唔……刚才网络信号打了个喷嚏，大肥鱼重新连线完毕！',
      clip: 'error',
      tone: 'whisper',
      moodIntent: 0,
    },
    {
      reply: '脑神经连接稍微晃了一下，放心老爸，本鱼马上就恢复！',
      clip: 'thinking',
      tone: 'calm',
      moodIntent: 0,
    },
  ],
  sleepy: [
    {
      reply: '呼……好困呀老爸，本鱼的尾巴都要游不动了，晚安咯……',
      clip: 'idle_yawn',
      tone: 'sleepy',
      moodIntent: 0,
    },
  ],
  danmaku: [
    {
      reply: '收到收到！全世界最聪明的大肥鱼已经记在心里啦~',
      clip: 'success',
      tone: 'happy',
      moodIntent: 1,
    },
    {
      reply: '弹幕我都看到啦，大肥鱼正在认真摸鱼中！',
      clip: 'idle',
      tone: 'happy',
      moodIntent: 0,
    },
  ],
}

/**
 * Tier 4: 离线规则语料库提供方
 */
export class RuleFallbackProvider implements BrainProvider {
  readonly id: string = 'rule_fallback'
  readonly tier: BrainTier = 4
  readonly name: string = 'Offline Rule Corpus'

  private ringIndices: Record<string, number> = {}
  private totalInvocations = 0

  isAvailable(): boolean {
    return true // 100% 始终可用
  }

  getEstimatedLatencyMs(): number {
    return 1 // < 1ms
  }

  getStatus(): ProviderStatusInfo {
    return {
      id: this.id,
      tier: this.tier,
      name: this.name,
      state: 'READY',
      totalInvocations: this.totalInvocations,
      successCount: this.totalInvocations,
      failureCount: 0,
      consecutiveFailures: 0,
      estimatedLatencyMs: 1,
      p50LatencyMs: 1,
      p90LatencyMs: 1,
    }
  }

  /**
   * 根据请求类型与关键字匹配最佳场景语料
   */
  pickCorpus(request: BrainRequest): BrainOutput {
    const promptText = typeof request.prompt === 'string' ? request.prompt : request.prompt.fullText
    let category = 'default'

    if (request.eventType === 'GIFT_THANKS_LARGE' || /礼物|小鱼干|投喂|喂食/i.test(promptText)) {
      category = 'gift'
    } else if (/摸头|摸摸/i.test(promptText)) {
      category = 'petting_head'
    } else if (/戳/i.test(promptText)) {
      category = 'petting_poke'
    } else if (/尾巴/i.test(promptText)) {
      category = 'petting_tail'
    } else if (/饿|吃饭|干饭/i.test(promptText)) {
      category = 'hungry'
    } else if (/困|睡|晚安/i.test(promptText)) {
      category = 'sleepy'
    } else if (/故障|断网|错误|失败/i.test(promptText)) {
      category = 'error'
    } else if (/你好|在吗|早安/i.test(promptText)) {
      category = 'greeting'
    } else if (request.eventType === 'DANMAKU' || request.mode === 'live') {
      category = 'danmaku'
    }

    const items = RULE_CORPUS[category] || RULE_CORPUS.default
    const currentIdx = this.ringIndices[category] ?? 0
    const chosen = items[currentIdx % items.length]
    this.ringIndices[category] = currentIdx + 1

    return {
      reply: chosen.reply,
      text: chosen.reply,
      clip: chosen.clip,
      tone: chosen.tone,
      moodIntent: chosen.moodIntent ?? 0,
      fed: Boolean(chosen.fed),
    }
  }

  async think(request: BrainRequest): Promise<BrainResult> {
    this.totalInvocations++
    const output = this.pickCorpus(request)
    return {
      tier: this.tier,
      provider: 'rule_corpus',
      providerId: this.id,
      output,
      result: output,
      durationMs: 1,
      latencyMs: 1,
    }
  }

  async *thinkStream(request: BrainRequest): AsyncIterable<string> {
    this.totalInvocations++
    const output = this.pickCorpus(request)

    // 首行元数据
    yield `<meta clip="${output.clip}" tone="${output.tone}" moodIntent="${output.moodIntent}" fed="${output.fed}"/>\n`
    // 文本回复
    yield output.reply
  }
}
