/**
 * @file motion-engine.ts
 * 大肥鱼高阶复合动作与神态编排引擎 (Composite Motion Engine)
 * 将原生 16 组 WebP 逐帧切片智能编排为生动的复合动作流（如跳舞、沉睡、加油、撒娇等）
 */

export interface MotionStep {
  clip: string
  durationMs: number
  loop?: boolean
  speech?: string
}

export interface MotionMacro {
  id: string
  name: string
  description: string
  defaultSpeech?: string
  steps: MotionStep[]
}

export class CompositeMotionEngine {
  private macros: Map<string, MotionMacro> = new Map()
  private activeSequenceTimer: any = null

  constructor() {
    this.registerDefaultMacros()
  }

  private registerDefaultMacros(): void {
    // 1. 元气大肥鱼摆尾舞 (dance)
    this.registerMacro({
      id: 'dance',
      name: '大肥鱼元气摆尾舞',
      description: '欢呼跳跃 + 啪嗒甩大尾巴 + 舒展收尾',
      defaultSpeech: '老爸看好啦！本鱼独创的元气摆尾舞来咯~ 哒哒哒！✨',
      steps: [
        { clip: 'success', durationMs: 2200 },
        { clip: 'tail', durationMs: 2500 },
        { clip: 'poke', durationMs: 1800 },
        { clip: 'idle', durationMs: 0, loop: true },
      ],
    })

    // 2. 沉睡打呼噜 (sleep)
    this.registerMacro({
      id: 'sleep',
      name: '深度沉睡打呼噜',
      description: '大打哈欠 + 眯眼趴下 + 打呼噜微动',
      defaultSpeech: '呼啊——眼皮打架了…本鱼先趴在桌角眯一会儿哦，呼噜噜…Zzz 💤',
      steps: [
        { clip: 'idle_yawn', durationMs: 3500 },
        { clip: 'idle', durationMs: 6000, loop: true },
      ],
    })

    // 3. 元气欢呼加油 (cheer)
    this.registerMacro({
      id: 'cheer',
      name: '元气加油欢呼',
      description: '大力挥手加油 + 雀跃欢呼庆祝',
      defaultSpeech: '老爸冲呀！代码毫无压力，Bug 全部退散！加油加油~ 🎉',
      steps: [
        { clip: 'poke', durationMs: 2000 },
        { clip: 'success', durationMs: 2600 },
        { clip: 'idle', durationMs: 0, loop: true },
      ],
    })

    // 4. 害羞撒娇 (shy)
    this.registerMacro({
      id: 'shy',
      name: '害羞撒娇',
      description: '被夸摸头娇羞 + 微微摇尾巴',
      defaultSpeech: '唔…老爸突然这么夸我，本鱼才没有很开心呢！只是尾巴自己动起来啦~ ⁄(⁄ ⁄•⁄ω⁄•⁄ ⁄)⁄',
      steps: [
        { clip: 'head_pat', durationMs: 3200 },
        { clip: 'tail', durationMs: 2200 },
        { clip: 'idle', durationMs: 0, loop: true },
      ],
    })

    // 5. 疲惫深度伸懒腰 (stretch)
    this.registerMacro({
      id: 'stretch',
      name: '舒爽大懒腰',
      description: '使出浑身力气的大懒腰 + 舒坦哈欠',
      defaultSpeech: '嗯————！使劲伸个大懒腰，鱼鳍都舒展爽快啦！舒服~ 🌸',
      steps: [
        { clip: 'idle_stretch', durationMs: 3600 },
        { clip: 'idle_yawn', durationMs: 2600 },
        { clip: 'idle', durationMs: 0, loop: true },
      ],
    })

    // 6. 连天大哈欠 (yawn)
    this.registerMacro({
      id: 'yawn',
      name: '哈欠连天',
      description: '揉眼睛打哈欠',
      defaultSpeech: '哈欠——唔，代码写太久容易走神嘛，要不要休息五分钟？🥱',
      steps: [
        { clip: 'idle_yawn', durationMs: 3500 },
        { clip: 'idle', durationMs: 0, loop: true },
      ],
    })

    // 7. 偷炫小鱼干 (snack)
    this.registerMacro({
      id: 'snack',
      name: '偷偷加餐炫零食',
      description: '嚼小鱼干 + 吐开心泡泡',
      defaultSpeech: '嗷呜！嚼嚼嚼…补充算力小零食，满血复活！🍙✨',
      steps: [
        { clip: 'eat_token', durationMs: 3200 },
        { clip: 'tail', durationMs: 2000 },
        { clip: 'idle', durationMs: 0, loop: true },
      ],
    })

    // 8. 傲娇叉腰 (proud)
    this.registerMacro({
      id: 'proud',
      name: '傲娇叉腰得意',
      description: '自信挥手 + 傲气摇尾巴',
      defaultSpeech: '哼哼！本鱼可是全宇宙最聪明的赛博小肥鱼，厉害吧！😎',
      steps: [
        { clip: 'poke', durationMs: 2200 },
        { clip: 'tail', durationMs: 2500 },
        { clip: 'idle', durationMs: 0, loop: true },
      ],
    })
  }

  public registerMacro(macro: MotionMacro): void {
    this.macros.set(macro.id, macro)
  }

  public getMacro(id: string): MotionMacro | undefined {
    return this.macros.get(id)
  }

  public getAllMacros(): MotionMacro[] {
    return Array.from(this.macros.values())
  }

  public hasMacro(id: string): boolean {
    return this.macros.has(id)
  }

  /**
   * 播放复合动作流
   */
  public async playMacro(
    macroId: string,
    scheduler: any,
    onSpeech?: (text: string) => void
  ): Promise<boolean> {
    const macro = this.macros.get(macroId)
    if (!macro || !scheduler) return false

    if (this.activeSequenceTimer) {
      clearTimeout(this.activeSequenceTimer)
      this.activeSequenceTimer = null
    }

    if (macro.defaultSpeech && onSpeech) {
      onSpeech(macro.defaultSpeech)
    }

    let delayAcc = 0
    for (let i = 0; i < macro.steps.length; i++) {
      const step = macro.steps[i]
      if (i === 0) {
        scheduler.play(step.clip, {
          maxMs: step.durationMs,
          loop: step.loop ?? false,
          resumeState: 'IDLE',
        })
      } else {
        const currentDelay = delayAcc
        this.activeSequenceTimer = setTimeout(() => {
          scheduler.play(step.clip, {
            maxMs: step.durationMs,
            loop: step.loop ?? false,
            resumeState: 'IDLE',
          })
        }, currentDelay)
        this.activeSequenceTimer.unref?.()
      }
      delayAcc += step.durationMs
    }

    return true
  }

  public cancel(): void {
    if (this.activeSequenceTimer) {
      clearTimeout(this.activeSequenceTimer)
      this.activeSequenceTimer = null
    }
  }
}
