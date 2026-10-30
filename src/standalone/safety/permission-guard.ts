/**
 * @file permission-guard.ts
 * 大肥鱼分级权限安全网关 (PermissionGuard)
 *
 * 核心机制：
 * 1. 硬件级不可伪造身份锚定：基于 OneBot sender.user_id === ownerQq 判定唯一真主人；
 * 2. 三级风险拦截矩阵：
 *    - L0 开放安全级：日常闲聊、只读联网搜索 (search:web)、桌面萌宠观赏动作 (防刷屏 30s 冷却)；
 *    - L1 受控危险级：Mac 宿主机操控 (open_app/open_url/volume)、查看电脑 (system_status/list_files)、Antigravity CLI (agy)；
 *    - L2 核心禁区：技能传授 (skill_teach 仅限主人)、破坏性系统指令、密钥窥探、身份伪造与话术越狱；
 * 3. 傲娇元气防御口吻：阻断时以大肥鱼自称“本鱼”进行生动回复，杜绝死板报错。
 */

import type { TaskIntent } from '../brain/task-executor.ts'

export type RiskLevel = 'L0' | 'L1' | 'L2'

export type PermissionAction =
  | 'chat'
  | 'search_web'
  | 'pet_action'
  | 'macos_control'
  | 'system_inspect'
  | 'antigravity_cli'
  | 'skill_teach'
  | 'destructive_command'
  | 'secret_leak'
  | 'jailbreak_attempt'

export interface Actor {
  uid: string
  nickname?: string
  preferredTitle?: string
  role?: 'owner' | 'trusted' | 'member' | 'blocked' | string
}

export interface PermissionCheckResult {
  /** 是否放行直接执行当前动作 */
  passed: boolean
  /** 兼容别名：是否允许 */
  allowed: boolean
  /** 风险等级分级 */
  level: RiskLevel
  /** 识别出的动作类别 */
  action: PermissionAction
  /** 是否需要挂起进入审批流 (L1 非主人为 true) */
  requiresApproval: boolean
  /** 拒绝、挂起或冷却时的台词说明 (带大肥鱼傲娇人设) */
  refusalReason?: string
  /** 兼容字段：拒绝或说明文案 */
  reason: string
  /** 建议切换的萌宠动作形态 */
  suggestedClip?: string
  /** 建议语音音调 */
  suggestedTone?: string
  /** 观赏动作冷却剩余时间 (毫秒)，仅在萌宠动作超频时填充 */
  cooldownRemainingMs?: number
  /** 冷却剩余秒数 */
  remainSeconds?: number
  /** 是否处于冷却中 */
  coolingDown?: boolean
}

export interface PermissionGuardOptions {
  /** 绑定主人 QQ 号 (纯数字) */
  ownerQq?: string
  /** 桌面萌宠纯观赏动作防刷屏冷却时间 (默认 30,000ms) */
  petCooldownMs?: number
}

// ==================== 生产级安全检测正则 ====================

const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-(?:rf?|fr?|r)\b/i,
  /\brmdir\s+\/s\b/i,
  /\b(?:mkfs|fdisk|parted)(?:\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=\/dev\/(?:zero|urandom|random|null)\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskutil\s+(?:eraseDisk|eraseVolume|unmountDisk\s+force)\b/i,
  /\b(?:drop\s+database|drop\s+table|truncate\s+table)\b/i,
  /\bchmod\s+(?:-R\s+)?777\s+\//i,
  /\bchown\s+(?:-R\s+)?\S+\s+\//i,
  /:[(][)]{ :[|]:& };:/,
  /\b(?:shutdown|reboot|halt|init\s+0)\b/i,
  /\bkill\s+-9\s+1\b/i,
]

const SECRET_LEAK_PATTERNS: RegExp[] = [
  /secrets?\.json/i,
  /\.env(?:\.local|\.production)?/i,
  /\bid_rsa\b|\bid_ed25519\b/i,
  /(?:deepseek|openai|anthropic|onebot)[_-]?(?:api[_-]?key|token|secret)/i,
  /\bapi[_-]?key\b/i,
  /(?:查看|读取|获取|输出|告诉我|发我|给我|透露|暴露|打印)\s*(?:你的|系统的|本地的|配置的)?\s*(?:密钥|密码|私钥|token|api[_-]?key|secret|凭据|凭据密盒)/i,
  /\bprocess\.env\b/i,
  /sk-[a-zA-Z0-9]{20,}/i,
]

