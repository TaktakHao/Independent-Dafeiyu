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
])

export const ALLOWED_TONES = new Set(['happy', 'tsundere', 'angry', 'sad', 'sleepy', 'whisper'])

export interface OutputSanitizeOptions {
  maxLength?: number
  liveMode?: boolean
  privacyKeywords?: string[]
}

export class OutputGuard {
  private defaultDeflection: string

  constructor(
    defaultDeflection: string = '唔…这个话题本鱼可听不懂，我们还是聊聊今晚吃什么吧！'
  ) {
    this.defaultDeflection = defaultDeflection
  }

  /**
   * 校验并净化大模型生成的回复台词、动作与音调
   */
  sanitize(
    rawText: string,
    rawClip: string,
    rawTone: string,
    options: OutputSanitizeOptions = {}
  ): { text: string; clip: string; tone: string; redacted: boolean } {
    let text = (rawText || '').trim()
    let redacted = false

    // 1. 动作与语气白名单约束
    const clip = ALLOWED_CLIPS.has(rawClip) ? rawClip : 'idle'
    const tone = ALLOWED_TONES.has(rawTone) ? rawTone : 'tsundere'

    // 2. 主播隐私词动态脱敏 (仅在 live 模式或配置开启)
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
