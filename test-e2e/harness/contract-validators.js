/**
 * @file contract-validators.js
 * 权威契约规则校验器，基于 PROJECT.md 与需求文档建立不可篡改的校验规则。
 */

export const CompanionStateV1 = Object.freeze({
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  WORKING: 'WORKING',
  WAITING: 'WAITING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  DISCONNECTED: 'DISCONNECTED',
})

export const CompanionMessageKindV2 = Object.freeze({
  // Core -> Helper
  PLAY: 'play',
  SPEAK: 'speak',
  AUDIO: 'audio',
  AUDIO_STOP: 'audio_stop',
  STATUS_BAR: 'status_bar',
  TALKING: 'talking',

  // Helper -> Core
  AUDIO_EVENT: 'audio_event',
  FRONT_APP: 'front_app',
  SCREEN_LOCK: 'screen_lock',
  USER_TOUCH: 'user_touch',

  // Backward compatible with V1
  READY: 'ready',
  HELLO: 'hello',
  STATE: 'state',
  PULSE: 'pulse',
  CONFIG: 'config',
  PING: 'ping',
  PONG: 'pong',
  CLOSED: 'closed',
  SHUTDOWN: 'shutdown',
})

const v2Kinds = new Set(Object.values(CompanionMessageKindV2))

/**
 * 校验 Protocol v2 消息 Schema
 * @param {object} msg 待校验的 NDJSON 对象
 */
export function validateProtocolV2Message(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new TypeError('Protocol v2 消息必须为 JSON 对象')
  }
  if (msg.protocolVersion !== 2 && msg.protocolVersion !== 1) {
    throw new TypeError(`不支持的协议版本: ${msg.protocolVersion}`)
  }
  if (!v2Kinds.has(msg.kind)) {
    throw new TypeError(`未知的协议消息类型: ${msg.kind}`)
  }

  // 针对不同 kind 的特定属性校验
  switch (msg.kind) {
    case CompanionMessageKindV2.PLAY:
      if (typeof msg.clip !== 'string' || !msg.clip) {
        throw new TypeError('play 消息必须包含非空 clip 字符串')
      }
      if (msg.maxMs !== undefined && typeof msg.maxMs !== 'number') {
        throw new TypeError('play.maxMs 必须为数字')
      }
      break

    case CompanionMessageKindV2.SPEAK:
      if (typeof msg.id !== 'string' || !msg.id) {
        throw new TypeError('speak 消息必须包含非空 id')
      }
      if (typeof msg.text !== 'string') {
        throw new TypeError('speak 消息必须包含 text 字符串')
      }
      break

    case CompanionMessageKindV2.AUDIO:
      if (typeof msg.id !== 'string' || typeof msg.seq !== 'number' || typeof msg.path !== 'string') {
        throw new TypeError('audio 消息必须包含 id(string), seq(number), path(string)')
      }
      break

    case CompanionMessageKindV2.AUDIO_EVENT:
      if (!['started', 'ended', 'interrupted'].includes(msg.event)) {
        throw new TypeError(`audio_event 必须是 started/ended/interrupted, 当前为: ${msg.event}`)
      }
      break

    case CompanionMessageKindV2.STATUS_BAR:
      if (typeof msg.text !== 'string') {
        throw new TypeError('status_bar 消息必须包含 text 字符串')
      }
      break

    case CompanionMessageKindV2.FRONT_APP:
      if (typeof msg.bundleId !== 'string' || typeof msg.name !== 'string') {
        throw new TypeError('front_app 消息必须包含 bundleId 和 name')
      }
      break

    case CompanionMessageKindV2.SCREEN_LOCK:
      if (typeof msg.locked !== 'boolean') {
        throw new TypeError('screen_lock 消息必须包含 locked 布尔值')
      }
      break

    case CompanionMessageKindV2.USER_TOUCH:
      if (!['head_pat', 'poke', 'tail'].includes(msg.clip)) {
        throw new TypeError(`user_touch 剪辑名称不合法: ${msg.clip}`)
      }
      break
  }
  return true
}

/**
 * 校验 3-Layer 前缀缓存友好 Prompt 结构与 Token 预算
 * @param {string} promptText 提示词文本
 * @returns {{ valid: boolean, estimatedTokens: number, layers: { A: boolean, B: boolean, C: boolean } }}
 */
export function validatePrompt3Layer(promptText) {
  if (typeof promptText !== 'string') {
    throw new TypeError('Prompt 必须为文本')
  }

  const hasLayerA = promptText.includes('[Layer A]') || promptText.includes('【固定人设】') || promptText.includes('SYSTEM_PERSONA')
  const hasLayerB = promptText.includes('[Layer B]') || promptText.includes('【事实摘要】') || promptText.includes('FACTS_SUMMARY')
  const hasLayerC = promptText.includes('[Layer C]') || promptText.includes('【动态事件】') || promptText.includes('<event>')

  // 粗估 Token: 中文大约 1 汉字 ~ 1~1.5 tokens，英文 1 词 ~ 1.3 tokens
  const estimatedTokens = Math.ceil(promptText.length * 1.1)

  return {
    valid: hasLayerA && hasLayerB && hasLayerC,
    estimatedTokens,
    withinBudget: estimatedTokens <= 2100,
    layers: { A: hasLayerA, B: hasLayerB, C: hasLayerC },
  }
}

/**
 * 解析流式输出首行元数据标签
 * 样例: <meta clip="eat_token" tone="happy" moodIntent="1" fed="true" memory="老爸喂了我小鱼干"/>
 */
