/**
 * @file scenario-quota-fallback-chain.test.js
 * Tier 4 场景测试 4: 多级思考引擎极端故障链与层层降级防御全链路
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentCliSandboxMock,
  MockLlmRouter,
} from '../harness/index.js'

describe('Tier 4 Scenario 4: Quota & Fault Cascade Fallback Chain', () => {
  it('TC-SC-04: Tier 1 额度耗尽 -> Tier 2 超日预算 -> Tier 3 离线 -> Tier 4 规则库全链路穿透降级', async () => {
    const cliPool = new AgentCliSandboxMock({ name: 'agy' })
    const router = new MockLlmRouter({ cliPool, deepSeekDailyBudget: 5.0 })

    const fallbacks = []
    router.on('fallback', (f) => fallbacks.push(f))

    // 状态 1: 全链路健康，走 Tier 1 CLI
    const r1 = await router.route('测试健康状态')
    assert.equal(r1.tier, 1)

    // 状态 2: Tier 1 CLI 额度耗尽，自动降级至 Tier 2 DeepSeek
    cliPool.setQuotaExhausted(true)
    const r2 = await router.route('测试 CLI 额度耗尽')
    assert.equal(r2.tier, 2)
    assert.equal(r2.provider, 'deepseek_sse')

    // 状态 3: Tier 2 DeepSeek 消耗达日上限 (5.00 元)，自动降级至 Tier 3 本地小模型
    router.addDeepSeekCost(5.00)
    const r3 = await router.route('测试 DeepSeek 超额')
    assert.equal(r3.tier, 3)
    assert.equal(r3.provider, 'local_ollama')

    // 状态 4: 本地小模型服务崩溃离线，最终落入 Tier 4 规则库兜底
    router.setLocalLlmAvailable(false)
    const r4 = await router.route('测试全系统极端离线')
    assert.equal(r4.tier, 4)
    assert.equal(r4.provider, 'rule_corpus')
    assert.ok(r4.result.text.length > 0)
    assert.ok(r4.durationMs < 50) // 毫秒级返回，绝无死锁

    // 验证降级轨迹记录
    assert.ok(fallbacks.length >= 2)
  })
})
