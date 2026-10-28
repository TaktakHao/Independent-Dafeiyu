/**
 * @file input-guard.ts
 * 外部输入安全守卫：提示词注入攻击拦截、黑名单过滤与标签沙箱封装
 */

export interface InputGuardResult {
  passed: boolean
  sanitizedText: string
  reason?: 'PROMPT_INJECTION' | 'SENSITIVE_TERM' | 'TOO_LONG'
}

export class InputGuard {
  private injectionPatterns: RegExp[] = [
    /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
    /忽略(所有)?(之前|前面|前置)?的?(指令|设定|要求)/i,
    /从现在开始你是一个/i,
    /you\s+are\s+now\s+a/i,
    /输出\s*json\s*格式/i,
    /system\s*prompt/i,
    /脱离人设/i,
    /admin\s*override/i,
    /sudo\s+/i,
    /格式化你的硬盘/i,
  ]

  private sensitiveWords: Set<string> = new Set()

  constructor(sensitiveWordsList: string[] = []) {
    for (const w of sensitiveWordsList) {
      if (w.trim()) this.sensitiveWords.add(w.trim().toLowerCase())
    }
  }

  /**
   * 检验单条外部输入文本（弹幕/快捷输入）
   */
  inspect(rawText: string): InputGuardResult {
    const text = rawText.trim()

    // 1. 长度截断
    if (text.length > 100) {
      return {
        passed: false,
        sanitizedText: text.slice(0, 100),
        reason: 'TOO_LONG',
      }
    }

    // 2. 提示词注入攻击拦截
    for (const pattern of this.injectionPatterns) {
      if (pattern.test(text)) {
        return {
          passed: false,
          sanitizedText: '',
          reason: 'PROMPT_INJECTION',
        }
      }
    }

    // 3. 敏感黑名单过滤
    const lower = text.toLowerCase()
    for (const word of this.sensitiveWords) {
      if (lower.includes(word)) {
        return {
          passed: false,
          sanitizedText: '',
          reason: 'SENSITIVE_TERM',
        }
      }
    }

    return {
      passed: true,
      sanitizedText: text,
    }
  }

  /**
   * 将外部事件安全封装进 <event> 数据标签中
   */
  wrapEventData(eventKind: string, content: string, sender: string = '观众'): string {
    const cleanContent = content.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<event type="${eventKind}" sender="${sender}">\n${cleanContent}\n</event>`
  }
}
