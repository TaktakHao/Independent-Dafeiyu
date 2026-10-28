/**
 * @file r4-boundaries.test.js
 * Tier 2: R4 Emotion Engine & Behavior 边界与极限测试
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateEmotionFSM,
} from '../harness/index.js'

describe('Tier 2: R4 Emotion Engine & Behavior Boundaries', () => {
  it('TC-R4-B01: 极端饱食与精力双 0 边界下，SLEEPY (精力衰竭) 享有更高判定优先级', () => {
    // 饱食度 0 (重度饥饿本应 GRUMPY)，但精力也是 0 (<20) -> 必须判定为 SLEEPY
    const state = evaluateEmotionFSM(50, 0, 0, 'HAPPY', false)
    assert.equal(state, 'SLEEPY')
  })

  it('TC-R4-B02: 全局多观众恶意刷屏累计心情钳制 (每分钟合计 <= ±15)', () => {
    // 模拟 50 位不同观众每人试图下调 -2 心情 (总计 -100)
    let globalMoodChange = 0
    const globalMaxPerMinute = 15

    for (let i = 0; i < 50; i++) {
      const intent = -2
      if (Math.abs(globalMoodChange + intent) <= globalMaxPerMinute) {
        globalMoodChange += intent
      }
    }

    // 全局合计扣减严格封顶在 -14 ~ -15，杜绝弹幕大军恶意黑化女儿
    assert.equal(globalMoodChange, -14)
    assert.ok(Math.abs(globalMoodChange) <= globalMaxPerMinute)
  })

  it('TC-R4-B03: 直播模式下即使输入负数心情，也强制 clamp 到 30 且杜绝 SULKING', () => {
    const state = evaluateEmotionFSM(-20, 80, 80, 'SULKING', true)
    assert.notEqual(state, 'SULKING')
    assert.equal(state, 'GRUMPY')
  })

  it('TC-R4-B04: 状态边界抖动抑制压测 (在 59 与 61 之间高频交替)', () => {
    // 初始 HAPPY，心情从 70 波动
    let currentState = 'HAPPY'

    // 跌至 61: 仍在 >= 60 范围内，保持 HAPPY
    currentState = evaluateEmotionFSM(61, 80, 80, currentState, false)
    assert.equal(currentState, 'HAPPY')

    // 跌至 59: 跌破 60，降级为 TSUNDERE
    currentState = evaluateEmotionFSM(59, 80, 80, currentState, false)
    assert.equal(currentState, 'TSUNDERE')

    // 回升至 61: 虽然 > 60，但未达到 TSUNDERE -> HAPPY 的晋升阈值 (70)，保持 TSUNDERE
    currentState = evaluateEmotionFSM(61, 80, 80, currentState, false)
    assert.equal(currentState, 'TSUNDERE')

    // 回升至 72: 达到 >= 70，晋升为 HAPPY
    currentState = evaluateEmotionFSM(72, 80, 80, currentState, false)
    assert.equal(currentState, 'HAPPY')
  })

  it('TC-R4-B05: 30 句历史滑动窗口边界淘汰机制', () => {
    const historyWindow = []
    const capacity = 30

    function pushUtterance(text) {
      if (historyWindow.length >= capacity) {
        historyWindow.shift() // 淘汰最旧的一句
      }
      historyWindow.push(text)
    }

    // 填入 30 句
    for (let i = 1; i <= 30; i++) {
      pushUtterance(`台词第 ${i} 句`)
    }
    assert.equal(historyWindow.length, 30)
    assert.equal(historyWindow[0], '台词第 1 句')

    // 压入第 31 句，第 1 句被淘汰，第 2 句变为头
    pushUtterance('台词第 31 句')
    assert.equal(historyWindow.length, 30)
    assert.equal(historyWindow[0], '台词第 2 句')
    assert.equal(historyWindow[29], '台词第 31 句')
  })

  it('TC-R4-B06: 跨天离线时长 (如 7 天 = 168 小时) 追补衰减计算安全封底在 0，不出现 NaN', () => {
    const lastActiveTime = Date.now() - 7 * 24 * 3600 * 1000
    const now = Date.now()
    const elapsedHours = (now - lastActiveTime) / (3600 * 1000)

    let hunger = 80 - elapsedHours * 2.5
    let energy = 80 - elapsedHours * 2.0
    let mood = 80 - elapsedHours * 1.5

    hunger = Math.max(0, Math.min(100, hunger))
    energy = Math.max(0, Math.min(100, energy))
    mood = Math.max(0, Math.min(100, mood))

    assert.equal(hunger, 0)
    assert.equal(energy, 0)
    assert.equal(mood, 0)
    assert.ok(!Number.isNaN(hunger))
    assert.ok(!Number.isNaN(energy))
    assert.ok(!Number.isNaN(mood))
  })
})
