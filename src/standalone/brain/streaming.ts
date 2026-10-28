/**
 * @file streaming.ts
 * 流式元数据解析器 (StreamingMetaParser) 与标点断句流式分词器 (PunctuationSplitter)
 */

import { EventEmitter } from 'node:events'

export interface StreamingMeta {
  clip: string
  tone: string
  moodIntent: number
  fed: boolean
  memory?: string
  to?: string
  [key: string]: any
}

/**
 * 解析流式输出首行元数据标签
 * 样例: <meta clip="eat_token" tone="happy" moodIntent="1" fed="true" memory="老爸喂了我小鱼干"/>
 */
export function parseStreamingMeta(metaLine: string): StreamingMeta | null {
  if (typeof metaLine !== 'string') return null

  // 严格匹配 <meta .../> 闭合标签
  const match = metaLine.match(/<meta\s+([^>]+)\/>/)
  if (!match) return null

  const attrs: Record<string, any> = {}
  const regex = /(\w+)="([^"]*)"/g
  let m: RegExpExecArray | null

  while ((m = regex.exec(match[1])) !== null) {
    attrs[m[1]] = m[2]
  }

  // 校验并规范化数值字段，防御 NaN 与数值越界（规范约定 -2 到 +2）
  const rawMood = attrs.moodIntent !== undefined ? parseInt(attrs.moodIntent, 10) : 0
  const validatedMoodIntent = (typeof rawMood === 'number' && !isNaN(rawMood))
    ? Math.max(-2, Math.min(2, rawMood))
    : 0

  return {
    ...attrs,
    clip: (typeof attrs.clip === 'string' && attrs.clip.trim().length > 0) ? attrs.clip.trim() : 'talking_normal',
    tone: (typeof attrs.tone === 'string' && attrs.tone.trim().length > 0) ? attrs.tone.trim() : 'happy',
    moodIntent: validatedMoodIntent,
    fed: attrs.fed === 'true' || attrs.fed === true,
    memory: attrs.memory ? String(attrs.memory).trim() : undefined,
    to: attrs.to ? String(attrs.to).trim() : undefined,
  }
}

/**
 * 流式首行元数据提取器
 */
export class StreamingMetaParser extends EventEmitter {
  private buffer = ''
  private metaExtracted = false
  private parsedMeta: StreamingMeta | null = null

  /**
   * 推送流式分片，若检测到首行元数据则发射 'meta' 事件，返回已剥离元数据的正文分片
   */
  processChunk(chunk: string): string {
    if (this.metaExtracted) {
      return chunk
    }

    this.buffer += chunk

    // 1. 优先通过 <meta .../> 闭合标签检测，不强制依赖换行符 \n
    const metaMatch = this.buffer.match(/<meta\s+([^>]+)\/>/)
    if (metaMatch && metaMatch.index !== undefined) {
      const meta = parseStreamingMeta(metaMatch[0])
      this.metaExtracted = true
      this.parsedMeta = meta ?? { clip: 'talking_normal', tone: 'happy', moodIntent: 0, fed: false }
      this.emit('meta', this.parsedMeta)

      const metaEnd = metaMatch.index + metaMatch[0].length
      const before = this.buffer.slice(0, metaMatch.index).trim()
      let after = this.buffer.slice(metaEnd)

      if (after.startsWith('\r\n')) {
        after = after.slice(2)
      } else if (after.startsWith('\n')) {
        after = after.slice(1)
      }

      this.buffer = ''
      return (before ? before + ' ' : '') + after
    }

    // 2. 若存在换行符但未匹配到有效 <meta .../>（如首行普通文字）
    const newlineIndex = this.buffer.indexOf('\n')
    if (newlineIndex !== -1) {
      const firstLine = this.buffer.slice(0, newlineIndex).trim()
      if (!firstLine.startsWith('<meta')) {
        this.metaExtracted = true
        this.parsedMeta = { clip: 'talking_normal', tone: 'happy', moodIntent: 0, fed: false }
        this.emit('meta', this.parsedMeta)
        const text = this.buffer
        this.buffer = ''
        return text
      }
    }

    // 容错安全降级：若已接收超过 120 字符仍未遇到换行且非 <meta 开头，判定为无 meta 标签直接下发正文
    if (this.buffer.length > 120 && !this.buffer.trimStart().startsWith('<meta')) {
      this.metaExtracted = true
      this.parsedMeta = { clip: 'talking_normal', tone: 'happy', moodIntent: 0, fed: false }
      this.emit('meta', this.parsedMeta)
      const text = this.buffer
      this.buffer = ''
      return text
    }

    return ''
  }

