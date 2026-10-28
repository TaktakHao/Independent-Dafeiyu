/**
 * @file r1-boundaries.test.js
 * Tier 2: R1 Standalone Core & Helper Protocol v2 边界与异常测试
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SwiftHelperMock,
  validateProtocolV2Message,
  CompanionMessageKindV2,
} from '../harness/index.js'

describe('Tier 2: R1 Protocol & Helper Boundary Cases', () => {
  it('TC-R1-B01: 畸形非法输入 (null, 非对象, 缺失 kind) 被严格校验拦截', () => {
    assert.throws(() => validateProtocolV2Message(null), /必须为 JSON 对象/)
    assert.throws(() => validateProtocolV2Message('hello'), /必须为 JSON 对象/)
    assert.throws(() => validateProtocolV2Message([]), /必须为 JSON 对象/)
    assert.throws(() => validateProtocolV2Message({ protocolVersion: 2 }), /未知的协议消息类型/)
  })

  it('TC-R1-B02: 不支持的 protocolVersion 被严格拒绝', () => {
    assert.throws(
      () => validateProtocolV2Message({ protocolVersion: 3, kind: 'play', clip: 'idle' }),
      /不支持的协议版本: 3/
    )
    assert.throws(
      () => validateProtocolV2Message({ protocolVersion: 0, kind: 'play', clip: 'idle' }),
      /不支持的协议版本: 0/
    )
  })

  it('TC-R1-B03: play 消息 clip 非法类型或为空时抛出类型错误', () => {
    assert.throws(
      () => validateProtocolV2Message({ protocolVersion: 2, kind: 'play', clip: '' }),
      /非空 clip/
    )
    assert.throws(
      () => validateProtocolV2Message({ protocolVersion: 2, kind: 'play', clip: 123 }),
      /非空 clip/
    )
    assert.throws(
      () => validateProtocolV2Message({ protocolVersion: 2, kind: 'play', clip: 'idle', maxMs: 'invalid' }),
      /play.maxMs 必须为数字/
    )
  })

  it('TC-R1-B04: speak 消息空 id 或缺少 text 抛出异常', () => {
    assert.throws(
      () => validateProtocolV2Message({ protocolVersion: 2, kind: 'speak', id: '', text: 'hi' }),
      /非空 id/
    )
    assert.throws(
      () => validateProtocolV2Message({ protocolVersion: 2, kind: 'speak', id: '1', text: 123 }),
      /包含 text 字符串/
    )
  })

  it('TC-R1-B05: 高频并发打断压力测试 (100 次快速打断)，Helper 状态不泄漏', () => {
    const helper = new SwiftHelperMock()
    const events = []
    helper.on('to-core', (e) => events.push(e))

    for (let i = 0; i < 100; i++) {
      helper.receiveFromCore({
        protocolVersion: 2,
        kind: CompanionMessageKindV2.AUDIO,
        id: `stress-${i}`,
        seq: 0,
        path: `/tmp/stress_${i}.mp3`,
        interrupt: true, // 强制打断上一句
      })
    }

    // 最后一个音频正在播放，前面的均被正常打断
    assert.equal(helper.currentPlaying.id, 'stress-99')
    assert.equal(helper.audioQueue.length, 0)
    assert.ok(events.length >= 100)
  })

  it('TC-R1-B06: 连续多次调用 audio_stop 与急停幂等性保障', () => {
    const helper = new SwiftHelperMock()
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.AUDIO,
      id: 'a1',
      seq: 0,
      path: '/tmp/a.mp3',
    })

    // 连续触发 3 次 audio_stop
    helper.receiveFromCore({ protocolVersion: 2, kind: CompanionMessageKindV2.AUDIO_STOP })
    helper.receiveFromCore({ protocolVersion: 2, kind: CompanionMessageKindV2.AUDIO_STOP })
    helper.receiveFromCore({ protocolVersion: 2, kind: CompanionMessageKindV2.AUDIO_STOP })

    assert.equal(helper.currentPlaying, null)
    assert.equal(helper.audioQueue.length, 0)
    assert.equal(helper.isTalking, false)
  })
})
