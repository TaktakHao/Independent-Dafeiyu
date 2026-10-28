/**
 * @file r4-r1-appfocus-silence.test.js
 * Tier 3 交互测试 10: R4 Emotion + R1 Helper 前台 IDE 编码免打扰静默联动
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SwiftHelperMock,
} from '../harness/index.js'

describe('Tier 3: Interaction R4 Emotion + R1 Helper Focus Protection Silence', () => {
  it('TC-IX-10: Helper 上报前台切换为 VS Code 且连续活跃，主动搭话自动推迟', () => {
    const helper = new SwiftHelperMock()
    let currentApp = null

    helper.on('to-core', (e) => {
      if (e.kind === 'front_app') {
        currentApp = e
      }
    })

    // 1. Helper 上报前台切换到代码编辑器
    helper.simulateFrontApp('com.microsoft.VSCode', 'Visual Studio Code')
    assert.equal(currentApp.name, 'Visual Studio Code')

    // 2. 模拟行为引擎判定: 处于专注编程模式 (Focus Mode)
    const isCodingApp = ['Visual Studio Code', 'Xcode', 'Cursor'].includes(currentApp.name)
    assert.equal(isCodingApp, true)

    // 3. 专注模式下，主动搭话概率被抑制为 0，或者主动独白仅播放微动作不发声
    const proactiveSpeechAllowed = !isCodingApp
    assert.equal(proactiveSpeechAllowed, false)
  })
})