  /**
   * 流结束时如果尚未完成元数据提取，做最终结算并冲刷缓冲区中所有残留台词
   */
  flush(): string {
    if (this.metaExtracted) {
      const remaining = this.buffer
      this.buffer = ''
      return remaining
    }

    if (this.buffer.length > 0) {
      // 检查缓冲区中是否存在 <meta .../> 标签
      const metaMatch = this.buffer.match(/<meta\s+([^>]+)\/>/)
      if (metaMatch && metaMatch.index !== undefined) {
        const meta = parseStreamingMeta(metaMatch[0])
        this.metaExtracted = true
        this.parsedMeta = meta ?? { clip: 'talking_normal', tone: 'happy', moodIntent: 0, fed: false }
        this.emit('meta', this.parsedMeta)

        const metaEnd = metaMatch.index + metaMatch[0].length
        const before = this.buffer.slice(0, metaMatch.index).trim()
        let after = this.buffer.slice(metaEnd)
        if (after.startsWith('\r\n')) {
          after = after.slice(2)
        } else if (after.startsWith('\n')) {
          after = after.slice(1)
        }
        this.buffer = ''
        return (before ? before + ' ' : '') + after
      }

      // 无有效 <meta .../> 标签，但有内容（如普通文本或破损标签）
      this.metaExtracted = true
      this.parsedMeta = { clip: 'talking_normal', tone: 'happy', moodIntent: 0, fed: false }
      this.emit('meta', this.parsedMeta)

      // 剔除破损未闭合的 <meta 标签残留
      const cleanText = this.buffer.replace(/<meta[^>]*$/i, '').trim()
      this.buffer = ''
      return cleanText
    }
    this.metaExtracted = true
    return ''
  }

  getMeta(): StreamingMeta | null {
    return this.parsedMeta
  }
}

// ==========================================
// Unicode UTF-16 代理对与 Emoji 安全切分辅助函数
// ==========================================

let segmenterInstance: Intl.Segmenter | null = null
try {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    segmenterInstance = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })
  }
} catch {
  segmenterInstance = null
}

/**
 * 快速检查并在切点落在 UTF-16 代理对 (Surrogate Pair) 中间时进行安全回退
 * High Surrogate: 0xD800 - 0xDBFF, Low Surrogate: 0xDC00 - 0xDFFF
 */
export function findSafeSurrogateCutPoint(str: string, targetIndex: number): number {
  if (targetIndex <= 0) return 0
  if (targetIndex >= str.length) return str.length

  const prev = str.charCodeAt(targetIndex - 1)
  const curr = str.charCodeAt(targetIndex)

  // 判定切点是否恰好割裂高代理项与低代理项
  if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) {
    if (targetIndex > 1) {
      return targetIndex - 1 // 向左回退 1 字符，严格保证切片 <= targetIndex
    } else {
      return targetIndex + 1 // 极端防御：targetIndex === 1 时向前推进，防止返回 0 导致死锁
    }
  }

  return targetIndex
}

/**
 * 计算不超过 maxLen 的安全截断切点：
 * 1. 优先使用 Intl.Segmenter 按字形簇 (Grapheme Cluster) 分割，保障复合 Emoji (如 👨‍💻、👍🏽、🇨🇳) 语义完整性；
 * 2. 降级回退至 O(1) Surrogate Pair 代理对检测，杜绝任何编码破坏与死锁。
 */
export function findSafeCutPoint(str: string, maxLen: number): number {
  if (!str || maxLen <= 0) return 0
  if (str.length <= maxLen) return str.length

  if (segmenterInstance) {
    let lastSafeIndex = 0
    for (const seg of segmenterInstance.segment(str)) {
      if (seg.index + seg.segment.length <= maxLen) {
        lastSafeIndex = seg.index + seg.segment.length
      } else {
        break
      }
    }
    if (lastSafeIndex > 0) {
      return lastSafeIndex
    }
  }

  return findSafeSurrogateCutPoint(str, maxLen)
}

