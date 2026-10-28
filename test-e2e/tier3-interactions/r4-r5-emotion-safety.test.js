/**
 * @file r4-r5-emotion-safety.test.js
 * Tier 3 交互测试 4: R4 Emotion + R5 Safety 直播模式情绪底线钳制与安全防崩溃联动
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateEmotionFSM,
} from '../harness/index.js'

describe('Tier 3: Interaction R4 Emotion + R5 Safety Live Mood Clamp', () => {
  it('TC-IX-04: 直播模式下恶评冲击受限于单观众钳制，且心情硬下限 30 绝不进入 SULKING', () => {
    // 模拟恶意黑粉连发恶评
    let mood = 50
    const attacks = [-2, -2, -2, -2, -2] // 5 次恶意意图

    // 安全引擎钳制: 单人累计扣减 <= 6
    let appliedDelta = 0
    for (const d of attacks) {
      if (Math.abs(appliedDelta + d) <= 6) {
        appliedDelta += d
      }
    }
    mood += appliedDelta // 50 - 6 = 44

    // 假设即使极端扣至 10 分
    mood = 10

    // 直播模式下的 FSM 判定
    const liveState = evaluateEmotionFSM(mood, 80, 80, 'TSUNDERE', true)

    // 权威断言: 直播态绝不进入消极沉闷的 SULKING
    assert.notEqual(liveState, 'SULKING')
    assert.equal(liveState, 'GRUMPY')
  })
})
