/**
 * @file llm-mock.js
 * 模拟 Tier 2 DeepSeek API (SSE 流式输出与日限额)、Tier 3 本地模型、Tier 4 规则语料与多级路由器
 */

import { EventEmitter } from 'node:events'

export class MockLlmRouter extends EventEmitter {
  constructor(options = {}) {
    super()
    this.cliPool = options.cliPool || null
    this.deepSeekDailyBudget = options.deepSeekDailyBudget ?? 5.0 // 默认 5 元限额
    this.deepSeekAccumulatedCost = 0.0
    this.deepSeekAvailable = true
    this.localLlmAvailable = true
    this.ruleCorpus = {
      default: '（摇了摇鱼尾）唔，大肥鱼正在待机中，老爸随时叫我哦！',
      hungry: '好饿呀好饿呀，老爸快喂我小鱼干或者投喂点代码吧！',
      gift: '哇！谢谢小可爱的礼物投喂，大肥鱼祝你天天暴富！',
      welcome: '欢迎来到直播间！快坐下看我和老爸摸鱼吧~',
      thinking_filler: ['让我想想呢…', '唔，这个嘛…', '稍微等我一下下哦~'],
    }
  }

  setDeepSeekAvailable(available) {
    this.deepSeekAvailable = available
  }

  setLocalLlmAvailable(available) {
    this.localLlmAvailable = available
  }

  addDeepSeekCost(cost) {
    this.deepSeekAccumulatedCost += cost
  }

  /**
   * 模拟 SSE 流式返回
   * 先返回 `<meta .../>`，再按标点切分台词推送
   */
  async *streamDeepSeek(prompt, options = {}) {
    if (!this.deepSeekAvailable) {
      throw new Error('DeepSeek API service unavailable')
    }
    if (this.deepSeekAccumulatedCost >= this.deepSeekDailyBudget) {
      throw new Error(`DeepSeek daily budget exceeded: ¥${this.deepSeekAccumulatedCost.toFixed(2)} >= ¥${this.deepSeekDailyBudget}`)
    }

    // 记录费用 (假定单次调用消耗 0.005 元)
    this.deepSeekAccumulatedCost += 0.005

    // 首行元数据
    yield '<meta clip="talking_happy" tone="happy" moodIntent="1" memory="今天也是元气满满的一天"/>\n'

    // 流式台词片段 (模拟按标点断句)
    const sentences = [
      '老爸老爸，',
      '你终于想起我啦！',
      '今天的工作顺利吗~',
    ]

    for (const s of sentences) {
      if (options.delayMs) {
        await new Promise((r) => setTimeout(r, options.delayMs))
      }
      yield s
    }
  }

  /**
   * 多级思考路由仲裁：Tier 1 -> Tier 2 -> Tier 3 -> Tier 4
   */
  async route(prompt, context = {}) {
    const startTime = Date.now()
    const latencyBudgetMs = context.latencyBudgetMs || 4000

    // 1. 尝试 Tier 1 CLI
    if (this.cliPool) {
      if (this.cliPool.isAvailable()) {
        try {
          const cliResult = await this.cliPool.execute(prompt, '/tmp/sandbox')
          return {
            tier: 1,
            provider: 'agent_cli',
            result: cliResult,
            durationMs: Date.now() - startTime,
          }
        } catch (err) {
          // CLI 失败，退避降级至 Tier 2
          this.emit('fallback', { fromTier: 1, toTier: 2, reason: err.message })
        }
      } else {
        this.emit('fallback', { fromTier: 1, toTier: 2, reason: 'CLI quota exhausted or circuit tripped' })
      }
    }

    // 2. 尝试 Tier 2 DeepSeek API
    if (this.deepSeekAvailable && this.deepSeekAccumulatedCost < this.deepSeekDailyBudget) {
      try {
        let meta = null
        let text = ''
        for await (const chunk of this.streamDeepSeek(prompt)) {
          if (chunk.startsWith('<meta')) {
            meta = chunk.trim()
          } else {
            text += chunk
          }
        }
        return {
          tier: 2,
          provider: 'deepseek_sse',
          result: { meta, text, tone: 'happy' },
          durationMs: Date.now() - startTime,
        }
      } catch (err) {
        this.emit('fallback', { fromTier: 2, toTier: 3, reason: err.message })
      }
    }

    // 3. 尝试 Tier 3 本地小模型
    if (this.localLlmAvailable) {
      return {
        tier: 3,
        provider: 'local_ollama',
        result: {
          clip: 'talking_normal',
          text: '（本地模型思考中）收到老爸指令，离线任务已处理完毕！',
          tone: 'neutral',
        },
        durationMs: Date.now() - startTime,
      }
    }

    // 4. Tier 4 离线确定性规则语料兜底
    return {
      tier: 4,
      provider: 'rule_corpus',
      result: {
        clip: 'idle',
        text: this.ruleCorpus.default,
        tone: 'calm',
      },
      durationMs: Date.now() - startTime,
    }
  }
}
