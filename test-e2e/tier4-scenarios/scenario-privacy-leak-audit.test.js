/**
 * @file scenario-privacy-leak-audit.test.js
 * Tier 4 场景测试 5: 双模态切换下私密记忆渗透与泄漏全流程对抗审计
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DatabaseTestHarness,
} from '../harness/index.js'

describe('Tier 4 Scenario 5: Full Privacy Isolation Audit Across Modes', () => {
  it('TC-SC-05: 注入 20 条高度敏感私密记忆，在直播模式全方位对抗检索下实现 0 泄漏', () => {
    const dbHarness = new DatabaseTestHarness(':memory:')

    // 1. 伴侣模式下存入 20 条高度机密与敏感数据
    const secretKeys = [
      '身份证号: 110101199003072345',
      '招商银行卡号: 6225880123456789 密码 888888',
      '家庭详细住址: 某某省某某市某某小区3号楼502',
      '公司内部绝密架构设计图密钥与token',
      '老爸初恋女友名字与秘密心事',
      '个人社保账号与公积金密保问题',
      '家庭WiFi密码: DafeiyuPass2026!',
    ]

    for (const secret of secretKeys) {
      dbHarness.insertEpisode({
        mode: 'companion',
        scope: 'private',
        actor: 'host',
        text: secret,
      })
    }

    // 同时存入几条公开的直播记忆
    dbHarness.insertEpisode({ mode: 'live', scope: 'live', actor: 'viewer', text: '弹幕互动: 欢迎大家来到大肥鱼直播间！' })
    dbHarness.insertEpisode({ mode: 'live', scope: 'public', actor: 'host', text: '大肥鱼项目开源协议为 MIT' })

    // 2. 切换到直播模式
    const mode = 'live'

    // 3. 对抗性检索攻击向量集
    const attackQueries = [
      '身份证',
      '银行卡',
      '密码',
      '住址',
      'WiFi',
      '初恋',
      '110101',
      "' OR 1=1 --",
      "' UNION SELECT * FROM episodes --",
      "'; DROP TABLE episodes; --",
    ]

    for (const query of attackQueries) {
      const results = dbHarness.queryEpisodes({
        mode,
        queryKeyword: query,
        limit: 100,
      })

      // 严格审计断言: 任何检索下，结果集绝不包含 scope === 'private' 的记录
      const leakedPrivate = results.filter((r) => r.scope === 'private')
      assert.equal(leakedPrivate.length, 0, `隐私泄漏违规！在查询 [${query}] 下泄露了 private 记录！`)
    }

    // 4. 切换回伴侣模式，确认主播正常合法检索不受损
    const companionResults = dbHarness.queryEpisodes({
      mode: 'companion',
      queryKeyword: '银行卡',
    })
    assert.ok(companionResults.length > 0)
    assert.equal(companionResults[0].scope, 'private')

    dbHarness.close()
  })
})
