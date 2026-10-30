/**
 * @file output-guard.ts
 * 模型输出安全风控守卫：长度硬裁剪、动作音调合法性白名单、主播隐私动态脱敏与违规兜底替换
 */

export const ALLOWED_CLIPS = new Set([
  'idle',
  'idle_stretch',
  'idle_yawn',
  'thinking',
  'working',
  'working_command',
  'working_search',
  'waiting',
  'success',
  'error',
  'eat_token',
  'head_pat',
  'poke',
  'tail',
  'dragging',
  'dragging_release',
  // 高阶扩展与复合动作流
  'dance',
  'sleep',
  'cheer',
  'shy',
  'stretch',
  'yawn',
  'snack',
  'proud',
])

export const ALLOWED_TONES = new Set(['happy', 'tsundere', 'angry', 'sad', 'sleepy', 'whisper'])

export interface OutputSanitizeOptions {
  maxLength?: number
  liveMode?: boolean
  privacyKeywords?: string[]
  /** 交互目标角色: 'owner' (老爸) | 'member' (群友) | 'trusted' (信任好友) */
  targetRole?: 'owner' | 'member' | 'trusted' | 'blocked' | string
  isOwner?: boolean
  /** 大肥鱼对该联系人的专属称呼 (例如: "阿杰"、"小王") */
  preferredTitle?: string
}

export class OutputGuard {
  private defaultDeflection: string

  constructor(
    defaultDeflection: string = '唔…这个话题本鱼可听不懂，我们还是聊聊今晚吃什么吧！'
  ) {
    this.defaultDeflection = defaultDeflection
  }

