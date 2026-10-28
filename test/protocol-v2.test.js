import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CompanionMessageKind,
  CompanionState,
  PROTOCOL_VERSION_V1,
  PROTOCOL_VERSION_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  assertCompanionMessage,
  createMessage,
  encodeMessage,
} from '../src/protocol.js'

test('protocol exports version constants and sets properly', () => {
  assert.equal(PROTOCOL_VERSION_V1, 1)
  assert.equal(PROTOCOL_VERSION_V2, 2)
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.has(1))
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.has(2))
  assert.ok(!SUPPORTED_PROTOCOL_VERSIONS.has(3))
})

test('protocol creates v1 state message by default maintaining backward compatibility', () => {
  const msg = createMessage(CompanionMessageKind.STATE, { state: CompanionState.IDLE })
  assert.equal(msg.protocolVersion, 1)
  assert.equal(msg.kind, 'state')
  assert.equal(assertCompanionMessage(msg), msg)
  assert.deepEqual(JSON.parse(encodeMessage(msg)), msg)
})

test('protocol creates v2 messages with automatic protocolVersion: 2', () => {
  const playMsg = createMessage(CompanionMessageKind.PLAY, { clip: 'eat_token', maxMs: 3500 })
  assert.equal(playMsg.protocolVersion, 2)
  assert.equal(playMsg.kind, 'play')
  assert.equal(playMsg.clip, 'eat_token')
  assert.equal(assertCompanionMessage(playMsg), playMsg)

  const speakMsg = createMessage(CompanionMessageKind.SPEAK, { text: '小鱼干真好吃！' })
  assert.equal(speakMsg.protocolVersion, 2)
  assert.equal(assertCompanionMessage(speakMsg), speakMsg)

  const audioMsg = createMessage(CompanionMessageKind.AUDIO, { path: '/tmp/test.mp3' })
  assert.equal(audioMsg.protocolVersion, 2)
  assert.equal(assertCompanionMessage(audioMsg), audioMsg)

  const stopMsg = createMessage(CompanionMessageKind.AUDIO_STOP)
  assert.equal(stopMsg.protocolVersion, 2)
  assert.equal(assertCompanionMessage(stopMsg), stopMsg)

  const statusMsg = createMessage(CompanionMessageKind.STATUS_BAR, { text: '🍙 100%' })
  assert.equal(statusMsg.protocolVersion, 2)
  assert.equal(assertCompanionMessage(statusMsg), statusMsg)

  const talkingMsg = createMessage(CompanionMessageKind.TALKING, { on: true })
  assert.equal(talkingMsg.protocolVersion, 2)
  assert.equal(assertCompanionMessage(talkingMsg), talkingMsg)
})

test('protocol validates v2 event messages from Helper', () => {
  const audioEvent = createMessage(CompanionMessageKind.AUDIO_EVENT, {
    id: 'utt-1',
    seq: 0,
    event: 'ended',
    durationMs: 2000,
  })
  assert.equal(assertCompanionMessage(audioEvent), audioEvent)

  const frontApp = createMessage(CompanionMessageKind.FRONT_APP, {
    bundleId: 'com.microsoft.VSCode',
    name: 'Code',
  })
  assert.equal(assertCompanionMessage(frontApp), frontApp)

  const screenLock = createMessage(CompanionMessageKind.SCREEN_LOCK, { locked: true })
  assert.equal(assertCompanionMessage(screenLock), screenLock)

  const userTouch = createMessage(CompanionMessageKind.USER_TOUCH, { clip: 'head_pat' })
  assert.equal(assertCompanionMessage(userTouch), userTouch)
})

test('protocol rejects invalid v2 messages', () => {
  assert.throws(
    () => assertCompanionMessage({ protocolVersion: 2, kind: 'play', clip: '' }),
    /requires a non-empty string "clip"/,
  )
  assert.throws(
    () => assertCompanionMessage({ protocolVersion: 2, kind: 'speak', text: 123 }),
    /requires string "text"/,
  )
  assert.throws(
    () => assertCompanionMessage({ protocolVersion: 2, kind: 'audio', path: '' }),
    /requires a non-empty string "path"/,
  )
  assert.throws(
    () => assertCompanionMessage({ protocolVersion: 2, kind: 'status_bar', text: null }),
    /requires string "text"/,
  )
  assert.throws(
    () => assertCompanionMessage({ protocolVersion: 2, kind: 'talking', on: 'yes' }),
    /requires boolean "on"/,
  )
  assert.throws(
    () => assertCompanionMessage({ protocolVersion: 2, kind: 'audio_event', event: 'sleeping' }),
    /must be started, ended, or interrupted/,
  )
  assert.throws(
    () => assertCompanionMessage({ protocolVersion: 2, kind: 'front_app', bundleId: 123, name: 'Test' }),
    /requires string "bundleId" and string "name"/,
  )
  assert.throws(
    () => assertCompanionMessage({ protocolVersion: 2, kind: 'screen_lock', locked: 'true' }),
    /requires boolean "locked"/,
  )
  assert.throws(
    () => assertCompanionMessage({ protocolVersion: 2, kind: 'user_touch', clip: '' }),
    /requires a non-empty string "clip"/,
  )
  assert.throws(
    () => assertCompanionMessage({ protocolVersion: 3, kind: 'play', clip: 'idle' }),
    /Unsupported protocol version/,
  )
})
