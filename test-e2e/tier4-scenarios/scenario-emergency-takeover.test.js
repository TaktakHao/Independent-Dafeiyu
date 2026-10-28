/**
 * @file scenario-emergency-takeover.test.js
 * Tier 4 场景测试 3: 突发状况真人主播紧急接管与控制台操控全链路
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SwiftHelperMock,
  CompanionMessageKindV2,
} from '../harness/index.js'

describe('Tier 4 Scenario 3: Host Emergency Takeover & Console Control', () => {
  it('TC-SC-03: 直播突发不合规输出或杂音时，主播热键急停并使用代她说功能无缝救场', () => {
    const helper = new SwiftHelperMock()
    const emitted = []
    helper.on('to-core', (e) => emitted.push(e))

    // 1. 模拟 AI 女儿正在播报一句长语音
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.AUDIO,
      id: 'bad-turn',
      seq: 0,
      path: '/tmp/bad_output.mp3',
    })
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.AUDIO,
      id: 'bad-turn',
      seq: 1,
      path: '/tmp/bad_output_cont.mp3',
    })
    assert.equal(helper.isTalking, true)

    // 2. 主播按下 Ctrl+Opt+Cmd+S 触发紧急急停
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.AUDIO_STOP,
    })
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.PLAY,
      clip: 'idle',
    })

    // 3. 校验音频即刻中断，待播队列被清空
    assert.equal(helper.isTalking, false)
    assert.equal(helper.audioQueue.length, 0)
    assert.equal(helper.currentPlaying, null)
    assert.equal(helper.currentClip, 'idle')

    // 4. 主播在 Web 控制台使用【代她说】功能，直接输入安抚台词 (绕过 LLM 思考)
    const hostTakeoverSpeech = '大家别慌，老爸刚才在测试音频特效呢，我们继续看弹幕！'
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.SPEAK,
      id: 'host-takeover-01',
      text: hostTakeoverSpeech,
      typewriter: true,
      holdMs: 4000,
    })
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.PLAY,
      clip: 'wave',
      maxMs: 3000,
    })

    // 5. 校验气泡与动作正常呈现
    assert.equal(helper.speechHistory[helper.speechHistory.length - 1].text, hostTakeoverSpeech)
    assert.equal(helper.currentClip, 'wave')
  })
})
