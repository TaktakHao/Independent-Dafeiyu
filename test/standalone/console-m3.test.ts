/**
 * @file console-m3.test.ts
 * Milestone M3: 深海赛博玻璃舱 Web 控制台 UI 解耦、多联系人 API 与实时审批 API 全链路测试
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { StateManager } from '../../src/standalone/core/state.ts'
import { initDatabase, closeDatabase } from '../../src/standalone/memory/db.ts'
import { MemoryStore } from '../../src/standalone/memory/store.ts'
import { HostImpressionEngine } from '../../src/standalone/memory/impression.ts'
import { ContactImpressionEngine } from '../../src/standalone/memory/contacts.ts'
import { PermissionGuard } from '../../src/standalone/safety/permission-guard.ts'
import { ApprovalManager } from '../../src/standalone/safety/approval-manager.ts'
import { TaskExecutor } from '../../src/standalone/brain/task-executor.ts'
import { OneBotGateway } from '../../src/standalone/gateway/onebot-gateway.ts'
import { ConsoleServer } from '../../src/standalone/console/server.ts'

test('M3 Web Console UI assets, 5 workspaces, Contacts API, and Approvals API', async () => {
  const secretsPath = path.resolve(process.cwd(), 'runtime/data/secrets.json')
  const backupSecrets = fs.existsSync(secretsPath) ? fs.readFileSync(secretsPath, 'utf-8') : null

  const db = initDatabase({ path: ':memory:' })
  const memory = new MemoryStore(db)
  const impression = new HostImpressionEngine(memory, 'runtime/temp/test-m3-skills')
  const contactImpression = new ContactImpressionEngine(db, memory)
  const permissionGuard = new PermissionGuard('88888888')
  const approvalManager = new ApprovalManager(db, { cooldownMs: 0 })
  const taskExecutor = new TaskExecutor({ impression })
  const onebotGateway = new OneBotGateway({ enabled: false, ownerQq: '88888888' })
  const state = new StateManager('companion')

  const mockScheduler: any = {
    emergencyStop: async () => {},
    playClip: async () => {},
    speakText: async () => {},
    play: () => {},
    motionEngine: {
      getMacro: (clip: string) => ({ defaultSpeech: `演练动作: ${clip}` }),
    },
  }

  const port = 7796
  const consoleServer = new ConsoleServer(port, state, mockScheduler, undefined, {
    memory,
    impression,
    contactImpression,
    permissionGuard,
    approvalManager,
    taskExecutor,
    onebotGateway,
    onResolveApproval: async (req, action) => {
      if (action === 'approve') {
        return { executed: true, detailReport: `已执行 ${req.intentLabel}`, spokenReply: '搞定啦！' }
      }
      return { executed: false, rejected: true }
    },
  })

  await consoleServer.start()

  try {
    // 1. 验证首页 HTML 与静态资源 /ui/styles.css、/ui/app.js 正常加载且无阻塞式 alert()
    const htmlRes = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(htmlRes.status, 200)
    const html = await htmlRes.text()
    assert.match(html, /深海赛博指挥舱/)
    assert.match(html, /pane-command/)
    assert.match(html, /pane-motion/)
    assert.match(html, /pane-memory/)
    assert.match(html, /pane-security/)
    assert.match(html, /pane-brain/)

    const cssRes = await fetch(`http://127.0.0.1:${port}/ui/styles.css`)
    assert.equal(cssRes.status, 200)
    const css = await cssRes.text()
    assert.match(css, /backdrop-filter:\s*blur/)

    const jsRes = await fetch(`http://127.0.0.1:${port}/ui/app.js`)
    assert.equal(jsRes.status, 200)
    const js = await jsRes.text()
    assert.match(js, /function showToast/)
    assert.doesNotMatch(js, /(?<!\.)\balert\s*\(/, '重构后的前端脚本严禁调用阻塞式 alert()')

    // 2. 验证主人 QQ 绑定与网关配置 API (/api/config/onebot)
    const cfgRes = await fetch(`http://127.0.0.1:${port}/api/config/onebot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        wsUrl: 'ws://127.0.0.1:3001',
        botName: '大肥鱼',
        ownerQq: '99999999',
      }),
    })
    assert.equal(cfgRes.status, 200)
    const cfgJson = await cfgRes.json()
    assert.equal(cfgJson.success, true)
    assert.equal(cfgJson.ownerQq, '99999999')
    assert.equal(permissionGuard.getOwnerQq(), '99999999')

    // 3. 验证多联系人印象墙查询与更新 API (/api/contacts & /api/contacts/update)
    contactImpression.loadOrCreateProfile({
      userId: '22334455',
      nickname: '群友阿杰',
      groupId: '90001',
      ownerQq: '99999999',
    })
    contactImpression.assimilateContactChat('qq:22334455', {
      userText: '以后叫我杰哥，我最喜欢写Rust',
      replyText: '好嘞杰哥！',
    })

    const contactsRes = await fetch(`http://127.0.0.1:${port}/api/contacts`)
    assert.equal(contactsRes.status, 200)
    const contactsJson = await contactsRes.json()
    assert.equal(contactsJson.success, true)
    const ajie = contactsJson.contacts.find((c: any) => c.externalId === '22334455')
    assert.ok(ajie, '联系人列表必须包含群友阿杰')
    assert.equal(ajie.preferredTitle, '杰哥')
    assert.ok(Array.isArray(ajie.facts) && ajie.facts.length >= 1)

    // 尝试通过控制台更新称呼
    const updateRes = await fetch(`http://127.0.0.1:${port}/api/contacts/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: 'qq:22334455',
        preferredTitle: '阿杰大侠',
        role: 'trusted',
      }),
    })
    assert.equal(updateRes.status, 200)
    const updateJson = await updateRes.json()
    assert.equal(updateJson.success, true)
    assert.equal(updateJson.profile.preferredTitle, '阿杰大侠')
    assert.equal(updateJson.profile.role, 'trusted')

    // 4. 验证 L1 危险操作审批列表与控制台一键批准执行 API (/api/approvals & /api/approvals/resolve)
    const taskIntent = taskExecutor.detectIntent('帮我检查电脑状态', 'companion')
    const created = approvalManager.createRequest({
      userId: '22334455',
      nickname: '阿杰大侠',
      channel: 'group',
      groupId: '90001',
      intent: taskIntent,
      rawText: '帮我检查电脑状态',
    })
    assert.equal(created.success, true)
    const code = created.request!.code

    const listRes = await fetch(`http://127.0.0.1:${port}/api/approvals`)
    assert.equal(listRes.status, 200)
    const listJson = await listRes.json()
    assert.equal(listJson.pendingCount, 1)
    assert.equal(listJson.pending[0].code, code)

    // 在控制台执行批准
    const resolveRes = await fetch(`http://127.0.0.1:${port}/api/approvals/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, action: 'approve' }),
    })
    assert.equal(resolveRes.status, 200)
    const resolveJson = await resolveRes.json()
    assert.equal(resolveJson.success, true)
    assert.equal(resolveJson.request.status, 'approved')
    assert.equal(resolveJson.executionResult?.executed, true)

    // 验证队列已清空且进入历史审计流水
    const afterListRes = await fetch(`http://127.0.0.1:${port}/api/approvals`)
    const afterListJson = await afterListRes.json()
    assert.equal(afterListJson.pendingCount, 0)
    assert.ok(afterListJson.history.some((h: any) => h.code === code && h.status === 'approved'))
  } finally {
    await consoleServer.stop()
    approvalManager.destroy()
    onebotGateway.disconnect()
    closeDatabase(db)
    if (backupSecrets !== null) {
      fs.writeFileSync(secretsPath, backupSecrets, 'utf-8')
    }
    try {
      fs.rmSync('runtime/temp/test-m3-skills', { recursive: true, force: true })
    } catch {}
  }
})
