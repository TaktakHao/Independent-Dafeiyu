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
}
