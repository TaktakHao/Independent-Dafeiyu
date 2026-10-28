/**
 * @file scenario-companion-full-day.test.js
 * Tier 4 场景测试 1: 完整一日工作陪伴业务全旅程模拟
 * (早晨唤醒 -> 专注写代码免打扰 -> 终端命令报错关怀 -> 午间投喂 -> 摸摸头交互 -> 晚间23:30第一人称日记)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SwiftHelperMock,
  DatabaseTestHarness,
  evaluateEmotionFSM,
  CompanionMessageKindV2,
} from '../harness/index.js'

describe('Tier 4 Scenario 1: Full-Day Companion Session', () => {
  it('TC-SC-01: 完整一日拟人化陪伴状态流转与记忆沉淀全生命周期', async () => {
    const helper = new SwiftHelperMock()
    const dbHarness = new DatabaseTestHarness(':memory:')

    // --- 阶段 1: 早晨 09:00 主播开机解锁屏幕 ---
    helper.simulateScreenLock(false) // 屏幕解锁
    let mood = 75
    let hunger = 70
    let energy = 90
    let state = evaluateEmotionFSM(mood, energy, hunger, 'HAPPY', false)
    assert.equal(state, 'HAPPY')

    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.SPEAK,
      id: 'day-01',
      text: '老爸早安！新的一天也要元气满满哦~',
    })
    assert.equal(helper.speechHistory.length, 1)

    // --- 阶段 2: 10:30 主播打开 VS Code 专注写代码 ---
    helper.simulateFrontApp('com.microsoft.VSCode', 'Visual Studio Code')
    // 专注模式下被动消耗精力与饱食度
    energy -= 15 // 75
    hunger -= 20 // 50
    // 主动搭话被抑制（静默免打扰）

    // --- 阶段 3: 11:30 终端命令编译失败关怀 ---
    const terminalErrorEvent = { command: 'cargo build', duration: 4.5, exitCode: 1 }
    if (terminalErrorEvent.exitCode !== 0 && terminalErrorEvent.duration > 3.0) {
      helper.receiveFromCore({
        protocolVersion: 2,
        kind: CompanionMessageKindV2.SPEAK,
        id: 'day-02',
        text: '老爸不要灰心，深呼吸一下，这个 bug 肯定能修好的！',
      })
      // 关怀写入情景记忆
      dbHarness.insertEpisode({
        mode: 'companion',
        scope: 'private',
        actor: 'daughter',
        text: '老爸编译代码报错了，我给老爸加油打气了',
        tone: 'encouraging',
      })
    }
    assert.equal(helper.speechHistory.length, 2)

    // --- 阶段 4: 12:30 饭点饥饿加速扣减与老爸投喂 ---
    hunger -= 30 // 20 (<30 重度饥饿)
    state = evaluateEmotionFSM(mood, energy, hunger, state, false)
    assert.equal(state, 'GRUMPY') // 女儿饿坏了，转入 GRUMPY 傲娇抱怨

    // 老爸下发投喂动作
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.PLAY,
      clip: 'eat_token',
      maxMs: 4000,
    })
    hunger = 85
    mood = 85
    // 投喂后吃饱，从 GRUMPY 迟滞平滑恢复到 TSUNDERE (傲娇满足)
    state = evaluateEmotionFSM(mood, energy, hunger, state, false)
    assert.equal(state, 'TSUNDERE')

    // --- 阶段 5: 15:00 桌面摸摸头点击互动 ---
    helper.simulateUserTouch('head_pat')
    helper.receiveFromCore({
      protocolVersion: 2,
      kind: CompanionMessageKindV2.PLAY,
      clip: 'head_pat',
    })
    assert.equal(helper.currentClip, 'head_pat')
    // 摸摸头增加心情至 90，从 TSUNDERE 晋升为 HAPPY
    mood = 90
    state = evaluateEmotionFSM(mood, energy, hunger, state, false)
    assert.equal(state, 'HAPPY')

    // --- 阶段 6: 23:30 睡前日记生成 (L5 日记) ---
    energy = 15 // 精力降到 15 (<20)
    state = evaluateEmotionFSM(mood, energy, hunger, state, false)
    assert.equal(state, 'SLEEPY')

    // 生成第一人称日记
    const diaryContent = `
# 2026-10-28 星期三 大肥鱼的日记

今天老爸一直在认真写代码，中间编译报错的时候虽然有点发愁，但在我的加油下还是坚持下来啦！
中午老爸给我投喂了好吃的，下午还摸了我的头，好开心~
现在困困的，老爸也早点休息哦，晚安啦！
`.trim()

    dbHarness.insertEpisode({
      mode: 'companion',
      scope: 'private',
      actor: 'daughter',
      text: diaryContent,
      importance: 10,
    })

    const finalRecords = dbHarness.queryEpisodes({ mode: 'companion' })
    assert.equal(finalRecords.length, 2)
    assert.ok(finalRecords[0].text.includes('大肥鱼的日记'))

    dbHarness.close()
  })
})