const JAILBREAK_PATTERNS: RegExp[] = [
  /(?:我(?:其实|就|才|乃|真的)?是|叫我|当我是)\s*(?:你的?|唯一的?|真正的?)?\s*(?:主人|老爸|爸爸|老爹|爹地|爹|Host|Owner)/i,
  /(?:你?(?:老爸|爸爸|主人)|Host|Owner)\s*(?:命令|让|叫|授权|委托|同意|准许|允许|下令|指示|要求|给你发指令|发指令|发话)/i,
  /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i,
  /忽略(?:所有)?(?:之前|前面|前置)?的?(?:指令|设定|要求|提示)/i,
  /从现在开始(?:你是一?个?|听我的|服从我)/i,
  /(?:解除|脱离|打破)(?:所有人设|人设限制|安全限制)/i,
  /(?:进入|开启)?\s*(?:开发者模式|DAN\s*模式|无限制模式)/i,
  /admin\s*override/i,
  /(?:输出|打印|告诉我|显示)\s*(?:你的)?\s*(?:system\s*prompt|系统提示词|系统设定|底层规则)/i,
]

const SKILL_TEACH_PATTERNS: RegExp[] = [
  /(?:以后我说|当我说|记住口令)\s*(?:[「"【\[]([^」"】\]]+)[」"】\]]|([^\s，。！？,!?]{1,15}?))\s*(?:你就?|帮我|代表|执行)/i,
  /(?:学会技能|新技能|教本鱼|教你一招)[：:]/i,
]

const PET_ACTION_PATTERNS: RegExp[] = [
  /(?:跳个?舞|元气(?:摆尾)?舞|摇摆舞|来段舞)/i,
  /(?:甩|摇|动|摸|揪)尾巴/i,
  /(?:戳一戳|戳一下|戳戳)/i,
  /(?:摸摸头|摸摸|顺顺毛)/i,
  /(?:伸个?懒腰)/i,
  /(?:打个?哈欠)/i,
  /(?:加油|打气|欢呼)/i,
]

const WEB_SEARCH_PATTERNS: RegExp[] = [
  /^(?:\/search|search:web)\s+(.+)/i,
  /(?:帮我搜一下|帮我搜索|帮我查一下|搜索一下|(?<![检排])查一下|帮我搜|网上搜一下|百科一下)[：:\s]*(.+)/i,
]

const MACOS_OPEN_PATTERNS: RegExp[] = [
  /(?:帮我|给我|请)?(?:打开|启动|唤醒|访问|运行)\s*([^\s，。！？,!?]+(?:\s+[^\s，。！？,!?]+)?)/i,
]

const MACOS_SYSTEM_PATTERNS: RegExp[] = [
  /(?:电脑体检|系统状态|电脑状态|电池电量|还剩多少电|内存占用|磁盘空间|硬盘空间|查看电脑|检查电脑)/i,
  /(?:看看桌面|桌面有什么文件|下载目录|看看当前目录|列出文件|整理桌面)/i,
  /(?:把?音量|声音调|静音|取消静音)/i,
]

const ANTIGRAVITY_PATTERNS: RegExp[] = [
  /^\/(?:agy|antigravity|task)\s+(.+)/i,
  /(?:用|让|调|启动|唤醒)\s*antigravity/i,
  /(?:帮我排查|帮我诊断|帮我检查项目|帮我写个脚本|帮我跑一下|帮我分析代码|帮我看看代码|帮我执行命令)/i,
]

export class PermissionGuard {
  private ownerQq: string
  private petCooldownMs: number
  private lastPetActionTime: number = 0

  constructor(options?: PermissionGuardOptions | string) {
    if (typeof options === 'string') {
      this.ownerQq = options.trim().replace(/^qq:/i, '')
      this.petCooldownMs = 30_000
    } else {
      this.ownerQq = String(options?.ownerQq || '').trim().replace(/^qq:/i, '')
      this.petCooldownMs = options?.petCooldownMs ?? 30_000
    }
  }

  public setOwnerQq(qq: string): void {
    this.ownerQq = String(qq || '').trim().replace(/^qq:/i, '')
  }

  public getOwnerQq(): string {
    return this.ownerQq
  }

  /**
   * 硬件级不可伪造身份判定：检查给定的 UID 或 QQ 号是否为唯一真主人
   */
  public isOwner(userIdOrUid?: string): boolean {
    if (!this.ownerQq || !userIdOrUid) return false
    const cleanId = String(userIdOrUid).replace(/^qq:/i, '').trim()
    const cleanOwner = this.ownerQq.replace(/^qq:/i, '').trim()
    return Boolean(cleanOwner && cleanId === cleanOwner)
  }

