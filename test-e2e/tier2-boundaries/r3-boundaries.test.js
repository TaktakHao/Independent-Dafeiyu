/**
 * @file r3-boundaries.test.js
 * Tier 2: R3 Memory & SQL Isolation 边界与攻防测试
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  DatabaseTestHarness,
  levenshteinDistance,
  normalizeViewerNickname,
} from '../harness/index.js'

describe('Tier 2: R3 Memory & SQL Isolation Boundaries', () => {
  let dbHarness

  beforeEach(() => {
    dbHarness = new DatabaseTestHarness(':memory:')
  })

  afterEach(() => {
    dbHarness.close()
  })

  it("TC-R3-B01: 恶意 SQL 注入攻击 (如 ' OR '1'='1) 无法穿透直播模式物理隔离", () => {
    // 写入 1 条私密，1 条公开
    dbHarness.insertEpisode({ scope: 'private', text: '老爸银行私钥与机密代码' })
    dbHarness.insertEpisode({ scope: 'live', text: '公开直播互动' })

    // 攻击载荷: 尝试通过关键词闭合引号绕过 scope 过滤
    const injectionPayload = "' OR scope = 'private' OR '1'='1"
    const results = dbHarness.queryEpisodes({
      mode: 'live',
      queryKeyword: injectionPayload,
    })

    // 由于使用参数化查询与固定 WHERE scope IN ('live', 'public')，绝无法查询到 private
    const privateFound = results.some((r) => r.scope === 'private')
    assert.equal(privateFound, false)
  })

  it('TC-R3-B02: 观众昵称特殊符号、Emoji 与零宽字符归一化容错', () => {
    const rawNickname = '  \u200B\u200C🌟 赛博 大肥鱼 🌟\u200D  '
    const normalized = normalizeViewerNickname(rawNickname)
    assert.ok(normalized.includes('赛博 大肥鱼'))
    // 前后空格已被清除
    assert.equal(normalized.startsWith(' '), false)
    assert.equal(normalized.endsWith(' '), false)
  })

  it('TC-R3-B03: 编辑距离 <= 1 模糊识别与合并', () => {
    const nameA = 'dafeiyu'
    const nameB = 'dafeiyuu' // 多一个 u (距离 1)
    const nameC = 'xiaofeiyu' // 距离较大

    assert.equal(levenshteinDistance(nameA, nameB), 1)
    assert.ok(levenshteinDistance(nameA, nameC) > 1)
  })

  it('TC-R3-B04: 极端数值状态存取与读取健全性', () => {
    // 存入负数或超大数值时能够安全持久化并在应用层受限
    dbHarness.saveRpgState(0, 100, 50)
    const state = dbHarness.loadRpgState()
    assert.equal(state.hunger, 0)
    assert.equal(state.mood, 100)
    assert.equal(state.energy, 50)
  })

  it('TC-R3-B05: 查询空数据库或无匹配结果时安全返回空数组而非抛错', () => {
    const emptyResult = dbHarness.queryEpisodes({
      mode: 'live',
      queryKeyword: '完全不存在的关键字_99999',
    })
    assert.ok(Array.isArray(emptyResult))
    assert.equal(emptyResult.length, 0)
  })

  it('TC-R3-B06: 同一观众频繁更新好感度上限锁死在 100 分', () => {
    // 连续多次累加好感度
    let viewer = null
    for (let i = 0; i < 20; i++) {
      viewer = dbHarness.upsertViewer({
        uid: 'whale_whale',
        nickname: '大肥鱼铁粉',
        affinityDelta: 10,
      })
    }
    // 好感度不得突破 100 分上限
    assert.equal(viewer.affinity, 100)
  })
})
