/**
 * @file r3-r4-memory-emotion.test.js
 * Tier 3 交互测试 3: R3 Memory + R4 Emotion 喂食事件同时更新数值、状态转移并写入记忆
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DatabaseTestHarness,
  evaluateEmotionFSM,
} from '../harness/index.js'

describe('Tier 3: Interaction R3 Memory + R4 Emotion Numerical & Memory Sync', () => {
  it('TC-IX-03: 喂食事件同时增加饱食度与心情，促发 HAPPY 态并记录情景事件', () => {
    const dbHarness = new DatabaseTestHarness(':memory:')

    // 初始状态: 饥饿 (35), 心情 (50) -> TSUNDERE
    let hunger = 35
    let mood = 50
    let state = evaluateEmotionFSM(mood, 80, hunger, 'TSUNDERE', false)
    assert.equal(state, 'TSUNDERE')

    // 发生喂食事件 (feed: +40 hunger, +25 mood)
    hunger = Math.min(100, hunger + 40) // 75
    mood = Math.min(100, mood + 25) // 75

    // 重新计算状态机
    state = evaluateEmotionFSM(mood, 80, hunger, state, false)
    assert.equal(state, 'HAPPY')

    // 将这一暖心事件写入情景记忆
    const rowId = dbHarness.insertEpisode({
      mode: 'companion',
      scope: 'private',
      actor: 'host',
      text: '老爸投喂了特级香烤小鱼干，饱食度和心情大幅提升！',
      tone: 'happy',
      importance: 9,
    })

    assert.ok(rowId > 0)
    dbHarness.saveRpgState(hunger, mood, 80)
    const saved = dbHarness.loadRpgState()
    assert.equal(saved.hunger, 75)
    assert.equal(saved.mood, 75)

    dbHarness.close()
  })
})