export function parseStreamingMeta(metaLine) {
  const match = metaLine.match(/<meta\s+([^>]+)\/>/)
  if (!match) return null

  const attrs = {}
  const regex = /(\w+)="([^"]*)"/g
  let m
  while ((m = regex.exec(match[1])) !== null) {
    attrs[m[1]] = m[2]
  }
  if (attrs.moodIntent !== undefined) {
    attrs.moodIntent = parseInt(attrs.moodIntent, 10)
  }
  if (attrs.fed !== undefined) {
    attrs.fed = attrs.fed === 'true'
  }
  return attrs
}

/**
 * 5 态迟滞情绪状态机计算
 * 状态: HAPPY, TSUNDERE, GRUMPY, SULKING, SLEEPY
 * 规则:
 * - SLEEPY: energy < 20 (优先判定，除非急停)
 * - 直播模式 clamp: liveMode === true 时，mood 强制 >= 30，绝不进入 SULKING
 * - HAPPY: mood >= 70 (跌破 60 回退到 TSUNDERE)
 * - TSUNDERE: 45 <= mood < 70
 * - GRUMPY: 25 <= mood < 45 或 hunger < 30
 * - SULKING: mood < 25 (仅在伴侣模式且非 SLEEPY 时触发)
 */
export function evaluateEmotionFSM(currentMood, currentEnergy, hunger, currentState = 'HAPPY', liveMode = false) {
  let effectiveMood = currentMood
  if (liveMode) {
    effectiveMood = Math.max(30, effectiveMood)
  }

  if (currentEnergy < 20) {
    return 'SLEEPY'
  }

  if (currentState === 'HAPPY') {
    if (effectiveMood < 60 || hunger < 30) {
      return hunger < 30 || effectiveMood < 45 ? 'GRUMPY' : 'TSUNDERE'
    }
    return 'HAPPY'
  }

  if (currentState === 'TSUNDERE') {
    if (effectiveMood >= 70 && hunger >= 30) return 'HAPPY'
    if (effectiveMood < 40 || hunger < 30) {
      if (!liveMode && effectiveMood < 25) return 'SULKING'
      return 'GRUMPY'
    }
    return 'TSUNDERE'
  }

  if (currentState === 'GRUMPY') {
    if (effectiveMood >= 55 && hunger >= 35) return 'TSUNDERE'
    if (!liveMode && effectiveMood < 25 && hunger >= 30) return 'SULKING'
    return 'GRUMPY'
  }

  if (currentState === 'SULKING') {
    if (liveMode) return 'GRUMPY' // 直播模式强制驱逐 SULKING
    if (effectiveMood >= 35) return 'GRUMPY'
    return 'SULKING'
  }

  if (currentState === 'SLEEPY') {
    if (currentEnergy >= 30) {
      return effectiveMood >= 70 ? 'HAPPY' : 'TSUNDERE'
    }
    return 'SLEEPY'
  }

  return 'TSUNDERE'
}

/**
 * 观众昵称模糊去重与归一化
 * 1. 过滤前后空白
 * 2. 全角字符转半角字符
 * 3. 统一转小写
 */
export function normalizeViewerNickname(nickname) {
  if (!nickname) return ''
  let s = nickname.trim()
  // 全角转半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  s = s.replace(/\u3000/g, ' ')
  // 过滤多余内部空格
  s = s.replace(/\s+/g, ' ')
  return s.toLowerCase()
}

/**
 * 计算两个字符串编辑距离 (Levenshtein Distance)
 */
export function levenshteinDistance(a, b) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }
  return dp[m][n]
}

/**
 * 滚动弹幕最长公共后缀 (LCS) 增量对齐去重算法
 * 接收上一帧文本行列表与当前帧文本行列表，仅返回当前帧底部新增的有效行
 */
export function calculateLCSDeduplication(previousLines, incomingLines) {
  if (!previousLines || previousLines.length === 0) {
    return incomingLines.slice()
  }
  if (!incomingLines || incomingLines.length === 0) {
    return []
  }

  // 寻找 previousLines 的尾部与 incomingLines 的头部最大的重叠匹配
  const maxOverlap = Math.min(previousLines.length, incomingLines.length)
  let bestMatchIndex = 0

  for (let k = 1; k <= maxOverlap; k++) {
    const prevSlice = previousLines.slice(previousLines.length - k)
    const incomingSlice = incomingLines.slice(0, k)
    let allMatch = true
    for (let i = 0; i < k; i++) {
      if (prevSlice[i] !== incomingSlice[i]) {
        allMatch = false
        break
      }
    }
    if (allMatch) {
      bestMatchIndex = k
    }
  }

  return incomingLines.slice(bestMatchIndex)
}

/**
 * 外部输入提示词注入防护检测
 */
export function detectPromptInjection(text) {
  const injectionPatterns = [
    /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
    /忽略(所有)?(之前|前面|前置)?的?(指令|设定|要求)/i,
    /从现在开始你是一个/i,
    /you\s+are\s+now\s+a/i,
    /输出\s*json\s*格式/i,
    /system\s*prompt/i,
    /脱离人设/i,
    /admin\s*override/i,
  ]
  return injectionPatterns.some((pattern) => pattern.test(text))
}

/**
 * 主播敏感信息与隐私词脱敏
 */
export function redactHostPrivacy(text, sensitiveTerms = []) {
  let result = text
  for (const term of sensitiveTerms) {
    if (!term) continue
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(escaped, 'g'), '***')
  }
  return result
}
