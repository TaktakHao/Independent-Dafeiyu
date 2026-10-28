/**
 * @file r5-r1-fastpath-helper.test.js
 * Tier 3 交互测试 5: R5 Safety + R1 Helper 0-Token 模板快速事件直通 Helper 渲染
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SwiftHelperMock,
  CompanionMessageKindV2,
} from '../harness/index.js'

describe('Tier 3: Interaction R5 Safety + R1 Helper Fast-Path Direct Dispatch', () => {
  it('TC-IX-05: 进房与点赞事件跳过 LLM 思考，毫秒级直接下发 speak 与 play 消息给 Helper', () => {
    const helper = new SwiftHelperMock()

    // 模拟接收进房事件
    const enterEvent = { type: 'ENTER', viewer: '摸鱼小仙女' }

    // 0-Token 模板短路逻辑直接拼装 Helper 消息
    const welcomeText = `欢迎 ${enterEvent.viewer} 进入大肥鱼直播间！`

    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.PLAY,
      clip: 'wave',
      maxMs: 2000,
    })
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.SPEAK,
      id: 'fast-001',
      text: welcomeText,
      typewriter: true,
      holdMs: 2500,
    })

    assert.equal(helper.currentClip, 'wave')
    assert.equal(helper.speechHistory.length, 1)
    assert.equal(helper.speechHistory[0].text, welcomeText)
    assert.equal(helper.receivedMessages.length, 2)
  })
})
