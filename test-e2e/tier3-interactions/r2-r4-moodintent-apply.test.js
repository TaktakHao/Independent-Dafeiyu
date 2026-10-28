/**
 * @file r2-r4-moodintent-apply.test.js
 * Tier 3 交互测试 8: R2 Brain + R4 Emotion LLM 输出 moodIntent 经三轴数值引擎安全吸收
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseStreamingMeta,
  evaluateEmotionFSM,
} from '../harness/index.js'

describe('Tier 3: Interaction R2 Brain + R4 Emotion Mood Intent Assimilation', () => {
  it('TC-IX-08: 解析流式 meta 标签中的 moodIntent 并更新当前情绪状态', () => {
    // 模拟 LLM 针对老爸夸奖返回的心情意图
    const metaLine = '<meta clip="talking_happy" tone="happy" moodIntent="2" memory="老爸夸我聪明"/>\n'
    const meta = parseStreamingMeta(metaLine)

    assert.equal(meta.moodIntent, 2)

    // 基础心情 62 (处于 TSUNDERE 态)，吸收 +2 * 5 (放大系数) = +10 分
    let currentMood = 62
    currentMood += meta.moodIntent * 5 // 72

    // 重新计算 FSM
    const newState = evaluateEmotionFSM(currentMood, 80, 80, 'TSUNDERE', false)
    // 突破 70 阈值，成功晋升为 HAPPY 态
    assert.equal(newState, 'HAPPY')
  })
})
