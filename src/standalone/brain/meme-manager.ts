/**
 * @file meme-manager.ts
 * 大肥鱼表情包管理与自身形象表情制作引擎
 * 
 * 核心功能：
 * 1. 桌面专属图库：在 ~/Desktop/大肥鱼表情包/ 维护分类目录（开心、傲娇、干饭、问号、工作等）。
 * 2. 自身形象表情包制作：自动从 assets/pet/ 的动态帧中挑选最萌的关键帧，制作成大肥鱼专属形象表情包。
 * 3. 联网搜图与自动收藏：按关键词在全网搜索图片，下载并按情感分类保存到桌面上，聊天时随时取用。
 * 4. QQ 专属发图集成：输出标准 CQ 码 [CQ:image,file=base64://...]，NapCat 容器与 QQ 客户端均可即时显示。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export interface MemeItem {
  id: string
  name: string
  category: string
  filePath: string
  source: 'self_avatar' | 'web_collected' | 'user_sent'
  base64?: string
}

export const MEME_CATEGORIES = [
  '开心happy',
  '傲娇tsundere',
  '干饭eat',
  '摸鱼slack',
  '工作working',
  '委屈sulking',
  '搞怪funny',
] as const

export type MemeCategory = typeof MEME_CATEGORIES[number]

export class MemeManager {
  private baseDir: string
  private assetsDir: string

  constructor(options: { baseDir?: string; assetsDir?: string } = {}) {
    this.baseDir = options.baseDir || path.join(os.homedir(), 'Desktop', '大肥鱼表情包')
    this.assetsDir = options.assetsDir || path.join(process.cwd(), 'assets', 'pet')
  }

  public getBaseDir(): string {
    return this.baseDir
  }

  /**
   * 初始化桌面表情包目录并生成大肥鱼自身形象的初始表情包
   */
  public async initDesktopMemes(): Promise<void> {
    try {
      // 1. 创建桌面主目录与各分类子目录
      fs.mkdirSync(this.baseDir, { recursive: true })
      for (const cat of MEME_CATEGORIES) {
        fs.mkdirSync(path.join(this.baseDir, cat), { recursive: true })
      }

      // 2. 自制大肥鱼自身动作的形象表情包
      await this.generateSelfMemes()
    } catch (err: any) {
      console.warn('[MemeManager] 初始化桌面表情包目录异常:', err?.message || String(err))
    }
  }

  /**
   * 从 assets/pet 中提取关键帧，自制成大肥鱼专属形象表情包存入桌面
   */
  public async generateSelfMemes(): Promise<void> {
    const avatarConfigs = [
      { action: 'head_pat', frame: 'head_pat_020.webp', name: '大肥鱼_被摸头超享受.webp', cat: '开心happy' },
      { action: 'eat_token', frame: 'eat_token_030.webp', name: '大肥鱼_吃小鱼干真香.webp', cat: '干饭eat' },
      { action: 'idle_stretch', frame: 'idle_stretch_040.webp', name: '大肥鱼_大懒腰摸鱼.webp', cat: '摸鱼slack' },
      { action: 'poke', frame: 'poke_025.webp', name: '大肥鱼_咬你哦.webp', cat: '傲娇tsundere' },
      { action: 'success', frame: 'success_035.webp', name: '大肥鱼_看本鱼厉害吧.webp', cat: '开心happy' },
      { action: 'error', frame: 'error_020.webp', name: '大肥鱼_委屈巴巴.webp', cat: '委屈sulking' },
      { action: 'thinking', frame: 'thinking_030.webp', name: '大肥鱼_思考鱼生.webp', cat: '工作working' },
      { action: 'working_command', frame: 'working_command_030.webp', name: '大肥鱼_开工敲代码.webp', cat: '工作working' },
      { action: 'tail', frame: 'tail_030.webp', name: '大肥鱼_甩你一脸尾巴.webp', cat: '傲娇tsundere' },
    ]

    for (const item of avatarConfigs) {
      const srcFile = path.join(this.assetsDir, item.action, item.frame)
      const destDir = path.join(this.baseDir, item.cat)
      const destFile = path.join(destDir, item.name)

      if (fs.existsSync(srcFile) && !fs.existsSync(destFile)) {
        try {
          fs.copyFileSync(srcFile, destFile)
        } catch {}
      }
    }
  }

  /**
   * 根据大肥鱼当前的情绪或动作 (clip/tone)，从桌面自选一张合适的表情包
   */
  public pickMemeForEmotion(clip?: string, tone?: string): MemeItem | null {
    let targetCat: string = '开心happy'

    if (tone === 'tsundere' || clip === 'poke' || clip === 'tail') {
      targetCat = '傲娇tsundere'
    } else if (clip === 'eat_token') {
      targetCat = '干饭eat'
    } else if (clip === 'idle_stretch' || clip === 'idle_yawn' || tone === 'sleepy') {
      targetCat = '摸鱼slack'
    } else if (clip === 'working' || clip === 'working_command' || clip === 'thinking') {
      targetCat = '工作working'
    } else if (clip === 'error' || tone === 'sulking' || tone === 'sad') {
      targetCat = '委屈sulking'
    }

    const catDir = path.join(this.baseDir, targetCat)
    if (!fs.existsSync(catDir)) return null

    try {
      const files = fs.readdirSync(catDir).filter((f) => !f.startsWith('.') && /\.(webp|png|jpg|jpeg|gif)$/i.test(f))
      if (files.length === 0) return null

      const picked = files[Math.floor(Math.random() * files.length)]
      const filePath = path.join(catDir, picked)
      const buf = fs.readFileSync(filePath)

      return {
        id: picked,
        name: picked,
        category: targetCat,
        filePath,
        source: 'self_avatar',
        base64: buf.toString('base64'),
      }
    } catch {
      return null
    }
  }

  /**
   * 联网检索图片/表情包并下载保存到桌面对应分类目录中
   */
  public async searchAndCollectMeme(keyword: string, category: string = '搞怪funny'): Promise<MemeItem | null> {
    const q = keyword.includes('表情包') || keyword.includes('图') ? keyword : `${keyword} 表情包`
    const searchUrl = `https://cn.bing.com/images/async?q=${encodeURIComponent(q)}&first=1&count=8&scenario=ImageBasicHover&datsrc=N_I&layout=RowBased&mmasync=1`

    let imgUrls: string[] = []
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 6000)
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: ctrl.signal,
      })
      clearTimeout(timer)

      if (res.ok) {
        const html = await res.text()
        imgUrls = [...html.matchAll(/murl&quot;:&quot;(http[^&]+)&quot;/g)].map((x) => x[1])
      }
    } catch {}

    if (imgUrls.length === 0) return null

    // 找到一张能顺利下载的图片
    for (const url of imgUrls.slice(0, 5)) {
      try {
        const imgCtrl = new AbortController()
        const imgTimer = setTimeout(() => imgCtrl.abort(), 5000)
        const imgRes = await fetch(url, { signal: imgCtrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
        clearTimeout(imgTimer)

        if (imgRes.ok) {
          const arrayBuffer = await imgRes.arrayBuffer()
          const buf = Buffer.from(arrayBuffer)
          if (buf.length < 5000) continue // 过滤过小破损图

          const ext = url.split('.').pop()?.split('?')[0]?.toLowerCase() || 'jpg'
          const validExt = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? ext : 'jpg'
          const safeName = `${keyword.replace(/[^\w\u4e00-\u9fa5]/g, '_').slice(0, 15)}_${Date.now()}.${validExt}`
          const destDir = path.join(this.baseDir, category)
          fs.mkdirSync(destDir, { recursive: true })
          const destPath = path.join(destDir, safeName)

          fs.writeFileSync(destPath, buf)

          return {
            id: safeName,
            name: safeName,
            category,
            filePath: destPath,
            source: 'web_collected',
            base64: buf.toString('base64'),
          }
        }
      } catch {}
    }

    return null
  }

  /**
   * 将 MemeItem 转成 QQ 发送可用的 CQ 码 [CQ:image,file=base64://...]
   */
  public toCqCode(meme: MemeItem): string {
    if (!meme.base64 && fs.existsSync(meme.filePath)) {
      try {
        meme.base64 = fs.readFileSync(meme.filePath).toString('base64')
      } catch {}
    }
    return meme.base64 ? `[CQ:image,file=base64://${meme.base64}]` : ''
  }

  /**
   * 计划一次拟人化的 QQ 聊天发送序列：
   * 1. 图文 100% 物理分离（绝不把文字与 [CQ:image,...] 混在同一个气泡里）
   * 2. 自动将回复拆成 1~3 条短促自然的 QQ 气泡，带模拟真人打字停顿
   * 3. 灵动表情包编排（支持「先甩图再说话」、「说半句甩张图再补刀」、「说完再单独发图」）
   * 4. 打破「一问一答」：针对敷衍短句、斗图、傲娇意犹未尽或状态触发，规划 3~5 秒后的延迟追击碎碎念 (afterthought)
   */
  public planQqChatSequence(options: QqChatPlanOptions): QqChatPlan {
    const rng = options.rng || Math.random
    const { textBubbles, embeddedImages } = splitIntoQqBubbles(options.text, 3)

    const userText = (options.userText || '').trim()
    const userSentMeme = userText === '[发来了一张表情包]' || userText === '[发了一个QQ小表情]'
    const isPerfunctoryUser = PERFUNCTORY_USER_REGEX.test(userText)

    // 决定是否配一张桌面表情包（若文本内未自带图片）
    const imageCqs: string[] = [...embeddedImages]
    if (imageCqs.length === 0) {
      if (options.explicitMeme) {
        const cq = this.toCqCode(options.explicitMeme)
        if (cq) imageCqs.push(cq)
      } else {
        const moodDelta = options.moodDelta ?? 0
        const shouldAttach =
          userSentMeme ||
          Boolean(options.fed) ||
          moodDelta >= 2 ||
          moodDelta <= -1 ||
          rng() < 0.42
        if (shouldAttach) {
          const picked = this.pickMemeForEmotion(options.clip, options.tone)
          if (picked) {
            const cq = this.toCqCode(picked)
            if (cq) imageCqs.push(cq)
          }
        }
      }
    }

    // 组装立即发送气泡序列（确保每个 image 都是独立气泡且 skipAt=true）
    const immediateBubbles: QqBubbleItem[] = []
    const isEmotionalFirst =
      userSentMeme ||
      ((options.tone === 'tsundere' || options.tone === 'grumpy' || options.clip === 'poke' || options.clip === 'tail') &&
        rng() < 0.38)

    if (imageCqs.length > 0 && isEmotionalFirst) {
      // 模式 A：先啪地甩出一张表情包，再发文字气泡吐槽
      immediateBubbles.push({
        kind: 'image',
        content: imageCqs[0],
        delayMs: 0,
        skipAt: true,
      })
      textBubbles.forEach((tb, idx) => {
        immediateBubbles.push({
          kind: 'text',
          content: tb,
          delayMs: calcTypingDelayMs(tb, idx + 1),
          skipAt: idx > 0, // 第一条文字在群聊中正常 @，后续文字不重复 @
        })
      })
      for (let i = 1; i < imageCqs.length; i++) {
        immediateBubbles.push({
          kind: 'image',
          content: imageCqs[i],
          delayMs: 500,
          skipAt: true,
        })
      }
    } else if (imageCqs.length > 0 && textBubbles.length >= 2 && rng() < 0.36) {
      // 模式 B：夹心连击（先发第 1 句短话 -> 单独甩一张表情包 -> 再补发剩余短话）
      immediateBubbles.push({
        kind: 'text',
        content: textBubbles[0],
        delayMs: 0,
        skipAt: false,
      })
      immediateBubbles.push({
        kind: 'image',
        content: imageCqs[0],
        delayMs: 480,
        skipAt: true,
      })
      for (let i = 1; i < textBubbles.length; i++) {
        immediateBubbles.push({
          kind: 'text',
          content: textBubbles[i],
          delayMs: calcTypingDelayMs(textBubbles[i], i + 1),
          skipAt: true,
        })
      }
      for (let i = 1; i < imageCqs.length; i++) {
        immediateBubbles.push({
          kind: 'image',
          content: imageCqs[i],
          delayMs: 500,
          skipAt: true,
        })
      }
    } else {
      // 模式 C：分段短句依次发出 -> 最后单独补发纯图片表情包
      textBubbles.forEach((tb, idx) => {
        immediateBubbles.push({
          kind: 'text',
          content: tb,
          delayMs: idx === 0 ? 0 : calcTypingDelayMs(tb, idx),
          skipAt: idx > 0,
        })
      })
      imageCqs.forEach((cq) => {
        immediateBubbles.push({
          kind: 'image',
          content: cq,
          delayMs: immediateBubbles.length === 0 ? 0 : 520,
          skipAt: true,
        })
      })
    }

    // 规划打破“一问一答”的延迟追击 / 意犹未尽碎碎念 (afterthought)
    const afterthought = this.buildAfterthought({
      ...options,
      userSentMeme,
      isPerfunctoryUser,
      rng,
    })

    return {
      immediateBubbles,
      afterthought,
    }
  }

  /**
   * 生成延迟 3~5 秒的主动追击气泡（当用户敷衍、斗图、或大肥鱼意犹未尽时触发）
   */
  private buildAfterthought(
    options: QqChatPlanOptions & {
      userSentMeme: boolean
      isPerfunctoryUser: boolean
      rng: () => number
    }
  ): { delayMs: number; bubbles: QqBubbleItem[] } | undefined {
    const {
      isOwner = true,
      isGroup = false,
      preferredTitle = isOwner ? '老爸' : '你',
      tone = 'tsundere',
      stats,
      activeAppCategory,
      userSentMeme,
      isPerfunctoryUser,
      rng,
    } = options

    // 群聊为防刷屏，仅在对方斗图或极其敷衍时才偶发追击；私聊则更活泼自然
    if (isGroup && !userSentMeme && !isPerfunctoryUser && rng() > 0.15) {
      return undefined
    }

    // 1. 对方只回了“嗯/哦/哈哈/好”等敷衍短词：大肥鱼隔 3 秒不服气追击！
    if (isPerfunctoryUser) {
      const lines = [
        `……喂！就回本鱼这么几个字吗！敷衍本鱼是要被鱼尾巴拍飞的哦😤`,
        `哼，字越少越显得你在敷衍本鱼！罚你多夸本鱼两句~`,
        `盯——${preferredTitle}是不是在偷偷忙别的事，居然这么敷衍本鱼！`,
      ]
      const chosen = lines[Math.floor(rng() * lines.length)]
      const bubbles: QqBubbleItem[] = [
        { kind: 'text', content: chosen, delayMs: 0, skipAt: true },
      ]
      const pokeMeme = this.pickMemeForEmotion('poke', 'tsundere')
      if (pokeMeme && rng() < 0.5) {
        const cq = this.toCqCode(pokeMeme)
        if (cq) bubbles.push({ kind: 'image', content: cq, delayMs: 480, skipAt: true })
      }
      return { delayMs: 2800 + Math.floor(rng() * 800), bubbles }
    }

    // 2. 对方发了表情包斗图：大肥鱼回敬完隔 3.2 秒傲娇补刀
    if (userSentMeme) {
      const lines = [
        `哼，比存表情包本鱼可从来没输过！不服再来斗图呀~`,
        `诶嘿，这张表情包是不是没有本鱼亲自出镜的可爱？🐟`,
      ]
      const chosen = lines[Math.floor(rng() * lines.length)]
      return {
        delayMs: 3000 + Math.floor(rng() * 900),
        bubbles: [{ kind: 'text', content: chosen, delayMs: 0, skipAt: true }],
      }
    }

    // 3. 日常对话中的意犹未尽碎碎念 / 主动反问（约 30% 概率触发，打破一问一答）
    if (rng() > 0.30) {
      return undefined
    }

    const candidates: string[] = []
    if (stats?.hunger !== undefined && stats.hunger < 48) {
      candidates.push(`不过话说回来……本鱼肚子都有点饿扁了，今天的小鱼干什么时候发呀？🐟`)
    }
    if (stats?.energy !== undefined && stats.energy < 40) {
      candidates.push(`呼啊……其实本鱼今天都有点犯困了，但为了陪${preferredTitle}还是强撑着鱼鳍呢~`)
    }
    if (isOwner && activeAppCategory === 'code') {
      candidates.push(`本鱼刚刚偷瞄了一眼屏幕，老爸那边的代码写得顺不顺呀？不许卡 Bug 生闷气哦👀`)
    }
    if (tone === 'tsundere') {
      candidates.push(
        `……刚才本鱼说的那句你听见没有嘛！不许装没看见！`,
        `算啦，看在你今天主动找本鱼聊天的份上，本鱼心情勉强 +1 咯~`
      )
    } else if (tone === 'happy') {
      candidates.push(
        `诶嘿，跟${preferredTitle}聊完本鱼心情都变好啦~ 你待会忙完打算干嘛呀？`,
        `对了${preferredTitle}，今天有没有遇到什么好玩的事，快跟本鱼八卦一下！`
      )
    }

    if (candidates.length === 0) return undefined
    const pickedLine = candidates[Math.floor(rng() * candidates.length)]
    return {
      delayMs: 3200 + Math.floor(rng() * 1200),
      bubbles: [{ kind: 'text', content: pickedLine, delayMs: 0, skipAt: true }],
    }
  }
}

