/**
 * @file r2-brain-streaming.test.js
 * Tier 1: R2 Tiered Brain Router, Agent CLI Adapter & Streaming Pipeline 核心特性测试
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentCliSandboxMock,
  MockLlmRouter,
  validatePrompt3Layer,
  parseStreamingMeta,
} from '../harness/index.js'

describe('Tier 1: R2 Tiered Brain Router & Streaming Pipeline', () => {
  it('TC-R2-01: 多级思考路由按优先级顺序仲裁 (Tier 1 优先执行)', async () => {
    const cliPool = new AgentCliSandboxMock({ name: 'agy' })
    const router = new MockLlmRouter({ cliPool })

    const decision = await router.route('老爸对女儿说：今晚吃小鱼干吗？')
    assert.equal(decision.tier, 1)
    assert.equal(decision.provider, 'agent_cli')
    assert.equal(decision.result.tone, 'happy')
  })

  it('TC-R2-02: CLI 额度耗尽自动识别并无缝降级至 Tier 2 DeepSeek', async () => {
    const cliPool = new AgentCliSandboxMock({ name: 'agy' })
    cliPool.setQuotaExhausted(true) // 模拟额度耗尽 (429 / quota limit)

    const router = new MockLlmRouter({ cliPool })
    let fallbackCaptured = null
    router.on('fallback', (f) => {
      fallbackCaptured = f
    })

    const decision = await router.route('老爸对女儿说：写完了需求文档！')
    assert.equal(decision.tier, 2)
    assert.equal(decision.provider, 'deepseek_sse')
    assert.ok(decision.result.text.length > 0)
    assert.ok(fallbackCaptured !== null)
    assert.equal(fallbackCaptured.fromTier, 1)
    assert.equal(fallbackCaptured.toTier, 2)
  })

  it('TC-R2-03: 所有在线大模型故障时由 Tier 4 离线规则语料秒级兜底', async () => {
    const cliPool = new AgentCliSandboxMock({ name: 'cursor-agent' })
    cliPool.setQuotaExhausted(true)

    const router = new MockLlmRouter({ cliPool })
    router.setDeepSeekAvailable(false)
    router.setLocalLlmAvailable(false)

    const decision = await router.route('老爸对女儿说：今天断网啦！')
    assert.equal(decision.tier, 4)
    assert.equal(decision.provider, 'rule_corpus')
    assert.ok(decision.result.text.includes('大肥鱼正在待机中'))
  })

  it('TC-R2-04: 3-Layer 前缀缓存友好 Prompt 布局合规性与 Token 预算裁剪 (<= 2100)', () => {
    // 构造符合规范的三层 Prompt
    const validPrompt = `
[Layer A] SYSTEM_PERSONA: 你是大肥鱼，老爸的赛博女儿，傲娇元气性格，说话简短俏皮。
[Layer B] FACTS_SUMMARY: 老爸是全栈工程师，最近在开发抖音直播版，喜欢喝乌龙茶。
[Layer C] <event type="DANMAKU" viewer="张三">老爸写代码辛苦啦！</event>
`
    const validation = validatePrompt3Layer(validPrompt)
    assert.equal(validation.valid, true)
    assert.equal(validation.withinBudget, true)
    assert.ok(validation.estimatedTokens < 2100)
    assert.equal(validation.layers.A, true)
    assert.equal(validation.layers.B, true)
    assert.equal(validation.layers.C, true)
  })

  it('TC-R2-05: 流式元数据头 <meta .../> 即时解析与动作剥离', () => {
    const metaLine = '<meta clip="eat_token" tone="happy" moodIntent="2" fed="true" memory="老爸喂了我小鱼干"/>\n'
    const meta = parseStreamingMeta(metaLine)

    assert.notEqual(meta, null)
    assert.equal(meta.clip, 'eat_token')
    assert.equal(meta.tone, 'happy')
    assert.equal(meta.moodIntent, 2)
    assert.equal(meta.fed, true)
    assert.equal(meta.memory, '老爸喂了我小鱼干')
  })

  it('TC-R2-06: DeepSeek 日预算限额守卫，超额后自动阻断 API 请求', async () => {
    const router = new MockLlmRouter({ deepSeekDailyBudget: 5.0 })
    router.addDeepSeekCost(5.01) // 累计花费超额

    let thrownError = null
    try {
      for await (const _ of router.streamDeepSeek('test prompt')) {}
    } catch (err) {
      thrownError = err
    }

    assert.notEqual(thrownError, null)
    assert.match(thrownError.message, /daily budget exceeded/i)
  })
})