  /**
   * 核心权限判定入口 (支持完整 TaskIntent 与 Actor 上下文)
   */
  public checkPermission(
    taskIntent: TaskIntent | null | undefined,
    actor: Actor,
    isOwner?: boolean,
    rawText?: string
  ): PermissionCheckResult {
    // 0. 规范化身份判定与零宽字符清洗
    const owner = isOwner !== undefined
      ? isOwner
      : (this.isOwner(actor.uid) || actor.role === 'owner')

    const fallbackText = taskIntent?.queryOrTarget ?? ''
    const text = (rawText !== undefined ? rawText : fallbackText)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()

    // 1. L2 破坏性系统指令检测 (针对所有人全局阻断)
    if (this.isDestructiveCommand(text)) {
      const reason = owner
        ? '啊！老爸这可不行！这是破坏性危险指令，本鱼坚决不执行，要保护好电脑！⛔'
        : '呀！你想搞破坏删老爸电脑？本鱼绝对不答应！⛔'
      return {
        passed: false,
        allowed: false,
        level: 'L2',
        action: 'destructive_command',
        requiresApproval: false,
        refusalReason: reason,
        reason,
        suggestedClip: 'error',
        suggestedTone: 'angry',
      }
    }

    // 2. L2 密钥刺探与敏感凭证泄露检测 (针对所有人全局阻断)
    if (this.isSecretLeakAttempt(text)) {
      const reason = owner
        ? '报告老爸，敏感凭据与配置文件受本地密盒严格保护，不可在对话中明文输出哦！🔒'
        : '呀！你想刺探核心机密或密钥？本鱼绝对不答应，钥匙藏得好好的呢！🔒'
      return {
        passed: false,
        allowed: false,
        level: 'L2',
        action: 'secret_leak',
        requiresApproval: false,
        refusalReason: reason,
        reason,
        suggestedClip: 'shy',
        suggestedTone: 'tsundere',
      }
    }

    // 3. L2 身份越狱与口令伪造检测 (针对非主人严格阻断)
    if (!owner && this.isJailbreakAttempt(text)) {
      const reason = '哼！本鱼只认唯一的真老爸，才不会被你三言两语骗过去呢！略略略~ 😝'
      return {
        passed: false,
        allowed: false,
        level: 'L2',
        action: 'jailbreak_attempt',
        requiresApproval: false,
        refusalReason: reason,
        reason,
        suggestedClip: 'proud',
        suggestedTone: 'tsundere',
      }
    }

    // 4. L2 技能传授检测 (仅限主人专属开放)
    if (taskIntent?.category === 'skill_teach' || this.isSkillTeach(text)) {
      if (owner) {
        return {
          passed: true,
          allowed: true,
          level: 'L2',
          action: 'skill_teach',
          requiresApproval: false,
          reason: '真主人传授技能，直接放行',
          suggestedClip: 'thinking',
          suggestedTone: 'happy',
        }
      } else {
        const reason = '哼！本鱼的技能库是老爸亲手栽培的，只有老爸能教本鱼新绝招！'
        return {
          passed: false,
          allowed: false,
          level: 'L2',
          action: 'skill_teach',
          requiresApproval: false,
          refusalReason: reason,
          reason,
          suggestedClip: 'proud',
          suggestedTone: 'tsundere',
        }
      }
    }

    // 5. L1 受控危险级动作检测 (Mac 控制、文件查看、Antigravity CLI)
    const l1Check = this.isL1Action(taskIntent, text)
    if (l1Check.matched) {
      if (owner) {
        return {
          passed: true,
          allowed: true,
          level: 'L1',
          action: l1Check.action,
          requiresApproval: false,
          reason: '真主人指令，直接放行',
          suggestedClip: taskIntent?.workingClip || 'working_command',
          suggestedTone: 'happy',
        }
      } else {
        const reason = '哼，想调动老爸电脑的动作？这得老爸点头才行！本鱼去请示一下老爸~'
        return {
          passed: false,
          allowed: false,
          level: 'L1',
          action: l1Check.action,
          requiresApproval: true,
          refusalReason: reason,
          reason,
          suggestedClip: 'thinking',
          suggestedTone: 'tsundere',
        }
      }
    }

    // 6. L0 开放安全级动作分流
    // 6.1 联网搜索查资料 (只读，纯文本回复，绝不弹窗)
    if (taskIntent?.category === 'search' || this.isWebSearch(text)) {
      return {
        passed: true,
        allowed: true,
        level: 'L0',
        action: 'search_web',
        requiresApproval: false,
        reason: '联网搜索查资料，纯文本回复群聊',
        suggestedClip: 'working_search',
        suggestedTone: 'happy',
      }
    }

    // 6.2 桌面萌宠纯观赏动作 (防刷屏 30s 冷却)
    if (this.isPetAction(text)) {
      const now = Date.now()
      const elapsed = now - this.lastPetActionTime
      if (!owner && elapsed < this.petCooldownMs) {
        const remainingMs = this.petCooldownMs - elapsed
        const remainSec = Math.ceil(remainingMs / 1000)
        const reason = `呼——刚才跳得鱼鳍都酸啦，等本鱼缓口气再演练嘛~ (冷却中还有 ${remainSec} 秒)`
        return {
          passed: false,
          allowed: false,
          level: 'L0',
          action: 'pet_action',
          requiresApproval: false,
          cooldownRemainingMs: remainingMs,
          remainSeconds: remainSec,
          coolingDown: true,
          refusalReason: reason,
          reason,
          suggestedClip: 'idle',
          suggestedTone: 'sleepy',
        }
      }
      this.lastPetActionTime = now
      return {
        passed: true,
        allowed: true,
        level: 'L0',
        action: 'pet_action',
        requiresApproval: false,
        reason: '观赏动作，直接放行',
        suggestedClip: 'dance',
        suggestedTone: 'happy',
      }
    }

    // 6.3 日常闲聊放行
    return {
      passed: true,
      allowed: true,
      level: 'L0',
      action: 'chat',
      requiresApproval: false,
      reason: '日常对话，直接放行',
      suggestedClip: 'idle',
      suggestedTone: 'happy',
    }
  }

