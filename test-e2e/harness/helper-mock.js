/**
 * @file helper-mock.js
 * 模拟 macOS Swift Native Helper (dsh-dafeiyu-helper.app) 的双向 NDJSON 管道与内部音频队列
 */

import { EventEmitter } from 'node:events'
import { validateProtocolV2Message, CompanionMessageKindV2 } from './contract-validators.js'

export class SwiftHelperMock extends EventEmitter {
  constructor() {
    super()
    this.receivedMessages = []
    this.audioQueue = []
    this.currentPlaying = null
    this.currentClip = 'idle'
    this.isTalking = false
    this.speechHistory = []
    this.statusBarText = ''
    this.isEmergencyStopped = false
  }

  /**
   * 模拟 Core 向 Helper 写入一行 NDJSON 字符串
   * @param {string|object} input 
   */
  receiveFromCore(input) {
    const msg = typeof input === 'string' ? JSON.parse(input) : input
    validateProtocolV2Message(msg)
    this.receivedMessages.push(msg)

    switch (msg.kind) {
      case CompanionMessageKindV2.PLAY:
        this.currentClip = msg.clip
        break

      case CompanionMessageKindV2.SPEAK:
        this.speechHistory.push(msg)
        break

      case CompanionMessageKindV2.AUDIO:
        if (msg.interrupt) {
          this.interruptCurrentAudio()
        }
        this.audioQueue.push(msg)
        if (!this.currentPlaying) {
          this._playNextAudio()
        }
        break

      case CompanionMessageKindV2.AUDIO_STOP:
        this.interruptCurrentAudio()
        this.audioQueue = []
        break

      case CompanionMessageKindV2.STATUS_BAR:
        this.statusBarText = msg.text
        break

      case CompanionMessageKindV2.TALKING:
        this.isTalking = msg.on
        break
    }
  }

  interruptCurrentAudio() {
    if (this.currentPlaying) {
      const item = this.currentPlaying
      this.currentPlaying = null
      this.isTalking = false
      this.emitToCore({
        protocolVersion: 2,
        kind: CompanionMessageKindV2.AUDIO_EVENT,
        id: item.id,
        seq: item.seq,
        event: 'interrupted',
        durationMs: 150,
      })
    }
  }

  _playNextAudio() {
    if (this.audioQueue.length === 0) {
      this.currentPlaying = null
      this.isTalking = false
      return
    }
    const item = this.audioQueue.shift()
    this.currentPlaying = item
    this.isTalking = true

    // 发送 started 事件
    this.emitToCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.AUDIO_EVENT,
      id: item.id,
      seq: item.seq,
      event: 'started',
      durationMs: 0,
    })
  }

  /**
   * 手动触发当前音频播放结束
   */
  finishCurrentAudio(durationMs = 800) {
    if (this.currentPlaying) {
      const item = this.currentPlaying
      this.currentPlaying = null
      this.emitToCore({
        protocolVersion: 2,
        kind: CompanionMessageKindV2.AUDIO_EVENT,
        id: item.id,
        seq: item.seq,
        event: 'ended',
        durationMs,
      })
      this._playNextAudio()
    }
  }

  /**
   * 触发急停
   */
  triggerEmergencyStop() {
    this.isEmergencyStopped = true
    this.interruptCurrentAudio()
    this.audioQueue = []
    this.currentClip = 'idle'
    this.isTalking = false
  }

  /**
   * 模拟 Helper 向 Core 发送事件
   * @param {object} eventMsg 
   */
  emitToCore(eventMsg) {
    validateProtocolV2Message(eventMsg)
    this.emit('to-core', eventMsg)
  }

  /**
   * 模拟前台活动应用感知切换
   */
  simulateFrontApp(bundleId, name) {
    this.emitToCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.FRONT_APP,
      bundleId,
      name,
    })
  }

  /**
   * 模拟系统锁屏/解锁
   */
  simulateScreenLock(locked) {
    this.emitToCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.SCREEN_LOCK,
      locked,
    })
  }

  /**
   * 模拟桌面抚摸/点击
   */
  simulateUserTouch(clip) {
    this.emitToCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.USER_TOUCH,
      clip,
    })
  }
}
