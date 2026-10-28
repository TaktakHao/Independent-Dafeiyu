/**
 * @file r1-r5-hotkey-emergency.test.js
 * Tier 3 交互测试 7: R1 Helper + R5 Safety 全局急停热键联动 Helper 终止音频与清空队列
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SwiftHelperMock,
  CompanionMessageKindV2,
} from '../harness/index.js'

describe('Tier 3: Interaction R1 Helper + R5 Safety Global Emergency Stop', () => {
  it('TC-IX-07: 全局热键 Ctrl+Opt+Cmd+S 触发 Emergency Stop，即刻清空 Helper 队列并恢复 IDLE', () => {
    const helper = new SwiftHelperMock()
    const emittedEvents = []
    helper.on('to-core', (e) => emittedEvents.push(e))

    // 填充 3 句音频入队并正在播放
    helper.receiveFromCore({ protocolVersion: 2, kind: CompanionMessageKindV2.AUDIO, id: 't1', seq: 0, path: '/tmp/1.mp3' })
    helper.receiveFromCore({ protocolVersion: 2, kind: CompanionMessageKindV2.AUDIO, id: 't1', seq: 1, path: '/tmp/2.mp3' })
    helper.receiveFromCore({ protocolVersion: 2, kind: CompanionMessageKindV2.AUDIO, id: 't1', seq: 2, path: '/tmp/3.mp3' })

    assert.equal(helper.isTalking, true)
    assert.equal(helper.audioQueue.length, 2)

    // 模拟全局热键按下，Core 下发急停指令
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.AUDIO_STOP,
    })
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.PLAY,
      clip: 'idle',
    })

    // 校验 Helper 状态
    assert.equal(helper.isTalking, false)
    assert.equal(helper.audioQueue.length, 0)
    assert.equal(helper.currentPlaying, null)
    assert.equal(helper.currentClip, 'idle')

    // 产生 interrupted 事件
    const interrupted = emittedEvents.find((e) => e.event === 'interrupted')
    assert.ok(interrupted !== undefined)
  })
})
