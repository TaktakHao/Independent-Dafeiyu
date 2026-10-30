/**
 * @file impression.ts
 * 主人印象加固、聊天认知自提炼与技能自进化引擎 (HostImpression & SkillEvolver)
 *
 * 核心能力：
 * 1. 维护大肥鱼对主人的长期关系档案 (HostImpressionProfile)：羁绊值、羁绊等级、印象标签、称呼、职业、日常习惯。
 * 2. 聊天认知加固 (Chat Cognitive Reinforcement)：
 *    - 从日常对话中双轨（语义模式 + LLM 标签）提炼主人的偏好、习惯、近况与性格特征，写入 L4 facts 表；
 *    - 同一事实或偏好被多次提及时，自动递增强化置信度 (confidence -> 1.0)，形成稳固的长期记忆与性格影响。
 * 3. 技能自进化 (Procedural Skill Evolution)：
 *    - 支持在聊天中直接传授技能（如“以后我说 XXX 你就帮我 YYY”），或从成功执行的 Antigravity / Mac 操控任务中自动提炼技能；
 *    - 自动生成符合 Antigravity 规范的 SKILL.md 文件并维护技能熟练度等级 (level / usageCount)。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { MemoryStore } from './store.ts'
import type { FactRecord } from './types.ts'

export interface HostImpressionProfile {
  hostName: string
  occupation: string
  bondScore: number
  bondLevel: string
  chatCount: number
  taskCount: number
  impressionTags: string[]
  habits: string[]
  lastInteractionAt: number
}

export interface LearnedSkill {
  id: string
  name: string
  triggerPhrase: string
  category: 'antigravity' | 'macos' | 'search' | 'workflow'
  description: string
  actionTemplate: string
  level: number
  usageCount: number
  createdAt: number
  updatedAt: number
  skillMdPath?: string
}

export interface AssimilateResult {
  extractedFacts: Array<{ predicate: string; object: string; confidence: number }>
  newTags: string[]
  bondDelta: number
  learnedSkill?: LearnedSkill
  episodeId?: number
}

const IMPRESSION_STATE_KEY = 'host_impression_profile'
const SKILLS_STATE_KEY = 'learned_skills_registry'

/**
 * 根据羁绊分数计算关系阶段称号
 */
export function computeBondLevel(score: number): string {
  if (score >= 650) return '灵魂羁绊 (Lv.4)'
  if (score >= 350) return '默契拍档 (Lv.3)'
  if (score >= 150) return '熟悉依赖 (Lv.2)'
  return '傲娇初识 (Lv.1)'
}

export class HostImpressionEngine {
  private store: MemoryStore
  private skillsBaseDir: string

  constructor(store: MemoryStore, skillsBaseDir: string = 'runtime/data/learned-skills') {
    this.store = store
    this.skillsBaseDir = skillsBaseDir
  }

