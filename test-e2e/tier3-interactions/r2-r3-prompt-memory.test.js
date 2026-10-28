/**
 * @file r2-r3-prompt-memory.test.js
 * Tier 3 交互测试 2: R2 Brain + R3 Memory 记忆检索动态注入 Prompt 并受 Token 预算约束
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DatabaseTestHarness,
  validatePrompt3Layer,
} from '../harness/index.js'

describe('Tier 3: Interaction R2 Brain + R3 Memory Prompt Assembly', () => {
  it('TC-IX-02: 从 SQLite 提取近期情景记忆填入 Layer B，组装完整 Prompt 并确保预算 <= 2100', () => {
    const dbHarness = new DatabaseTestHarness(':memory:')

    // 预置几条情景记忆
    dbHarness.insertEpisode({ scope: 'live', text: '观众小鱼赠送了荧光棒' })
    dbHarness.insertEpisode({ scope: 'live', text: '主播正在调试音频驱动' })

    const episodes = dbHarness.queryEpisodes({ mode: 'live', limit: 5 })
    const summaryText = episodes.map((e) => `- ${e.text}`).join('\n')

    const assembledPrompt = `
[Layer A] SYSTEM_PERSONA: 你是大肥鱼，老爸的赛博女儿，元气可爱。
[Layer B] FACTS_SUMMARY:
近期互动事件：
${summaryText}
[Layer C] <event type="DANMAKU" viewer="观众A">大肥鱼在干嘛呢？</event>
`

    const validation = validatePrompt3Layer(assembledPrompt)
    assert.equal(validation.valid, true)
    assert.equal(validation.withinBudget, true)
    assert.ok(assembledPrompt.includes('小鱼赠送了荧光棒'))
    assert.ok(assembledPrompt.includes('主播正在调试音频驱动'))

    dbHarness.close()
  })
})