/**
 * 标点断句分词器 (将连续文字流按标点切分为 <= 20 字的自然语音分句)
 */
export class PunctuationSplitter extends EventEmitter {
  private buffer = ''
  private seq = 0
  private maxSentenceLen = 20

  constructor(maxSentenceLen = 20) {
    super()
    this.maxSentenceLen = maxSentenceLen
  }

  /**
   * 写入增量文本片段
   */
  push(textChunk: string): void {
    if (!textChunk) return
    this.buffer += textChunk
    this.stripMemories()
    this.stripThoughts()
    this.stripXmlTags()
    this.extractSentences()
  }

  private stripMemories(): void {
    const memRegex = /<mem\s+imp="(\d+)">([^<]+)<\/mem>/g
    let match: RegExpExecArray | null
    while ((match = memRegex.exec(this.buffer)) !== null) {
      const imp = parseInt(match[1], 10)
      const content = match[2].trim()
      this.emit('memory', { importance: imp, content })
    }
    this.buffer = this.buffer.replace(/<mem\s+imp="\d+">[^<]+<\/mem>/g, '')
  }

  private stripThoughts(): void {
    // 剥离完整的闭合 <think> 思考链及其内容
    this.buffer = this.buffer.replace(/<think>[\s\S]*?<\/think>/gi, '')
  }

  private stripXmlTags(): void {
    // 排除 <think> 和 <mem> 容器标签，仅剥离其他通用 XML 单标签或闭合标签
    this.buffer = this.buffer.replace(/<(?!\/?(?:think|mem)\b)[a-zA-Z\/][^>]*>/gi, '')
  }

  /**
   * 从缓冲区中提取完整句子
   */
  private extractSentences(): void {
    // 终结标点：句号、感叹号、问号、波浪号、省略号、换行
    const terminalRegex = /[。！？~…\n]+/

    while (true) {
      // 1. 统一检测未闭合的流式容器标签 (<think 或 <mem)
      let unclosedCut = -1
      const thinkIdx = this.buffer.indexOf('<think')
      if (thinkIdx !== -1 && !this.buffer.includes('</think>')) {
        unclosedCut = thinkIdx
      }
      const memIdx = this.buffer.indexOf('<mem')
      if (memIdx !== -1 && !this.buffer.includes('</mem>')) {
        if (unclosedCut === -1 || memIdx < unclosedCut) {
          unclosedCut = memIdx
        }
      }

      // 2. 若未闭合容器位于 buffer 最前端 (索引 0)
      if (unclosedCut === 0) {
        if (this.buffer.length > 500) {
          // 超时容错：超过 500 字符仍未闭合，判定为破损标签安全剥离（包含跨行匹配）
          this.buffer = this.buffer.replace(/<(think|mem)[\s\S]*$/gi, '')
          continue
        } else {
          // 暂停提取，等待闭合标签到达
          break
        }
      }

      // 3. 确定当前可用于分句的有效文本 activeBuffer
      const activeBuffer = unclosedCut > 0 ? this.buffer.slice(0, unclosedCut) : this.buffer

      // 4. 优先提取终结标点
      const match = activeBuffer.match(terminalRegex)
      if (!match || match.index === undefined) {
        // 5. 关键安全修复：超长判定只能且必须基于 activeBuffer，严禁检查全量 buffer.length！
        if (activeBuffer.length >= this.maxSentenceLen) {
          // 泛化未闭合尖括号保护
          if (activeBuffer.includes('<') && !activeBuffer.includes('>')) {
            const tagIdx = activeBuffer.lastIndexOf('<')
            if (activeBuffer.length - tagIdx > 80) {
              this.buffer = this.buffer.replace(/<[^>]*$/gs, '')
            } else {
              break
            }
          }

          const secondaryRegex = /[,，、;；]/
          const secLimit = findSafeCutPoint(activeBuffer, this.maxSentenceLen)
          const secMatch = activeBuffer.slice(0, secLimit).match(secondaryRegex)
          if (secMatch && secMatch.index !== undefined && secMatch.index > 3) {
            const cutIndex = secMatch.index + 1
            const sentence = this.buffer.slice(0, cutIndex)
            this.buffer = this.buffer.slice(cutIndex)
            this.emitSentence(sentence)
            continue
          } else {
            // 安全截断：保障 Unicode 代理对与复合 Emoji 完整性
            const safeCut = findSafeCutPoint(activeBuffer, this.maxSentenceLen)
            const sentence = this.buffer.slice(0, safeCut)
            this.buffer = this.buffer.slice(safeCut)
            this.emitSentence(sentence)
            continue
          }
        }
        // activeBuffer 不足分句长度且无终结标点，跳出循环等待后续 chunk
        break
      }

      const endIndex = match.index + match[0].length
      let rawSentence = this.buffer.slice(0, endIndex)
      this.buffer = this.buffer.slice(endIndex)

      this.emitSentence(rawSentence)
    }
  }

