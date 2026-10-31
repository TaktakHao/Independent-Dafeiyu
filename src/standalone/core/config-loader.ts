/**
 * @file config-loader.ts
 * 配置、密钥密盒、模板语料库与敏感词加载器
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { OperationalMode } from './types.ts'

/**
 * 动态加载 ownerQq，支持 secrets.json 根字段、onebot 子字段与环境变量回退
 */
export function getOwnerQq(fileConfig?: any): string {
  try {
    const secPath = path.resolve(process.cwd(), 'runtime/data/secrets.json')
    if (fs.existsSync(secPath)) {
      const sec = JSON.parse(fs.readFileSync(secPath, 'utf-8'))
      const qq = sec.ownerQq || sec.onebot?.ownerQq
      if (qq) return String(qq).trim()
    }
  } catch {}
  return String(process.env.OWNER_QQ || fileConfig?.ownerQq || fileConfig?.onebot?.ownerQq || '').trim()
}

/**
 * 加载本地配置文件并合并 runtime/data/secrets.json 中的持久化密钥
 */
export function loadConfig(configPath: string = 'config/daughter.config.json'): any {
  let cfg: any = {}
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8')
      cfg = JSON.parse(content)
    }
  } catch (err) {
    console.warn('[dsh-dafeiyu] 加载配置文件失败，将使用默认配置:', (err as Error).message)
  }

  try {
    const secretsPath = path.resolve(process.cwd(), 'runtime/data/secrets.json')
    if (fs.existsSync(secretsPath)) {
      const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'))
      if (secrets?.deepseekApiKey) {
        if (!cfg.brain) cfg.brain = {}
        if (!cfg.brain.deepseek) cfg.brain.deepseek = {}
        cfg.brain.deepseek.apiKey = secrets.deepseekApiKey
      }
    }
  } catch {}

  return cfg
}

/**
 * 加载 OneBot 网关持久化密钥与配置
 */
export function loadOneBotSecrets(initialOwnerQq: string, headless?: boolean): Record<string, any> {
  let onebotSecrets: Record<string, any> = {}
  try {
    const secPath = path.resolve(process.cwd(), 'runtime/data/secrets.json')
    if (fs.existsSync(secPath)) {
      const sec = JSON.parse(fs.readFileSync(secPath, 'utf-8'))
      onebotSecrets = sec.onebot || {}
      if (!onebotSecrets.ownerQq && sec.ownerQq) {
        onebotSecrets.ownerQq = sec.ownerQq
      }
    }
  } catch {}

  if (!onebotSecrets.ownerQq && initialOwnerQq) {
    onebotSecrets.ownerQq = initialOwnerQq
  }
  if (headless) {
    onebotSecrets.enabled = false
  }
  return onebotSecrets
}

/**
 * 加载模板语料库
 */
export function loadTemplates(templatesPath: string = 'config/templates.zh.json'): any {
  try {
    if (fs.existsSync(templatesPath)) {
      const content = fs.readFileSync(templatesPath, 'utf-8')
      return JSON.parse(content)
    }
  } catch {
    // 忽略加载错误
  }
  return {}
}

/**
 * 加载敏感词黑名单
 */
export function loadSensitiveWords(wordsPath: string = 'config/sensitive-words.txt'): string[] {
  try {
    if (fs.existsSync(wordsPath)) {
      return fs
        .readFileSync(wordsPath, 'utf-8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    }
  } catch {
    // 忽略
  }
  return []
}

/**
 * 解析命令行启动参数
 */
export function parseCliArgs(args: string[]): { mode: OperationalMode; headless: boolean } {
  let mode: OperationalMode = 'companion'
  let headless = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      const target = args[i + 1].toLowerCase()
      if (target === 'live' || target === 'companion') {
        mode = target
      }
      i++
    } else if (args[i] === '--headless') {
      headless = true
    }
  }

  return { mode, headless }
}
