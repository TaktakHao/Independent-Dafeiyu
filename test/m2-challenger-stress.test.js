/**
 * @file m2-challenger-stress.test.js
 * Empirical Challenger 2 Stress Test Suite:
 * 1. Massive Input Prompt Stress & Token Budgeting (<= 2100 tokens, Layer A 100% intact)
 * 2. Streaming Meta Tag & Punctuation Splitting Stress (malformed meta, long unpunctuated text <= 20, memory tags)
 * 3. End-to-End Latency Verification (first audio chunk p50 <= 2.5s)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PromptBuilder,
  validatePrompt3Layer,
  FIXED_PERSONA_LAYER_A,
  StreamingMetaParser,
  PunctuationSplitter,
  parseStreamingMeta,
  StreamingTTSPipeline,
  MacSayTTSEngine,
} from '../src/standalone/brain/index.ts'

describe('M2 Challenger 2 Empirical Stress Test Suite', () => {

  // =========================================================================
  // 1. Massive Input Prompt Stress
  // =========================================================================
  describe('1. Massive Input Prompt Stress & Token Budgeting', () => {
    it('1.1 检查 PromptBuilder 是否实现 fitToBudget 方法契约', () => {
      const builder = new PromptBuilder(2100)
      const hasFitToBudget = typeof builder.fitToBudget === 'function' &&
                            typeof PromptBuilder.fitToBudget === 'function'
      console.log(`[CHALLENGER-CHECK] PromptBuilder.fitToBudget exists: ${hasFitToBudget}`)
      assert.equal(hasFitToBudget, true, 'PromptBuilder.fitToBudget 方法已正确实现')
      const fitted = builder.fitToBudget({ mode: 'live' }, 1800)
      assert.ok(fitted.estimatedTokens <= 1800, 'fitToBudget 确保在指定预算内')
    })

    it('1.2 极端海量输入压力测试：100 条事实 + 50 轮对话 + 100 条情景记忆', () => {
      const builder = new PromptBuilder(2100)

      // 构造 100 条超长事实
      const extremeFacts = Array.from({ length: 100 }, (_, i) => ({
        text: `老爸关于架构设计的第 ${i} 项核心工程原则：微服务与单体权衡、分布式事务CAP理论、高并发锁机制、网络I/O多路复用等细节深入分析与实践经验记录。`,
        confidence: i % 3 === 0 ? 0.95 : 0.65,
      }))

      // 构造 50 轮长对话
      const extremeDialogues = Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `历史对话轮次第 ${i} 轮：关于赛博女儿在直播场景下如何实现音画同步、降低首字延迟到2.5秒以内的深入技术探讨。`,
      }))

      // 构造 100 条记忆
      const extremeMemories = Array.from({ length: 100 }, (_, i) => ({
        id: `mem-${i}`,
        text: `回忆条目 ${i}：老爸在深夜调试 macOS Swift Helper 原生模块，修复了 WebP 序列帧播放的偶发卡顿问题。`,
        score: 0.9,
      }))

      const result = builder.build({
        mode: 'live',
        hostProfile: {
          name: '老爸',
          occupation: '资深全栈系统架构师与开源项目维护者',
          habits: ['喝乌龙茶', '写TypeScript', '调试原生Swift', '听轻音乐'],
          facts: extremeFacts,
        },
        sessionSummary: '今天的直播间人气非常旺盛，有多位舰长赠送了大量小鱼干礼物，女儿进行了连环感谢。'.repeat(15),
        yesterdayDiary: '昨日老爸一直在认真编写核心状态机与协议转换层代码，直到凌晨两点才休息。'.repeat(15),
        retrievedMemories: extremeMemories,
        recentDialogue: extremeDialogues,
        event: {
          type: 'DANMAKU',
          viewer: '热情粉丝007',
          content: '大肥鱼快出来给大伙儿表演一个后空翻！'.repeat(5),
        },
      })

      // 验证 1: 必须严格满足 <= 2100 tokens 预算
      assert.ok(
        result.estimatedTokens <= 2100,
        `Token 超出预算! 实际 tokens: ${result.estimatedTokens}, 预算上限: 2100`
      )

      // 验证 2: [Layer A] 必须 100% 逐字保留，绝对不允许被裁剪或篡改
      assert.equal(
        result.layerA,
        FIXED_PERSONA_LAYER_A,
        '[Layer A] 固化人设被篡改或裁剪！'
      )
      assert.equal(
        result.layerA.length,
        FIXED_PERSONA_LAYER_A.length,
        '[Layer A] 长度不一致！'
      )

      // 验证 3: 必须包含完整的 3-Layer 契约
      const validation = validatePrompt3Layer(result.fullText)
      assert.equal(validation.valid, true, 'Prompt 3-Layer 结构校验失败')
      assert.equal(validation.withinBudget, true, 'validatePrompt3Layer 判定超标')
    })

    it('1.3 病态输入漏洞防护：超长单项字段 (activeApp / hostProfile) 截断保护确保 <= 2100 预算', () => {
      const builder = new PromptBuilder(2100)

      const result = builder.build({
        mode: 'companion',
        hostProfile: {
          name: '老爸',
          occupation: '全栈架构师'.repeat(200),
        },
        activeApp: {
          name: 'Xcode & Visual Studio Code & Obsidian & Terminal'.repeat(50),
          durationMin: 120,
        },
        event: '老爸在写代码',
      })

      console.log(`[CHALLENGER-CHECK] Pathological single field tokens: ${result.estimatedTokens}`)
      assert.ok(result.estimatedTokens <= 2100, `超长字段截断保护生效，tokens: ${result.estimatedTokens} <= 2100`)
      assert.ok(result.layerB.includes('职业/特征: 全栈架构师'))
      assert.ok(result.layerC.includes('老爸当前窗口: Xcode'))
    })

    it('1.4 事件标签闭合保障：超长 event 在 Pass 1 裁剪后保留完整闭合标签 </event>', () => {
      const builder = new PromptBuilder(2100)

      const result = builder.build({
        mode: 'live',
        hostProfile: {
          name: '老爸',
          facts: Array.from({ length: 30 }, (_, i) => ({ text: '事实 ' + i + '：老爸的技术很强。'.repeat(10) })),
        },
        event: {
          type: 'DANMAKU',
          viewer: '测试观众',
          content: '这是一条非常非常非常非常非常非常非常非常非常非常非常非常长的弹幕！'.repeat(5),
        },
      })

      // 验证 Pass 1 切割 eventStr 是否保留了 </event>
      const hasClosedTag = result.layerC.includes('</event>')
      console.log(`[CHALLENGER-CHECK] Event tag closed after Pass 1: ${hasClosedTag}`)
      assert.equal(hasClosedTag, true, 'Pass 1 内部 content 截断保护了 </event> 闭合标签')
      assert.ok(result.layerC.trim().endsWith('</event>'), 'Layer C 末尾以 </event> 正常闭合')
    })

    it('1.5 病态超长 event.type 与 emotionState 输入截断保护：总 Token 严格 <= 2100', () => {
      const builder = new PromptBuilder(2100)

      // 场景 A: event.type 10,000 字符超长输入防御
      const resA = builder.build({
        mode: 'live',
        event: {
          type: 'A'.repeat(10000),
          viewer: '测试观众',
          content: '这是一条普通弹幕内容',
        },
        hostProfile: {
          name: '老爸',
          facts: Array.from({ length: 15 }, (_, i) => ({ text: `事实第 ${i} 项：老爸在深夜调试代码` })),
        },
      })

      assert.ok(
        resA.estimatedTokens <= 2100,
        `event.type 10000 字符下 Token 超标! 实际: ${resA.estimatedTokens} > 2100`
      )
      assert.ok(resA.layerC.includes('</event>'), '超长 event.type 截断后必须保留闭合标签 </event>')
      assert.equal(resA.layerA, FIXED_PERSONA_LAYER_A, 'Layer A 固化人设必须 100% 完整保留')
      const valA = validatePrompt3Layer(resA.fullText)
      assert.equal(valA.valid, true, '3-Layer 契约校验必须为 true')
      assert.equal(valA.withinBudget, true, '预算判定必须为 true')

      // 场景 B: emotionState 10,000 字符超长输入防御
      const resB = builder.build({
        mode: 'companion',
        emotionState: 'E'.repeat(10000),
        event: '老爸在写代码',
      })

      assert.ok(
        resB.estimatedTokens <= 2100,
        `emotionState 10000 字符下 Token 超标! 实际: ${resB.estimatedTokens} > 2100`
      )
      const valB = validatePrompt3Layer(resB.fullText)
      assert.equal(valB.valid, true, '3-Layer 契约校验必须为 true')
      assert.equal(valB.withinBudget, true, '预算判定必须为 true')
    })
  })

  // =========================================================================
  // 2. Streaming Meta Tag & Punctuation Splitting Stress
  // =========================================================================
  describe('2. Streaming Meta Tag & Punctuation Splitting Stress', () => {
    it('2.1 畸形 <meta> 标签容错与 spread 属性覆盖缺陷修复验证', () => {
      // 场景 A: 未闭合标签 -> parseStreamingMeta 返回 null
      const unclosed = parseStreamingMeta('<meta clip="eat_token" tone="happy"')
      assert.equal(unclosed, null, '未闭合 meta 标签应解析为 null')

      // 场景 B: 缺少属性引号 -> 回退至默认 clip 和 tone
      const noQuotes = parseStreamingMeta('<meta clip=eat_token tone=happy/>')
      assert.notEqual(noQuotes, null)
      assert.equal(noQuotes.clip, 'talking_normal')
      assert.equal(noQuotes.tone, 'happy')

      // 场景 C: 空属性 clip="" -> 防御回退至默认 clip 'talking_normal'
      const emptyClip = parseStreamingMeta('<meta clip=""/>')
      assert.notEqual(emptyClip, null)
      console.log(`[CHALLENGER-CHECK] emptyClip result: "${emptyClip.clip}"`)
      assert.equal(emptyClip.clip, 'talking_normal', 'clip 空字符串应回退至默认 talking_normal')

      // 场景 D: 畸形数值 moodIntent="not_a_number" -> 防御回退至 0 且非 NaN
      const nanMood = parseStreamingMeta('<meta clip="head_pat" moodIntent="not_a_number"/>')
      assert.notEqual(nanMood, null)
      console.log(`[CHALLENGER-CHECK] nanMood moodIntent isNaN: ${Number.isNaN(nanMood.moodIntent)}`)
      assert.equal(Number.isNaN(nanMood.moodIntent), false, 'moodIntent 不可为 NaN')
      assert.equal(nanMood.moodIntent, 0, 'moodIntent 应安全回退至 0')
    })

    it('2.2 StreamingMetaParser 无换行符导致正文被吞噬缺陷修复验证', () => {
      const parser = new StreamingMetaParser()
      let emittedMeta = null
      parser.on('meta', (m) => { emittedMeta = m })

      // 模拟大模型输出 <meta .../> 后面紧随台词而没有换行符
      const streamWithoutNewline = '<meta clip="head_pat" tone="happy" fed="false"/>老爸今天辛苦啦！'
      const chunkOut = parser.processChunk(streamWithoutNewline)
      const flushOut = parser.flush()

      console.log(`[CHALLENGER-CHECK] Stream without newline chunkOut: "${chunkOut}", flushOut: "${flushOut}"`)
      const totalText = (chunkOut || '') + (flushOut || '')
      assert.equal(totalText, '老爸今天辛苦啦！', '正文台词应完整下发，不得被吞噬')
      assert.notEqual(emittedMeta, null)
      assert.equal(emittedMeta.clip, 'head_pat')
    })

    it('2.3 极端无标点超长文本分句测试 (>100 字无标点，强制 <= 20 字且无死锁)', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      splitter.on('sentence', (s) => sentences.push(s.text))

      // 150 字纯中文无标点文本
      const longText = '今天的天气真是不错老爸一直在专心写代码大肥鱼在桌面上看着老爸敲键盘真是太厉害了不过老爸要注意多喝水不要一直盯着屏幕眼睛会酸痛的本鱼可以给老爸唱首歌解闷哦嗷呜小鱼干真好吃呀老爸什么时候再喂我一包小鱼干呢这是一段极其漫长超过一百五十个字符的纯中文文本没有任何标点符号必须被强制切分'
      assert.ok(longText.length > 100, `输入文本长度: ${longText.length}`)

      const start = Date.now()
      splitter.push(longText)
      splitter.flush()
      const duration = Date.now() - start

      // 验证 1: 零死锁与低耗时 (< 50ms)
      assert.ok(duration < 50, `分词耗时过长: ${duration}ms`)

      // 验证 2: 必须成功切分出多个句子
      assert.ok(sentences.length >= 6, `切分句子数量不足: ${sentences.length}`)

      // 验证 3: 严格校验每一句必须 <= 20 字
      const overLong = sentences.filter((s) => s.length > 20)
      assert.equal(overLong.length, 0, '存在超过 20 字的分句！')
    })

    it('2.4 流式中间夹杂闭合 <mem imp="8"> 记忆标签测试', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      const memories = []

      splitter.on('sentence', (s) => sentences.push(s.text))
      splitter.on('memory', (m) => memories.push(m))

      // 分散推送包含记忆标签的流式内容
      splitter.push('老爸今天敲代码好快呀！')
      splitter.push('<mem imp="8">老爸今天写了很多核心模块</mem>')
      splitter.push('大肥鱼要给你泡一杯热茶哦。')
      splitter.flush()

      // 验证 1: 记忆标签被完整提取
      assert.equal(memories.length, 1)
      assert.equal(memories[0].importance, 8)
      assert.equal(memories[0].content, '老爸今天写了很多核心模块')

      // 验证 2: 记忆标签 100% 从发往 TTS 的句子中剥离
      for (const s of sentences) {
        assert.ok(!s.includes('<mem'), `句子残留 <mem: ${s}`)
        assert.ok(!s.includes('</mem>'), `句子残留 </mem>: ${s}`)
        assert.ok(!s.includes('imp='), `句子残留 imp=: ${s}`)
      }
    })

    it('2.5 未闭合 <mem> 标签导致分句失效与标签外泄漏洞修复验证', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      const memories = []

      splitter.on('sentence', (s) => sentences.push(s.text))
      splitter.on('memory', (m) => memories.push(m))

      const unclosedMemText = '老爸今天真棒<mem imp="8">老爸在写代码这是一段非常非常长的文本超过一百个字而且没有闭合标签或者后面还有很多字大肥鱼在旁边看着老爸写代码老爸辛苦了快喝水吧'
      splitter.push(unclosedMemText)
      splitter.flush()

      // 检验未闭合 <mem> 标签下的防御表现
      const hasMemTagInSentence = sentences.some((s) => s.includes('<mem'))
      const hasOverlong = sentences.some((s) => s.length > 20)
      console.log(`[CHALLENGER-CHECK] Unclosed mem leaked into TTS sentences: ${hasMemTagInSentence}`)
      console.log(`[CHALLENGER-CHECK] Unclosed mem caused >20 chars sentence: ${hasOverlong}`)

      assert.equal(hasMemTagInSentence, false, '未闭合 <mem> 标签必须被彻底剥离，不得泄露至发声文本')
      assert.equal(hasOverlong, false, '分句必须严格保证 <=20 字限制')
      assert.ok(sentences.length > 0, '必须能正常产出有效分句')
    })

    it('2.6 包含终结标点的超长句子分句测试 (>=35 字以终结标点结尾，切分后单句严格 <= 20 字)', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      splitter.on('sentence', (s) => sentences.push(s.text))

      // 场景 A: 37 字带句号超长单句 (中间有逗号)
      splitter.push('这是一个长达三十五个字符的超长句子，在中间有一个逗号但在末尾才有一个句号。')

      // 场景 B: 30 字带感叹号超长单句 (无次级标点)
      splitter.push('老爸今天在电脑前写了整整一天的代码真是太辛苦了要好好休息呀！')

      // 场景 C: 流式增量推送 43 字超长单句 (末尾波浪号)
      const chunks = ['老爸老爸，', '本鱼发现了一个非常重要的事情，', '那就是今天晚上的小鱼干好像还没喂呢~']
      for (const c of chunks) {
        splitter.push(c)
      }

      splitter.flush()

      // 验证 1: 必须成功切分出多个句子 (至少 6 句)
      assert.ok(sentences.length >= 6, `分句数量不足: ${sentences.length} < 6`)

      // 验证 2: 每一句必须严格 <= 20 字
      const overlong = sentences.filter((s) => s.length > 20)
      assert.equal(
        overlong.length,
        0,
        `存在超过 20 字的分句! 数量: ${overlong.length}, 分句: ${JSON.stringify(overlong)}`
      )

      // 验证 3: 句首句尾无空白，且无空分句
      assert.ok(sentences.every((s) => s.trim().length > 0), '不能发射空白分句')
    })

    it('2.7 思考链 <think> 与通用 XML 标签 100% 剥离测试 (杜绝裸标签与思考过程外泄至发声文本)', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      splitter.on('sentence', (s) => sentences.push(s.text))

      // 场景 A: 闭合思考链与台词混杂
      splitter.push('老爸快看<think>思考链：分析老爸情绪，给出安慰</think>，今天天气真不错呀！')

      // 场景 B: 通用 XML 标签 (单标签、成对标签、自定义属性)
      splitter.push('大肥鱼给你准备了礼物<event type="GIFT">小红花</event>哦！<foo bar="123"/>还有热茶<br/>呢！')

      // 场景 C: 流式分片到达的思考链
      splitter.push('老爸辛苦了，<think>流式思考前半段')
      splitter.push('流式思考后半段</think>快喝水吧~')

      // 场景 D: 极端破损/未闭合思考链 (在大模型输出被异常打断时)
      splitter.push('本鱼最喜欢老爸啦！<think>未闭合的思考链被意外截断')

      splitter.flush()

      // 验证 1: 绝无裸露 XML 标签 (采用严格标签检测)
      const tagRegex = /<[a-zA-Z\/][^>]*>/
      const leakedTags = sentences.filter((s) => tagRegex.test(s))
      assert.equal(
        leakedTags.length,
        0,
        `台词中泄露裸露 XML 标签: ${JSON.stringify(leakedTags)}`
      )

      // 验证 2: 思考链标签与内部思考过程内容 100% 剥离
      for (const s of sentences) {
        assert.ok(!s.includes('<think>'), `包含 <think>: ${s}`)
        assert.ok(!s.includes('</think>'), `包含 </think>: ${s}`)
        assert.ok(!s.includes('思考链'), `包含思考链内容: ${s}`)
        assert.ok(!s.includes('分析老爸情绪'), `包含分析思考内容: ${s}`)
        assert.ok(!s.includes('流式思考'), `包含流式思考内容: ${s}`)
        assert.ok(!s.includes('未闭合的思考链'), `包含未闭合思考链内容: ${s}`)
      }

      // 验证 3: 正常台词保留且字数合规
      assert.ok(sentences.some((s) => s.includes('老爸快看')), '保留正常台词')
      assert.ok(sentences.some((s) => s.includes('今天天气真不错呀')), '保留正常台词')
      assert.ok(sentences.some((s) => s.includes('快喝水吧')), '保留正常台词')
      assert.ok(sentences.every((s) => s.length <= 20), '所有台词严格 <= 20 字')
    })

    it('2.8 跨 chunk 未闭合 <think> 思考链对抗测试 (短前缀无标点 + 长思考跨分片，100% 杜绝思考泄露至 TTS)', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      splitter.on('sentence', (s) => sentences.push(s.text))

      // 场景 A: 短前缀无标点 + 长思考内容跨 chunk (Reviewer 2 发现的核心复现 POC)
      splitter.push('老爸快看<think>这是一段非常漫长非常漫长非常漫长的思考分析')
      splitter.push('并且决定提醒老爸喝水</think>快喝水吧~')

      // 场景 B: 多 chunk 跨分片深度思考 (思考过程跨越 3 个分片到达)
      splitter.push('本鱼在想<think>第一阶段深度分析老爸专注状态，连续写代码多小时')
      splitter.push('第二阶段评估健康风险并匹配关怀策略')
      splitter.push('第三阶段决定主动提醒休息</think>老爸注意眼睛，起来活动一下身体嘛！')

      // 场景 C: 句首即为未闭合思考链 (前缀完全为空) 跨分片
      splitter.push('<think>前缀为空的纯思考分析过程，正在评估环境信息')
      splitter.push('思考完毕决定打招呼</think>老爸晚上好呀！')

      splitter.flush()

      // 验证 1: 绝对不允许任何思考链私密内容泄露至发声文本
      const forbiddenFragments = [
        '思考分析',
        '非常漫长',
        '决定提醒老爸喝水',
        '深度分析',
        '专注状态',
        '评估健康风险',
        '匹配关怀策略',
        '决定主动提醒休息',
        '前缀为空',
        '纯思考分析过程',
        '评估环境信息',
        '思考完毕',
        '<think',
        '</think>',
      ]

      for (const s of sentences) {
        for (const forbidden of forbiddenFragments) {
          assert.equal(
            s.includes(forbidden),
            false,
            `发声分句中严重泄露思考链私密内容 "${forbidden}": "${s}"`
          )
        }
      }

      // 验证 2: 思考链外部的正常台词 100% 完整保留并下发
      assert.ok(sentences.some((s) => s.includes('老爸快看') || s.includes('快喝水吧')), '保留场景 A 正常台词')
      assert.ok(sentences.some((s) => s.includes('本鱼在想') || s.includes('老爸注意眼睛')), '保留场景 B 正常台词')
      assert.ok(sentences.some((s) => s.includes('老爸晚上好呀')), '保留场景 C 正常台词')

      // 验证 3: 严格保证所有分句 <= 20 字符且无空分句
      for (const s of sentences) {
        assert.ok(s.trim().length > 0, '分句不能为纯空白')
        assert.ok(s.length <= 20, `分句长度超过 20 字符限制: "${s}" (长度: ${s.length})`)
      }
    })

    it('2.9 跨 chunk 未闭合 <mem> 记忆容器对抗测试 (跨分片记忆提取 100% 触发且私密记忆绝不外泄至发声句子)', () => {
      const splitter = new PunctuationSplitter(20)
      const sentences = []
      const memories = []
      splitter.on('sentence', (s) => sentences.push(s.text))
      splitter.on('memory', (m) => memories.push(m))

      // 场景 A: 带终结标点的前缀 + 超长记忆跨 chunk (Reviewer 2 发现的核心复现 POC)
      splitter.push('老爸今天真棒！<mem imp="9">老爸修复了高并发内存泄漏 Bug，架构能力')
      splitter.push('非常强</mem>快去休息吧~')

      // 场景 B: 短前缀无标点 + 跨 3 个 chunk 的高重要度记忆
      splitter.push('本鱼记下了<mem imp="10">老爸的技术栈包括 TypeScript 原生 Node.js 运行时')
      splitter.push('以及 macOS Swift 原生渲染助手')
      splitter.push('双向 NDJSON 管道协同架构</mem>真的太厉害啦！')

      // 场景 C: 同一段流式输出中连续包含两条跨 chunk 记忆
      splitter.push('老爸老爸，<mem imp="8">老爸喜欢在下午三点')
      splitter.push('喝乌龙茶</mem>而且<mem imp="7">工作时习惯戴')
      splitter.push('降噪耳机</mem>我都清楚记在小本本上啦！')

      splitter.flush()

      // 验证 1: 跨 chunk 记忆提取事件 100% 触发，条数严格等于 4 条
      assert.equal(memories.length, 4, `跨 chunk 记忆提取数量不符: 期望 4 条，实际 ${memories.length} 条`)

      // 验证 2: 记忆内容与重要度解析准确
      assert.equal(memories[0].importance, 9)
      assert.ok(memories[0].content.includes('老爸修复了高并发内存泄漏 Bug，架构能力非常强'))

      assert.equal(memories[1].importance, 10)
      assert.ok(memories[1].content.includes('老爸的技术栈包括 TypeScript') && memories[1].content.includes('双向 NDJSON 管道协同架构'))

      assert.equal(memories[2].importance, 8)
      assert.equal(memories[2].content, '老爸喜欢在下午三点喝乌龙茶')

      assert.equal(memories[3].importance, 7)
      assert.equal(memories[3].content, '工作时习惯戴降噪耳机')

      // 验证 3: 私密记忆内容与 <mem> 标签 100% 绝不泄露至发声文本
      const forbiddenMemories = [
        '内存泄漏',
        '架构能力',
        '技术栈',
        '双向 NDJSON',
        '乌龙茶',
        '降噪耳机',
        '<mem',
        '</mem>',
        'imp=',
      ]

      for (const s of sentences) {
        for (const forbidden of forbiddenMemories) {
          assert.equal(
            s.includes(forbidden),
            false,
            `发声分句中泄露私密记忆内容或标签 "${forbidden}": "${s}"`
          )
        }
      }

      // 验证 4: 正常台词完整保留
      assert.ok(sentences.some((s) => s.includes('老爸今天真棒')), '保留场景 A 正常台词')
      assert.ok(sentences.some((s) => s.includes('快去休息吧')), '保留场景 A 正常台词')
      assert.ok(sentences.some((s) => s.includes('太厉害啦')), '保留场景 B 正常台词')
      assert.ok(sentences.some((s) => s.includes('记在小本本上')), '保留场景 C 正常台词')

      // 验证 5: 严格保证所有分句 <= 20 字符且无空分句
      for (const s of sentences) {
        assert.ok(s.trim().length > 0, '分句不能为纯空白')
        assert.ok(s.length <= 20, `分句长度超过 20 字符限制: "${s}" (长度: ${s.length})`)
      }
    })
  })

  // =========================================================================
  // 3. Latency Verification (p50 <= 2.5s)
  // =========================================================================
  describe('3. Latency Verification (首字到首音频片合成入队 p50 <= 2.5s)', () => {
    it('3.1 端到端流式语音管道延迟实测 (10 次实跑)', async () => {
      const schedulerEvents = []
      const mockScheduler = {
        play: (clip) => {
          schedulerEvents.push({ kind: 'play', payload: clip, timestamp: Date.now() })
        },
        speak: (text, opts) => {
          schedulerEvents.push({ kind: 'speak', payload: { text, opts }, timestamp: Date.now() })
        },
        playAudio: (path, opts) => {
          schedulerEvents.push({ kind: 'playAudio', payload: { path, opts }, timestamp: Date.now() })
        },
      }

      const engine = new MacSayTTSEngine('Tingting')
      const isSayAvailable = await engine.isAvailable()
      console.log(`[CHALLENGER-CHECK] macOS /usr/bin/say available: ${isSayAvailable}`)

      const latencies = []
      const TRIALS = 10

      for (let i = 0; i < TRIALS; i++) {
        const pipeline = new StreamingTTSPipeline({
          ttsEngine: engine,
          scheduler: mockScheduler,
          tempAudioDir: `runtime/temp/audio_stress_${i}`,
        })

        // 构造流式生成器：模拟大模型以 30ms 间隔吐出 token
        async function* mockTokenStream() {
          const chunks = [
            '<meta clip="head_pat" tone="happy" moodIntent="1" fed="false"/>\n',
            '老爸，',
            '今天',
            '辛苦啦！',
            '大肥鱼',
            '一直都在',
            '陪着你呢。',
          ]
          for (const c of chunks) {
            await new Promise((r) => setTimeout(r, 30))
            yield c
          }
        }

        const startTime = Date.now()
        let firstAudioPlayTime = 0

        const originalPlayAudio = mockScheduler.playAudio
        mockScheduler.playAudio = (p, opts) => {
          if (firstAudioPlayTime === 0) {
            firstAudioPlayTime = Date.now()
          }
          originalPlayAudio(p, opts)
        }

        await pipeline.processStream(mockTokenStream(), { id: `stress-${i}` })
        mockScheduler.playAudio = originalPlayAudio

        const elapsed = firstAudioPlayTime > 0 ? (firstAudioPlayTime - startTime) : (Date.now() - startTime)
        latencies.push(elapsed)
      }

      latencies.sort((a, b) => a - b)
      const p50 = latencies[Math.floor(latencies.length * 0.5)]
      const p90 = latencies[Math.floor(latencies.length * 0.9)]

      console.log(`[CHALLENGER-LATENCY-RESULTS] Trials: ${TRIALS}`)
      console.log(`[CHALLENGER-LATENCY-RESULTS] All latencies: ${latencies.join(', ')} ms`)
      console.log(`[CHALLENGER-LATENCY-RESULTS] p50: ${p50} ms, p90: ${p90} ms`)

      // 验证需求指标：首音频片分句合成入队 p50 <= 2500ms
      assert.ok(
        p50 <= 2500,
        `p50 延迟超标: ${p50}ms > 2500ms`
      )
    })
  })
})
