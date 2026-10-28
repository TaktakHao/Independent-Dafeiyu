/**
 * @file m2-it2-router-adversarial.test.js
 * Milestone M2 第二轮迭代实证对抗测试套件 (Challenger 1)
 * 专项验证：
 * 1. CLI 状态机在连续 3 次及多次 429 下严格保持 EXHAUSTED，绝不退化为 CIRCUIT_BROKEN，60s 后依然不可用
 * 2. 下游 Provider 抛出 null / undefined / 非 Error 异常时，TieredBrainRouter 绝对不崩并顺利降级到 Tier 4
 * 3. Tier 1 极速返回时，对冲定时器 100% 被清理，零延迟触发
 * 4. 极端边界：toxic 异常 getter、无 executor 沙箱下的 429 短路保护、对冲落败方的 Abort 信号与失败计数豁免
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TieredBrainRouter,
  AgentCliProvider,
  RuleFallbackProvider,
  DeepSeekProvider,
  LocalLlmProvider,
} from '../src/standalone/brain/index.ts'

describe('M2 Iteration 2 Challenger 1: Adversarial Router & State Machine Stress Harness', () => {

  // =========================================================================
  // 1. CLI 状态机 429 额度耗尽与熔断隔离实证
  // =========================================================================
  describe('1. CLI 状态机 429 额度耗尽与 60s 熔断严格隔离对抗', () => {

    it('1.1 连续 3 次 429：状态严格保持 EXHAUSTED，consecutiveFailures 恒为 0，绝不篡改为 CIRCUIT_BROKEN', async () => {
      let callCount = 0
      const cli = new AgentCliProvider({
        id: 'cli_429_triple_test',
        breakerThreshold: 3,
        breakerCooldownMs: 60_000,     // 60秒短熔断
        cooldownOnExhaustedMs: 3600_000, // 1小时长额度冷却
        executor: async () => {
          callCount++
          return {
            stdout: '',
            stderr: `Rate limit reached: HTTP 429 Too Many Requests (call ${callCount})`,
            exitCode: 1,
          }
        },
      })

      // 验证第 1 次 429
      await assert.rejects(() => cli.execute('prompt 1'), (err) => {
        assert.equal(err.code, 'EXHAUSTED')
        return true
      })
      let status = cli.getStatus()
      assert.equal(status.state, 'EXHAUSTED', '第 1 次 429 必须进入 EXHAUSTED')
      assert.equal(status.consecutiveFailures, 0, '429 额度耗尽不能累加 consecutiveFailures')
      assert.equal(status.circuitBrokenUntil, undefined, '绝不能设置 circuitBrokenUntil')
      assert.equal(cli.isAvailable(), false)

      // 验证第 2 次 429
      await assert.rejects(() => cli.execute('prompt 2'), (err) => {
        assert.equal(err.code, 'EXHAUSTED')
        return true
      })
      status = cli.getStatus()
      assert.equal(status.state, 'EXHAUSTED', '第 2 次 429 必须保持 EXHAUSTED')
      assert.equal(status.consecutiveFailures, 0, 'consecutiveFailures 必须保持 0')
      assert.equal(status.circuitBrokenUntil, undefined)
      assert.equal(cli.isAvailable(), false)

      // 验证第 3 次 429 (这是最关键的临界点：普通错误在此会触发 breakerThreshold=3 熔断)
      await assert.rejects(() => cli.execute('prompt 3'), (err) => {
        assert.equal(err.code, 'EXHAUSTED')
        return true
      })
      status = cli.getStatus()
      assert.equal(status.state, 'EXHAUSTED', '第 3 次 429 依然必须严格保持 EXHAUSTED，绝不能被篡改为 CIRCUIT_BROKEN！')
      assert.equal(status.consecutiveFailures, 0, 'consecutiveFailures 必须依然为 0')
      assert.equal(status.circuitBrokenUntil, undefined, '绝不能设置 circuitBrokenUntil')
      assert.equal(cli.isAvailable(), false)
    })

    it('1.2 连续多次（5次、10次、20次）429 持续高压冲击：EXHAUSTED 状态坚不可摧', async () => {
      let invocations = 0
      const quotaPatterns = [
        'API quota limit exceeded (429)',
        'HTTP 429: rate limit exceeded',
        'insufficient_quota: current balance is 0',
        '当前账号调用额度已达上限，请充值后重试',
        'tokens exceeded for the current billing cycle (429)',
      ]

      const cli = new AgentCliProvider({
        id: 'cli_429_high_stress',
        breakerThreshold: 3,
        breakerCooldownMs: 60_000,
        cooldownOnExhaustedMs: 3600_000,
        executor: async () => {
          const errText = quotaPatterns[invocations % quotaPatterns.length]
          invocations++
          return { stdout: '', stderr: errText, exitCode: 1 }
        },
      })

      for (let i = 1; i <= 20; i++) {
        await assert.rejects(() => cli.execute(`prompt_${i}`), (err) => {
          assert.equal(err.code, 'EXHAUSTED', `第 ${i} 次调用应识别为 EXHAUSTED`)
          return true
        })

        const status = cli.getStatus()
        assert.equal(status.state, 'EXHAUSTED', `第 ${i} 次连续 429 后状态必须为 EXHAUSTED`)
        assert.equal(status.consecutiveFailures, 0, `第 ${i} 次连续 429 后 consecutiveFailures 必须为 0`)
        assert.equal(status.circuitBrokenUntil, undefined, `第 ${i} 次连续 429 后绝不能有 circuitBrokenUntil`)
        assert.equal(cli.isAvailable(), false)
      }
      assert.equal(invocations, 20)
    })

    it('1.3 60 秒后依然不可用实证：模拟 60s、61s、600s 流逝，状态依然为 EXHAUSTED 且不可用', async () => {
      const realNow = Date.now()
      let simulatedTime = realNow

      const originalDateNow = Date.now
      try {
        Date.now = () => simulatedTime

        const cli = new AgentCliProvider({
          id: 'cli_60s_guard',
          breakerThreshold: 3,
          breakerCooldownMs: 60_000,      // 60秒短熔断
          cooldownOnExhaustedMs: 3600_000, // 1小时长额度冷却
          probeIntervalMs: 900_000,       // 15分钟探针
          executor: async () => ({
            stdout: '',
            stderr: '429 rate limit exceeded',
            exitCode: 1,
          }),
        })

        // 触发 3 次 429
        await assert.rejects(() => cli.execute('test 1'))
        await assert.rejects(() => cli.execute('test 2'))
        await assert.rejects(() => cli.execute('test 3'))

        assert.equal(cli.getStatus().state, 'EXHAUSTED')
        assert.equal(cli.isAvailable(), false)

        // 模拟时间推进 59 秒 (59,000ms)
        simulatedTime = realNow + 59_000
        assert.equal(cli.getStatus().state, 'EXHAUSTED')
        assert.equal(cli.isAvailable(), false, '59s 时必须不可用')

        // 模拟时间推进整整 60 秒 (60,000ms，短熔断的到期点)
        simulatedTime = realNow + 60_000
        assert.equal(cli.getStatus().state, 'EXHAUSTED', '60s 时必须依然是 EXHAUSTED，绝不能变成 HALF_OPEN！')
        assert.equal(cli.isAvailable(), false, '60s 时绝不能恢复可用（因为额度冷却需 1 小时）！')

        // 模拟时间推进 61 秒 (61,000ms)
        simulatedTime = realNow + 61_000
        assert.equal(cli.getStatus().state, 'EXHAUSTED')
        assert.equal(cli.isAvailable(), false, '61s 时必须依然不可用！')

        // 模拟时间推进 10 分钟 (600,000ms，小于 15 分钟探针和 1 小时冷却)
        simulatedTime = realNow + 600_000
        assert.equal(cli.getStatus().state, 'EXHAUSTED')
        assert.equal(cli.isAvailable(), false, '10分钟时必须依然不可用！')

        // 验证调用仍然被阻断
        await assert.rejects(() => cli.execute('test at 600s'), /EXHAUSTED/)
      } finally {
        Date.now = originalDateNow
      }
    })

    it('1.4 混合故障穿插对抗：EXHAUSTED 状态下遭遇 500 / 超时，绝不被篡改为 CIRCUIT_BROKEN', async () => {
      let currentError = 'API quota limit exceeded (429)'
      const cli = new AgentCliProvider({
        id: 'cli_mixed_faults',
        breakerThreshold: 3,
        breakerCooldownMs: 60_000,
        cooldownOnExhaustedMs: 3600_000,
        executor: async () => ({
          stdout: '',
          stderr: currentError,
          exitCode: 1,
        }),
      })

      // 1. 触发 429
      await assert.rejects(() => cli.execute('p1'), /EXHAUSTED/)
      assert.equal(cli.getStatus().state, 'EXHAUSTED')

      // 2. 紧接着抛出 3 次 500 内部服务错误
      currentError = 'HTTP 500 Internal Server Error'
      await assert.rejects(() => cli.execute('p2'), /Internal Server Error/)
      await assert.rejects(() => cli.execute('p3'), /Internal Server Error/)
      await assert.rejects(() => cli.execute('p4'), /Internal Server Error/)

      // 3. 状态必须依然锁定为 EXHAUSTED，绝不能被 500 的 3 次失败篡改为 CIRCUIT_BROKEN！
      const status = cli.getStatus()
      assert.equal(status.state, 'EXHAUSTED', '在 1 小时冷却期内遭遇 500，状态必须锁死为 EXHAUSTED')
      assert.equal(status.circuitBrokenUntil, undefined, '绝不被设置 circuitBrokenUntil')
      assert.equal(cli.isAvailable(), false)
    })

    it('1.5 连续 2 次 500 错误后紧接着发生 429：consecutiveFailures 必须清零，状态直接转为 EXHAUSTED', async () => {
      let callStep = 0
      const cli = new AgentCliProvider({
        id: 'cli_500_then_429',
        breakerThreshold: 3,
        breakerCooldownMs: 60_000,
        cooldownOnExhaustedMs: 3600_000,
        executor: async () => {
          callStep++
          if (callStep <= 2) {
            return { stdout: '', stderr: 'HTTP 500 Internal Server Error', exitCode: 1 }
          }
          return { stdout: '', stderr: 'API 429 quota exceeded', exitCode: 1 }
        },
      })

      // 第 1 次 500
      await assert.rejects(() => cli.execute('call 1'))
      assert.equal(cli.getStatus().consecutiveFailures, 1)

      // 第 2 次 500 (再有 1 次就熔断)
      await assert.rejects(() => cli.execute('call 2'))
      assert.equal(cli.getStatus().consecutiveFailures, 2)

      // 第 3 次发生 429
      await assert.rejects(() => cli.execute('call 3'))
      const status = cli.getStatus()
      assert.equal(status.state, 'EXHAUSTED', '第 3 次发生 429 必须进入 EXHAUSTED')
      assert.equal(status.consecutiveFailures, 0, 'consecutiveFailures 必须被立即清零为 0')
      assert.equal(status.circuitBrokenUntil, undefined, '绝不可触发熔断')
    })

    it('1.6 无自定义 executor 的默认沙箱短路保护：EXHAUSTED 状态下阻断执行并维持 EXHAUSTED', async () => {
      const cli = new AgentCliProvider({
        id: 'cli_no_executor_exhausted',
        cooldownOnExhaustedMs: 3600_000,
        probeIntervalMs: 900_000,
      })
      cli.setQuotaExhausted(true)

      assert.equal(cli.getStatus().state, 'EXHAUSTED')
      assert.equal(cli.isAvailable(), false)

      // 调用 execute，应当被第 354 行的原生短路保护拦截，抛出带 EXHAUSTED code 的 Error
      await assert.rejects(
        () => cli.execute('test prompt without executor'),
        (err) => {
          assert.equal(err.code, 'EXHAUSTED')
          return true
        }
      )

      assert.equal(cli.getStatus().state, 'EXHAUSTED')
      assert.equal(cli.getStatus().consecutiveFailures, 0)
    })
  })

  // =========================================================================
  // 2. 下游 Provider 抛出 null / undefined / 非 Error 异常时路由器健壮性实证
  // =========================================================================
  describe('2. 下游 Provider 抛出 null / undefined / 非 Error 异常时路由器健壮性对抗', () => {

    it('2.1 Tier 1 抛出 null (Promise.reject(null))：路由器绝不崩溃，安全降级至 Tier 2 并触发 fallback 事件', async () => {
      const nullCli = {
        id: 'null_cli',
        tier: 1,
        name: 'Null Throwing CLI',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({ id: 'null_cli', tier: 1, name: 'Null Throwing CLI', state: 'READY', totalInvocations: 0, successCount: 0, failureCount: 0, consecutiveFailures: 0, estimatedLatencyMs: 100, p50LatencyMs: 100, p90LatencyMs: 100 }),
        think: async () => {
          return Promise.reject(null)
        },
      }

      const deepSeek = {
        id: 'deepseek_ok',
        tier: 2,
        name: 'DeepSeek OK',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({ id: 'deepseek_ok', tier: 2, name: 'DeepSeek OK', state: 'READY', totalInvocations: 0, successCount: 0, failureCount: 0, consecutiveFailures: 0, estimatedLatencyMs: 100, p50LatencyMs: 100, p90LatencyMs: 100 }),
        think: async () => ({
          tier: 2,
          provider: 'deepseek_sse',
          providerId: 'deepseek_ok',
          output: { reply: '从 null 异常中成功降级到 Tier 2', text: '从 null 异常中成功降级到 Tier 2', clip: 'talking_normal', tone: 'happy' },
          result: { reply: '从 null 异常中成功降级到 Tier 2', text: '从 null 异常中成功降级到 Tier 2', clip: 'talking_normal', tone: 'happy' },
          durationMs: 50,
          latencyMs: 50,
        }),
      }

      const router = new TieredBrainRouter({
        providers: [nullCli, deepSeek, new RuleFallbackProvider()],
      })

      const fallbackEvents = []
      router.on('fallback', (e) => fallbackEvents.push(e))

      const res = await router.route('测试 Tier 1 抛出 null')
      assert.equal(res.tier, 2)
      assert.equal(res.output.reply, '从 null 异常中成功降级到 Tier 2')
      assert.ok(fallbackEvents.length >= 1)
      assert.equal(fallbackEvents[0].fromTier, 1)
      assert.equal(fallbackEvents[0].toTier, 2)
      assert.equal(typeof fallbackEvents[0].reason, 'string')
      assert.equal(fallbackEvents[0].reason, 'Unknown error')
    })

    it('2.2 Tier 1 抛出 undefined (Promise.reject(undefined))：路由器绝不崩溃，平滑降级', async () => {
      const undefinedCli = {
        id: 'undefined_cli',
        tier: 1,
        name: 'Undefined CLI',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({}),
        think: async () => Promise.reject(undefined),
      }

      const router = new TieredBrainRouter({
        providers: [undefinedCli, new RuleFallbackProvider()],
      })

      const fallbackEvents = []
      router.on('fallback', (e) => fallbackEvents.push(e))

      const res = await router.route('测试 Tier 1 抛出 undefined')
      assert.equal(res.tier, 4)
      assert.ok(res.output.reply.length > 0)
      assert.equal(fallbackEvents[0].reason, 'Unknown error')
    })

    it('2.3 下游 Provider 抛出纯字符串、数字、布尔值与 Symbol 原始类型：路由器 100% 免疫', async () => {
      const primitiveErrors = [
        'A raw string error message without Error wrapper',
        502,
        false,
        Symbol('exotic_error'),
      ]

      for (const rawErr of primitiveErrors) {
        const weirdProvider = {
          id: 'weird_provider',
          tier: 1,
          name: 'Weird Provider',
          isAvailable: () => true,
          getEstimatedLatencyMs: () => 100,
          getStatus: () => ({}),
          think: async () => Promise.reject(rawErr),
        }

        const router = new TieredBrainRouter({
          providers: [weirdProvider, new RuleFallbackProvider()],
        })

        const fallbackEvents = []
        router.on('fallback', (e) => fallbackEvents.push(e))

        const res = await router.route('测试原始类型抛错')
        assert.equal(res.tier, 4)
        assert.ok(res.output.reply.length > 0)
        assert.equal(typeof fallbackEvents[0].reason, 'string')
        assert.equal(fallbackEvents[0].reason, String(rawErr))
      }
    })

    it('2.4 下游 Provider 抛出无 message 属性的自定义对象与循环引用对象：路由器鲁棒兼容', async () => {
      const circularObj = { code: 'CIRCULAR_ERROR' }
      circularObj.self = circularObj

      const strangeObjects = [
        { code: 'INTERNAL_ERR', codeNum: 1024 },
        { details: ['a', 'b', 'c'] },
        circularObj,
      ]

      for (const strangeObj of strangeObjects) {
        const objProvider = {
          id: 'obj_provider',
          tier: 1,
          name: 'Obj Provider',
          isAvailable: () => true,
          getEstimatedLatencyMs: () => 100,
          getStatus: () => ({}),
          think: async () => Promise.reject(strangeObj),
        }

        const router = new TieredBrainRouter({
          providers: [objProvider, new RuleFallbackProvider()],
        })

        const res = await router.route('测试对象类型抛错')
        assert.equal(res.tier, 4)
        assert.ok(res.output.reply.length > 0)
      }
    })

    it('2.5 全链路前 3 层 Provider 均抛出畸形非 Error 异常：路由器顺利终极降级至 Tier 4 规则库', async () => {
      const tier1 = {
        id: 't1_null',
        tier: 1,
        name: 'T1 Null',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 50,
        getStatus: () => ({}),
        think: async () => Promise.reject(null),
      }

      const tier2 = {
        id: 't2_undefined',
        tier: 2,
        name: 'T2 Undefined',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 50,
        getStatus: () => ({}),
        think: async () => Promise.reject(undefined),
      }

      const tier3 = {
        id: 't3_string',
        tier: 3,
        name: 'T3 String',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 50,
        getStatus: () => ({}),
        think: async () => Promise.reject('Ollama backend unreachable'),
      }

      const ruleProvider = new RuleFallbackProvider()

      const router = new TieredBrainRouter({
        providers: [tier1, tier2, tier3, ruleProvider],
      })

      const fallbacks = []
      router.on('fallback', (e) => fallbacks.push(e))

      const res = await router.route('测试全链路多级非 Error 异常穿透')
      assert.equal(res.tier, 4, '必须成功降级至 Tier 4')
      assert.equal(res.provider, 'rule_corpus')
      assert.ok(res.output.reply.length > 0)
      assert.equal(fallbacks.length, 3, '应记录 3 次 fallback')
      assert.equal(fallbacks[0].fromTier, 1)
      assert.equal(fallbacks[1].fromTier, 2)
      assert.equal(fallbacks[2].fromTier, 3)
    })

    it('2.6 Provider.think 同步直接 throw null（非返回 Promise.reject）：路由器依然安全兜底', async () => {
      const syncThrowCli = {
        id: 'sync_throw_cli',
        tier: 1,
        name: 'Sync Throw CLI',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 50,
        getStatus: () => ({}),
        think: () => {
          throw null // 同步抛错！
        },
      }

      const router = new TieredBrainRouter({
        providers: [syncThrowCli, new RuleFallbackProvider()],
      })

      const res = await router.route('测试同步 throw null')
      assert.equal(res.tier, 4)
      assert.ok(res.output.reply.length > 0)
    })

    it('2.7 极端对抗：恶意错误对象的 message 属性自身是一个抛错 getter：最外层 catch 兜底成功', async () => {
      const toxicError = {
        get message() {
          throw new Error('Exploding getter inside error object!')
        },
      }

      const toxicProvider = {
        id: 'toxic_provider',
        tier: 1,
        name: 'Toxic Provider',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 50,
        getStatus: () => ({}),
        think: async () => Promise.reject(toxicError),
      }

      const router = new TieredBrainRouter({
        providers: [toxicProvider, new RuleFallbackProvider()],
      })

      // 验证最外层 catch (outerErr) 拦截爆炸并降级到 Tier 4
      const res = await router.route('测试恶意 getter 异常对象')
      assert.equal(res.tier, 4)
      assert.equal(res.provider, 'rule_corpus')
      assert.ok(res.output.reply.length > 0)
    })
  })

  // =========================================================================
  // 3. 对冲定时器清除与无延迟触发实证
  // =========================================================================
  describe('3. Tier 1 极速返回时对冲定时器 100% 清除实证', () => {

    it('3.1 单次 Tier 1 极速返回 (5ms)：对冲定时器被 100% 清除，150ms 内 Tier 2 零延迟触发', async () => {
      let tier2Triggered = false
      let tier2InvokedCount = 0

      const fastCli = {
        id: 'instant_cli',
        tier: 1,
        name: 'Instant CLI',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 50,
        getStatus: () => ({}),
        think: async () => {
          await new Promise((r) => setTimeout(r, 5)) // 5ms 极速返回
          return {
            tier: 1,
            provider: 'agent_cli',
            providerId: 'instant_cli',
            output: { reply: '极速响应', text: '极速响应', clip: 'talking_normal', tone: 'happy' },
            result: { reply: '极速响应', text: '极速响应', clip: 'talking_normal', tone: 'happy' },
            durationMs: 5,
            latencyMs: 5,
          }
        },
      }

      const tier2 = {
        id: 'tier2_spied',
        tier: 2,
        name: 'Tier 2 Spied',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({}),
        think: async () => {
          tier2Triggered = true
          tier2InvokedCount++
          return {
            tier: 2,
            provider: 'deepseek_sse',
            providerId: 'tier2_spied',
            output: { reply: 'T2', text: 'T2' },
            result: { reply: 'T2', text: 'T2' },
            durationMs: 10,
            latencyMs: 10,
          }
        },
      }

      const router = new TieredBrainRouter({
        providers: [fastCli, tier2, new RuleFallbackProvider()],
        hedgeAfterMs: 40, // 设定 40ms 对冲窗口
      })

      const res = await router.route('测试极速返回对冲定时器清除')
      assert.equal(res.tier, 1)
      assert.equal(res.output.reply, '极速响应')

      // 等待 150ms（远超 40ms 对冲阈值），验证没有任何对冲定时器滞后触发
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(tier2Triggered, false, 'Tier 1 极速返回后，Tier 2 绝不可被延迟触发！')
      assert.equal(tier2InvokedCount, 0, 'Tier 2 调用计数必须严格为 0')
    })

    it('3.2 Tier 1 极速抛错 (5ms)：对冲定时器在 finally 中立即清除，绝不产生滞后幽灵调用', async () => {
      let t2HedgeCalled = false
      let t2FallbackCalled = false

      const fastFailingCli = {
        id: 'fast_failing_cli',
        tier: 1,
        name: 'Fast Failing CLI',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 50,
        getStatus: () => ({}),
        think: async () => {
          await new Promise((r) => setTimeout(r, 5))
          throw new Error('Immediate T1 crash')
        },
      }

      const tier2 = {
        id: 'tier2_for_fast_fail',
        tier: 2,
        name: 'Tier 2 For Fast Fail',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({}),
        think: async (_req, opts) => {
          // 区分是常规降级调用还是对冲调用
          if (opts?.abortSignal) {
            t2HedgeCalled = true
          }
          t2FallbackCalled = true
          return {
            tier: 2,
            provider: 'deepseek_sse',
            providerId: 'tier2_for_fast_fail',
            output: { reply: 'T2 正常降级响应', text: 'T2 正常降级响应', clip: 'talking_normal', tone: 'happy' },
            result: { reply: 'T2 正常降级响应', text: 'T2 正常降级响应', clip: 'talking_normal', tone: 'happy' },
            durationMs: 20,
            latencyMs: 20,
          }
        },
      }

      const router = new TieredBrainRouter({
        providers: [fastFailingCli, tier2, new RuleFallbackProvider()],
        hedgeAfterMs: 60, // 设定 60ms 对冲
      })

      const res = await router.route('测试 T1 快速失败时对冲定时器清除')
      assert.equal(res.tier, 2)
      assert.equal(res.output.reply, 'T2 正常降级响应')
      assert.equal(t2FallbackCalled, true, '正常降级调用必须成功')

      // 再次等待 120ms，确保没有未清理的 hedgeTimer 再次触发调用
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(t2HedgeCalled, false, '原对冲定时器必须已被清除，绝不发起幽灵调用')
    })

    it('3.3 50 次高并发极速请求无定时器泄漏实证：50 个请求全量极速完成且零定时器残留', async () => {
      let tier2Calls = 0

      const fastCli = {
        id: 'concurrent_fast_cli',
        tier: 1,
        name: 'Concurrent Fast CLI',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 20,
        getStatus: () => ({}),
        think: async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 8 + 2)) // 2~10ms
          return {
            tier: 1,
            provider: 'agent_cli',
            providerId: 'concurrent_fast_cli',
            output: { reply: '并发极速回复', text: '并发极速回复', clip: 'talking_normal', tone: 'happy' },
            result: { reply: '并发极速回复', text: '并发极速回复', clip: 'talking_normal', tone: 'happy' },
            durationMs: 5,
            latencyMs: 5,
          }
        },
      }

      const tier2 = {
        id: 'tier2_concurrent',
        tier: 2,
        name: 'Tier 2 Concurrent',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({}),
        think: async () => {
          tier2Calls++
          return {}
        },
      }

      const router = new TieredBrainRouter({
        providers: [fastCli, tier2, new RuleFallbackProvider()],
        hedgeAfterMs: 50, // 设定 50ms 对冲
      })

      // 并发打入 50 个请求
      const tasks = Array.from({ length: 50 }, (_, i) => router.route(`并发请求 #${i}`))
      const results = await Promise.all(tasks)

      assert.equal(results.length, 50)
      for (const r of results) {
        assert.equal(r.tier, 1)
        assert.equal(r.output.reply, '并发极速回复')
      }

      // 等待 150ms 越过 50ms 的对冲时间窗口
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(tier2Calls, 0, '50 次并发极速请求中，Tier 2 调用必须严格为 0，所有定时器 100% 被清理')
    })

    it('3.4 对冲取消临界对抗：Tier 1 在 hedgeAfterMs 触发前临界时刻 (30ms < 50ms) 返回', async () => {
      let t2Called = false

      const boundaryCli = {
        id: 'boundary_cli',
        tier: 1,
        name: 'Boundary CLI',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 40,
        getStatus: () => ({}),
        think: async () => {
          await new Promise((r) => setTimeout(r, 30)) // 30ms 返回，hedgeAfterMs 为 50ms
          return {
            tier: 1,
            provider: 'agent_cli',
            providerId: 'boundary_cli',
            output: { reply: '临界返回', text: '临界返回', clip: 'talking_normal', tone: 'happy' },
            result: { reply: '临界返回', text: '临界返回', clip: 'talking_normal', tone: 'happy' },
            durationMs: 30,
            latencyMs: 30,
          }
        },
      }

      const tier2 = {
        id: 'tier2_boundary',
        tier: 2,
        name: 'Tier 2 Boundary',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({}),
        think: async () => {
          t2Called = true
          return {}
        },
      }

      const router = new TieredBrainRouter({
        providers: [boundaryCli, tier2, new RuleFallbackProvider()],
        hedgeAfterMs: 50,
      })

      const res = await router.route('测试临界点对冲清除')
      assert.equal(res.tier, 1)
      assert.equal(res.output.reply, '临界返回')

      await new Promise((r) => setTimeout(r, 100))
      assert.equal(t2Called, false, '临界点未超时的请求，其对冲定时器必须被安全清除')
    })
  })
})
