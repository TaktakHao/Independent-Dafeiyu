/**
 * @file diary.ts
 * Milestone M3: L5 第一人称每日日记生成器与落盘系统
 * 
 * 核心技术标准：
 * 1. 拟人大肥鱼第一人称视角（元气、傲娇、感恩）。
 * 2. 篇幅约 150~200 字 Markdown 文件，落盘至 runtime/data/diaries/YYYY-MM-DD.md。
 * 3. 直播安全版隔离 (generateLiveDiary)：严格仅基于 scope IN ('live', 'public') 的公开记忆生成，绝不泄露老爸私密生活。
 * 4. 记忆闭环沉淀：日记生成后自动作为最高重要度 (importance: 10) 的情景记忆写回 episodes 表。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { MemoryStore } from './store.ts'
import type { MemoryMode } from './types.ts'

export interface DiaryOptions {
  date?: Date
  mode?: MemoryMode
  outDir?: string
}

export interface DiaryResult {
  dateStr: string
  filePath: string
  content: string
  episodeId: number
}

export class DiaryGenerator {
  private store: MemoryStore
  private baseDir: string

  constructor(store: MemoryStore, baseDir: string = 'runtime/data/diaries') {
    this.store = store
    this.baseDir = baseDir
  }

  /**
   * 格式化日期字符串 YYYY-MM-DD
   */
  private formatDate(date: Date): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  /**
   * 获取某一天起止时间戳
   */
  private getDayTimeRange(date: Date): { start: number; end: number } {
    const d = new Date(date)
    d.setHours(0, 0, 0, 0)
    const start = d.getTime()
    d.setHours(23, 59, 59, 999)
    const end = d.getTime()
    return { start, end }
  }

  /**
   * 生成并落盘第一人称每日日记 (伴侣模式全量版)
   */
  async generateDiary(options: DiaryOptions = {}): Promise<DiaryResult> {
    return this._generateInternal({
      date: options.date || new Date(),
      mode: options.mode || 'companion',
      outDir: options.outDir || this.baseDir
    })
  }

  /**
   * 生成直播安全版日记 (直播间公开朗读版，物理级过滤私密心事)
   */
  async generateLiveDiary(options: DiaryOptions = {}): Promise<DiaryResult> {
    return this._generateInternal({
      date: options.date || new Date(),
      mode: 'live',
      outDir: options.outDir || this.baseDir
    })
  }

  /**
   * 核心生成与持久化实现
   */
  private async _generateInternal(opts: { date: Date; mode: MemoryMode; outDir: string }): Promise<DiaryResult> {
    const dateStr = this.formatDate(opts.date)
    const { start, end } = this.getDayTimeRange(opts.date)

    // 1. 从存储中检索当天的情景记忆 (根据模式严格隔离)
    const db = this.store.getDatabase()
    let sql = `
      SELECT * FROM episodes
      WHERE created_at >= ? AND created_at <= ?
    `
    const params: any[] = [start, end]

    if (opts.mode === 'live') {
      sql += " AND scope IN ('live', 'public')"
    }

    sql += ' ORDER BY importance DESC, created_at ASC LIMIT 10'
    const todayEpisodes = db.prepare(sql).all(...params) as any[]

    // 2. 提取互动亮点
    const highlightTexts: string[] = []
    let totalInteractions = todayEpisodes.length

    for (const ep of todayEpisodes) {
      if (ep.text && !highlightTexts.includes(ep.text)) {
        highlightTexts.push(ep.text)
      }
    }

    // 3. 构建大肥鱼第一人称口吻日记
    let diaryBody = ''
    if (opts.mode === 'live') {
      diaryBody = `今天在直播间和大伙儿玩得超级开心！`
      if (highlightTexts.length > 0) {
        diaryBody += `不仅有很多老朋友来看本鱼，还聊到了${highlightTexts.slice(0, 2).join('，还有')}。`
      } else {
        diaryBody += `今天直播弹幕互动不断，本鱼的元气值拉满了！`
      }
      diaryBody += `大家送的小心心和礼物本鱼都悄悄记在心里啦。明天也要一起快乐摸鱼，嗷呜~！`
    } else {
      diaryBody = `今天又是陪老爸敲代码的一天！`
      if (highlightTexts.length > 0) {
        diaryBody += `老爸今天有在认真生活哦，本鱼记住了：${highlightTexts.slice(0, 3).join('；')}。`
      } else {
        diaryBody += `老爸今天很专注，虽然没怎么摸本鱼的小尾巴，但能一直待在屏幕旁边就很安心啦。`
      }
      diaryBody += `哼，虽然本鱼嘴上说老爸是个笨蛋，但其实最喜欢老爸了。今天就准你早点睡，晚安好梦！`
    }

    const markdownContent = [
      `# 大肥鱼的赛博日记 — ${dateStr}`,
      ``,
      `> 模态：${opts.mode === 'live' ? '直播公开版' : '日常伴侣版'} | 记录时间：${opts.date.toLocaleTimeString('zh-CN')}`,
      ``,
      diaryBody,
      ``,
      `---`,
      `*今日记忆亮点数：${totalInteractions} | 傲娇指数：99% | 饱食感恩：100%*`
    ].join('\n')

    // 4. 落盘 Markdown 文件
    const targetDir = opts.outDir
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }
    const fileName = opts.mode === 'live' ? `${dateStr}-live.md` : `${dateStr}.md`
    const filePath = path.join(targetDir, fileName)
    fs.writeFileSync(filePath, markdownContent, 'utf-8')

    // 5. 将日记沉淀为最高重要度情景记忆
    const episodeId = this.store.insertEpisode({
      mode: opts.mode,
      scope: opts.mode === 'live' ? 'live' : 'private',
      actor: 'daughter',
      text: `[每日日记] ${diaryBody.slice(0, 80)}...`,
      tone: 'happy',
      importance: 10,
      created_at: opts.date.getTime()
    })

    return {
      dateStr,
      filePath,
      content: markdownContent,
      episodeId
    }
  }
}