export interface QqBubbleItem {
  kind: 'text' | 'image'
  content: string
  /** 发送该气泡前的拟人打字停顿毫秒数 */
  delayMs: number
  /** 群聊中是否跳过 @发送者（纯图片与连发第 2+ 条气泡设为 true） */
  skipAt: boolean
}

export interface QqChatPlan {
  immediateBubbles: QqBubbleItem[]
  afterthought?: {
    delayMs: number
    bubbles: QqBubbleItem[]
  }
}

export interface QqChatPlanOptions {
  text: string
  clip?: string
  tone?: string
  moodDelta?: number
  fed?: boolean
  userText?: string
  isOwner?: boolean
  isGroup?: boolean
  preferredTitle?: string
  stats?: { hunger?: number; mood?: number; energy?: number }
  activeAppCategory?: string
  explicitMeme?: MemeItem | null
  rng?: () => number
}

/** 识别用户极短敷衍回复（嗯、哦、噢、好、行、哈哈、6、ok、...） */
export const PERFUNCTORY_USER_REGEX =
  /^(?:嗯+|哦+|噢+|额+|呃+|好(?:的|吧|嘞|呀)?|行(?:吧)?|哈+|嘿+|呵+|6+|ok|okay|\.+|。+|…+)$/i

/**
 * 根据单条气泡字数估算拟人打字间隔 (400ms ~ 900ms)
 */
