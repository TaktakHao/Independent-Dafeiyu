/**
 * @file r1-protocol-lifecycle.test.js
 * Tier 1: R1 Standalone Core & Swift Helper Protocol v2 核心特性测试
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SwiftHelperMock,
  validateProtocolV2Message,
  CompanionMessageKindV2,
  CompanionStateV1,
} from '../harness/index.js'

describe('Tier 1: R1 Standalone Core & Swift Helper Protocol v2', () => {
  it('TC-R1-01: 校验 Protocol v2 消息 Schema 与关键字段格式', () => {
    // 1. play 消息
    const playMsg = {
      protocolVersion: 2,
      kind: CompanionMessageKindV2.PLAY,
      clip: 'eat_token',
      maxMs: 5000,
      loop: false,
      resumeState: 'idle',
    }
    assert.equal(validateProtocolV2Message(playMsg), true)

    // 2. speak 消息
    const speakMsg = {
      protocolVersion: 2,
      kind: CompanionMessageKindV2.SPEAK,
      id: 'spk-001',
      text: '老爸，我饿了，想吃小鱼干！',
      typewriter: true,
      holdMs: 3000,
    }
    assert.equal(validateProtocolV2Message(speakMsg), true)

    // 3. status_bar 消息
    const statusMsg = {
      protocolVersion: 2,
      kind: CompanionMessageKindV2.STATUS_BAR,
      text: '饱食:85 | 心情:90 | 精力:95 [开心]',
    }
    assert.equal(validateProtocolV2Message(statusMsg), true)
  })

  it('TC-R1-02: Helper 接收 play 消息能够正确更新动作状态并支持 maxMs 截断', () => {
    const helper = new SwiftHelperMock()
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.PLAY,
      clip: 'head_pat',
      maxMs: 3000,
    })

    assert.equal(helper.currentClip, 'head_pat')
    assert.equal(helper.receivedMessages.length, 1)
    assert.equal(helper.receivedMessages[0].clip, 'head_pat')
    assert.equal(helper.receivedMessages[0].maxMs, 3000)
  })

  it('TC-R1-03: 内置音频播放队列支持连续分句播放与非阻塞推进', () => {
    const helper = new SwiftHelperMock()
    const emittedEvents = []
    helper.on('to-core', (evt) => emittedEvents.push(evt))

    // 连续入队 2 句音频
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.AUDIO,
      id: 'turn-1',
      seq: 0,
      path: '/tmp/audio_0.mp3',
    })
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.AUDIO,
      id: 'turn-1',
      seq: 1,
      path: '/tmp/audio_1.mp3',
    })

    // 此时第 1 句自动开始播放
    assert.equal(helper.isTalking, true)
    assert.equal(emittedEvents.length, 1)
    assert.equal(emittedEvents[0].event, 'started')
    assert.equal(emittedEvents[0].seq, 0)

    // 模拟第 1 句播放结束，自动触发第 2 句
    helper.finishCurrentAudio(650)
    assert.equal(emittedEvents.length, 3) // ended(seq:0) + started(seq:1)
    assert.equal(emittedEvents[1].event, 'ended')
    assert.equal(emittedEvents[1].seq, 0)
    assert.equal(emittedEvents[2].event, 'started')
    assert.equal(emittedEvents[2].seq, 1)

    // 第 2 句播放结束，队列空闲，恢复不说话态
    helper.finishCurrentAudio(500)
    assert.equal(helper.isTalking, false)
    assert.equal(emittedEvents[3].event, 'ended')
    assert.equal(emittedEvents[3].seq, 1)
  })

  it('TC-R1-04: 音频强制打断与 audio_stop 紧急清空队列', () => {
    const helper = new SwiftHelperMock()
    const emittedEvents = []
    helper.on('to-core', (evt) => emittedEvents.push(evt))

    // 入队一句
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.AUDIO,
      id: 'turn-2',
      seq: 0,
      path: '/tmp/audio_a.mp3',
    })
    assert.equal(emittedEvents[0].event, 'started')

    // 下发 audio_stop 强行终止
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.AUDIO_STOP,
    })

    assert.equal(emittedEvents.length, 2)
    assert.equal(emittedEvents[1].event, 'interrupted')
    assert.equal(helper.audioQueue.length, 0)
    assert.equal(helper.currentPlaying, null)
  })

  it('TC-R1-05: 接收前台应用、锁屏及桌面点击交互事件', () => {
    const helper = new SwiftHelperMock()
    const events = []
    helper.on('to-core', (evt) => events.push(evt))

    // 1. 前台切换应用通知
    helper.simulateFrontApp('com.microsoft.VSCode', 'Visual Studio Code')
    assert.equal(events[0].kind, 'front_app')
    assert.equal(events[0].bundleId, 'com.microsoft.VSCode')
    assert.equal(events[0].name, 'Visual Studio Code')

    // 2. 锁屏通知
    helper.simulateScreenLock(true)
    assert.equal(events[1].kind, 'screen_lock')
    assert.equal(events[1].locked, true)

    // 3. 桌面摸头点击
    helper.simulateUserTouch('head_pat')
    assert.equal(events[2].kind, 'user_touch')
    assert.equal(events[2].clip, 'head_pat')
  })

  it('TC-R1-06: 协议向后兼容性验证，确保兼容 Protocol v1 消息', () => {
    const v1StateMsg = {
      protocolVersion: 1,
      kind: 'state',
      state: CompanionStateV1.WORKING,
      text: '正在思考代码重构',
    }
    // 必须被当前校验器安全放行
    assert.equal(validateProtocolV2Message(v1StateMsg), true)

    const v1PulseMsg = {
      protocolVersion: 1,
      kind: 'pulse',
      state: CompanionStateV1.SUCCESS,
    }
    assert.equal(validateProtocolV2Message(v1PulseMsg), true)
  })
})