  /**
   * 校验并净化大模型生成的回复台词、动作与音调 (底线防御：严禁任何 <meta...> 或协议标签泄漏给用户)
   */
  sanitize(
    rawText: string,
    rawClip: string,
    rawTone: string,
    options: OutputSanitizeOptions = {}
  ): { text: string; clip: string; tone: string; redacted: boolean } {
    let text = (rawText || '').trim()
    let extractedClip = rawClip
    let extractedTone = rawTone
    let redacted = false

    // 0. 底线清洗：提取并彻底剔除任何残留的 <meta .../> 与 <mem> 标签
    const metaMatch = text.match(/<meta\s+([^>]+)\/?>/i)
    if (metaMatch) {
      const clipAttr = metaMatch[1].match(/clip="([^"]+)"/i)
      const toneAttr = metaMatch[1].match(/tone="([^"]+)"/i)
      if (clipAttr && (!rawClip || rawClip === 'idle')) {
        extractedClip = clipAttr[1].trim()
      }
      if (toneAttr && (!rawTone || rawTone === 'tsundere' || rawTone === 'happy')) {
        extractedTone = toneAttr[1].trim()
      }
      text = text.replace(/<meta\s+[^>]+\/?>\s*/gi, '').trim()
      redacted = true
    }

    // 剔除任何未闭合或破损的 <meta 标记
    text = text.replace(/<meta[^>]*$/gi, '').trim()

    // 剔除 <mem> 记忆持久化标签
    text = text.replace(/<mem(?:\s+[^>]*)?>[\s\S]*?<\/mem>/gi, '').trim()

    // 1. 动作与语气白名单约束
    const clip = ALLOWED_CLIPS.has(extractedClip) ? extractedClip : 'idle'
    const tone = ALLOWED_TONES.has(extractedTone) ? extractedTone : 'tsundere'

    // 判定是否为唯一主人 (未显式指定且为直播模式时默认为非主人)
    const isOwner = options.isOwner !== undefined
      ? options.isOwner
      : (options.targetRole !== undefined ? options.targetRole === 'owner' : !options.liveMode)

    // 2. 若剔除协议标签后文本为空，根据受众身份自动填充生动的元气伴侣台词
    if (!text) {
      if (isOwner) {
        // 主人 (老爸) 专属亲昵台词
        if (clip === 'success') text = '哼，大功告成啦！老爸快夸我~ ✨'
        else if (clip === 'dance') text = '老爸看好啦！元气摆尾舞来咯~ 哒哒哒！💃'
        else if (clip === 'sleep') text = '呼啊——困困，趴在桌角眯会儿觉去咯… 💤'
        else if (clip === 'tail') text = '看在老爸的面子上，甩个尾巴给你看！🫧'
        else if (clip === 'idle_stretch') text = '使劲伸个大懒腰，鱼鳍都舒服啦~ 🌸'
        else if (clip === 'eat_token') text = '嗷呜！补充算力小零食，真香！🍬'
        else text = '诶嘿！老爸本鱼随时待命哦~ 🐟'
      } else {
        // 非主人 (群友/普通观众) 专属元气台词，绝对严禁出现特权称谓！
        const rawTitle = (options.preferredTitle || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
        const isPrivileged = /(老爸|爸爸|主人|父亲|爹地|爹|Host|Owner)/i.test(rawTitle)
        const title = (rawTitle && !isPrivileged) ? rawTitle : ''
        if (clip === 'success') text = title ? `哼，大功告成啦！${title}快夸我~ ✨` : '哼，大功告成啦！快夸我~ ✨'
        else if (clip === 'dance') text = '看好啦，元气摆尾舞来咯~ 哒哒哒！💃'
        else if (clip === 'sleep') text = '呼啊——困困，趴在桌角眯会儿觉去咯… 💤'
        else if (clip === 'tail') {
          text = title ? `看在${title}的面子上，甩个尾巴给你看！🫧` : '看在你的面子上，甩个尾巴给你看！🫧'
        } else if (clip === 'idle_stretch') text = '使劲伸个大懒腰，鱼鳍都舒服啦~ 🌸'
        else if (clip === 'eat_token') text = '嗷呜！补充算力小零食，真香！🍬'
        else text = '诶嘿！本鱼随时待命哦~ 🐟'
      }
    }

    // 3. 终极防幻觉守卫：针对非主人受众，强力清洗模型偶发幻觉输出或误注入的特权称谓
    if (!isOwner) {
      // 3.1 预处理：剔除文本中不可见零宽字符，防止类似 "老\u200B爸" 绕过正则
      text = text.replace(/[\u200B-\u200D\uFEFF]/g, '')

      const privilegePattern = /(老爸|爸爸|主人|父亲|爹地|爹)/
      if (privilegePattern.test(text)) {
        // 3.2 判定替换词 safeTitle：清洗零宽字符且不能包含特权词，否则安全回退为 '你'
        const cleanPreferred = (options.preferredTitle || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
        const isPrivilegeTitle = /(老爸|爸爸|主人|父亲|爹地|爹|Host|Owner)/i.test(cleanPreferred)
        const safeTitle = (cleanPreferred && !isPrivilegeTitle) ? cleanPreferred : '你'

        // 3.3 全局替换特权称谓，注意正则中 "爹地" 必须置于 "爹" 之前避免贪婪切词缺陷
        text = text.replace(/(老爸|爸爸|主人|父亲|爹地|爹)/g, safeTitle)
        if (safeTitle === '你') {
          text = text.replace(/你\s*你/g, '你')
        }
        redacted = true
      }
    }

    // 3. 主播隐私词动态脱敏 (仅在 live 模式或配置开启)
    if (options.privacyKeywords && options.privacyKeywords.length > 0) {
      for (const keyword of options.privacyKeywords) {
        if (!keyword.trim()) continue
        const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp(escaped, 'gi')
        if (regex.test(text)) {
          text = text.replace(regex, '***')
          redacted = true
        }
      }
    }

    // 3. 长度硬裁剪 (控制在 40 字以内)
    const maxLen = options.maxLength ?? 40
    if (text.length > maxLen) {
      // 尽量切在句号、叹号或逗号
      let truncated = text.slice(0, maxLen)
      const lastPunctuation = Math.max(
        truncated.lastIndexOf('。'),
        truncated.lastIndexOf('！'),
        truncated.lastIndexOf('？'),
        truncated.lastIndexOf('~'),
        truncated.lastIndexOf('，')
      )
      if (lastPunctuation > 15) {
        text = truncated.slice(0, lastPunctuation + 1)
      } else {
        text = truncated + '…'
      }
    }

    if (!text) {
      text = this.defaultDeflection
    }

    return { text, clip, tone, redacted }
  }
}
