/**
 * @file r2-boundaries.test.js
 * Tier 2: R2 Brain Router & Streaming 边界与异常测试
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentCliSandboxMock,
  MockLlmRouter,
  validatePrompt3Layer,
  parseStreamingMeta,
} from '../harness/index.js'

describe('Tier 2: R2 Brain Router & Streaming Boundaries', () => {
  it('TC-R2-B01: 连续 3 次失败触发 60 秒熔断器，冷却期内直接拒绝调用', async () => {
    const cliPool = new AgentCliSandboxMock({ name: 'agy' })
    cliPool.setQuotaExhausted(true)

    // 前 3 次连续失败
    await assert.rejects(() => cliPool.execute('p1', '/tmp'), /EXHAUSTED/)
    await assert.rejects(() => cliPool.execute('p2', '/tmp'), /EXHAUSTED/)
    await assert.rejects(() => cliPool.execute('p3', '/tmp'), /EXHAUSTED/)

    // 第 4 次在熔断器触发后调用，直接被熔断拦截
    assert.equal(cliPool.isAvailable(), false)
    await assert.rejects(() => cliPool.execute('p4', '/tmp'), /Circuit breaker is OPEN/)
  })

  it('TC-R2-B02: 熔断器重置后恢复可用状态', async () => {
    const cliPool = new AgentCliSandboxMock({ name: 'agy' })
    cliPool.setQuotaExhausted(true)
    for (let i = 0; i < 3; i++) {
      try {
        await cliPool.execute('p', '/tmp')
      } catch (_) {}
    }
    assert.equal(cliPool.isAvailable(), false)

    // 重置熔断器
    cliPool.resetCircuitBreaker()
    assert.equal(cliPool.isAvailable(), true)
    const res = await cliPool.execute('p', '/tmp')
    assert.equal(res.tone, 'happy')
  })

  it('TC-R2-B03: 超大超长 Prompt 触发 Token 预算超限判定', () => {
    // 构造超长 Prompt (> 2500 字，远超 2100 Token 预算)
    const hugeHistory = '老爸今天很辛苦，写了很多代码。'.repeat(200)
    const overbudgetPrompt = `
[Layer A] SYSTEM_PERSONA: 你是大肥鱼。
[Layer B] FACTS_SUMMARY: ${hugeHistory}
[Layer C] <event>老爸说你好</event>
`
    const validation = validatePrompt3Layer(overbudgetPrompt)
    assert.equal(validation.valid, true)
    assert.equal(validation.withinBudget, false)
    assert.ok(validation.estimatedTokens > 2100)
  })

  it('TC-R2-B04: 畸形流式元数据头安全降级 (缺少闭合标签或属性格式错误)', () => {
    // 缺少闭合 />
    const brokenMeta1 = '<meta clip="eat_token" tone="happy"'
    assert.equal(parseStreamingMeta(brokenMeta1), null)

    // 纯普通文本而非元数据
    const normalText = '老爸今天工作顺利吗？'
    assert.equal(parseStreamingMeta(normalText), null)
  })

  it('TC-R2-B05: DeepSeek API 产生异常时多级路由器自动捕获并无死锁降级', async () => {
    const router = new MockLlmRouter()
    router.setDeepSeekAvailable(false) // 模拟 DeepSeek API 500 / 网络故障

    const decision = await router.route('测试异常降级')
    // 自动降级到 Tier 3 本地模型或 Tier 4 规则库，绝不挂死
    assert.ok(decision.tier >= 3)
    assert.ok(decision.result !== null)
  })

  it('TC-R2-B06: 空 Prompt 或纯空白输入处理', () => {
    assert.throws(() => validatePrompt3Layer(null), /Prompt 必须为文本/)
    const emptyValidation = validatePrompt3Layer('   ')
    assert.equal(emptyValidation.valid, false)
  })
})
