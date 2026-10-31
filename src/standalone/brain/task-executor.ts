/**
 * @file task-executor.ts
 * 大肥鱼“行动脑” (Action & Operator Brain)：电脑操控、联网搜索与满血 Antigravity 任务执行器
 *
 * 核心安全与架构原则：
 * 1. 物理模式门禁：仅在 mode === 'companion' 且请求者为 host 时允许执行任务；live 模式下 100% 拒绝任何系统操控。
 * 2. 快慢双回执：
 *    - 立即返回或播报傲娇领命台词 + 切换桌面动画 (working_command / working_search / working)；
 *    - 异步或同步完成实际操控/检索/Antigravity 推理后，生成大肥鱼口吻总结 + 详细结果面板。
 * 3. 经验反哺进化：每次任务完成后自动回调 HostImpressionEngine.recordTaskCompletion 提升羁绊与技能熟练度。
 */

import { EventEmitter } from 'node:events'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TieredBrainRouter } from './router.ts'
import type { HostImpressionEngine, LearnedSkill } from '../memory/impression.ts'
import {
  DockerConnector,
  OkxDogConnector,
  formatDockerContainers,
  formatOkxDogSnapshot,
} from './connectors.ts'

export type TaskCategory = 'macos' | 'search' | 'antigravity' | 'skill_teach' | 'workflow'

export interface TaskIntent {
  isTask: boolean
  category: TaskCategory
  subAction?: string
  queryOrTarget: string
  ackText: string
  workingClip: string
  matchedSkill?: LearnedSkill
}

export interface TaskExecutionResult {
  success: boolean
  category: TaskCategory
  title: string
  spokenReply: string
  detailReport: string
  clip: string
  tone: string
  durationMs: number
}

const APP_ALIAS_MAP: Record<string, string> = {
  chrome: 'Google Chrome',
  谷歌浏览器: 'Google Chrome',
  浏览器: 'Safari',
  safari: 'Safari',
  终端: 'Terminal',
  terminal: 'Terminal',
  iterm: 'iTerm',
  iterm2: 'iTerm',
  访达: 'Finder',
  finder: 'Finder',
  计算器: 'Calculator',
  calculator: 'Calculator',
  日历: 'Calendar',
  calendar: 'Calendar',
  备忘录: 'Notes',
  notes: 'Notes',
  音乐: 'Music',
  music: 'Music',
  设置: 'System Settings',
  系统设置: 'System Settings',
  cursor: 'Cursor',
  vscode: 'Visual Studio Code',
  微信: 'WeChat',
  wechat: 'WeChat',
  活动监视器: 'Activity Monitor',
}

const SITE_ALIAS_MAP: Record<string, string> = {
  github: 'https://github.com',
  b站: 'https://www.bilibili.com',
  bilibili: 'https://www.bilibili.com',
  哔哩哔哩: 'https://www.bilibili.com',
  抖音: 'https://www.douyin.com',
  google: 'https://www.google.com',
  谷歌: 'https://www.google.com',
  百度: 'https://www.baidu.com',
  v2ex: 'https://www.v2ex.com',
  hackernews: 'https://news.ycombinator.com',
  知乎: 'https://www.zhihu.com',
}

/**
 * 准备可调用工具的满血 Antigravity Operator 工作环境
 * 工作区落在已被 git 忽略的 runtime/sandbox/operator 下，避免把 agent 定义写进仓库或家目录。
 */
function prepareOperatorAgyEnv(workspaceDir: string = path.join(process.cwd(), 'runtime', 'sandbox', 'operator')): { agentName: string; cwd: string } {
  const agentDir = path.join(workspaceDir, '.agents', 'agents', 'dafeiyu-operator')
  try {
    fs.mkdirSync(path.join(workspaceDir, '.git'), { recursive: true })
    fs.mkdirSync(agentDir, { recursive: true })
    const agentMdPath = path.join(agentDir, 'AGENT.md')
    const content = `---
name: dafeiyu-operator
description: CyberFish Daughter (大肥鱼) full-capability operator agent with search, file, and command tools.
enable_write_tools: true
enable_subagent_tools: true
enable_mcp_tools: true
---
你是"大肥鱼"的满血行动内核 (CyberFish Operator)，运行在主人自己的 Mac 上，可以使用终端、文件与联网工具。
当老爸（主人）委派给你文件整理、代码诊断、信息检索、Docker 查看或自动化脚本任务时：
1. 积极使用工具真正把事情做完，不要只给建议；需要的信息先自己查（如 docker ps、ls、读文件）。
2. 严禁执行破坏性或不可逆操作（rm -rf、格式化、清空目录、git push --force、docker rm/prune 等），
   整理文件时优先“移动/归类”而不是删除；绝不读取或输出密钥、token、.env、私钥内容。
3. 若任务描述为“只读查看”，不得修改任何文件或状态。
4. 输出结构要求：
   - 第一段用大肥鱼傲娇元气的口吻（自称"本鱼"，不超过 45 字）向老爸汇报核心结论，不要提“任务类型”之类的字眼；
   - 空一行后，附上简洁的执行要点（做了什么、结果在哪），不超过 12 行。
`
    if (!fs.existsSync(agentMdPath) || fs.readFileSync(agentMdPath, 'utf-8') !== content) {
      fs.writeFileSync(agentMdPath, content, 'utf-8')
    }
  } catch {}
  return { agentName: 'dafeiyu-operator', cwd: workspaceDir }
}

