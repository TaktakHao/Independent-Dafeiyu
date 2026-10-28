import assert from 'node:assert/strict'
import test from 'node:test'
import { StateManager } from '../src/standalone/core/state.ts'
import { RuntimeScheduler } from '../src/standalone/core/scheduler.ts'

test('StateManager initializes in companion mode and formats status bar', () => {
  const state = new StateManager('companion')
  assert.equal(state.getMode(), 'companion')
  assert.equal(state.getEmotion(), 'HAPPY')
  assert.match(state.formatStatusBarText(), /陪伴中/)
  assert.match(state.formatStatusBarText(), /开心/)
})

test('StateManager enforces mood clamp and SULKING avoidance in live mode', () => {
  const state = new StateManager('companion')
  state.updateStats({ mood: 10 })
  state.setEmotion('SULKING')
  assert.equal(state.getEmotion(), 'SULKING')
  assert.equal(state.getStats().mood, 10)

  // 切换为 live 直播模式
  state.setMode('live')
  assert.equal(state.getMode(), 'live')
  assert.ok(state.getStats().mood >= 30, 'Mood must be clamped >= 30 in live mode')
  assert.notEqual(state.getEmotion(), 'SULKING', 'Cannot remain in SULKING in live mode')

  // 在 live 模式下尝试将 mood 设为低于 30
  state.updateStats({ mood: 5 })
  assert.equal(state.getStats().mood, 30)

  // 在 live 模式下尝试触发 SULKING
  state.setEmotion('SULKING')
  assert.notEqual(state.getEmotion(), 'SULKING')
})

test('StateManager classifies and masks apps in live mode', () => {
  const state = new StateManager('companion')
  state.setActiveApp('com.microsoft.VSCode', 'Visual Studio Code')
  assert.equal(state.getActiveApp().category, 'code')
  assert.equal(state.getActiveApp().name, 'Visual Studio Code')

  state.setMode('live')
  state.setActiveApp('com.google.Chrome', 'Google Chrome')
  assert.equal(state.getActiveApp().category, 'browser')
  assert.equal(state.getActiveApp().name, 'BROWSER') // 脱敏保护
})

test('RuntimeScheduler manages play, speak, audio and emergencyStop', async () => {
  const state = new StateManager('companion')
  const sentMessages = []
  const mockHelper = {
    start() {},
    stop() {},
    send(msg) { sentMessages.push(msg) },
  }

  const scheduler = new RuntimeScheduler(state, { headless: true })
  // 注入 mock helper
  scheduler.helper = mockHelper

  scheduler.play('eat_token', { maxMs: 3000 })
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].kind, 'play')
  assert.equal(sentMessages[0].clip, 'eat_token')

  const uttId = scheduler.speak('你好呀老爸！')
  assert.ok(uttId.startsWith('utt-'))
  assert.equal(sentMessages[1].kind, 'speak')
  assert.equal(sentMessages[1].text, '你好呀老爸！')

  scheduler.syncStatusBar()
  assert.equal(sentMessages.at(-1).kind, 'status_bar')

  let stoppedEventFired = false
  scheduler.on('emergency_stopped', () => { stoppedEventFired = true })
  scheduler.emergencyStop()
  assert.ok(stoppedEventFired)
  assert.equal(sentMessages.at(-3).kind, 'audio_stop')
  assert.equal(sentMessages.at(-2).kind, 'play')
  assert.equal(sentMessages.at(-1).kind, 'talking')
  assert.equal(sentMessages.at(-1).on, false)
})

test('RuntimeScheduler handles user touch and adjusts mood', () => {
  const state = new StateManager('companion')
  const sentMessages = []
  const mockHelper = {
    start() {},
    stop() {},
    send(msg) { sentMessages.push(msg) },
  }

  const scheduler = new RuntimeScheduler(state, { headless: true })
  scheduler.helper = mockHelper

  const initialMood = state.getStats().mood
  scheduler.handleUserTouch({ protocolVersion: 2, kind: 'user_touch', clip: 'head_pat' })
  assert.equal(state.getStats().mood, initialMood + 3)
  assert.equal(sentMessages.at(-1).kind, 'play')
  assert.equal(sentMessages.at(-1).clip, 'head_pat')
})