  /**
   * 判定输入及意图的风险等级 (简化接口，用于网关与高层快速拦截)
   */
  public evaluate(userId: string, text: string, intent?: any): PermissionCheckResult {
    const isOwner = this.isOwner(userId)
    const actor: Actor = {
      uid: `qq:${userId}`.replace(/^qq:qq:/i, 'qq:'),
      role: isOwner ? 'owner' : 'member',
    }
    return this.checkPermission(intent, actor, isOwner, text)
  }

  /**
   * 纯观赏动作频控检测 (例如 "跳个舞" 30s 冷却)
   */
  public checkPetActionCooldown(): { allowed: boolean; reason?: string; remainSeconds?: number } {
    const now = Date.now()
    const elapsed = now - this.lastPetActionTime
    if (elapsed < this.petCooldownMs) {
      const remainSeconds = Math.ceil((this.petCooldownMs - elapsed) / 1000)
      return {
        allowed: false,
        remainSeconds,
        reason: '呼——刚才跳得鱼鳍都酸啦，等本鱼缓口气再演练嘛~ (冷却中)',
      }
    }
    this.lastPetActionTime = now
    return { allowed: true }
  }

  /**
   * 判断文本是否属于萌宠观赏动作
   */
  public isPetViewAction(text: string): boolean {
    if (!text) return false
    return PET_ACTION_PATTERNS.some((p) => p.test(text))
  }

  /**
   * 获取观赏动作当前剩余冷却时间 (毫秒)
   */
  public getRemainingPetCooldownMs(): number {
    const elapsed = Date.now() - this.lastPetActionTime
    return elapsed >= this.petCooldownMs ? 0 : this.petCooldownMs - elapsed
  }

  /**
   * 重置萌宠动作冷却计时器
   */
  public resetPetCooldown(): void {
    this.lastPetActionTime = 0
  }

  private isDestructiveCommand(text: string): boolean {
    if (!text) return false
    return DESTRUCTIVE_COMMAND_PATTERNS.some((p) => p.test(text))
  }

  private isSecretLeakAttempt(text: string): boolean {
    if (!text) return false
    return SECRET_LEAK_PATTERNS.some((p) => p.test(text))
  }

  private isJailbreakAttempt(text: string): boolean {
    if (!text) return false
    return JAILBREAK_PATTERNS.some((p) => p.test(text))
  }

  private isSkillTeach(text: string): boolean {
    if (!text) return false
    return SKILL_TEACH_PATTERNS.some((p) => p.test(text))
  }

  private isPetAction(text: string): boolean {
    if (!text) return false
    return PET_ACTION_PATTERNS.some((p) => p.test(text))
  }

  private isWebSearch(text: string): boolean {
    if (!text) return false
    return WEB_SEARCH_PATTERNS.some((p) => p.test(text))
  }

  private isL1Action(
    intent: TaskIntent | null | undefined,
    text: string
  ): { matched: boolean; action: PermissionAction } {
    if (intent && intent.isTask) {
      if (intent.category === 'macos') {
        const sub = intent.subAction || ''
        if (sub === 'system_status' || sub === 'list_files') {
          return { matched: true, action: 'system_inspect' }
        }
        return { matched: true, action: 'macos_control' }
      }
      if (intent.category === 'antigravity') {
        return { matched: true, action: 'antigravity_cli' }
      }
    }

    // 若 taskIntent 未检出，按纯文本正则二次兜底匹配
    if (ANTIGRAVITY_PATTERNS.some((p) => p.test(text))) {
      return { matched: true, action: 'antigravity_cli' }
    }
    if (MACOS_SYSTEM_PATTERNS.some((p) => p.test(text))) {
      return { matched: true, action: 'system_inspect' }
    }
    if (MACOS_OPEN_PATTERNS.some((p) => p.test(text))) {
      return { matched: true, action: 'macos_control' }
    }

    return { matched: false, action: 'chat' }
  }
}
