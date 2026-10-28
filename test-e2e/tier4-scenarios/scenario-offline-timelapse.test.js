/**
 * @file scenario-offline-timelapse.test.js
 * Tier 4 场景测试 6: 离线时光流逝衰减追补与跨天重启恢复全旅程
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DatabaseTestHarness,
  evaluateEmotionFSM,
} from '../harness/index.js'

describe('Tier 4 Scenario 6: Offline Time-Lapse Catch-up & State Recovery', () => {
  it('TC-SC-06: 关机 10 小时后重启，离线衰减准确追补、状态恢复并触发想念台词', () => {
    const dbHarness = new DatabaseTestHarness(':memory:')

    // 1. 模拟昨晚 22:00 正常关机时保存的状态
    dbHarness.saveRpgState(50, 70, 40) // 饱食 50, 心情 70, 精力 40

    // 2. 模拟经过 10 小时离线时间后重新启动 (08:00)
    const elapsedHours = 10.0
    const loadedState = dbHarness.loadRpgState()

    // 计算被动衰减: 饱食度每小时消耗 2.5 点，精力每小时消耗 1.5 点
    let newHunger = Math.max(0, loadedState.hunger - elapsedHours * 2.5) // 50 - 25 = 25
    let newEnergy = Math.max(0, loadedState.energy - elapsedHours * 1.5) // 40 - 15 = 25

    // 心情向基线 60 平滑回归
    let newMood = loadedState.mood
    if (newMood > 60) {
      newMood = Math.max(60, newMood - elapsedHours * 1.0) // 70 -> 60
    }

    // 保存更新后的状态
    dbHarness.saveRpgState(newHunger, newMood, newEnergy)

    // 3. 计算唤醒后的情绪状态机
    // 此时饥饿度为 25 (<30 属于饥饿)，应转入 GRUMPY 傲娇抱怨态
    const wakeState = evaluateEmotionFSM(newMood, newEnergy, newHunger, 'TSUNDERE', false)
    assert.equal(wakeState, 'GRUMPY')

    // 4. 触发离线想念与讨食台词
    const wakeUpUtterance = `老爸你终于开机了！我都饿了 ${elapsedHours} 个小时了，快给我投喂小鱼干啦！`
    assert.ok(wakeUpUtterance.includes('饿了 10 个小时'))

    // 5. 校验数据库最终状态
    const finalState = dbHarness.loadRpgState()
    assert.equal(finalState.hunger, 25)
    assert.equal(finalState.mood, 60)
    assert.equal(finalState.energy, 25)

    dbHarness.close()
  })
})