  private emitSentence(rawSentence: string): void {
    let clean = rawSentence.replace(/\n+/g, ' ').trim()
    if (!clean) return

    // 双重检查并剥离 <mem>
    const memMatch = clean.match(/<mem\s+imp="(\d+)">([^<]+)<\/mem>/)
    if (memMatch) {
      const imp = parseInt(memMatch[1], 10)
      const content = memMatch[2].trim()
      this.emit('memory', { importance: imp, content })
      clean = clean.replace(/<mem\s+imp="\d+">[^<]+<\/mem>/g, '').trim()
    }

    // 深度防御清洗：剥离可能残留的 <mem>、<think> 思考链及其内容、以及通用 XML 标签
    clean = clean
      .replace(/<mem[^>]*>.*?<\/mem>/gs, '')
      .replace(/<mem[^>]*>.*$/gs, '')
      .replace(/<mem[^>]*$/g, '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think[^>]*>[\s\S]*$/gi, '')
      .replace(/<think[^>]*$/gi, '')
      .replace(/<[a-zA-Z\/][^>]*>/g, '')
      .trim()

    if (!clean) return

    // 包含终结标点超长分句循环拆分，强制单句 <= maxSentenceLen
    while (clean.length > this.maxSentenceLen) {
      const secondaryRegex = /[,，、;；]/
      const secLimit = findSafeCutPoint(clean, this.maxSentenceLen)
      const secMatch = clean.slice(0, secLimit).match(secondaryRegex)
      if (secMatch && secMatch.index !== undefined && secMatch.index > 3) {
        const cutIndex = secMatch.index + 1
        const sentence = clean.slice(0, cutIndex).trim()
        clean = clean.slice(cutIndex).trim()
        if (sentence) {
          this.emit('sentence', { seq: this.seq++, text: sentence })
        }
      } else {
        // 安全截断：保障 Unicode 代理对与复合 Emoji 完整性
        const safeCut = findSafeCutPoint(clean, this.maxSentenceLen)
        const sentence = clean.slice(0, safeCut).trim()
        clean = clean.slice(safeCut).trim()
        if (sentence) {
          this.emit('sentence', { seq: this.seq++, text: sentence })
        }
      }
    }

    if (clean) {
      this.emit('sentence', {
        seq: this.seq++,
        text: clean,
      })
    }
  }

  /**
   * 流结束，冲刷尾部剩余未结句的文字
   */
  flush(): void {
    this.stripMemories()
    this.stripThoughts()
    this.stripXmlTags()
    this.buffer = this.buffer
      .replace(/<mem[^>]*>.*?<\/mem>/gs, '')
      .replace(/<mem[^>]*>.*$/gs, '')
      .replace(/<mem[^>]*$/g, '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think[^>]*>[\s\S]*$/gi, '')
      .replace(/<think[^>]*$/gi, '')

    // 冲刷时首先尝试常规标点提取
    this.extractSentences()

    // 冲刷尾部剩余未结句的文字，直接交由 emitSentence 处理（内置全量清洗与超长强制循环切分）
    if (this.buffer.trim()) {
      const remaining = this.buffer
      this.buffer = ''
      this.emitSentence(remaining)
    }
  }

  reset(): void {
    this.buffer = ''
    this.seq = 0
  }
}