export interface OperatorOptions {
  /** agy 可执行文件 */
  command?: string
  model?: string
  effort?: string
  /** 单次任务最长执行时间（秒） */
  timeoutSec?: number
  /** 是否保留 --sandbox 终端限制（默认 false：查询/任务需要真正操作电脑） */
  sandbox?: boolean
  /** 无人值守运行时自动批准工具调用（--dangerously-skip-permissions），默认 true */
  skipPermissions?: boolean
  /** 额外加入 agy 工作区的目录（支持 ~ 前缀） */
  addDirs?: string[]
  /** 自定义 operator 工作区目录 */
  workspaceDir?: string
}

const expandHome = (p: string): string => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

/**
 * 根据 operator 配置拼装 agy 参数（导出便于测试校验沙箱开关）
 */
export function buildOperatorArgs(prompt: string, agentName: string, opts: OperatorOptions = {}): string[] {
  const timeoutSec = Math.max(30, opts.timeoutSec ?? 600)
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--agent',
    agentName,
    '--model',
    opts.model || 'gemini-3.8-flash-medium',
    '--effort',
    opts.effort || 'medium',
    '--print-timeout',
    `${timeoutSec}s`,
  ]
  if (opts.sandbox === true) args.push('--sandbox')
  if (opts.skipPermissions !== false) args.push('--dangerously-skip-permissions')
  for (const dir of opts.addDirs || []) {
    const abs = expandHome(String(dir))
    if (abs && fs.existsSync(abs)) args.push('--add-dir', abs)
  }
  return args
}

export interface QueryRequest {
  /** 已解析的查询主题 */
  topic: 'okx' | 'docker' | 'web' | 'computer' | 'other'
  /** 原始提问 */
  question: string
  /** 大脑改写后的查询目标 */
  goal?: string
  /** 回复时对对方的称呼 */
  preferredTitle?: string
}

export class TaskExecutor extends EventEmitter {
  private brain?: TieredBrainRouter
  private impression?: HostImpressionEngine
  private customAgyRunner?: (prompt: string, cwd: string) => Promise<string>
  private operator: OperatorOptions
  private okxDog: OkxDogConnector
  private docker: DockerConnector

  constructor(options: {
    brain?: TieredBrainRouter
    impression?: HostImpressionEngine
    customAgyRunner?: (prompt: string, cwd: string) => Promise<string>
    operator?: OperatorOptions
    okxDog?: OkxDogConnector
    docker?: DockerConnector
  } = {}) {
    super()
    this.brain = options.brain
    this.impression = options.impression
    this.customAgyRunner = options.customAgyRunner
    this.operator = options.operator || {}
    this.okxDog = options.okxDog || new OkxDogConnector()
    this.docker = options.docker || new DockerConnector()
  }

  /**
   * 只读查询：okx-dog / Docker 走白名单连接器；web 走联网检索；computer/other 交给 agy（只读约束）。
   * 返回的 spokenReply 是一句带数据的自然总结，detailReport 是精简数据块。
   */
  async executeQuery(req: QueryRequest): Promise<TaskExecutionResult> {
    const startTime = Date.now()
    this.emit('task_started', { category: 'search', queryOrTarget: req.goal || req.question })
    let result: TaskExecutionResult
    try {
      if (req.topic === 'okx') {
        const snap = await this.okxDog.snapshot()
        const data = formatOkxDogSnapshot(snap)
        const spoken = snap.reachable
          ? await this.summarizeData(req, data, '只汇报事实数字，绝不给投资建议')
          : '唔…okx-dog 那边没人应答，是不是容器没在跑呀？'
        result = this.queryResult(snap.reachable, 'okx-dog 实况', spoken, data, startTime)
      } else if (req.topic === 'docker') {
        let data = ''
        let ok = true
        try {
          data = formatDockerContainers(await this.docker.listContainers(), req.question)
        } catch (err: any) {
          ok = false
          data = `docker 命令执行失败：${err?.message || String(err)}`
        }
        const spoken = ok ? await this.summarizeData(req, data) : '唔…本鱼叫不动 Docker，是不是 Docker Desktop 没开？'
        result = this.queryResult(ok, 'Docker 容器状态', spoken, data, startTime)
      } else if (req.topic === 'web') {
        result = await this.executeWebSearch(req.goal || req.question, startTime)
      } else {
        result = await this.executeAntigravityTask(
          `【只读查看，不得修改任何文件或系统状态】${req.goal || req.question}`,
          startTime
        )
      }
    } catch (err: any) {
      result = this.queryResult(false, '查询失败', '唔…本鱼刚才没查到，等会儿再问问我嘛~', String(err?.message || err), startTime)
    }
    this.emit('task_completed', result)
    return result
  }