function calcTypingDelayMs(text: string, index: number): number {
  const len = (text || '').length
  const base = 360 + Math.min(480, len * 22)
  return index === 1 ? base : Math.min(920, base + 80)
}

/**
 * 将回复文本与内嵌 CQ 图片彻底拆离，并将长句按真人 QQ 习惯切分为 1~3 条短句气泡
 */
export function splitIntoQqBubbles(
  rawText: string,
  maxTextBubbles: number = 3
): { textBubbles: string[]; embeddedImages: string[] } {
  const embeddedImages: string[] = []
  if (!rawText) {
    return { textBubbles: [], embeddedImages }
  }

  // 1. 提取并剥离所有 [CQ:image,...]，确保图片绝不与文字混在同一个气泡
  const withoutImages = rawText
    .replace(/\[CQ:image,[^\]]+\]/gi, (match) => {
      embeddedImages.push(match.trim())
      return ''
    })
    .trim()

  if (!withoutImages) {
    return { textBubbles: [], embeddedImages }
  }

  // 2. 若包含结构化数据报告（如双换行后的【...】或列表项），将口语开场白与数据卡片分为两个独立气泡
  const doubleNewlineIdx = withoutImages.indexOf('\n\n')
  if (
    doubleNewlineIdx !== -1 &&
    (withoutImages.includes('【') || withoutImages.includes('- ') || withoutImages.includes('• '))
  ) {
    const intro = withoutImages.slice(0, doubleNewlineIdx).replace(/\s*\|\s*/g, '，').trim()
    const report = withoutImages.slice(doubleNewlineIdx + 2).trim()
    const bubbles = [intro, report].filter(Boolean)
    return { textBubbles: bubbles, embeddedImages }
  }

  // 3. 优先按显式气泡分隔符 "|" 或换行切分
  let segments = withoutImages
    .split(/\s*\|\s*|\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean)

  // 4. 若仍为单条较长口语（> 11 字），按句末语气标点（！ ？ ~ … 。 ；）自然切分
  if (segments.length === 1 && segments[0].length > 11) {
    const sentenceParts = segments[0]
      .split(/(?<=[！？!?~～…；。])\s*/)
      .map((s) => s.trim())
      .filter(Boolean)

    if (sentenceParts.length > 1) {
      segments = sentenceParts
    } else if (segments[0].length > 16 && segments[0].includes('，')) {
      // 若无句号但有较长逗号分句，按第一处逗号拆为上下两句
      const commaIdx = segments[0].indexOf('，')
      if (commaIdx >= 4 && segments[0].length - commaIdx > 5) {
        segments = [
          segments[0].slice(0, commaIdx).trim(),
          segments[0].slice(commaIdx + 1).trim(),
        ]
      }
    }
  }

  // 5. 合并超出 maxTextBubbles 的尾部片段，并去掉短句末尾生硬的句号 "。"
  if (segments.length > maxTextBubbles) {
    const head = segments.slice(0, maxTextBubbles - 1)
    const tail = segments.slice(maxTextBubbles - 1).join('，')
    segments = [...head, tail]
  }

  const textBubbles = segments
    .map((seg) => (seg.length <= 28 ? seg.replace(/。+$/, '') : seg))
    .filter(Boolean)

  return { textBubbles, embeddedImages }
}