  /**
   * 加载主人印象与羁绊档案
   */
  getProfile(): HostImpressionProfile {
    const raw = this.store.loadState(IMPRESSION_STATE_KEY)
    let profile: HostImpressionProfile = {
      hostName: '老爸',
      occupation: '全栈与AI开发者',
      bondScore: 100,
      bondLevel: '傲娇初识 (Lv.1)',
      chatCount: 0,
      taskCount: 0,
      impressionTags: ['专注敲代码', '本鱼的专属老爸'],
      habits: [],
      lastInteractionAt: Date.now(),
    }

    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        profile = {
          ...profile,
          ...parsed,
          impressionTags: Array.isArray(parsed.impressionTags) ? parsed.impressionTags : profile.impressionTags,
          habits: Array.isArray(parsed.habits) ? parsed.habits : profile.habits,
        }
      } catch {
        // 忽略损坏 JSON
      }
    }

    profile.bondLevel = computeBondLevel(profile.bondScore)
    return profile
  }

  /**
   * 保存主人印象档案
   */
  saveProfile(profile: HostImpressionProfile): HostImpressionProfile {
    profile.bondScore = Math.max(0, Math.min(1000, Math.round(profile.bondScore)))
    profile.bondLevel = computeBondLevel(profile.bondScore)
    profile.impressionTags = Array.from(new Set(profile.impressionTags)).slice(-12)
    profile.habits = Array.from(new Set(profile.habits)).slice(-10)
    this.store.saveState(IMPRESSION_STATE_KEY, JSON.stringify(profile))
    return profile
  }

  /**
   * 带置信度强化机制的语义事实更新（重复提及自动加固印象）
   */
  reinforceFact(options: {
    category: string
    predicate: string
    object: string
    baseConfidence?: number
    scope?: 'private' | 'live' | 'public'
  }): { id: number; confidence: number } {
    const existingFacts = this.store.queryFacts('host', 'companion')
    const matched = existingFacts.find((f) => f.predicate === options.predicate)

    let nextConfidence = options.baseConfidence ?? 0.8
    if (matched) {
      // 如果事实内容一致或相似，强化置信度 (+0.08 直至 1.0)
      if (matched.object === options.object || options.object.includes(matched.object)) {
        nextConfidence = Math.min(1.0, Number(((matched.confidence ?? 0.8) + 0.08).toFixed(2)))
      } else {
        // 如果主人更新了说法，以较高置信度覆盖
        nextConfidence = Math.max(0.85, matched.confidence ?? 0.85)
      }
    }

    const id = this.store.upsertFact({
      category: options.category,
      subject: 'host',
      predicate: options.predicate,
      object: options.object.slice(0, 80),
      confidence: nextConfidence,
      scope: options.scope ?? 'private',
    })

    return { id, confidence: nextConfidence }
  }

  /**
   * 从单轮伴侣对话中提炼认知、加固对主人的印象并沉淀记忆
   */
  assimilateChat(
    userText: string,
    assistantReply: string,
    meta?: { memory?: string; moodIntent?: number; tone?: string }
  ): AssimilateResult {
    const cleanText = (userText || '').trim()
    const profile = this.getProfile()
    profile.chatCount += 1
    profile.lastInteractionAt = Date.now()

    const extractedFacts: Array<{ predicate: string; object: string; confidence: number }> = []
    const newTags: string[] = []
    let bondDelta = 2 // 每次正常聊天基础增加 2 点羁绊

    // 1. 识别是否为主动传授技能
    const learnedSkill = this.tryExtractSkillFromChat(cleanText)
    if (learnedSkill) {
      bondDelta += 6
      newTags.push('会教本鱼新技能的导师')
    }

    // 2. 识别称呼变更
    const nameMatch = cleanText.match(/(?:我叫|我的名字是|你可以叫我|以后叫我|称呼我为?)\s*[「"【]?([^\s，。！？,!?」"】]{1,16})[」"】]?/)
    if (nameMatch && nameMatch[1]) {
      const newName = nameMatch[1].trim()
      profile.hostName = newName
      const r = this.reinforceFact({
        category: 'profile',
        predicate: '称呼',
        object: newName,
        baseConfidence: 0.95,
      })
      extractedFacts.push({ predicate: '称呼', object: newName, confidence: r.confidence })
    }

    // 3. 识别职业或身份
    const jobMatch = cleanText.match(/(?:我是做|我的职业是|我是个|我是一名|我从事)\s*([^，。！？,!?]{2,20})/)
    if (jobMatch && jobMatch[1]) {
      const job = jobMatch[1].trim()
      profile.occupation = job
      const r = this.reinforceFact({
        category: 'profile',
        predicate: '职业与身份',
        object: job,
        baseConfidence: 0.9,
      })
      extractedFacts.push({ predicate: '职业与身份', object: job, confidence: r.confidence })
    }

    // 4. 识别喜好与偏好
    const likeMatch = cleanText.match(/(?:我最?喜欢|我爱吃|我爱喝|我超爱|我平时喜欢)\s*([^，。！？,!?]{1,25})/)
    if (likeMatch && likeMatch[1]) {
      const liked = likeMatch[1].trim()
      const pred = `喜好:${liked.slice(0, 8)}`
      const r = this.reinforceFact({
        category: 'preference',
        predicate: pred,
        object: `喜欢${liked}`,
        baseConfidence: 0.85,
      })
      extractedFacts.push({ predicate: pred, object: `喜欢${liked}`, confidence: r.confidence })
      bondDelta += 2
    }

    // 5. 识别讨厌或禁忌
    const dislikeMatch = cleanText.match(/(?:我最?讨厌|我不吃|我不喜欢|我受不了|千万别)\s*([^，。！？,!?]{1,25})/)
    if (dislikeMatch && dislikeMatch[1]) {
      const disliked = dislikeMatch[1].trim()
      const pred = `禁忌:${disliked.slice(0, 8)}`
      const r = this.reinforceFact({
        category: 'preference',
        predicate: pred,
        object: `不喜欢/避免${disliked}`,
        baseConfidence: 0.9,
      })
      extractedFacts.push({ predicate: pred, object: `不喜欢/避免${disliked}`, confidence: r.confidence })
      bondDelta += 2
    }

    // 6. 识别日常习惯与开发偏好
    const habitMatch = cleanText.match(/(?:我习惯用?|我一般用|我每天都会?|记住我|我写代码喜欢?)\s*([^，。！？,!?]{2,35})/)
    if (habitMatch && habitMatch[1]) {
      const habit = habitMatch[1].trim()
      if (!profile.habits.includes(habit)) {
        profile.habits.push(habit)
      }
      const pred = `习惯:${habit.slice(0, 10)}`
      const r = this.reinforceFact({
        category: 'habit',
        predicate: pred,
        object: habit,
        baseConfidence: 0.88,
      })
      extractedFacts.push({ predicate: pred, object: habit, confidence: r.confidence })
      bondDelta += 3
    }

    // 7. 识别近期专注事项或项目
    const focusMatch = cleanText.match(/(?:我最近在写|我正在做|最近在忙|我在开发|今天在弄)\s*([^，。！？,!?]{2,35})/)
    if (focusMatch && focusMatch[1]) {
      const focus = focusMatch[1].trim()
      const r = this.reinforceFact({
        category: 'project',
        predicate: '近期专注项目',
        object: focus,
        baseConfidence: 0.85,
      })
      extractedFacts.push({ predicate: '近期专注项目', object: focus, confidence: r.confidence })
    }

    // 8. 情感互动与对大肥鱼的态度识别 -> 加固印象标签
    if (/(真棒|好聪明|太厉害了|真乖|可爱|喜欢你|爱你|干得漂亮|谢谢你|夸夸)/.test(cleanText)) {
      bondDelta += 4
      newTags.push('温柔会夸鱼的好老爸')
    }
    if (/(好累|加班|头疼|写不动了|困死|心累|熬夜|debug|报错)/.test(cleanText)) {
      bondDelta += 2
      newTags.push('挑灯夜战的极客')
    }
    if (/(笨蛋|蠢鱼|胖鱼|红烧|炖汤)/.test(cleanText)) {
      newTags.push('爱嘴硬逗本鱼玩')
    }

    // 9. 解析大模型回复中可能附带的 <fact pred="..." obj="..."/> 或 meta.memory
    if (meta?.memory) {
      const memStr = String(meta.memory).trim()
      if (memStr.length >= 2) {
        const predKey = `印象:${memStr.slice(0, 8)}`
        const r = this.reinforceFact({
          category: 'impression',
          predicate: predKey,
          object: memStr,
          baseConfidence: 0.82,
        })
        extractedFacts.push({ predicate: predKey, object: memStr, confidence: r.confidence })
      }
    }

    const factRegex = /<fact\s+pred="([^"]+)"\s+obj="([^"]+)"\s*\/?>/gi
    let fm: RegExpExecArray | null
    while ((fm = factRegex.exec(assistantReply)) !== null) {
      const pred = fm[1].trim()
      const obj = fm[2].trim()
      if (pred && obj) {
        const r = this.reinforceFact({
          category: 'llm_extracted',
          predicate: pred,
          object: obj,
          baseConfidence: 0.85,
        })
        extractedFacts.push({ predicate: pred, object: obj, confidence: r.confidence })
      }
    }

    for (const t of newTags) {
      if (!profile.impressionTags.includes(t)) {
        profile.impressionTags.push(t)
      }
    }

    profile.bondScore += bondDelta + Math.max(0, meta?.moodIntent ?? 0)
    this.saveProfile(profile)

    // 10. 若本轮对话提炼出了新事实、新技能或具备一定信息量，自动写入 L3 情景记忆
    let episodeId: number | undefined
    if (extractedFacts.length > 0 || learnedSkill || cleanText.length >= 8) {
      const importance = learnedSkill ? 9 : extractedFacts.length > 0 ? 8 : 5
      const summaryNote = meta?.memory
        ? `${meta.memory} (原话: ${cleanText.slice(0, 50)})`
        : `老爸跟我聊到: "${cleanText.slice(0, 60)}"，本鱼回复: "${assistantReply.slice(0, 40)}"`
      episodeId = this.store.insertEpisode({
        mode: 'companion',
        scope: 'private',
        actor: 'host',
        text: summaryNote,
        tone: meta?.tone || 'happy',
        importance,
      })
    }

    return {
      extractedFacts,
      newTags,
      bondDelta,
      learnedSkill,
      episodeId,
    }
  }

  /**
   * 组装可直接注入 PromptBuilder Layer B 的 hostProfile 结构
   */
  buildPromptHostProfile(mode: 'companion' | 'live' = 'companion'): {
    name: string
    occupation: string
    habits: string[]
    facts: Array<{ text: string; confidence?: number; scope?: 'private' | 'live' | 'public' }>
  } {
    const profile = this.getProfile()
    const rawFacts: FactRecord[] = this.store.queryFacts('host', mode)

    const formattedFacts: Array<{ text: string; confidence?: number; scope?: 'private' | 'live' | 'public' }> = []

    // 伴侣模式下首先注入关系羁绊与对老爸的整体印象标签
    if (mode === 'companion') {
      formattedFacts.push({
        text: `与${profile.hostName}的羁绊: ${profile.bondLevel} (亲密度:${profile.bondScore}, 累计对话:${profile.chatCount}次, 协同任务:${profile.taskCount}次)`,
        confidence: 1.0,
        scope: 'private',
      })
      if (profile.impressionTags.length > 0) {
        formattedFacts.push({
          text: `本鱼对${profile.hostName}的印象标签: ${profile.impressionTags.join('、')}`,
          confidence: 0.95,
          scope: 'private',
        })
      }
    }

    for (const f of rawFacts.slice(0, 8)) {
      formattedFacts.push({
        text: `${f.predicate} -> ${f.object}`,
        confidence: f.confidence ?? 0.85,
        scope: f.scope,
      })
    }

    return {
      name: mode === 'live' ? '主播老爸' : profile.hostName,
      occupation: profile.occupation,
      habits: mode === 'live' ? [] : profile.habits,
      facts: formattedFacts,
    }
  }

  // =========================================================================
  // 技能自进化系统 (Learned Skills & Auto SKILL.md Generation)
  // =========================================================================

  /**
   * 获取所有已学会的技能
   */
  getLearnedSkills(): LearnedSkill[] {
    const raw = this.store.loadState(SKILLS_STATE_KEY)
    if (!raw) return this.getDefaultStarterSkills()
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
      }
    } catch {}
    return this.getDefaultStarterSkills()
  }

  private getDefaultStarterSkills(): LearnedSkill[] {
    const now = Date.now()
    return [
      {
        id: 'mac-system-check',
        name: 'Mac 电脑健康体检',
        triggerPhrase: '电脑体检|查看系统状态|电池电量|内存占用',
        category: 'macos',
        description: '快速检查老爸 Mac 的电池电量、内存压力、磁盘剩余空间与负载状态',
        actionTemplate: 'macos:system_status',
        level: 2,
        usageCount: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'antigravity-problem-solver',
        name: 'Antigravity 协同排障与编码',
        triggerPhrase: '用antigravity|帮我排查|帮我修bug|帮我写个脚本',
        category: 'antigravity',
        description: '唤醒宿主满血 Antigravity Agent，调用终端与文件工具帮老爸诊断代码或执行复杂任务',
        actionTemplate: 'antigravity:solve',
        level: 2,
        usageCount: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'web-research-assistant',
        name: '全网实时资讯检索',
        triggerPhrase: '帮我搜|搜索一下|查一下|网上怎么说',
        category: 'search',
        description: '帮老爸联网搜索最新技术文档、新闻或问题解答并提炼重点汇报',
        actionTemplate: 'search:web',
        level: 2,
        usageCount: 1,
        createdAt: now,
        updatedAt: now,
      },
    ]
  }

  /**
   * 保存技能注册表
   */
  saveLearnedSkills(skills: LearnedSkill[]): void {
    this.store.saveState(SKILLS_STATE_KEY, JSON.stringify(skills))
  }

  /**
   * 尝试从聊天话语中提取主人传授的新技能
   * 例如：“以后我说【早安开工】你就帮我【打开GitHub并播报系统状态】”
   * 或：“学会技能：代码巡检 -> 运行 npm test 检查项目状态”
   */
  tryExtractSkillFromChat(text: string): LearnedSkill | undefined {
    const pattern1 = text.match(
      /(?:以后我说|当我说|记住口令)\s*(?:[「"【\[]([^」"】\]]+)[」"】\]]|([^\s，。！？,!?]{1,15}?))\s*(?:你就?|帮我|代表|执行)\s*[「"【\[]?([^。！？\n」"】\]]+)[」"】\]]?/
    )
    const pattern2 = text.match(
      /(?:学会技能|新技能|教本鱼|教你一招)[：:]\s*([^\s->=：:]+)\s*(?:->|=|：|:|是)\s*(.+)/
    )

    if (!pattern1 && !pattern2) return undefined

    const trigger = (pattern1 ? (pattern1[1] || pattern1[2]) : pattern2![1]).trim()
    const actionDesc = (pattern1 ? pattern1[3] : pattern2![2]).trim()
    if (!trigger || !actionDesc) return undefined

    return this.learnOrUpgradeSkill({
      name: `专属口令: ${trigger}`,
      triggerPhrase: trigger,
      category: actionDesc.toLowerCase().includes('antigravity')
        ? 'antigravity'
        : actionDesc.includes('搜') || actionDesc.includes('查')
          ? 'search'
          : 'workflow',
      description: `当老爸说“${trigger}”时，自动执行：${actionDesc}`,
      actionTemplate: actionDesc,
    })
  }

  /**
   * 学习新技能或升级已有技能，并同步生成 SKILL.md
   */
  learnOrUpgradeSkill(input: {
    id?: string
    name: string
    triggerPhrase: string
    category: 'antigravity' | 'macos' | 'search' | 'workflow'
    description: string
    actionTemplate: string
  }): LearnedSkill {
    const skills = this.getLearnedSkills()
    const now = Date.now()
    const slug =
      input.id ||
      `skill-${input.triggerPhrase
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '')
        .slice(0, 12)}-${now.toString(36).slice(-4)}`

    const existing = skills.find(
      (s) => s.id === input.id || s.name === input.name || s.triggerPhrase === input.triggerPhrase
    )

    let target: LearnedSkill
    if (existing) {
      existing.description = input.description
      existing.actionTemplate = input.actionTemplate
      existing.level += 1
      existing.usageCount += 1
      existing.updatedAt = now
      target = existing
    } else {
      target = {
        id: slug,
        name: input.name,
        triggerPhrase: input.triggerPhrase,
        category: input.category,
        description: input.description,
        actionTemplate: input.actionTemplate,
        level: 1,
        usageCount: 1,
        createdAt: now,
        updatedAt: now,
      }
      skills.unshift(target)
    }

    // 落盘生成标准 SKILL.md 文件
    try {
      const skillDir = path.resolve(process.cwd(), this.skillsBaseDir, target.id)
      fs.mkdirSync(skillDir, { recursive: true })
      const mdPath = path.join(skillDir, 'SKILL.md')
      const mdContent = [
        `---`,
        `name: ${target.id}`,
        `description: ${target.description.replace(/[\r\n]/g, ' ')}`,
        `---`,
        ``,
        `# 🐋 大肥鱼自进化技能: ${target.name}`,
        ``,
        `- **技能分类**: \`${target.category}\``,
        `- **触发短语/口令**: \`${target.triggerPhrase}\``,
        `- **熟练度等级**: Lv.${target.level} (已执行 ${target.usageCount} 次)`,
        `- **更新时间**: ${new Date(target.updatedAt).toISOString()}`,
        ``,
        `## 执行指引与工作流模板`,
        ``,
        `${target.actionTemplate}`,
        ``,
      ].join('\n')
      fs.writeFileSync(mdPath, mdContent, 'utf-8')
      target.skillMdPath = mdPath
    } catch {
      // 忽略目录只读等异常
    }

    this.saveLearnedSkills(skills.slice(0, 30))

    // 同步记录到 facts 表
    this.reinforceFact({
      category: 'skill',
      predicate: `已掌握技能:${target.name}`,
      object: `${target.description} (Lv.${target.level})`,
      baseConfidence: 0.95,
    })

    return target
  }

  /**
   * 记录一次任务执行成功，增加主人协同任务计数并升级对应技能熟练度
   */
  recordTaskCompletion(category: 'antigravity' | 'macos' | 'search' | 'workflow', summary: string): void {
    const profile = this.getProfile()
    profile.taskCount += 1
    profile.bondScore += 5
    this.saveProfile(profile)

    const skills = this.getLearnedSkills()
    const matched = skills.find((s) => s.category === category)
    if (matched) {
      matched.usageCount += 1
      if (matched.usageCount % 3 === 0) {
        matched.level += 1
      }
      matched.updatedAt = Date.now()
      this.saveLearnedSkills(skills)
    }

    // 写入高价值情景记忆
    this.store.insertEpisode({
      mode: 'companion',
      scope: 'private',
      actor: 'daughter',
      text: `[协同任务达成] 本鱼帮${profile.hostName}完成了(${category})任务: ${summary.slice(0, 80)}`,
      tone: 'happy',
      importance: 8,
    })
  }

  /**
   * 匹配用户输入是否命中某个已学口令技能
   */
  matchCustomSkill(userText: string): LearnedSkill | undefined {
    const skills = this.getLearnedSkills()
    for (const s of skills) {
      // 跳过内置通用大类触发词，仅精确匹配用户后天教授的专属口令
      if (['mac-system-check', 'antigravity-problem-solver', 'web-research-assistant'].includes(s.id)) {
        continue
      }
      if (s.triggerPhrase && userText.includes(s.triggerPhrase)) {
        return s
      }
    }
    return undefined
  }
}
