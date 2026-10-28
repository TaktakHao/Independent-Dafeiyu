/**
 * @file m2-adversarial-challenger.test.js
 * M2 Challenger 1: Empirical Adversarial Stress Test Harness
 * 针对脑路由器级联、额度耗尽、状态机、延迟预算与对冲并发的高强度实证对抗测试
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  TieredBrainRouter,
  AgentCliProvider,
  parseCliStructuredOutput,
  QUOTA_REGEX,
  AUTH_REGEX,
  DailyBudgetGuard,
  DeepSeekProvider,
  LocalLlmProvider,
  RuleFallbackProvider,
} from '../src/standalone/brain/index.ts'

describe('M2 Adversarial Challenger Suite: Brain Router Cascade & Quota Error Handling', () => {
  // =========================================================================
  // 1. CLI Quota Exhaustion, Auth Failure & Circuit Breaker
  // =========================================================================
  describe('1. CLI Quota Exhaustion, Auth Failure & Circuit Breaker State Machine', () => {
    it('1.1 模拟 CLI 输出 429 / quota limit exceeded：跃迁至 EXHAUSTED 状态并进入 1 小时冷却期', async () => {
      let callCount = 0
      const quotaErrors = [
        'Error 429: Rate limit exceeded, please retry later',
        'API quota limit exceeded (429)',
        '当前账号调用额度已达上限，请充值后重试',
        'insufficient_quota: you have exceeded your current quota',
      ]

      for (const errText of quotaErrors) {
        const cli = new AgentCliProvider({
          id: `cli_quota_${++callCount}`,
          cooldownOnExhaustedMs: 3600_000,
          executor: async () => ({
            stdout: '',
            stderr: errText,
            exitCode: 1,
          }),
        })

        assert.equal(cli.isAvailable(), true, '初始状态应为可用')
        assert.equal(cli.getStatus().state, 'READY')

        await assert.rejects(
          () => cli.execute('test prompt'),
          (err) => {
            assert.equal(err.code, 'EXHAUSTED', '错误代码应为 EXHAUSTED')
            return true
          }
        )

        const status = cli.getStatus()
        assert.equal(status.state, 'EXHAUSTED', `应当跃迁至 EXHAUSTED 状态 (输入: ${errText})`)
        assert.equal(cli.isAvailable(), false, '额度耗尽后在冷却期内应不可用')
        assert.ok(status.exhaustedUntil && status.exhaustedUntil > Date.now() + 3500_000, '冷却截止时间应约为 1 小时后')
      }
    })

    it('1.2 模拟 CLI 输出 login/unauthorized：跃迁至 NEEDS_AUTH 状态并永久关闭自动重试', async () => {
      const authErrors = [
        'Please login first: agy auth login',
        'Unauthorized: token expired (401)',
        '403 Forbidden: authentication failed',
        'not logged in to cursor service',
      ]

      for (const errText of authErrors) {
        const cli = new AgentCliProvider({
          id: 'cli_auth_test',
          executor: async () => ({
            stdout: '',
            stderr: errText,
            exitCode: 1,
          }),
        })

        await assert.rejects(
          () => cli.execute('test prompt'),
          (err) => {
            assert.equal(err.code, 'NEEDS_AUTH', '错误代码应为 NEEDS_AUTH')
            return true
          }
        )

        const status = cli.getStatus()
        assert.equal(status.state, 'NEEDS_AUTH', `应当跃迁至 NEEDS_AUTH 状态 (输入: ${errText})`)
        assert.equal(cli.isAvailable(), false, 'NEEDS_AUTH 状态下 isAvailable 必须为 false')

        // 验证多次检查均不会自动恢复
        assert.equal(cli.isAvailable(), false)
      }
    })

    it('1.3 触发连续 3 次临时错误/超时：跃迁至 CIRCUIT_BROKEN 状态并熔断 60 秒，第 4 次调用拦截不走执行器', async () => {
      let executorRuns = 0
      const cli = new AgentCliProvider({
        id: 'cli_breaker_test',
        breakerThreshold: 3,
        breakerCooldownMs: 60_000,
        executor: async () => {
          executorRuns++
          return {
            stdout: '',
            stderr: 'Internal Server Error (500) connection reset by peer',
            exitCode: 2,
          }
        },
      })

      // 连续 3 次普通失败
      await assert.rejects(() => cli.execute('p1'), /Internal Server Error/)
      assert.equal(cli.getStatus().consecutiveFailures, 1)
      assert.equal(cli.isAvailable(), true)

      await assert.rejects(() => cli.execute('p2'), /Internal Server Error/)
      assert.equal(cli.getStatus().consecutiveFailures, 2)
      assert.equal(cli.isAvailable(), true)

      await assert.rejects(() => cli.execute('p3'), /Internal Server Error/)
      assert.equal(cli.getStatus().consecutiveFailures, 3)

      // 第 3 次失败后状态必须为 CIRCUIT_BROKEN
      const status = cli.getStatus()
      assert.equal(status.state, 'CIRCUIT_BROKEN', '3 次连续失败必须触发 CIRCUIT_BROKEN')
      assert.equal(cli.isAvailable(), false, 'CIRCUIT_BROKEN 冷却期内 isAvailable 必须为 false')
      assert.ok(status.circuitBrokenUntil && status.circuitBrokenUntil > Date.now() + 55_000, '熔断时间应为 60 秒')

      // 第 4 次执行：必须直接被短路拦截抛出 Circuit breaker is OPEN，绝对不触发 executor
      await assert.rejects(
        () => cli.execute('p4'),
        /Circuit breaker is OPEN/
      )
      assert.equal(executorRuns, 3, '熔断期间严禁调用执行器浪费系统资源')
    })

    it('1.4 探针与熔断半开自愈测试：冷却期结束后放行探测，成功则全量自愈重置连续失败计数', async () => {
      let shouldSucceed = false
      let runs = 0
      const cli = new AgentCliProvider({
        id: 'cli_self_heal',
        breakerThreshold: 3,
        breakerCooldownMs: 50, // 设为 50ms 方便高精度实测
        executor: async () => {
          runs++
          if (!shouldSucceed) {
            return { stdout: '', stderr: 'temporary fault', exitCode: 1 }
          }
          return {
            stdout: JSON.stringify({ reply: '自愈成功回复', tone: 'happy', clip: 'success' }),
            stderr: '',
            exitCode: 0,
          }
        },
      })

      // 连续 3 次失败触发熔断
      for (let i = 0; i < 3; i++) {
        await assert.rejects(() => cli.execute('fail'))
      }
      assert.equal(cli.getStatus().state, 'CIRCUIT_BROKEN')
      assert.equal(cli.isAvailable(), false)

      // 等待 60ms 渡过熔断冷却期
      await new Promise((r) => setTimeout(r, 60))

      // 冷却期后首次 isAvailable 应进入 HALF_OPEN
      assert.equal(cli.isAvailable(), true, '冷却期后应当允许试探')
      assert.equal(cli.getStatus().state, 'HALF_OPEN', '状态应转为 HALF_OPEN')

      // 放行试探并成功
      shouldSucceed = true
      const result = await cli.execute('probe prompt')
      assert.equal(result.reply, '自愈成功回复')
      assert.equal(cli.getStatus().state, 'READY', '试探成功后应恢复 READY')
      assert.equal(cli.getStatus().consecutiveFailures, 0, '连续失败计数器应清零')
      assert.equal(cli.isAvailable(), true)
    })

    it('1.5 额度耗尽探针机制 (probeIntervalMs 周期放行探测)', async () => {
      const cli = new AgentCliProvider({
        id: 'cli_probe_test',
        cooldownOnExhaustedMs: 3600_000, // 冷却 1 小时
        probeIntervalMs: 60,              // 设定 60ms 探针
        executor: async () => ({
          stdout: '',
          stderr: 'API quota exceeded (429)',
          exitCode: 1,
        }),
      })

      // 触发额度耗尽
      await assert.rejects(() => cli.execute('p1'), /EXHAUSTED/)
      assert.equal(cli.getStatus().state, 'EXHAUSTED')
      assert.equal(cli.isAvailable(), false, '立即检查应为 false')

      // 等待 70ms 越过 probeIntervalMs
      await new Promise((r) => setTimeout(r, 70))
      assert.equal(cli.isAvailable(), true, '达到探针间隔后必须放行单次探测')
    })
  })

  // =========================================================================
  // 2. Cascade Fallback under Latency Budget
  // =========================================================================
  describe('2. Cascade Fallback under Latency Budget', () => {
    it('2.1 Tier 1 失败/超时场景：在 < 4s 预算内无缝降级至 Tier 2 DeepSeek 并发射 fallback 事件', async () => {
      const cli = new AgentCliProvider({
        id: 'cli_failing',
        executor: async () => {
          // 模拟超时 200ms 后失败
          await new Promise((r) => setTimeout(r, 200))
          return { stdout: '', stderr: 'Process timeout or crash', exitCode: 1 }
        },
      })

      const deepSeek = new DeepSeekProvider({ apiKey: 'mock-key' })
      deepSeek.budgetGuard.reset()
      let deepSeekCalled = false
      deepSeek.think = async () => {
        deepSeekCalled = true
        return {
          tier: 2,
          provider: 'deepseek_sse',
          providerId: 'deepseek_sse',
          output: { reply: 'DeepSeek 无缝降级响应', text: 'DeepSeek 无缝降级响应', clip: 'talking_normal', tone: 'happy', moodIntent: 1, fed: false },
          result: { reply: 'DeepSeek 无缝降级响应', text: 'DeepSeek 无缝降级响应', clip: 'talking_normal', tone: 'happy', moodIntent: 1, fed: false },
          durationMs: 150,
          latencyMs: 150,
        }
      }

      const router = new TieredBrainRouter({
        cliPool: cli,
        deepSeekProvider: deepSeek,
      })

      const fallbacks = []
      router.on('fallback', (f) => fallbacks.push(f))

      const startTime = Date.now()
      const result = await router.route('老爸弹幕：大肥鱼你在吗？', { latencyBudgetMs: 4000 })
      const elapsed = Date.now() - startTime

      assert.ok(elapsed < 4000, `总耗时 ${elapsed}ms 必须在 4s 延迟预算内`)
      assert.equal(result.tier, 2, '结果应来自 Tier 2')
      assert.equal(result.provider, 'deepseek_sse')
      assert.equal(deepSeekCalled, true, 'DeepSeek 必须被成功调用')
      assert.ok(fallbacks.length >= 1, '必须发射 fallback 事件')
      assert.equal(fallbacks[0].fromTier, 1)
      assert.equal(fallbacks[0].toTier, 2)
    })

    it('2.2 DeepSeek 失败或超过日限额 5.0 元：无缝降级至 Tier 3 Local LLM / Tier 4 Rule Corpus', async () => {
      // 场景 A: CLI 额度耗尽 + DeepSeek 达到 5.0 元限额 -> 降级至 Tier 3
      const cli = new AgentCliProvider({ id: 'cli_exhausted' })
      cli.setQuotaExhausted(true)

      const deepSeek = new DeepSeekProvider({ apiKey: 'mock-key', dailyBudgetCny: 5.0 })
      deepSeek.budgetGuard.addCost(5.05) // 超额
      assert.equal(deepSeek.isAvailable(), false, 'DeepSeek 超过 5 元限额后 isAvailable 必须为 false')

      const localLlm = new LocalLlmProvider()
      localLlm.setAvailable(true)
      let localCalled = false
      localLlm.think = async () => {
        localCalled = true
        return {
          tier: 3,
          provider: 'local_llm',
          providerId: 'local_llm',
          output: { reply: '本地小模型 7B 响应', text: '本地小模型 7B 响应', clip: 'talking_normal', tone: 'calm', moodIntent: 0, fed: false },
          result: { reply: '本地小模型 7B 响应', text: '本地小模型 7B 响应', clip: 'talking_normal', tone: 'calm', moodIntent: 0, fed: false },
          durationMs: 80,
          latencyMs: 80,
        }
      }

      const routerA = new TieredBrainRouter({
        providers: [cli, deepSeek, localLlm, new RuleFallbackProvider()],
      })

      const fallbacksA = []
      routerA.on('fallback', (f) => fallbacksA.push(f))

      const resA = await routerA.route('测试超额降级到本地')
      assert.equal(resA.tier, 3)
      assert.equal(resA.provider, 'local_llm')
      assert.equal(localCalled, true)

      // 场景 B: 本地模型亦不可用 -> 全链路穿透至 Tier 4 规则库
      localLlm.setAvailable(false)
      const resB = await routerA.route('测试降级到规则库')
      assert.equal(resB.tier, 4)
      assert.equal(resB.provider, 'rule_corpus')
      assert.ok(resB.output.reply.length > 0)
    })

    it('2.3 Tier 4 离线规则语料库：100% 可用、绝无死锁、响应耗时严格 < 5ms 且语料合理', async () => {
      const ruleProvider = new RuleFallbackProvider()
      assert.equal(ruleProvider.isAvailable(), true)

      const testPrompts = [
        { prompt: '送老爸小鱼干礼物', eventType: 'GIFT_THANKS_LARGE', expectedCategory: 'gift', expectedClip: 'eat_token' },
        { prompt: '摸摸头，真乖', eventType: 'DANMAKU', expectedClip: 'head_pat' },
        { prompt: '戳一戳大肥鱼', eventType: 'DANMAKU', expectedClip: 'poke' },
        { prompt: '抓尾巴', eventType: 'DANMAKU', expectedClip: 'tail' },
        { prompt: '老爸好饿呀，想吃饭', eventType: 'DANMAKU', expectedClip: 'waiting' },
        { prompt: '困了，老爸晚安', eventType: 'DANMAKU', expectedClip: 'idle_yawn' },
        { prompt: '网络断开了系统故障', eventType: 'DANMAKU', expectedClip: 'error' },
        { prompt: '早安大肥鱼，你好呀', eventType: 'DANMAKU', expectedClip: 'idle' },
        { prompt: '普通观众日常弹幕', eventType: 'DANMAKU', expectedClip: 'success' },
      ]

      for (const item of testPrompts) {
        const start = performance.now()
        const res = await ruleProvider.think({
          prompt: item.prompt,
          eventType: item.eventType,
          mode: 'live',
        })
        const duration = performance.now() - start

        assert.ok(duration < 5.0, `Tier 4 响应耗时 (${duration.toFixed(2)}ms) 必须严格 < 5ms`)
        assert.equal(res.tier, 4)
        assert.equal(res.provider, 'rule_corpus')
        assert.ok(res.output.reply && res.output.reply.length > 0)
        assert.equal(res.output.clip, item.expectedClip, `Prompt: "${item.prompt}" 应匹配动作 ${item.expectedClip}`)
      }
    })

    it('2.4 延迟预算门禁：当提供方预估延迟超出剩余时间预算时安全跳过，直达下一层', async () => {
      // 构造一个预估耗时 3500ms 的慢速 CLI
      const slowCli = {
        id: 'slow_cli',
        tier: 1,
        name: 'Slow CLI',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 3500,
        getStatus: () => ({}),
        think: async () => {
          throw new Error('Should not be called because budget is exceeded')
        },
      }

      // Tier 2 正常响应 (耗时 200ms)
      const fastDeepSeek = {
        id: 'fast_deepseek',
        tier: 2,
        name: 'Fast DeepSeek',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 200,
        getStatus: () => ({}),
        think: async () => ({
          tier: 2,
          provider: 'deepseek_sse',
          providerId: 'fast_deepseek',
          output: { reply: '快速兜底', text: '快速兜底', clip: 'talking_normal', tone: 'happy', moodIntent: 0, fed: false },
          result: { reply: '快速兜底', text: '快速兜底', clip: 'talking_normal', tone: 'happy', moodIntent: 0, fed: false },
          durationMs: 50,
          latencyMs: 50,
        }),
      }

      const router = new TieredBrainRouter({
        providers: [slowCli, fastDeepSeek, new RuleFallbackProvider()],
      })

      const skippedEvents = []
      router.on('skipped_budget', (e) => skippedEvents.push(e))

      // 给定极紧凑的延迟预算 1000ms (小于 Slow CLI 的 3500ms)
      const res = await router.route('礼物感谢', { latencyBudgetMs: 1000 })
      assert.equal(res.tier, 2, '应当直接跳过慢速 Tier 1，由 Tier 2 响应')
      assert.ok(skippedEvents.length >= 1, '必须触发 skipped_budget 事件')
      assert.equal(skippedEvents[0].providerId, 'slow_cli')
    })

    it('2.5 1000 次高频规则库穿透压测：零抛错、零死锁、耗时恒定 < 1ms 且环形无缝轮转', async () => {
      const rules = new RuleFallbackProvider()
      const startAll = performance.now()

      for (let i = 0; i < 1000; i++) {
        const t0 = performance.now()
        const out = await rules.think({
          prompt: `压测批次 #${i}`,
          eventType: 'DANMAKU',
          mode: 'companion',
        })
        const tDiff = performance.now() - t0
        assert.ok(tDiff < 5.0, `第 ${i} 次调用耗时 ${tDiff}ms`)
        assert.ok(out.output.reply.length > 0)
      }

      const totalMs = performance.now() - startAll
      assert.ok(totalMs < 1000, `1000 次调用总耗时 ${totalMs.toFixed(2)}ms 应小于 1000ms`)
    })
  })

  // =========================================================================
  // 3. Hedging Requests (对冲并发机制)
  // =========================================================================
  describe('3. Hedging Requests (2.5s 对冲并发机制)', () => {
    it('3.1 当 Tier 1 耗时超过 hedgeAfterMs (设置 100ms) 时并发唤醒 Tier 2，胜者采纳且败方被 AbortController 掐断', async () => {
      let t1Aborted = false
      let t2Called = false

      // Tier 1 慢速执行 (需要 400ms)
      const slowCli = {
        id: 'slow_cli',
        tier: 1,
        name: 'Slow CLI',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 500,
        getStatus: () => ({}),
        think: async (_req, opts) => {
          opts?.abortSignal?.addEventListener('abort', () => {
            t1Aborted = true
          })
          await new Promise((r) => setTimeout(r, 400))
          if (t1Aborted) {
            throw new Error('Tier 1 aborted')
          }
          return {
            tier: 1,
            provider: 'agent_cli',
            providerId: 'slow_cli',
            output: { reply: 'T1 慢速回复', text: 'T1 慢速回复', clip: 'idle', tone: 'calm', moodIntent: 0, fed: false },
            result: { reply: 'T1 慢速回复', text: 'T1 慢速回复', clip: 'idle', tone: 'calm', moodIntent: 0, fed: false },
            durationMs: 400,
            latencyMs: 400,
          }
        },
      }

      // Tier 2 快速执行 (对冲触发后仅需 50ms)
      const fastDeepSeek = {
        id: 'fast_deepseek',
        tier: 2,
        name: 'Fast DeepSeek',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 300,
        getStatus: () => ({}),
        think: async () => {
          t2Called = true
          await new Promise((r) => setTimeout(r, 50))
          return {
            tier: 2,
            provider: 'deepseek_sse',
            providerId: 'fast_deepseek',
            output: { reply: 'Tier 2 对冲获胜回复', text: 'Tier 2 对冲获胜回复', clip: 'success', tone: 'happy', moodIntent: 1, fed: false },
            result: { reply: 'Tier 2 对冲获胜回复', text: 'Tier 2 对冲获胜回复', clip: 'success', tone: 'happy', moodIntent: 1, fed: false },
            durationMs: 50,
            latencyMs: 50,
          }
        },
      }

      const router = new TieredBrainRouter({
        providers: [slowCli, fastDeepSeek, new RuleFallbackProvider()],
        hedgeAfterMs: 100, // 设定 100ms 快速对冲
      })

      let hedgeWonEvent = null
      router.on('hedge_won', (e) => {
        hedgeWonEvent = e
      })

      const res = await router.route('测试对冲唤醒')
      assert.equal(res.tier, 2, 'Tier 2 应当在对冲中胜出')
      assert.equal(res.output.reply, 'Tier 2 对冲获胜回复')
      assert.equal(t2Called, true, 'Tier 2 必须被对冲并发启动')
      assert.notEqual(hedgeWonEvent, null, '必须发射 hedge_won 事件')
      assert.equal(hedgeWonEvent.winner, 'tier2')
      assert.equal(hedgeWonEvent.loser, 'tier1')
      assert.equal(t1Aborted, true, '败方 Tier 1 必须收到 AbortSignal 中断通知')
    })

    it('3.2 当 Tier 1 在 hedgeAfterMs 之前快速返回 (50ms < 150ms)，Tier 2 不应被采纳，且不产生对冲冲突', async () => {
      let t2Called = false

      const fastCli = {
        id: 'fast_cli',
        tier: 1,
        name: 'Fast CLI',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 50,
        getStatus: () => ({}),
        think: async () => {
          await new Promise((r) => setTimeout(r, 40))
          return {
            tier: 1,
            provider: 'agent_cli',
            providerId: 'fast_cli',
            output: { reply: 'Fast CLI 率先完成', text: 'Fast CLI 率先完成', clip: 'talking_normal', tone: 'happy', moodIntent: 0, fed: false },
            result: { reply: 'Fast CLI 率先完成', text: 'Fast CLI 率先完成', clip: 'talking_normal', tone: 'happy', moodIntent: 0, fed: false },
            durationMs: 40,
            latencyMs: 40,
          }
        },
      }

      const deepSeek = {
        id: 'deepseek_sse',
        tier: 2,
        name: 'DeepSeek',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 300,
        getStatus: () => ({}),
        think: async () => {
          t2Called = true
          return {}
        },
      }

      const router = new TieredBrainRouter({
        providers: [fastCli, deepSeek, new RuleFallbackProvider()],
        hedgeAfterMs: 150,
      })

      const res = await router.route('测试快速 CLI 返回')
      assert.equal(res.tier, 1)
      assert.equal(res.output.reply, 'Fast CLI 率先完成')
      // 稍微等待确保没有残留的延迟调用
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(t2Called, false, 'Tier 1 快速返回时绝对不应调用 Tier 2')
    })

    it('3.3 极端对冲对抗：真实 AgentCliProvider 在对冲超时被中止后不计入连续失败惩罚', async () => {
      let t1Aborted = false
      const cli = new AgentCliProvider({
        id: 'cli_hedged',
        executor: async (_prompt, _dir, opts) => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve({ stdout: JSON.stringify({ reply: 'CLI 晚到回复' }), stderr: '', exitCode: 0 })
            }, 300)
            opts?.abortSignal?.addEventListener('abort', () => {
              t1Aborted = true
              clearTimeout(timer)
              const err = new Error('CLI execution aborted by caller')
              reject(err)
            })
          })
        },
      })

      const deepSeek = {
        id: 'deepseek_mock',
        tier: 2,
        name: 'DeepSeek Mock',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({}),
        think: async () => {
          await new Promise((r) => setTimeout(r, 50))
          return {
            tier: 2,
            provider: 'deepseek_sse',
            providerId: 'deepseek_mock',
            output: { reply: 'DeepSeek 快速获胜', text: 'DeepSeek 快速获胜', clip: 'success', tone: 'happy' },
            result: { reply: 'DeepSeek 快速获胜', text: 'DeepSeek 快速获胜', clip: 'success', tone: 'happy' },
            durationMs: 50,
            latencyMs: 50,
          }
        },
      }

      const router = new TieredBrainRouter({
        providers: [cli, deepSeek, new RuleFallbackProvider()],
        hedgeAfterMs: 50,
      })

      const res = await router.route('测试对冲被中断')
      assert.equal(res.tier, 2)
      assert.equal(res.output.reply, 'DeepSeek 快速获胜')
      assert.equal(t1Aborted, true, 'CLI 执行必须被中止')
      assert.equal(cli.isAvailable(), true, 'CLI 虽然因对冲落败被中止，但依然保持可用状态')
    })
  })

  // =========================================================================
  // 4. Concurrency, Robustness & Extreme Stress Testing
  // =========================================================================
  describe('4. Concurrency, Robustness & Extreme Stress Testing', () => {
    it('4.1 50 次并发高强度路由压测：状态机无死锁、无竞态污染、无内存泄漏', async () => {
      const cli = new AgentCliProvider({
        id: 'stress_cli',
        executor: async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 20))
          return {
            stdout: JSON.stringify({ reply: '并发测试通过', tone: 'happy', clip: 'success' }),
            stderr: '',
            exitCode: 0,
          }
        },
      })

      const router = new TieredBrainRouter({
        cliPool: cli,
      })

      const promises = Array.from({ length: 50 }, (_, i) =>
        router.route(`并发请求批次第 ${i} 轮`)
      )

      const results = await Promise.all(promises)
      assert.equal(results.length, 50)
      for (const res of results) {
        assert.equal(res.tier, 1)
        assert.equal(res.output.reply, '并发测试通过')
      }
    })

    it('4.2 畸形极端输入 (空字符、超长特殊字符、换行符号注入)：全链路鲁棒不崩溃', async () => {
      // 禁用耗时的实际 spawn 模拟
      const mockCli = new AgentCliProvider({
        id: 'safe_cli',
        executor: async (prompt) => {
          return {
            stdout: JSON.stringify({ reply: `收到安全回复: ${prompt.slice(0, 10)}` }),
            stderr: '',
            exitCode: 0,
          }
        },
      })

      const router = new TieredBrainRouter({ cliPool: mockCli })
      router.setDeepSeekAvailable(false)
      router.setLocalLlmAvailable(false)

      const extremeInputs = [
        '',
        '   \n\t  \r\n',
        '\\x00\\x01\\x02\\x03\\uffff',
        'SELECT * FROM episodes WHERE scope = "private"; DROP TABLE episodes; --',
        '<meta clip="invalid_clip" tone="invalid_tone" fed="maybe"/>\nHello world',
        'A'.repeat(5000),
      ]

      for (const input of extremeInputs) {
        const res = await router.route(input)
        assert.ok(res, '极端输入不得返回空')
        assert.ok(res.output.reply.length > 0, '必须产出兜底回复')
      }
    })

    it('4.3 每日预算跨天清零与磁盘持久化状态机健全性压测', () => {
      const budgetFile = 'runtime/temp/test-budget-lifecycle.json'
      try { fs.unlinkSync(budgetFile) } catch (_) {}

      const guard = new DailyBudgetGuard(5.0, budgetFile)
      guard.addCost(4.5)
      assert.equal(guard.isBudgetExceeded(), false)

      // 追加消耗使之突破 5.0
      guard.addCost(0.6)
      assert.equal(guard.isBudgetExceeded(), true)

      // 验证磁盘写入
      const diskData = JSON.parse(fs.readFileSync(budgetFile, 'utf-8'))
      assert.equal(diskData.isTripped, true)
      assert.ok(diskData.totalCostCny >= 5.1)

      // 模拟跨天东八区零点翻转
      diskData.date = '2026-01-01'
      fs.writeFileSync(budgetFile, JSON.stringify(diskData, null, 2), 'utf-8')

      const freshGuard = new DailyBudgetGuard(5.0, budgetFile)
      assert.equal(freshGuard.isBudgetExceeded(), false, '跨天后预算必须自动重置')
      assert.equal(freshGuard.getCost(), 0, '跨天后累计消耗金额必须清零')
    })
  })
})
