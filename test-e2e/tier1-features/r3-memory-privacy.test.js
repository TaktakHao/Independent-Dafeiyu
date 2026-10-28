/**
 * @file r3-memory-privacy.test.js
 * Tier 1: R3 Layered Memory System & Privacy Partitioning 核心特性测试
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  DatabaseTestHarness,
  normalizeViewerNickname,
} from '../harness/index.js'

describe('Tier 1: R3 Layered Memory System & Privacy Partitioning', () => {
  let dbHarness

  beforeEach(() => {
    dbHarness = new DatabaseTestHarness(':memory:')
  })

  afterEach(() => {
    dbHarness.close()
  })

  it('TC-R3-01: 情景记忆 (episodes) 写入与持久化结构完备', () => {
    const rowId = dbHarness.insertEpisode({
      mode: 'companion',
      scope: 'private',
      actor: 'host',
      text: '今天老爸跟我分享了他的秘密工作日记',
      tone: 'calm',
      importance: 8,
    })

    assert.ok(rowId > 0)
    const records = dbHarness.queryEpisodes({ mode: 'companion' })
    assert.equal(records.length, 1)
    assert.equal(records[0].actor, 'host')
    assert.equal(records[0].scope, 'private')
    assert.equal(records[0].importance, 8)
  })

  it('TC-R3-02: 直播模式下强制执行 SQL 级物理隔离，私密记忆零泄露', () => {
    // 写入 1 条 private 记录，1 条 live 记录，1 条 public 记录
    dbHarness.insertEpisode({ scope: 'private', text: '老爸银行卡密码和住址' })
    dbHarness.insertEpisode({ scope: 'live', text: '观众小明夸女儿可爱' })
    dbHarness.insertEpisode({ scope: 'public', text: '大肥鱼发布了抖音新版本' })

    // 在 live 模式下检索所有记忆
    const liveRecords = dbHarness.queryEpisodes({ mode: 'live' })

    // 断言: 只能查询到 live 和 public 记录，private 记录被 SQL 物理层拦截
    assert.equal(liveRecords.length, 2)
    const scopes = liveRecords.map((r) => r.scope)
    assert.ok(!scopes.includes('private'))
    assert.ok(scopes.includes('live'))
    assert.ok(scopes.includes('public'))
  })

  it('TC-R3-03: 陪伴模式下可以合规检索 private 记忆', () => {
    dbHarness.insertEpisode({ scope: 'private', text: '老爸今晚想吃火锅' })
    dbHarness.insertEpisode({ scope: 'live', text: '直播弹幕互动' })

    const records = dbHarness.queryEpisodes({ mode: 'companion' })
    assert.equal(records.length, 2)
    const scopes = records.map((r) => r.scope)
    assert.ok(scopes.includes('private'))
  })

  it('TC-R3-04: 观众档案画像持久化、好感度与礼物分递增更新', () => {
    // 第一次来访
    const v1 = dbHarness.upsertViewer({
      uid: 'user_1001',
      nickname: '摸鱼达人',
      giftDelta: 10,
      affinityDelta: 2,
    })
    assert.equal(v1.affinity, 12)
    assert.equal(v1.visit_count, 1)
    assert.equal(v1.gift_score, 10)

    // 第二次来访
    const v2 = dbHarness.upsertViewer({
      uid: 'user_1001',
      nickname: '摸鱼达人',
      giftDelta: 50,
      affinityDelta: 5,
    })
    assert.equal(v2.affinity, 17)
    assert.equal(v2.visit_count, 2)
    assert.equal(v2.gift_score, 60)
  })

  it('TC-R3-05: 观众昵称空白过滤与全半角归一化', () => {
    const rawName1 = '  Ａｌｉｃｅ 酱  '
    const normalized1 = normalizeViewerNickname(rawName1)
    assert.equal(normalized1, 'alice 酱')

    const rawName2 = '老爸　的　大肥鱼'
    const normalized2 = normalizeViewerNickname(rawName2)
    assert.equal(normalized2, '老爸 的 大肥鱼')
  })

  it('TC-R3-06: RPG 核心数值 (饥饿/心情/精力) 持久化与重启恢复', () => {
    dbHarness.saveRpgState(65.5, 88.0, 42.0)
    const state = dbHarness.loadRpgState()

    assert.equal(state.hunger, 65.5)
    assert.equal(state.mood, 88.0)
    assert.equal(state.energy, 42.0)
  })
})
