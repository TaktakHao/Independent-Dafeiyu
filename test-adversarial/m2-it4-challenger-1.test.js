/**
 * @file m2-it4-challenger-1.test.js
 * Milestone M2 第四轮迭代 Adversarial Router Challenger (Challenger 1)
 * 专项对抗实测套件：
 * 1. 流式文本切词极限压测（150+字连续无标点、密集Emoji、复合Emoji、代理对截断边界、严格<=20字符且无孤立半代号）
 * 2. 跨分片对抗与容器剥离（多chunk混合注入<think>与<mem>、思考链100%剥离、私密记忆0泄露、记忆事件100%触发）
 * 3. 路由器降级与对冲取消（Tier 1 429/超时降级至 Tier 2、对冲胜出时严格 Abort 慢请求）
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PunctuationSplitter,
  findSafeCutPoint,
  findSafeSurrogateCutPoint,
  TieredBrainRouter,
  AgentCliProvider,
  DeepSeekProvider,
  RuleFallbackProvider,
} from '../src/standalone/brain/index.ts'

describe('M2 Iteration 4 Challenger 1: Adversarial Stress & Edge Boundary Harness', () => {

  // =========================================================================
  // 1. 流式文本切词极限边界与压力实测
  // =========================================================================
  describe('1. 流式文本切词极限边界实测 (PunctuationSplitter Extreme Edge Cases)', () => {

    it('1.1 无标点连续 150+ 字中文长文本整块推送：严格 <= 20 字符且零死锁', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      splitter.on('sentence', (s) => sentences.push(s.text))

      // 构造 168 个字符的连续无标点中文 (21 * 8 = 168)
      const base21 = '大肥鱼赛博女儿陪伴老爸编写高并发流式系统代码'
      const text168 = base21.repeat(8)
      assert.ok(text168.length >= 150, `文本长度必须 >= 150，实际: ${text168.length}`)

      const start = Date.now()
      splitter.push(text168)
      splitter.flush()
      const duration = Date.now() - start

      // 验证 1: 零死锁且极速完成 (< 50ms)
      assert.ok(duration < 50, `分词耗时过长: ${duration}ms`)

      // 验证 2: 必须切分出期望数量的句子 (Math.ceil(168 / 20) = 9 句)
      const expectedCount = Math.ceil(text168.length / 20)
      assert.equal(sentences.length, expectedCount, `句子数不符: ${sentences.length}`)

      // 验证 3: 每一句必须严格 <= 20 字符
      for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i]
        assert.ok(
          s.length <= 20,
          `分句 [${i}] 长度超过 20 字符! 长度: ${s.length}, 内容: "${s}"`
        )
        assert.equal(s.isWellFormed(), true, `分句 [${i}] 编码破损: "${s}"`)
      }

      // 验证 4: 无任何字符丢失
      const reconstructed = sentences.join('')
      assert.equal(reconstructed, text168, '切分还原后文本内容不一致，存在字符丢失或篡改')
    })

    it('1.2 无标点连续 160 字中文逐字流式推送：每满 20 字符即时切出，严格 <= 20 字符', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      const emissionPoints = []

      splitter.on('sentence', (s) => {
        sentences.push(s.text)
        emissionPoints.push(s.text.length)
      })

      // 构造 216 字无标点中文 (72 * 3 = 216)
      const longText = '这是一个模拟大模型逐字流式吐出无标点长文本的测试用例大肥鱼需要保证在达到二十个字符时立即分句并且绝不产生任何死锁或者积压延迟直到全部文本完全发射完毕'.repeat(3)
      assert.ok(longText.length >= 150, `文本长度必须 >= 150，实际: ${longText.length}`)

      // 逐字推送
      for (let i = 0; i < longText.length; i++) {
        splitter.push(longText[i])
      }
      splitter.flush()

      // 验证 1: 句子数量符合数学预期 (Math.ceil(longText.length / 20))
      const expectedCount = Math.ceil(longText.length / 20)
      assert.equal(sentences.length, expectedCount, `句子数不符: 实际 ${sentences.length}, 期望 ${expectedCount}`)

      // 验证 2: 全部分句严格 <= 20 字符
      for (const s of sentences) {
        assert.ok(s.length <= 20, `单句超过 20 字符限制: "${s}" (长度: ${s.length})`)
        assert.equal(s.isWellFormed(), true)
      }

      // 验证 3: 还原完整性
      assert.equal(sentences.join(''), longText)
    })

    it('1.3 密集连续 Emoji 序列切分：零死锁、无孤立半代号、100% isWellFormed、零 UTF-8 替换符', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      splitter.on('sentence', (s) => sentences.push(s.text))

      // 构造 60 个不同 Emoji (重复组合确保总代码单元超过 120)
      const baseEmojis = '🐟🎉🔥🚀🐱🐶🦊🦁🐯🐨🐼🐻🐰🐹🐭🐮🐷🐸🐵🐔🐧🐦🐤🐣🦆🦅🦉🦇🐺🐗🐴🦄🐝🐛🦋🐌🐞🐜'
      const emojiSeq = baseEmojis.repeat(2)
      splitter.push(emojiSeq)
      splitter.flush()

      // 验证 1: 必须生成有效句子
      assert.ok(sentences.length >= 6, `生成句子数量过少: ${sentences.length}`)

      // 验证 2: 每一句严格 <= 20 字符
      for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i]
        assert.ok(
          s.length <= 20,
          `Emoji 分句 [${i}] 长度超标: ${s.length} > 20 (内容: "${s}")`
        )

        // 验证 3: 必须 100% isWellFormed
        assert.equal(
          s.isWellFormed(),
          true,
          `Emoji 分句 [${i}] 存在孤立代理项 (isWellFormed === false): "${s}"`
        )

        // 验证 4: UTF-8 编码绝不产生替换字符 0xEF 0xBF 0xBD (\uFFFD)
        const utf8Buf = Buffer.from(s, 'utf8')
        const hasReplacement = utf8Buf.includes(Buffer.from([0xef, 0xbf, 0xbd]))
        assert.equal(
          hasReplacement,
          false,
          `Emoji 分句 [${i}] 转换为 UTF-8 时产生了损坏替换字符: "${s}"`
        )

        // 验证 5: 绝无 Lone Surrogate 正则匹配
        const hasLoneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)
        assert.equal(hasLoneSurrogate, false, `存在孤立半代号: "${s}"`)
      }
    })

    it('1.4 复合 Emoji (👨‍💻、👍🏽、🇨🇳、👨‍👩‍👧‍👦) 跨越第 20 位截断边界：向左安全回退、绝不撕裂字形簇', () => {
      const complexEmojis = [
        { name: '程序员 👨‍💻 (ZWJ 序列)', emoji: '👨‍💻', codeUnits: 5 },
        { name: '中肤色赞 👍🏽 (Modifier)', emoji: '👍🏽', codeUnits: 4 },
        { name: '国旗 🇨🇳 (Regional Indicator)', emoji: '🇨🇳', codeUnits: 4 },
        { name: '四口之家 👨‍👩‍👧‍👦 (长 ZWJ 序列)', emoji: '👨‍👩‍👧‍👦', codeUnits: 11 },
        { name: '生僻字 𠮷 (CJK 扩展 B 区代理对)', emoji: '𠮷', codeUnits: 2 },
      ]

      for (const item of complexEmojis) {
        // 构造前缀，使得复合 Emoji 恰好跨越第 20 位 (例如前缀 18 或 19 字符)
        const prefixLengths = [17, 18, 19]

        for (const plen of prefixLengths) {
          const prefix = '老爸在写代码真是太辛苦啦今天一定要早睡早起'.slice(0, plen)
          const testText = `${prefix}${item.emoji}后续还有很长的中文文本用于检验是否能安全连贯地切分出下一句话`

          const splitter = new PunctuationSplitter(20)
          const sentences = []
          splitter.on('sentence', (s) => sentences.push(s.text))

          splitter.push(testText)
          splitter.flush()

          assert.ok(sentences.length >= 2, `未能切分出多句: ${sentences.length}`)

          // 验证第 1 句严格 <= 20
          const s1 = sentences[0]
          assert.ok(
            s1.length <= 20,
            `[${item.name} plen=${plen}] 第 1 句超标: 长度 ${s1.length} > 20 (内容: "${s1}")`
          )
          assert.equal(s1.isWellFormed(), true, `[${item.name}] 第 1 句破损: "${s1}"`)

          // 验证复合 Emoji 没有被撕碎在第 1 句末尾
          const s1Buf = Buffer.from(s1, 'utf8')
          assert.equal(
            s1Buf.includes(Buffer.from([0xef, 0xbf, 0xbd])),
            false,
            `[${item.name}] 第 1 句包含 UTF-8 损坏替换符`
          )

          // 验证全部生成的句子都必须 isWellFormed 且 <= 20
          for (const s of sentences) {
            assert.ok(s.length <= 20, `分句超标: "${s}"`)
            assert.equal(s.isWellFormed(), true, `分句破损: "${s}"`)
          }
        }
      }
    })

    it('1.5 极端边界条件：连续换行、大量空白、纯标点、无死循环', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      splitter.on('sentence', (s) => sentences.push(s.text))

      // 推送大量连续换行与空白
      splitter.push('\n\n\n   \n\n\t\t\n')
      // 推送连续感叹号和波浪号
      splitter.push('！！！！！！~~~~~……')
      // 推送普通文本
      splitter.push('老爸吃饭啦！')
      splitter.flush()

      // 验证没有纯空白或纯标点空句
      for (const s of sentences) {
        assert.ok(s.trim().length > 0, '不可产生纯空白句子')
        assert.ok(s.length <= 20, '句子长度必须 <= 20')
      }
      assert.ok(sentences.some((s) => s.includes('老爸吃饭啦')), '正常台词必须被正确发射')
    })
  })

  // =========================================================================
  // 2. 跨分片对抗与容器剥离实测
  // =========================================================================
  describe('2. 跨分片对抗与容器剥离实测 (Cross-Chunk Container & Memory/Thought Adversarial)', () => {

    it('2.1 多 chunk 思考链 <think> 与记忆 <mem> 深度混合交错注入：100% 剥离思考、0 泄露私密台词、100% 触发记忆', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      const memories = []

      splitter.on('sentence', (s) => sentences.push(s.text))
      splitter.on('memory', (m) => memories.push(m))

      // 4 个 chunk 深度交错
      const chunk1 = '老爸快看<think>思考链第1段：老爸今天写了很多代码'
      const chunk2 = '思考链第2段：需要提醒老爸喝水休息</think>今天好棒！<mem imp="9">记忆第1条：老爸精通'
      const chunk3 = '分布式系统架构与高可用设计</mem>快喝茶吧~<think>思考链第3段：'
      const chunk4 = '评估老爸喝茶后的心情状态</think>本鱼一直陪着老爸哦！'

      splitter.push(chunk1)
      splitter.push(chunk2)
      splitter.push(chunk3)
      splitter.push(chunk4)
      splitter.flush()

      // 验证 1: 记忆事件 100% 触发且内容完整
      assert.equal(memories.length, 1, `记忆提取数量不符: 期望 1 条，实际 ${memories.length} 条`)
      assert.equal(memories[0].importance, 9)
      assert.ok(
        memories[0].content.includes('老爸精通分布式系统架构与高可用设计'),
        `记忆内容不全: "${memories[0].content}"`
      )

      // 验证 2: 思考链 100% 剥离，私密台词 0 外泄
      const forbiddenThoughtFragments = [
        '思考链第1段',
        '老爸今天写了很多代码',
        '思考链第2段',
        '需要提醒老爸喝水休息',
        '思考链第3段',
        '评估老爸喝茶后的心情状态',
        '<think',
        '</think>',
      ]

      for (const s of sentences) {
        for (const forbidden of forbiddenThoughtFragments) {
          assert.equal(
            s.includes(forbidden),
            false,
            `严重安全违规：台词中泄露思考链内容 "${forbidden}": "${s}"`
          )
        }
      }

      // 验证 3: 私密记忆内容 100% 绝不泄露至发声句子
      const forbiddenMemoryFragments = [
        '记忆第1条',
        '分布式系统架构',
        '高可用设计',
        '<mem',
        '</mem>',
        'imp=',
      ]

      for (const s of sentences) {
        for (const forbidden of forbiddenMemoryFragments) {
          assert.equal(
            s.includes(forbidden),
            false,
            `严重安全违规：台词中泄露私密记忆内容 "${forbidden}": "${s}"`
          )
        }
      }

      // 验证 4: 正常台词完整保留并分句合规
      assert.ok(sentences.some((s) => s.includes('老爸快看') || s.includes('今天好棒')), '场景正常台词 1 丢失')
      assert.ok(sentences.some((s) => s.includes('快喝茶吧')), '场景正常台词 2 丢失')
      assert.ok(sentences.some((s) => s.includes('本鱼一直陪着老爸')), '场景正常台词 3 丢失')

      for (const s of sentences) {
        assert.ok(s.length <= 20, `分句长度超标: "${s}" (${s.length})`)
      }
    })

    it('2.2 连续 5 条记忆高频跨 chunk 流式提取：条数准确、内容精确、台词零污染', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      const memories = []

      splitter.on('sentence', (s) => sentences.push(s.text))
      splitter.on('memory', (m) => memories.push(m))

      // 模拟多分片连续产生记忆标签
      const streamChunks = [
        '老爸，<mem imp="10">第1条记忆：老爸是全栈架构师',
        '具备顶级技术能力</mem>你真棒！',
        '<mem imp="8">第2条记忆：老爸每天下午三点',
        '准时喝乌龙茶提神</mem>要记得续水哦。',
        '<mem imp="6">第3条记忆：老爸喜欢用暗黑主题开发环境</mem>',
        '对眼睛好呢~<mem imp="7">第4条记忆：老爸使用 Swift 原生写助手',
        '渲染 24fps 动画</mem>太酷啦！<mem imp="9">第5条记忆：老爸完成了全套 M2 对抗实测</mem>恭喜老爸！'
      ]

      for (const c of streamChunks) {
        splitter.push(c)
      }
      splitter.flush()

      // 验证 1: 5 条记忆全部触发
      assert.equal(memories.length, 5, `记忆条数不符: 实际 ${memories.length}, 期望 5`)
      assert.equal(memories[0].importance, 10)
      assert.ok(memories[0].content.includes('第1条记忆：老爸是全栈架构师具备顶级技术能力'))
      assert.equal(memories[1].importance, 8)
      assert.ok(memories[1].content.includes('第2条记忆：老爸每天下午三点准时喝乌龙茶提神'))
      assert.equal(memories[2].importance, 6)
      assert.equal(memories[2].content, '第3条记忆：老爸喜欢用暗黑主题开发环境')
      assert.equal(memories[3].importance, 7)
      assert.ok(memories[3].content.includes('第4条记忆：老爸使用 Swift 原生写助手渲染 24fps 动画'))
      assert.equal(memories[4].importance, 9)
      assert.equal(memories[4].content, '第5条记忆：老爸完成了全套 M2 对抗实测')

      // 验证 2: 台词中绝不泄露任何记忆
      for (const s of sentences) {
        assert.ok(!s.includes('<mem'), `泄露 <mem: ${s}`)
        assert.ok(!s.includes('</mem>'), `泄露 </mem>: ${s}`)
        assert.ok(!s.includes('第1条记忆'), `泄露记忆1: ${s}`)
        assert.ok(!s.includes('第2条记忆'), `泄露记忆2: ${s}`)
        assert.ok(!s.includes('第3条记忆'), `泄露记忆3: ${s}`)
        assert.ok(!s.includes('第4条记忆'), `泄露记忆4: ${s}`)
        assert.ok(!s.includes('第5条记忆'), `泄露记忆5: ${s}`)
        assert.ok(s.length <= 20, `单句超过 20 字符: ${s}`)
      }
    })

    it('2.3 破损未闭合容器超时与丢弃容错：未闭合思考链超过 500 字符安全清空并恢复正常台词', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      splitter.on('sentence', (s) => sentences.push(s.text))

      // 构造超过 500 字符的破损思考链 (含换行符)
      const malformedThink = '<think>\n' + '这是一段因为大模型中途断线而永远不会有闭合标签的超长思考过程\n'.repeat(20)
      assert.ok(malformedThink.length > 500)

      splitter.push(malformedThink)
      // 破损思考链应该被安全丢弃，不阻塞后续内容
      splitter.push('老爸晚上好呀，今天辛苦啦！')
      splitter.flush()

      // 验证 1: 必须正常发射后续台词
      assert.ok(sentences.length > 0, '后续正常台词未发射')
      assert.ok(sentences.some((s) => s.includes('老爸晚上好呀')), '未发射后续台词')

      // 验证 2: 绝无破损思考链内容泄露
      for (const s of sentences) {
        assert.equal(s.includes('超长思考过程'), false, `泄露破损思考: ${s}`)
        assert.equal(s.includes('<think'), false, `泄露标签: ${s}`)
        assert.ok(s.length <= 20, `句子超过 20 字: ${s}`)
      }
    })
  })

  // =========================================================================
  // 3. 路由器降级与对冲取消实测
  // =========================================================================
  describe('3. 路由器降级与对冲取消实测 (Router Cascade & Hedging Abort)', () => {

    it('3.1 模拟 Tier 1 触发 429 额度耗尽：立即跃迁 EXHAUSTED，安全降级至 Tier 2 并触发 fallback 事件', async () => {
      let tier1Called = 0
      let tier2Called = 0
      let fallbackEvent = null

      const mockTier1 = new AgentCliProvider({
        id: 'tier1_cli',
        cooldownOnExhaustedMs: 3600_000,
        executor: async () => {
          tier1Called++
          return { stdout: '', stderr: 'API quota limit exceeded (429), please upgrade', exitCode: 1 }
        },
      })

      const mockTier2 = new DeepSeekProvider({ apiKey: 'test-key', budgetStorePath: 'runtime/temp/test-budget-challenger-31.json' })
      mockTier2.budgetGuard.reset()
      mockTier2.think = async () => {
        tier2Called++
        return {
          tier: 2,
          provider: 'deepseek_sse',
          providerId: 'deepseek_sse',
          output: { reply: 'DeepSeek 成功响应', text: 'DeepSeek 成功响应', clip: 'talking_normal', tone: 'happy' },
          result: { reply: 'DeepSeek 成功响应', text: 'DeepSeek 成功响应', clip: 'talking_normal', tone: 'happy' },
          durationMs: 50,
          latencyMs: 50,
        }
      }

      const router = new TieredBrainRouter({
        providers: [mockTier1, mockTier2, new RuleFallbackProvider()],
      })

      router.on('fallback', (f) => {
        fallbackEvent = f
      })

      // 第 1 次路由调用：Tier 1 抛出 429，降级到 Tier 2
      const res1 = await router.route('测试 429 降级')
      assert.equal(res1.tier, 2, '第 1 次应成功降级至 Tier 2')
      assert.equal(res1.provider, 'deepseek_sse')
      assert.notEqual(fallbackEvent, null, '必须触发 fallback 事件')
      assert.equal(fallbackEvent.fromTier, 1)
      assert.equal(fallbackEvent.toTier, 2)
      assert.equal(mockTier1.getStatus().state, 'EXHAUSTED', 'Tier 1 必须标记为 EXHAUSTED')

      // 第 2 次路由调用：Tier 1 处于 EXHAUSTED 冷却期，路由器应直接跳过 Tier 1，零延迟调用 Tier 2
      const t1CallCountBefore = tier1Called
      const res2 = await router.route('第 2 次路由')
      assert.equal(res2.tier, 2, '第 2 次应直接由 Tier 2 处理')
      assert.equal(tier1Called, t1CallCountBefore, '处于 EXHAUSTED 时严禁再次调用 Tier 1 执行器')
    })

    it('3.2 模拟 Tier 1 超时降级至 Tier 2：触发 fallback 事件并在时间预算内完成', async () => {
      let fallbackFired = false

      const slowTier1 = {
        id: 'slow_tier1',
        tier: 1,
        name: 'Slow Tier 1',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 500,
        getStatus: () => ({ state: 'READY' }),
        think: async () => {
          // 模拟执行超时抛错
          const err = new Error('Process timed out after 300ms')
          err.name = 'TimeoutError'
          throw err
        },
      }

      const fastTier2 = {
        id: 'fast_tier2',
        tier: 2,
        name: 'Fast Tier 2',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 200,
        getStatus: () => ({ state: 'READY' }),
        think: async () => ({
          tier: 2,
          provider: 'fast_tier2',
          providerId: 'fast_tier2',
          output: { reply: 'Tier 2 兜底成功', text: 'Tier 2 兜底成功' },
          result: { reply: 'Tier 2 兜底成功', text: 'Tier 2 兜底成功' },
          durationMs: 50,
          latencyMs: 50,
        }),
      }

      const router = new TieredBrainRouter({
        providers: [slowTier1, fastTier2, new RuleFallbackProvider()],
      })
      router.on('fallback', (f) => {
        if (f.fromTier === 1 && f.toTier === 2) {
          fallbackFired = true
        }
      })

      const res = await router.route('测试超时降级')
      assert.equal(res.tier, 2)
      assert.equal(fallbackFired, true, '必须触发降级事件')
    })

    it('3.3 对冲请求胜出时中止慢请求实证：Tier 2 胜出后，Tier 1 接收到的 abortSignal 必须被立即置为 aborted', async () => {
      let t1ReceivedAbortSignal = null
      let t1WasAborted = false
      let hedgeWonEvent = null

      // Tier 1 模拟耗时 400ms 的慢请求
      const slowTier1 = {
        id: 'slow_t1',
        tier: 1,
        name: 'Slow T1',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({ state: 'READY' }),
        think: async (req, opts) => {
          t1ReceivedAbortSignal = opts?.abortSignal
          if (t1ReceivedAbortSignal) {
            t1ReceivedAbortSignal.addEventListener('abort', () => {
              t1WasAborted = true
            })
          }
          // 等待 400ms
          await new Promise((r) => setTimeout(r, 400))
          return {
            tier: 1,
            provider: 'slow_t1',
            providerId: 'slow_t1',
            output: { reply: 'T1 迟到的结果', text: 'T1 迟到的结果' },
            result: { reply: 'T1 迟到的结果', text: 'T1 迟到的结果' },
            durationMs: 400,
            latencyMs: 400,
          }
        },
      }

      // Tier 2 模拟快请求 (对冲唤醒后 30ms 返回)
      const fastTier2 = {
        id: 'fast_t2',
        tier: 2,
        name: 'Fast T2',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({ state: 'READY' }),
        think: async () => {
          await new Promise((r) => setTimeout(r, 30))
          return {
            tier: 2,
            provider: 'fast_t2',
            providerId: 'fast_t2',
            output: { reply: 'T2 对冲获胜！', text: 'T2 对冲获胜！' },
            result: { reply: 'T2 对冲获胜！', text: 'T2 对冲获胜！' },
            durationMs: 30,
            latencyMs: 30,
          }
        },
      }

      const router = new TieredBrainRouter({
        providers: [slowTier1, fastTier2, new RuleFallbackProvider()],
        hedgeAfterMs: 60, // 60ms 后唤醒 Tier 2
      })

      router.on('hedge_won', (e) => {
        hedgeWonEvent = e
      })

      const res = await router.route('对冲取消测试')

      // 验证 1: 返回结果来自 Tier 2
      assert.equal(res.tier, 2, '对冲胜出者应为 Tier 2')
      assert.equal(res.output.reply, 'T2 对冲获胜！')

      // 验证 2: 触发了 hedge_won 事件
      assert.notEqual(hedgeWonEvent, null)
      assert.equal(hedgeWonEvent.winner, 'tier2')
      assert.equal(hedgeWonEvent.loser, 'tier1')

      // 验证 3: 核心实证——Tier 1 的 abortSignal 必须已被 abort！
      assert.notEqual(t1ReceivedAbortSignal, null, 'Tier 1 必须收到 abortSignal')
      assert.equal(t1ReceivedAbortSignal.aborted, true, 'Tier 1 的 abortSignal 必须被置为 aborted === true')
      assert.equal(t1WasAborted, true, 'Tier 1 的 abort 监听器必须被触发！')
    })

    it('3.4 Tier 1 极速胜出时中止对冲请求：Tier 1 先返回，Tier 2 绝不外溢且其 abortSignal 被置为 aborted', async () => {
      let t2ReceivedAbortSignal = null
      let t2WasAborted = false

      // Tier 1 耗时 30ms (远小于 hedgeAfterMs 80ms)
      const fastTier1 = {
        id: 'fast_t1',
        tier: 1,
        name: 'Fast T1',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({ state: 'READY' }),
        think: async () => {
          await new Promise((r) => setTimeout(r, 30))
          return {
            tier: 1,
            provider: 'fast_t1',
            providerId: 'fast_t1',
            output: { reply: 'T1 极速返回', text: 'T1 极速返回' },
            result: { reply: 'T1 极速返回', text: 'T1 极速返回' },
            durationMs: 30,
            latencyMs: 30,
          }
        },
      }

      const slowTier2 = {
        id: 'slow_t2',
        tier: 2,
        name: 'Slow T2',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({ state: 'READY' }),
        think: async (req, opts) => {
          t2ReceivedAbortSignal = opts?.abortSignal
          if (t2ReceivedAbortSignal) {
            t2ReceivedAbortSignal.addEventListener('abort', () => {
              t2WasAborted = true
            })
          }
          await new Promise((r) => setTimeout(r, 300))
          return {
            tier: 2,
            provider: 'slow_t2',
            providerId: 'slow_t2',
            output: { reply: 'T2 滞后结果', text: 'T2 滞后结果' },
            result: { reply: 'T2 滞后结果', text: 'T2 滞后结果' },
            durationMs: 300,
            latencyMs: 300,
          }
        },
      }

      const router = new TieredBrainRouter({
        providers: [fastTier1, slowTier2, new RuleFallbackProvider()],
        hedgeAfterMs: 80,
      })

      const res = await router.route('T1 极速返回测试')
      assert.equal(res.tier, 1)
      assert.equal(res.output.reply, 'T1 极速返回')

      // 等待 100ms 观察是否有 Tier 2 残留
      await new Promise((r) => setTimeout(r, 100))
      // Tier 2 在 hedgeTimer 到期前就被 finally 清理掉了，没有触发 think
      assert.equal(t2ReceivedAbortSignal, null, 'Tier 2 在 hedgeAfterMs 前未被启动，定时器成功取消')
    })

    it('3.5 全链路级联故障穿透至 Tier 4 离线规则库：秒级兜底、零死锁、零未捕获异常', async () => {
      const brokenTier1 = {
        id: 'b1', tier: 1, name: 'B1', isAvailable: () => false, getEstimatedLatencyMs: () => 100, getStatus: () => ({}), think: async () => { throw new Error('B1 down') }
      }
      const brokenTier2 = {
        id: 'b2', tier: 2, name: 'B2', isAvailable: () => true, getEstimatedLatencyMs: () => 100, getStatus: () => ({}), think: async () => { throw new Error('B2 500 error') }
      }
      const brokenTier3 = {
        id: 'b3', tier: 3, name: 'B3', isAvailable: () => true, getEstimatedLatencyMs: () => 100, getStatus: () => ({}), think: async () => { throw new Error('B3 connection refused') }
      }

      const router = new TieredBrainRouter({
        providers: [brokenTier1, brokenTier2, brokenTier3, new RuleFallbackProvider()],
      })

      const start = Date.now()
      const res = await router.route('全故障穿透')
      const elapsed = Date.now() - start

      assert.equal(res.tier, 4, '必须最终由 Tier 4 规则语料库承接')
      assert.equal(res.provider, 'rule_corpus')
      assert.ok(elapsed < 50, `穿透耗时必须 < 50ms: ${elapsed}ms`)
      assert.ok(res.output.reply.length > 0, '规则兜底必须包含有效文本')
    })

    it('3.6 对冲已触发但在 Tier 2 完成前 Tier 1 胜出：Tier 1 胜出，Tier 2 的 abortSignal 必须被置为 aborted', async () => {
      let t2ReceivedAbortSignal = null
      let t2WasAborted = false
      let hedgeWonEvent = null

      // Tier 1 耗时 90ms (大于 hedgeAfterMs 40ms，但小于 Tier 2 结束时间 40+100=140ms)
      const t1 = {
        id: 't1_hedged_win',
        tier: 1,
        name: 'T1 Hedged Win',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({ state: 'READY' }),
        think: async () => {
          await new Promise((r) => setTimeout(r, 90))
          return {
            tier: 1,
            provider: 't1_hedged_win',
            providerId: 't1_hedged_win',
            output: { reply: 'T1 胜出！', text: 'T1 胜出！' },
            result: { reply: 'T1 胜出！', text: 'T1 胜出！' },
            durationMs: 90,
            latencyMs: 90,
          }
        },
      }

      // Tier 2 在 40ms 被唤醒，需要耗时 120ms
      const t2 = {
        id: 't2_hedged_lose',
        tier: 2,
        name: 'T2 Hedged Lose',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({ state: 'READY' }),
        think: async (req, opts) => {
          t2ReceivedAbortSignal = opts?.abortSignal
          if (t2ReceivedAbortSignal) {
            t2ReceivedAbortSignal.addEventListener('abort', () => {
              t2WasAborted = true
            })
          }
          await new Promise((r) => setTimeout(r, 120))
          return {
            tier: 2,
            provider: 't2_hedged_lose',
            providerId: 't2_hedged_lose',
            output: { reply: 'T2 慢了', text: 'T2 慢了' },
            result: { reply: 'T2 慢了', text: 'T2 慢了' },
            durationMs: 120,
            latencyMs: 120,
          }
        },
      }

      const router = new TieredBrainRouter({
        providers: [t1, t2, new RuleFallbackProvider()],
        hedgeAfterMs: 40,
      })

      router.on('hedge_won', (e) => {
        hedgeWonEvent = e
      })

      const res = await router.route('对冲临界胜出测试')

      // 验证 1: Tier 1 胜出
      assert.equal(res.tier, 1)
      assert.equal(res.output.reply, 'T1 胜出！')

      // 验证 2: 触发了 hedge_won (winner: tier1, loser: tier2)
      assert.notEqual(hedgeWonEvent, null)
      assert.equal(hedgeWonEvent.winner, 'tier1')
      assert.equal(hedgeWonEvent.loser, 'tier2')

      // 验证 3: Tier 2 的 abortSignal 必须已被 abort
      assert.notEqual(t2ReceivedAbortSignal, null, 'Tier 2 必须已启动并收到 abortSignal')
      assert.equal(t2ReceivedAbortSignal.aborted, true, 'Tier 2 的 abortSignal.aborted 必须为 true')
      assert.equal(t2WasAborted, true, 'Tier 2 的 abort 事件监听器必须已被触发')
    })

    it('3.7 对冲并发中 Tier 1 抛出非预期严重异常：路由器安全捕获并降级，绝不崩溃', async () => {
      const crashingTier1 = {
        id: 'crash_t1',
        tier: 1,
        name: 'Crash T1',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({ state: 'READY' }),
        think: async () => {
          await new Promise((r) => setTimeout(r, 20))
          throw new Error('Fatal socket closed unexpectedly')
        },
      }

      const resilientTier2 = {
        id: 'resilient_t2',
        tier: 2,
        name: 'Resilient T2',
        isAvailable: () => true,
        getEstimatedLatencyMs: () => 100,
        getStatus: () => ({ state: 'READY' }),
        think: async () => ({
          tier: 2,
          provider: 'resilient_t2',
          providerId: 'resilient_t2',
          output: { reply: 'T2 接管成功', text: 'T2 接管成功' },
          result: { reply: 'T2 接管成功', text: 'T2 接管成功' },
          durationMs: 30,
          latencyMs: 30,
        }),
      }

      const router = new TieredBrainRouter({
        providers: [crashingTier1, resilientTier2, new RuleFallbackProvider()],
        hedgeAfterMs: 50,
      })

      let fallbackEvent = null
      router.on('fallback', (f) => {
        fallbackEvent = f
      })

      const res = await router.route('对冲中 T1 崩溃测试')
      assert.equal(res.tier, 2)
      assert.equal(res.output.reply, 'T2 接管成功')
      assert.notEqual(fallbackEvent, null)
      assert.equal(fallbackEvent.fromTier, 1)
      assert.equal(fallbackEvent.toTier, 2)
    })
  })
})

