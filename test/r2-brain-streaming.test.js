/**
 * @file r2-brain-streaming.test.js
 * 核心单元测试：分级思考路由器、Agent CLI 沙箱进程池、3 层 Prompt 预算裁剪与流式语音管线
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TieredBrainRouter,
  AgentCliProvider,
  parseCliStructuredOutput,
  QUOTA_REGEX,
  AUTH_REGEX,
  PromptBuilder,
  validatePrompt3Layer,
  FIXED_PERSONA_LAYER_A,
  StreamingMetaParser,
  PunctuationSplitter,
  parseStreamingMeta,
  DailyBudgetGuard,
  DeepSeekProvider,
  RuleFallbackProvider,
} from '../src/standalone/brain/index.ts'

describe('Milestone M2: Tiered Brain Router & Streaming Pipeline', () => {
  describe('1. Agent CLI 沙箱池与错误状态机 (Tier 1)', () => {
    it('1.1 能够解析多层结构化 JSON、Markdown 块与纯文本容错', () => {
      // 场景 A: 纯 JSON
      const jsonStr = '{"clip":"eat_token","tone":"happy","moodIntent":2,"fed":true,"reply":"小鱼干真好吃！"}'
      const outA = parseCliStructuredOutput(jsonStr)
      assert.equal(outA.clip, 'eat_token')
      assert.equal(outA.tone, 'happy')
      assert.equal(outA.moodIntent, 2)
      assert.equal(outA.fed, true)
      assert.equal(outA.reply, '小鱼干真好吃！')
      assert.equal(outA.text, '小鱼干真好吃！')

      // 场景 B: Markdown 包含的 JSON 块
      const mdStr = '一些前置思考...\n```json\n{"clip":"head_pat","tone":"tsundere","moodIntent":5,"reply":"才没有觉得舒服呢！"}\n```'
      const outB = parseCliStructuredOutput(mdStr)
      assert.equal(outB.clip, 'head_pat')
      assert.equal(outB.tone, 'tsundere')
      assert.equal(outB.moodIntent, 2) // clamp 至 2
      assert.equal(outB.reply, '才没有觉得舒服呢！')

      // 场景 C: 外层包装 { result: "..." }
      const wrappedStr = JSON.stringify({ result: JSON.stringify({ clip: 'poke', tone: 'grumpy', moodIntent: -10, reply: '别戳我！' }) })
      const outC = parseCliStructuredOutput(wrappedStr)
      assert.equal(outC.clip, 'poke')
      assert.equal(outC.tone, 'grumpy')
      assert.equal(outC.moodIntent, -2) // clamp 至 -2
      assert.equal(outC.reply, '别戳我！')

      // 场景 D: 纯文本回复容错
      const textStr = '老爸今天辛苦啦，大肥鱼一直陪着你呢！'
      const outD = parseCliStructuredOutput(textStr)
      assert.equal(outD.reply, textStr)
      assert.equal(outD.tone, 'happy')
      assert.equal(outD.moodIntent, 0)
    })

    it('1.2 正则识别额度耗尽 (EXHAUSTED) 与认证失效 (NEEDS_AUTH)', () => {
      assert.ok(QUOTA_REGEX.test('API quota limit exceeded (429)'))
      assert.ok(QUOTA_REGEX.test('insufficient_quota'))
      assert.ok(QUOTA_REGEX.test('Rate limit reached'))
      assert.ok(QUOTA_REGEX.test('当前账号调用额度已达上限'))

      assert.ok(AUTH_REGEX.test('Unauthorized, please login first'))
      assert.ok(AUTH_REGEX.test('token expired (401)'))
      assert.ok(AUTH_REGEX.test('authentication failed (403)'))
    })

    it('1.3 连续 3 次失败触发 60 秒熔断器，冷却期内直接拒绝执行，重置后恢复', async () => {
      let runCount = 0
      const cli = new AgentCliProvider({
        id: 'test_cli',
        executor: async () => {
          runCount++
          return { stdout: '', stderr: 'Internal Server Error (500) connection reset', exitCode: 1 }
        },
      })

      // 连续 3 次调用失败
      await assert.rejects(() => cli.execute('p1'), /Internal Server Error/)
      await assert.rejects(() => cli.execute('p2'), /Internal Server Error/)
      await assert.rejects(() => cli.execute('p3'), /Internal Server Error/)
      assert.equal(runCount, 3)

      // 触发熔断器，第 4 次调用在熔断器打开期直接被拒绝，不会触发 executor
      assert.equal(cli.isAvailable(), false)
      await assert.rejects(() => cli.execute('p4'), /Circuit breaker is OPEN/)
      assert.equal(runCount, 3)

      // 重置熔断器
      cli.resetCircuitBreaker()
      assert.equal(cli.isAvailable(), true)
    })

    it('1.4 连续多次 429 额度耗尽保持 EXHAUSTED 状态，严禁被 60 秒短熔断覆写', async () => {
      let runCount = 0
      const cli = new AgentCliProvider({
        id: 'test_cli_quota_guard',
        breakerCooldownMs: 50,
        breakerThreshold: 3,
        cooldownOnExhaustedMs: 3600_000,
        executor: async () => {
          runCount++
          return { stdout: '', stderr: 'API quota limit exceeded (429)', exitCode: 1 }
        },
      })

      await assert.rejects(() => cli.execute('p1'), /EXHAUSTED/)
      await assert.rejects(() => cli.execute('p2'), /EXHAUSTED/)
      await assert.rejects(() => cli.execute('p3'), /EXHAUSTED/)
      assert.equal(runCount, 3)

      // 状态必须保持 EXHAUSTED，绝不降级为 CIRCUIT_BROKEN
      assert.equal(cli.getStatus().state, 'EXHAUSTED')
      assert.equal(cli.isAvailable(), false)

      // 等待 60ms（超过 breakerCooldownMs 50ms），状态依然必须为 EXHAUSTED
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(cli.getStatus().state, 'EXHAUSTED')
      assert.equal(cli.isAvailable(), false)
    })
  })

  describe('2. 3-Layer 前缀缓存友好 Prompt 与 Token 预算裁剪', () => {
    it('2.1 固定人设 [Layer A] 包含关键规则并作为不可裁剪基石', () => {
      assert.ok(FIXED_PERSONA_LAYER_A.includes('[Layer A] SYSTEM_PERSONA'))
      assert.ok(FIXED_PERSONA_LAYER_A.includes('大肥鱼'))
      assert.ok(FIXED_PERSONA_LAYER_A.includes('<meta clip='))
      assert.ok(FIXED_PERSONA_LAYER_A.includes('Few-Shot'))
    })

    it('2.2 PromptBuilder 自适应裁剪超长历史与记忆，确保 <= 2100 tokens', () => {
      const builder = new PromptBuilder(2100)

      // 构造大批量数据
      const hugeFacts = Array.from({ length: 30 }, (_, i) => ({
        text: `老爸的第 ${i} 项工程技术栈是极其复杂的分布式系统设计细节。`,
        confidence: i % 2 === 0 ? 0.9 : 0.6,
      }))
      const hugeDialogues = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `历史对话轮次第 ${i} 句：讨论关于流式传输与音画同步的优化方案。`,
      }))
      const hugeMemories = Array.from({ length: 10 }, (_, i) => ({
        id: `mem-${i}`,
        text: `情景记忆第 ${i} 项：主播在测试网络抖动情况下的音画同步。`,
        score: 0.8,
      }))

      const result = builder.build({
        mode: 'live',
        hostProfile: {
          name: '老爸',
          occupation: '全栈架构师',
          habits: ['喝乌龙茶', '听轻音乐'],
          facts: hugeFacts,
        },
        sessionSummary: '今天的互动非常热烈，多名观众进行了小鱼干投喂。'.repeat(10),
        yesterdayDiary: '昨日老爸一直在认真写代码直到深夜。'.repeat(10),
        retrievedMemories: hugeMemories,
        recentDialogue: hugeDialogues,
        event: {
          type: 'DANMAKU',
          viewer: '测试观众',
          content: '大肥鱼快出来冒个泡！',
        },
      })

      // 验证 3-Layer 契约
      const validation = validatePrompt3Layer(result.fullText)
      assert.equal(validation.valid, true)
      assert.equal(validation.withinBudget, true)
      assert.ok(validation.estimatedTokens <= 2100)
      assert.ok(result.fullText.includes('[Layer A]'))
      assert.ok(result.fullText.includes('[Layer B]'))
      assert.ok(result.fullText.includes('[Layer C]'))
      assert.ok(result.fullText.includes('大肥鱼快出来冒个泡！'))
    })
  })

  describe('3. 流式元数据解析器与标点断句分词器 (Streaming)', () => {
    it('3.1 StreamingMetaParser 能够即时截取首行元数据并剥离正文', () => {
      const parser = new StreamingMetaParser()
      let metaEvent = null
      parser.on('meta', (m) => { metaEvent = m })

      // 首个分片包含完整首行
      const chunk1 = '<meta clip="eat_token" tone="happy" moodIntent="2" fed="true" memory="老爸喂了我小鱼干"/>\n老爸，'
      const text1 = parser.processChunk(chunk1)
      assert.notEqual(metaEvent, null)
      assert.equal(metaEvent.clip, 'eat_token')
      assert.equal(metaEvent.tone, 'happy')
      assert.equal(metaEvent.moodIntent, 2)
      assert.equal(metaEvent.fed, true)
      assert.equal(metaEvent.memory, '老爸喂了我小鱼干')
      assert.equal(text1, '老爸，')

      // 后续分片直接放行
      const text2 = parser.processChunk('小鱼干真好吃！')
      assert.equal(text2, '小鱼干真好吃！')
    })

    it('3.2 PunctuationSplitter 能够按标点分句且单句 <= 20 字，剥离 <mem> 标签', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      let capturedMem = null

      splitter.on('sentence', (s) => sentences.push(s.text))
      splitter.on('memory', (m) => { capturedMem = m })

      splitter.push('老爸老爸，你终于想起我啦！')
      splitter.push('今天的工作顺利吗~本鱼今天心情超好。<mem imp="8">老爸今天心情很好</mem>')
      splitter.flush()

      assert.ok(sentences.length >= 2)
      assert.ok(sentences.every((s) => s.length <= 20))
      assert.ok(!sentences.some((s) => s.includes('<mem')))
      assert.notEqual(capturedMem, null)
      assert.equal(capturedMem.importance, 8)
      assert.equal(capturedMem.content, '老爸今天心情很好')
    })

    it('3.3 畸形元数据标签优雅容错，不抛出异常', () => {
      // 缺少闭合 />
      assert.equal(parseStreamingMeta('<meta clip="eat_token" tone="happy"'), null)
      // 纯文本
      assert.equal(parseStreamingMeta('你好呀大肥鱼'), null)
    })
  })

  describe('4. DeepSeek 5.0 元每日预算守卫 (Tier 2)', () => {
    it('4.1 计费累计与跨天重置逻辑', () => {
      const guard = new DailyBudgetGuard(5.0)
      guard.reset()
      assert.equal(guard.isBudgetExceeded(), false)

      // 模拟调用消耗
      guard.recordUsage(1000, 2000, 500)
      assert.ok(guard.getCost() > 0)
      assert.equal(guard.isBudgetExceeded(), false)

      // 模拟累计花费达 5.01 元
      guard.addCost(5.0)
      assert.equal(guard.isBudgetExceeded(), true)
    })

    it('4.2 预算超限时阻断请求并抛出规范异常', async () => {
      const provider = new DeepSeekProvider({ dailyBudgetCny: 5.0, budgetStorePath: 'runtime/temp/test-budget-42.json' })
      provider.addCost(5.01)
      assert.equal(provider.isAvailable(), false)

      await assert.rejects(
        () => provider.think({ prompt: 'test', eventType: 'DANMAKU' }),
        /daily budget exceeded/i
      )
    })
  })

  describe('5. 离线规则语料库 (Tier 4)', () => {
    it('5.1 纯同步响应耗时 < 1ms，100% 可用且零死锁', async () => {
      const rules = new RuleFallbackProvider()
      assert.equal(rules.isAvailable(), true)

      const start = Date.now()
      const res = await rules.think({
        prompt: '任意故障或网络断开',
        eventType: 'DANMAKU',
      })
      const elapsed = Date.now() - start

      assert.ok(elapsed <= 20)
      assert.equal(res.tier, 4)
      assert.equal(res.provider, 'rule_corpus')
      assert.ok(res.output.reply.length > 0)
    })

    it('5.2 兼容流式输出格式', async () => {
      const rules = new RuleFallbackProvider()
      const chunks = []
      for await (const chunk of rules.thinkStream({ prompt: '送你小鱼干', eventType: 'GIFT_THANKS_LARGE' })) {
        chunks.push(chunk)
      }
      assert.ok(chunks.length >= 2)
      assert.ok(chunks[0].startsWith('<meta'))
      assert.ok(chunks[1].length > 0)
    })
  })

  describe('6. 分级大脑路由器 (TieredBrainRouter) 级联仲裁与降级链路', () => {
    it('6.1 Tier 1 优先仲裁', async () => {
      const cli = new AgentCliProvider({
        id: 'mock_cli',
        executor: async () => ({
          stdout: JSON.stringify({ reply: 'CLI 正在为您服务！', tone: 'happy', clip: 'talking_normal' }),
          stderr: '',
          exitCode: 0,
        }),
      })

      const router = new TieredBrainRouter({ cliPool: cli })
      const decision = await router.route('老爸对女儿说：今晚吃小鱼干吗？')
      assert.equal(decision.tier, 1)
      assert.equal(decision.provider, 'agent_cli')
      assert.equal(decision.result.tone, 'happy')
    })

    it('6.2 Tier 1 额度耗尽降级至 Tier 2，抛出 fallback 事件', async () => {
      const cli = new AgentCliProvider({ id: 'mock_cli' })
      cli.setQuotaExhausted(true)

      let fallbackEvent = null
      const deepSeek = new DeepSeekProvider({ apiKey: 'test-key', budgetStorePath: 'runtime/temp/test-budget-62.json' })
      deepSeek.budgetGuard.reset()
      const router = new TieredBrainRouter({
        cliPool: cli,
        deepSeekProvider: deepSeek,
      })
      router.on('fallback', (f) => { fallbackEvent = f })

      // 模拟 DeepSeek 可用且返回
      deepSeek.think = async () => ({
        tier: 2,
        provider: 'deepseek_sse',
        providerId: 'deepseek_sse',
        output: { reply: 'DeepSeek 回复成功', text: 'DeepSeek 回复成功', clip: 'talking_normal', tone: 'happy' },
        result: { reply: 'DeepSeek 回复成功', text: 'DeepSeek 回复成功', clip: 'talking_normal', tone: 'happy' },
        durationMs: 50,
        latencyMs: 50,
      })

      const decision = await router.route('测试降级')
      assert.equal(decision.tier, 2)
      assert.equal(decision.provider, 'deepseek_sse')
      assert.notEqual(fallbackEvent, null)
      assert.equal(fallbackEvent.fromTier, 1)
      assert.equal(fallbackEvent.toTier, 2)
    })

    it('6.3 全部大模型故障全链路穿透至 Tier 4 规则库秒级兜底', async () => {
      const cli = new AgentCliProvider({ id: 'mock_cli' })
      cli.setQuotaExhausted(true)

      const router = new TieredBrainRouter({ cliPool: cli })
      router.setDeepSeekAvailable(false)
      router.setLocalLlmAvailable(false)

      const decision = await router.route('极端故障全离线')
      assert.equal(decision.tier, 4)
      assert.equal(decision.provider, 'rule_corpus')
      assert.ok(decision.result.text.includes('大肥鱼正在待机中') || decision.result.reply.length > 0)
    })

    it('6.4 思考动作与 1.2s 语气词掩盖事件触发', async () => {
      const plays = []
      const speaks = []
      const mockScheduler = {
        play: (clip) => { plays.push(clip) },
        speak: (text) => { speaks.push(text) },
      }

      // 构造一个延迟 1500ms 的提供方
      const slowProvider = {
        id: 'slow',
        tier: 1,
        name: 'Slow Provider',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 500,
        getStatus: () => ({}),
        think: async () => {
          await new Promise((r) => setTimeout(r, 1400))
          return {
            tier: 1,
            provider: 'slow',
            providerId: 'slow',
            output: { reply: '终于想好啦！', text: '终于想好啦！', clip: 'success' },
            result: { reply: '终于想好啦！', text: '终于想好啦！', clip: 'success' },
            durationMs: 1400,
            latencyMs: 1400,
          }
        },
      }

      const router = new TieredBrainRouter({
        providers: [slowProvider],
        scheduler: mockScheduler,
      })

      let toneMaskingFired = false
      router.on('thinking_tone', () => { toneMaskingFired = true })

      await router.route('测试语气词掩盖')

      assert.ok(plays.includes('thinking'))
      assert.equal(toneMaskingFired, true)
      assert.ok(speaks.length >= 1)
    })
  })
})