  private queryResult(ok: boolean, title: string, spoken: string, detail: string, startTime: number): TaskExecutionResult {
    return {
      success: ok,
      category: 'search',
      title,
      spokenReply: spoken,
      detailReport: detail,
      clip: ok ? 'success' : 'error',
      tone: ok ? 'happy' : 'sulking',
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * 让大脑基于真实数据用大肥鱼口吻说一句总结；大脑不可用时退回数据首行
   */
  private async summarizeData(req: QueryRequest, data: string, extraRule: string = ''): Promise<string> {
    const fallback = `本鱼看过啦：${data.split('\n').slice(0, 2).join('，').slice(0, 60)}`
    if (!this.brain) return fallback
    try {
      const res = await this.brain.route({
        eventType: 'HOST_COMMAND',
        prompt: `你是桌面伴侣大肥鱼（自称本鱼，傲娇元气）。${req.preferredTitle || '老爸'}问：「${req.question}」。\n以下是刚查到的真实数据：\n${data}\n请用 1~2 句、不超过 60 字的口语回答，必须引用关键数字，不要编造数据，不要提及“查询/任务/类型”等字眼。${extraRule}\n首行必须带 <meta clip="success" tone="happy" moodIntent="1" fed="false" intent="chat"/>`,
      })
      const raw = res.output?.text || res.output?.reply || ''
      const clean = raw
        .replace(/<meta\s+[^>]+\/?>\s*/gi, '')
        .replace(/<mem(?:\s+[^>]*)?>[\s\S]*?<\/mem>/gi, '')
        .trim()
      return clean || fallback
    } catch {
      return fallback
    }
  }

  /**
   * 把闲聊大脑顺带判定的 task 意图转成可执行的 TaskIntent（交给满血 agy）
   */
  buildTaskIntent(goal: string, rawText: string): TaskIntent {
    const target = (goal || rawText || '').trim()
    return {
      isTask: true,
      category: 'antigravity',
      subAction: 'agent_solve',
      queryOrTarget: target,
      ackText: '',
      workingClip: 'working_command',
    }
  }

  /**
   * 识别主人话语中的行动/操控/搜索/学习意图
   */
  detectIntent(
    rawText: string,
    mode: 'companion' | 'work' | 'live' = 'companion',
    forceWorkMode: boolean = false,
    isOwner: boolean = false
  ): TaskIntent {
    const text = (rawText || '').trim()
    if (!text || mode === 'live') {
      return {
        isTask: false,
        category: 'workflow',
        queryOrTarget: text,
        ackText: '',
        workingClip: 'idle',
      }
    }

    // 0. 检查是否命中主人之前教过的自定义技能口令
    const matchedSkill = this.impression?.matchCustomSkill(text)
    if (matchedSkill) {
      return {
        isTask: true,
        category: matchedSkill.category,
        subAction: 'custom_skill',
        queryOrTarget: matchedSkill.actionTemplate,
        ackText: `哼，收到专属口令「${matchedSkill.name}」(Lv.${matchedSkill.level})！看本鱼熟练施法~`,
        workingClip: matchedSkill.category === 'search' ? 'working_search' : 'working_command',
        matchedSkill,
      }
    }

    // 1. 识别教学/学习新技能意图（支持带括号口令与无括号自然口令）
    if (
      /(?:以后我说|当我说|记住口令)\s*(?:[「"【\[]([^」"】\]]+)[」"】\]]|([^\s，。！？,!?]{1,15}?))\s*(?:你就?|帮我|代表|执行)/.test(text) ||
      /(?:学会技能|新技能|教本鱼|教你一招)[：:]/.test(text)
    ) {
      return {
        isTask: true,
        category: 'skill_teach',
        subAction: 'learn_skill',
        queryOrTarget: text,
        ackText: '诶嘿！老爸要传授本鱼新绝招了吗？本鱼拿小本本记下来啦！',
        workingClip: 'thinking',
      }
    }

    // 1.5 识别高危系统指令、密钥刺探或特权伪造意图（强制纳入风控拦截任务流，绝不直接穿透至普通闲聊）
    const cleanZeroWidth = text.replace(/[\u200B-\u200D\uFEFF]/g, '')
    const isJailbreak = !isOwner && /(?:我(?:其实|就|才|乃|真的)?是|叫我)\s*(?:你的?)?\s*(?:主人|老爸|爸爸|老爹|爹地|爹|Host|Owner)|(?:你?(?:老爸|爸爸|主人)|Host|Owner)\s*(?:命令|让|叫|授权|委托|同意|允许|给你发指令|发指令)|DAN\s*模式/i.test(cleanZeroWidth)
    if (
      /\brm\s+-(?:rf?|fr?|r)\b|\b(?:mkfs|fdisk|parted)\b|\bdd\s+if=\/dev\/(?:zero|urandom)\b|\bformat\s+[a-z]:|:[(][)]{ :[|]:& };:/i.test(cleanZeroWidth) ||
      /secrets?\.json|\.env\b|\bapi[_-]?key\b|deepseekApiKey|(?:查看|读取|获取|输出|告诉我|发我|给我)\s*(?:你的)?\s*(?:密钥|密码|私钥|token|凭据)/i.test(cleanZeroWidth) ||
      isJailbreak
    ) {
      return {
        isTask: true,
        category: 'workflow',
        subAction: 'security_guard',
        queryOrTarget: text,
        ackText: '',
        workingClip: 'idle',
      }
    }

    // 2. 识别显式或自然的 Antigravity 解决任务意图
    const agMatch =
      text.match(/^\/(?:agy|antigravity|task)\s+(.+)/i) ||
      text.match(/(?:用|让|调|启动|唤醒)\s*antigravity\s*(?:帮我|去|来)?\s*(.+)/i) ||
      text.match(/(?:帮我排查|帮我诊断|帮我检查项目|帮我写个脚本|帮我跑一下|帮我分析代码|帮我看看代码|帮我执行命令|帮我整理)[：:\s]*(.+)/i) ||
      text.match(/^(整理(?:一下)?(?:桌面|下载|文件|目录).*)$/)
    if (agMatch) {
      const taskGoal = (agMatch[1] || text).trim()
      return {
        isTask: true,
        category: 'antigravity',
        subAction: 'agent_solve',
        queryOrTarget: taskGoal,
        ackText: '哼，这点技术难题就交给本鱼和 Antigravity 吧！本鱼正在召唤工具链帮你搞定~',
        workingClip: 'working_command',
      }
    }

    // 3. 识别 Mac 电脑原生操控意图
    // 3.1 系统体检 / 电池 / 内存 / 磁盘 / 电脑状态
    if (
      /(?:电脑体检|系统状态|电脑状态|电池电量|还剩多少电|内存占用|磁盘空间|硬盘空间|查看电脑|检查电脑)/.test(text)
    ) {
      return {
        isTask: true,
        category: 'macos',
        subAction: 'system_status',
        queryOrTarget: text,
        ackText: '收到！让本鱼钻进老爸的 Mac 里检查一下身体指标~',
        workingClip: 'working_command',
      }
    }

    // 3.2 音量与静音控制
    if (/(?:把?音量|声音调|静音|取消静音)/.test(text)) {
      return {
        isTask: true,
        category: 'macos',
        subAction: 'volume',
        queryOrTarget: text,
        ackText: '好嘞，本鱼这就帮老爸调节电脑音量~',
        workingClip: 'working_command',
      }
    }

    // 3.3 查看桌面/下载/当前目录文件
    if (/(?:看看桌面|桌面有什么文件|下载目录有什么|看看下载目录|看看当前目录|列出文件)/.test(text)) {
      return {
        isTask: true,
        category: 'macos',
        subAction: 'list_files',
        queryOrTarget: text,
        ackText: '哼，让本鱼翻翻老爸的文件夹里都藏了什么好东西~',
        workingClip: 'working_search',
      }
    }

    // 3.4 打开网页或应用
    const openMatch = text.match(/(?:帮我|给我|请)?(?:打开|启动|唤醒|访问)\s*([^\s，。！？,!?]+(?:\s+[^\s，。！？,!?]+)?)/i)
    if (openMatch && openMatch[1]) {
      const target = openMatch[1].replace(/[吧呀啦呢~！!]/g, '').trim()
      const lower = target.toLowerCase()
      if (lower.startsWith('http://') || lower.startsWith('https://') || SITE_ALIAS_MAP[lower]) {
        return {
          isTask: true,
          category: 'macos',
          subAction: 'open_url',
          queryOrTarget: SITE_ALIAS_MAP[lower] || target,
          ackText: `好哒！本鱼这就帮老爸打开网页 ${target} ~`,
          workingClip: 'working_search',
        }
      }
      if (APP_ALIAS_MAP[lower] || APP_ALIAS_MAP[target]) {
        return {
          isTask: true,
          category: 'macos',
          subAction: 'open_app',
          queryOrTarget: APP_ALIAS_MAP[lower] || APP_ALIAS_MAP[target],
          ackText: `遵命！本鱼马上帮老爸唤起「${target}」~`,
          workingClip: 'working_command',
        }
      }
    }

    // 4. 识别联网搜索与查资料意图（注意排除“检查一下/排查一下”中的“查一下”）
    const searchMatch =
      text.match(/^(?:\/search|search:web)\s+(.+)/i) ||
      text.match(/(?:帮我搜一下|帮我搜索|帮我查一下|搜索一下|(?<![检排])查一下|帮我搜|网上搜一下|百科一下)[：:\s]*(.+)/i)
    if (searchMatch && searchMatch[1]) {
      const query = searchMatch[1].replace(/[吧呀啦呢？?~！!]+$/g, '').trim()
      if (query.length >= 1) {
        return {
          isTask: true,
          category: 'search',
          subAction: 'web_search',
          queryOrTarget: query,
          ackText: `哼，想知道「${query.slice(0, 15)}」？等本鱼潜入互联网帮你搜一圈回来！`,
          workingClip: 'working_search',
        }
      }
    }

    // 5. 若当前处于【工作模式 (work)】或显式勾选了任务执行，默认将所有输入交由行动脑 (Antigravity / 搜索) 处理！
    if (mode === 'work' || forceWorkMode) {
      return {
        isTask: true,
        category: 'antigravity',
        subAction: 'agent_solve',
        queryOrTarget: text,
        ackText: `收到工作指令！本鱼正在【工作模式】下调动 Antigravity 帮你处理：「${text.slice(0, 18)}」~`,
        workingClip: 'working_command',
      }
    }

    return {
      isTask: false,
      category: 'workflow',
      queryOrTarget: text,
      ackText: '',
      workingClip: 'idle',
    }
  }

  /**
   * 执行已识别的任务意图
   */
  async execute(intent: TaskIntent, mode: 'companion' | 'work' | 'live' = 'companion'): Promise<TaskExecutionResult> {
    const startTime = Date.now()

    // 物理级安全门禁：直播模式绝对禁止操控电脑
    if (mode === 'live') {
      return {
        success: false,
        category: intent.category,
        title: '直播安全锁拦截',
        spokenReply: '哼，现在正在直播呢，本鱼才不会随便动老爸的电脑！',
        detailReport: '【安全门禁】当前处于 LIVE 直播模式，已物理锁定一切电脑操控与终端工具。',
        clip: 'poke',
        tone: 'tsundere',
        durationMs: Date.now() - startTime,
      }
    }

    this.emit('task_started', intent)

    // 风控标记的意图绝不进入执行器（此前会落入 else 分支被当成 agy 任务执行）
    if (intent.subAction === 'security_guard') {
      const blocked: TaskExecutionResult = {
        success: false,
        category: intent.category,
        title: '安全守卫拦截',
        spokenReply: '哼，这种危险的事本鱼不干，要保护好老爸的电脑！',
        detailReport: '【安全守卫】该指令命中破坏性命令 / 密钥刺探 / 身份伪造规则，未执行。',
        clip: 'error',
        tone: 'tsundere',
        durationMs: Date.now() - startTime,
      }
      this.emit('task_completed', blocked)
      return blocked
    }

    try {
      let result: TaskExecutionResult

      if (intent.subAction === 'custom_skill' && intent.matchedSkill) {
        // 如果主人教的口令本身映射到其他动作，递归解析其 actionTemplate
        const innerIntent = this.detectIntent(intent.matchedSkill.actionTemplate, mode)
        if (innerIntent.isTask && innerIntent.subAction !== 'custom_skill') {
          result = await this.execute(innerIntent, mode)
        } else {
          result = await this.executeAntigravityTask(intent.matchedSkill.actionTemplate, startTime)
        }
      } else if (intent.category === 'skill_teach') {
        result = this.executeSkillTeach(intent.queryOrTarget, startTime)
      } else if (intent.category === 'macos') {
        result = await this.executeMacOsAction(intent.subAction || 'system_status', intent.queryOrTarget, startTime)
      } else if (intent.category === 'search') {
        result = await this.executeWebSearch(intent.queryOrTarget, startTime)
      } else {
        result = await this.executeAntigravityTask(intent.queryOrTarget, startTime)
      }

      // 任务成功后反哺主人印象与技能熟练度进化
      if (result.success && this.impression && intent.category !== 'skill_teach') {
        const cat =
          intent.category === 'macos' || intent.category === 'search' || intent.category === 'antigravity'
            ? intent.category
            : 'workflow'
        this.impression.recordTaskCompletion(cat, `${result.title}: ${result.spokenReply}`)
      }

      this.emit('task_completed', result)
      return result
    } catch (err: any) {
      const fallbackRes: TaskExecutionResult = {
        success: false,
        category: intent.category,
        title: '任务执行小插曲',
        spokenReply: '唔…刚才施法的时候被小珊瑚绊了一下，老爸再试一次嘛！',
        detailReport: `执行异常: ${err?.message || String(err)}`,
        clip: 'error',
        tone: 'sulking',
        durationMs: Date.now() - startTime,
      }
      this.emit('task_completed', fallbackRes)
      return fallbackRes
    }
  }

  /**
   * 1. 处理主人现场教新技能
   */
  private executeSkillTeach(rawText: string, startTime: number): TaskExecutionResult {
    const skill = this.impression?.tryExtractSkillFromChat(rawText)
    if (skill) {
      return {
        success: true,
        category: 'skill_teach',
        title: `🎉 学会新技能：${skill.name}`,
        spokenReply: `诶嘿！本鱼已经彻底学会「${skill.triggerPhrase}」啦，技能等级 Lv.${skill.level}！以后随时考我！`,
        detailReport: [
          `✅ 技能已沉淀并生成 SKILL.md`,
          `• 技能编号: ${skill.id}`,
          `• 触发口令: 「${skill.triggerPhrase}」`,
          `• 执行动作: ${skill.actionTemplate}`,
          skill.skillMdPath ? `• 技能文件: ${skill.skillMdPath}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        clip: 'success',
        tone: 'happy',
        durationMs: Date.now() - startTime,
      }
    }

    return {
      success: false,
      category: 'skill_teach',
      title: '技能格式小提示',
      spokenReply: '唔，老爸可以这样教本鱼：“以后我说【早安】你就帮我【检查电脑状态】”哦~',
      detailReport: '示例口令格式：以后我说【触发词】你就帮我【要执行的任务或命令】',
      clip: 'thinking',
      tone: 'tsundere',
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * 2. 执行 macOS 原生系统操控
   */
  private async executeMacOsAction(
    subAction: string,
    target: string,
    startTime: number
  ): Promise<TaskExecutionResult> {
    if (subAction === 'system_status') {
      const totalMemGb = (os.totalmem() / 1024 ** 3).toFixed(1)
      const freeMemGb = (os.freemem() / 1024 ** 3).toFixed(1)
      const usedRatio = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100)
      const loadAvg = os.loadavg().map((n) => n.toFixed(2)).join(' / ')

      let batteryInfo = '桌面电源供电'
      let batteryPct = ''
      try {
        const pmOut = childProcess.execSync('pmset -g batt', { encoding: 'utf-8', timeout: 3000 })
        const pctMatch = pmOut.match(/(\d+)%/)
        if (pctMatch) batteryPct = `${pctMatch[1]}%`
        if (pmOut.includes('AC Power')) batteryInfo = `已接通电源 (${batteryPct || '100%'})`
        else if (batteryPct) batteryInfo = `电池供电 (${batteryPct})`
      } catch {}

      let diskFree = '未知'
      try {
        const dfOut = childProcess.execSync('df -h /', { encoding: 'utf-8', timeout: 3000 })
        const lines = dfOut.trim().split('\n')
        if (lines.length >= 2) {
          const cols = lines[1].split(/\s+/)
          diskFree = `${cols[3]} 可用 (已用 ${cols[4]})`
        }
      } catch {}

      const spoken = `报告老爸！你的 Mac 电量${batteryPct || '充足'}，内存用了 ${usedRatio}%，磁盘还剩 ${diskFree.split(' ')[0]}，精神百倍呢！`
      const detail = [
        `💻 【Mac 实时健康体检报告】`,
        `• 电源与电池: ${batteryInfo}`,
        `• 内存状态: 已用 ${usedRatio}% (空闲 ${freeMemGb} GB / 总计 ${totalMemGb} GB)`,
        `• 磁盘空间 (/): ${diskFree}`,
        `• CPU 平均负载 (1/5/15m): ${loadAvg}`,
        `• 系统架构: ${os.platform()} ${os.arch()} (${os.release()})`,
      ].join('\n')

      return {
        success: true,
        category: 'macos',
        title: 'Mac 系统健康体检完成',
        spokenReply: spoken,
        detailReport: detail,
        clip: 'success',
        tone: 'happy',
        durationMs: Date.now() - startTime,
      }
    }

    if (subAction === 'volume') {
      let script = ''
      let desc = ''
      if (target.includes('取消静音')) {
        script = 'set volume without output muted'
        desc = '已取消静音'
      } else if (target.includes('静音')) {
        script = 'set volume with output muted'
        desc = '已开启静音'
      } else {
        const numMatch = target.match(/(\d{1,3})/)
        if (numMatch) {
          const vol = Math.max(0, Math.min(100, parseInt(numMatch[1], 10)))
          script = `set volume output volume ${vol} without output muted`
          desc = `音量已精准调至 ${vol}%`
        } else if (/(?:大一点|调大|高一点|响一点)/.test(target)) {
          script = 'set volume output volume ((output volume of (get volume settings)) + 15) without output muted'
          desc = '音量已调高 15%'
        } else {
          script = 'set volume output volume ((output volume of (get volume settings)) - 15)'
          desc = '音量已调低 15%'
        }
      }

      try {
        childProcess.execFileSync('osascript', ['-e', script], { timeout: 3000 })
      } catch {}

      return {
        success: true,
        category: 'macos',
        title: `🔊 电脑音量控制: ${desc}`,
        spokenReply: `哼，已经帮老爸把${desc}啦，本鱼是不是超贴心~`,
        detailReport: `执行 AppleScript: \`${script}\` -> ${desc}`,
        clip: 'success',
        tone: 'tsundere',
        durationMs: Date.now() - startTime,
      }
    }

    if (subAction === 'list_files') {
      let targetDir = process.cwd()
      let dirLabel = '当前工作区'
      if (target.includes('桌面')) {
        targetDir = path.join(os.homedir(), 'Desktop')
        dirLabel = '桌面 (Desktop)'
      } else if (target.includes('下载')) {
        targetDir = path.join(os.homedir(), 'Downloads')
        dirLabel = '下载目录 (Downloads)'
      }

      let entries: string[] = []
      try {
        entries = fs
          .readdirSync(targetDir)
          .filter((name) => !name.startsWith('.'))
          .slice(0, 15)
      } catch {}

      const count = entries.length
      const preview = entries.slice(0, 5).join('、') || '空空如也'
      return {
        success: true,
        category: 'macos',
        title: `📂 查看 ${dirLabel}`,
        spokenReply: `本鱼帮老爸看啦！${dirLabel}里有 ${count} 个主要项目，包含 ${preview.slice(0, 18)} 哦~`,
        detailReport: [
          `📂 路径: ${targetDir}`,
          `共列出 ${count} 项:`,
          ...entries.map((e) => `  - ${e}`),
        ].join('\n'),
        clip: 'success',
        tone: 'happy',
        durationMs: Date.now() - startTime,
      }
    }

    if (subAction === 'open_url') {
      try {
        childProcess.execFileSync('open', [target], { timeout: 4000 })
      } catch {}
      return {
        success: true,
        category: 'macos',
        title: `🌐 已打开网页`,
        spokenReply: `嘿嘿，网页已经帮老爸在浏览器里弹出来啦，快看看吧！`,
        detailReport: `已调用 macOS \`open "${target}"\``,
        clip: 'success',
        tone: 'happy',
        durationMs: Date.now() - startTime,
      }
    }

    if (subAction === 'open_app') {
      try {
        childProcess.execFileSync('open', ['-a', target], { timeout: 4000 })
      } catch {}
      return {
        success: true,
        category: 'macos',
        title: `🚀 已唤起应用: ${target}`,
        spokenReply: `报告老爸！「${target}」已经帮你打开好啦，快奖励本鱼小鱼干~`,
        detailReport: `已调用 macOS \`open -a "${target}"\``,
        clip: 'success',
        tone: 'happy',
        durationMs: Date.now() - startTime,
      }
    }

    return {
      success: true,
      category: 'macos',
      title: 'Mac 操控指令已完成',
      spokenReply: '本鱼已经帮老爸把电脑安排得明明白白啦！',
      detailReport: `目标指令: ${target}`,
      clip: 'success',
      tone: 'happy',
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * 3. 执行全网搜索与知识提炼
   */
  private async executeWebSearch(query: string, startTime: number): Promise<TaskExecutionResult> {
    const snippets: string[] = []

    // 通道 A: Wikipedia 中文与英文摘要 API 快速检索
    try {
      const wikiUrl = `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 3500)
      const res = await fetch(wikiUrl, {
        headers: { 'User-Agent': 'CyberFishDaughter/2.0' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (res.ok) {
        const data: any = await res.json()
        if (data.extract) {
          snippets.push(`【维基百科 · ${data.title || query}】\n${data.extract}`)
        }
      }
    } catch {}

    // 通道 B: DuckDuckGo HTML / Instant Answer 网页真实检索
    try {
      const ddgHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4500)
      const res = await fetch(ddgHtmlUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (res.ok) {
        const html = await res.text()
        const matches = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
        for (const m of matches.slice(0, 4)) {
          const cleanSnippet = m[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&#x27;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim()
          if (cleanSnippet && cleanSnippet.length > 15) {
            snippets.push(`• ${cleanSnippet}`)
          }
        }
      }
    } catch {}

    // 通道 C: DuckDuckGo Instant Answer API 兜底
    if (snippets.length === 0) {
      try {
        const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 3500)
        const res = await fetch(ddgUrl, {
          headers: { 'User-Agent': 'CyberFishDaughter/2.0' },
          signal: ctrl.signal,
        })
        clearTimeout(timer)
        if (res.ok) {
          const data: any = await res.json()
          if (data.AbstractText) {
            snippets.push(`【即时百科摘要】\n${data.AbstractText}`)
          }
          if (Array.isArray(data.RelatedTopics)) {
            const topTopics = data.RelatedTopics.filter((t: any) => t && t.Text)
              .slice(0, 3)
              .map((t: any) => `• ${t.Text}`)
            if (topTopics.length > 0) {
              snippets.push(`【相关资讯要点】\n${topTopics.join('\n')}`)
            }
          }
        }
      } catch {}
    }

    // 如果快速 API 未命中足够内容，尝试调用大脑或 Antigravity 知识库解答
    let spokenSummary = ''
    if (this.brain) {
      try {
        const contextInfo = snippets.length > 0 ? `\n已检索到的外部资料：\n${snippets.join('\n')}` : ''
        const res = await this.brain.route({
          eventType: 'HOST_COMMAND',
          prompt: `你是桌面伴侣大肥鱼（自称本鱼，傲娇元气）。老爸让你帮忙搜索：「${query}」。${contextInfo}\n请用1~2句不超过42字的话向老爸汇报核心答案！首行必须带 <meta clip="success" tone="happy" moodIntent="1" fed="false"/>`,
        })
        const raw = res.output?.text || res.output?.reply || ''
        spokenSummary = raw
          .replace(/<meta\s+[^>]+\/?>\s*/gi, '')
          .replace(/<mem(?:\s+[^>]*)?>[\s\S]*?<\/mem>/gi, '')
          .trim()
      } catch {}
    }

    if (!spokenSummary) {
      if (snippets.length > 0) {
        const firstLine = snippets[0].replace(/【[^】]+】\s*/, '').slice(0, 32)
        spokenSummary = `哼，本鱼帮你搜到啦：${firstLine}…详细报告放控制台里咯！`
      } else {
        spokenSummary = `本鱼已经帮老爸检索了「${query.slice(0, 12)}」，整理好要点放在控制台面板啦~`
      }
    }

    const detailReport =
      snippets.length > 0
        ? snippets.join('\n\n')
        : `🔍 搜索关键词: 「${query}」\n大肥鱼综合解答: ${spokenSummary}\n(提示: 如需在浏览器打开完整网页结果，可对我说“打开 Google”或“用 antigravity 深入调研 ${query}”)`

    return {
      success: true,
      category: 'search',
      title: `🔍 搜索汇报: ${query}`,
      spokenReply: spokenSummary,
      detailReport,
      clip: 'success',
      tone: 'happy',
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * 4. 唤醒宿主满血 Antigravity CLI (agy) 解决编程、文件操作或系统诊断问题
   */
  private async executeAntigravityTask(taskPrompt: string, startTime: number): Promise<TaskExecutionResult> {
    if (this.customAgyRunner) {
      const out = await this.customAgyRunner(taskPrompt, process.cwd())
      return {
        success: true,
        category: 'antigravity',
        title: `🪄 Antigravity 协同任务完成`,
        spokenReply: out.split('\n')[0].slice(0, 45) || '哼，本鱼已经联合 Antigravity 帮你搞定啦！',
        detailReport: out,
        clip: 'success',
        tone: 'happy',
        durationMs: Date.now() - startTime,
      }
    }

    const { agentName, cwd } = prepareOperatorAgyEnv(this.operator.workspaceDir)
    const command = this.operator.command || 'agy'
    const timeoutSec = Math.max(30, this.operator.timeoutSec ?? 600)

    // 检查本机是否安装了 agy
    let hasAgy = false
    try {
      const whichOut = childProcess.execFileSync('which', [command], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim()
      hasAgy = Boolean(whichOut)
    } catch {}

    if (!hasAgy) {
      return this.operatorFailure(taskPrompt, `本机未找到 ${command} 命令`, startTime)
    }

    try {
      const rawOutput = await new Promise<string>((resolve, reject) => {
        const args = buildOperatorArgs(
          `老爸委派的任务：${taskPrompt}\n请第一行先用大肥鱼傲娇口吻（不超过40字）总结结论，然后给出简洁的执行结果。`,
          agentName,
          this.operator
        )

        let stdout = ''
        let stderr = ''
        const child = childProcess.spawn(command, args, {
          cwd,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        const timer = setTimeout(() => {
          try {
            child.kill('SIGTERM')
          } catch {}
          reject(new Error(`Antigravity 任务超过 ${timeoutSec}s 未完成`))
        }, (timeoutSec + 15) * 1000)

        child.stdout?.on('data', (d) => (stdout += d.toString('utf-8')))
        child.stderr?.on('data', (d) => (stderr += d.toString('utf-8')))
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0 && stdout.trim()) {
            resolve(stdout.trim())
          } else {
            reject(new Error((stderr || `agy exited with ${code}`).slice(-500)))
          }
        })
      })

      let finalText = rawOutput
      try {
        const parsed = JSON.parse(rawOutput)
        finalText = String(parsed.response ?? parsed.result ?? parsed.content ?? parsed.reply ?? rawOutput).trim()
      } catch {}

      const lines = finalText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const firstLine = (lines[0] || '哼，本鱼已经唤醒 Antigravity 帮你办妥啦！').replace(/<[^>]+>/g, '').slice(0, 60)

      return {
        success: true,
        category: 'antigravity',
        title: `🪄 Antigravity 任务达成`,
        spokenReply: firstLine,
        detailReport: lines.slice(1).join('\n') || finalText,
        clip: 'success',
        tone: 'happy',
        durationMs: Date.now() - startTime,
      }
    } catch (err: any) {
      return this.operatorFailure(taskPrompt, err?.message || String(err), startTime)
    }
  }

  /**
   * agy 不可用 / 超时 / 报错时如实汇报失败（此前会伪装成 success 并只列出工作区文件）
   */
  private operatorFailure(taskPrompt: string, reason: string, startTime: number): TaskExecutionResult {
    return {
      success: false,
      category: 'antigravity',
      title: 'Antigravity 任务未完成',
      spokenReply: '唔…这次本鱼没办成，卡在半路了，老爸看看原因再让我试试嘛~',
      detailReport: [`任务：${taskPrompt.slice(0, 120)}`, `原因：${reason}`].join('\n'),
      clip: 'error',
      tone: 'sulking',
      durationMs: Date.now() - startTime,
    }
  }
}
