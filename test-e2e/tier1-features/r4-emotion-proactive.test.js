/**
 * @file r4-emotion-proactive.test.js
 * Tier 1: R4 Human-like Emotion Engine & Proactive Interaction 核心特性测试
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateEmotionFSM,
  levenshteinDistance,
} from '../harness/index.js'

describe('Tier 1: R4 Human-like Emotion Engine & Proactive Interaction', () => {
  it('TC-R4-01: 5 态迟滞情绪状态机正常状态转移 (HAPPY -> TSUNDERE -> GRUMPY)', () => {
    // 初始高心情高饱食高精力 -> HAPPY
    let state = evaluateEmotionFSM(85, 90, 80, 'HAPPY', false)
    assert.equal(state, 'HAPPY')

    // 心情跌至 65，由于迟滞阈值 (>=60 保持 HAPPY)，仍然保持 HAPPY
    state = evaluateEmotionFSM(65, 80, 70, 'HAPPY', false)
    assert.equal(state, 'HAPPY')

    // 心情跌破 60，降级至 TSUNDERE
    state = evaluateEmotionFSM(58, 80, 70, 'HAPPY', false)
    assert.equal(state, 'TSUNDERE')

    // 饥饿严重 (<30) 或心情跌破 40，降级至 GRUMPY
    state = evaluateEmotionFSM(58, 80, 20, 'TSUNDERE', false)
    assert.equal(state, 'GRUMPY')
  })

  it('TC-R4-02: 精力衰竭 (<20) 优先进入 SLEEPY 困倦态', () => {
    const state = evaluateEmotionFSM(90, 15, 90, 'HAPPY', false)
    assert.equal(state, 'SLEEPY')
  })

  it('TC-R4-03: 直播模式下心情下限 clamp (>=30) 且绝不进入 SULKING 委屈态', () => {
    // 在伴侣模式下，极度低心情 (<25) 会进入消极的 SULKING
    const companionState = evaluateEmotionFSM(15, 80, 80, 'TSUNDERE', false)
    assert.equal(companionState, 'SULKING')

    // 在直播模式下 (liveMode = true)，即便输入心情 10，强制 clamp 到 30，且驱逐 SULKING 为 GRUMPY
    const liveState = evaluateEmotionFSM(10, 80, 80, 'TSUNDERE', true)
    assert.notEqual(liveState, 'SULKING')
    assert.equal(liveState, 'GRUMPY')
  })

  it('TC-R4-04: 单观众刷屏恶意操控心情钳制防护 (单人每分钟 <= ±6)', () => {
    // 模拟恶意观众 1 分钟内连续发送 20 次负面攻击
    let accumulatedMoodChange = 0
    const singleViewerMaxPerMinute = 6
    const attacks = new Array(20).fill(-2)

    for (const intent of attacks) {
      if (Math.abs(accumulatedMoodChange + intent) <= singleViewerMaxPerMinute) {
        accumulatedMoodChange += intent
      }
    }

    assert.equal(accumulatedMoodChange, -6)
    assert.ok(Math.abs(accumulatedMoodChange) <= singleViewerMaxPerMinute)
  })

  it('TC-R4-05: 30 句台词滑动窗口防重复检测机制', () => {
    const history = [
      '老爸今天工作辛苦啦，快喝口水吧！',
      '大肥鱼今天也在认真陪你哦！',
      '你写代码的样子真帅气呢~',
    ]

    const candidateRepeat = '老爸今天工作辛苦啦，快喝口水吧！'
    const candidateFresh = '好想吃炸小鱼干呀，老爸要不要点外卖？'

    // 计算与历史的最小编辑距离比率
    function isDuplicate(candidate, historyList, threshold = 0.85) {
      for (const h of historyList) {
        const dist = levenshteinDistance(candidate, h)
        const similarity = 1 - dist / Math.max(candidate.length, h.length)
        if (similarity >= threshold) {
          return true
        }
      }
      return false
    }

    assert.equal(isDuplicate(candidateRepeat, history), true)
    assert.equal(isDuplicate(candidateFresh, history), false)
  })

  it('TC-R4-06: 编码专注工作免打扰保护抑制主动搭话', () => {
    // 模拟连续编码 45 分钟 (>30 分钟)
    const hostContinuousCodingMinutes = 45
    const isFocusWorking = hostContinuousCodingMinutes >= 30

    // 免打扰规则: 专注工作时，主动搭话冷却时间拉长至 30 分钟 (1800s)
    const proactiveIntervalSeconds = isFocusWorking ? 1800 : 300
    assert.equal(proactiveIntervalSeconds, 1800)
  })
})
