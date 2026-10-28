#!/usr/bin/env node
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

console.log('========================================================')
console.log(' 🧠 CyberFish Daughter (大肥鱼) 思考大脑环境诊断')
console.log('========================================================\n')

// 1. 检查配置文件
let config = {}
try {
  const cfgPath = path.resolve(process.cwd(), 'config/daughter.config.json')
  if (fs.existsSync(cfgPath)) {
    config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
  }
} catch (e) {}

// 2. 检查 Tier 1 CLI
function checkBin(cmd) {
  try {
    const p = execSync(`which ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    return p || null
  } catch {
    return null
  }
}

const agyPath = checkBin('agy')
const cursorPath = checkBin('cursor-agent')
const ollamaPath = checkBin('ollama')

console.log('【Tier 1: 本地智能体 CLI 沙箱池 (最高优先级)】')
console.log(`  1. Antigravity CLI (agy):`)
if (agyPath) {
  console.log(`     - 状态: 🟢 已就绪 (READY)`)
  console.log(`     - 路径: ${agyPath}`)
  console.log(`     - 优化参数: --model gemini-3.8-flash-low --effort low`)
} else {
  console.log(`     - 状态: ⚪ 未检测到命令`)
}

console.log(`  2. Cursor Agent (cursor-agent):`)
if (cursorPath) {
  console.log(`     - 状态: 🟢 已就绪 (READY)`)
  console.log(`     - 路径: ${cursorPath}`)
} else {
  console.log(`     - 状态: ⚪ 未检测到命令`)
}

// 3. 检查 Tier 2 DeepSeek
console.log('\n【Tier 2: DeepSeek Chat API 流式云端 (次级降级)】')
const deepseekKey = process.env.DEEPSEEK_API_KEY || config.brain?.deepseek?.apiKey || ''
if (deepseekKey && deepseekKey !== 'sk-dummy-key') {
  const masked = `${deepseekKey.slice(0, 5)}...${deepseekKey.slice(-4)}`
  console.log(`     - 密钥状态: 🟢 已配置 (${masked})`)
  console.log(`     - 模型: ${config.brain?.deepseek?.model || 'deepseek-chat'}`)
  console.log(`     - 每日硬限额: ¥${config.brain?.deepseek?.dailyBudgetCny || 5.0} 元`)
} else {
  console.log(`     - 密钥状态: ⚪ 未配置 (可在控制台 http://127.0.0.1:7788 在线保存)`)
}

// 4. 检查 Tier 3 本地 Ollama
console.log('\n【Tier 3: 本地大模型离线服务 (离线备选)】')
if (ollamaPath) {
  console.log(`     - 工具安装: 🟢 已安装 (${ollamaPath})`)
  try {
    const res = execSync('curl -s http://127.0.0.1:11434/api/tags', { encoding: 'utf-8', timeout: 800 })
    console.log(`     - 服务连通: 🟢 服务运行中 (127.0.0.1:11434)`)
  } catch {
    console.log(`     - 服务连通: 🟡 服务未启动 (可执行 ollama serve 启动)`)
  }
} else {
  console.log(`     - 工具安装: ⚪ 未安装 ollama`)
}

// 5. Tier 4 规则库
console.log('\n【Tier 4: 本地离线规则语料库 (100% 终极兜底)】')
console.log(`     - 状态: 🟢 0ms 零延迟永久可用 (绝不死锁)`)

console.log('\n========================================================')
console.log(' 💡 延迟优化建议与对冲策略:')
console.log('   • 系统已内置 2.5s 对冲并发：若 CLI 响应超过 2.5s，自动唤起 DeepSeek 竞速')
console.log('   • 思考空档期，桌宠自动触发垫话动作与语气词，消除等待感')
console.log('   • 启动服务: ./scripts/launch.sh')
console.log('   • 在线控制台: http://127.0.0.1:7788 (支持在线热配置 DeepSeek Key)')
console.log('========================================================')
