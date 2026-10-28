/**
 * @file r1-r2-helper-streaming.test.js
 * Tier 3 交互测试 1: R1 Helper + R2 Brain 流式元数据先出动作 + 分句流式合成播放联动
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SwiftHelperMock,
  MockLlmRouter,
  parseStreamingMeta,
  CompanionMessageKindV2,
} from '../harness/index.js'

describe('Tier 3: Interaction R1 Helper + R2 Brain Streaming Pipeline', () => {
  it('TC-IX-01: LLM 流式输出首行元数据即刻驱动 Helper 动作，随后分句送入音频队列', async () => {
    const helper = new SwiftHelperMock()
    const router = new MockLlmRouter()

    const stream = router.streamDeepSeek('老爸给女儿讲了个冷笑话')
    let firstLine = true

    for await (const chunk of stream) {
      if (firstLine && chunk.startsWith('<meta')) {
        const meta = parseStreamingMeta(chunk.trim())
        // 即刻下发动作点名
        helper.receiveFromCore({
          protocolVersion: 2,
          kind: CompanionMessageKindV2.PLAY,
          clip: meta.clip,
          maxMs: 3000,
        })
        firstLine = false
      } else if (!firstLine) {
        // 模拟流式分句合成 TTS 并入队 Helper
        helper.receiveFromCore({
          protocolVersion: 2,
          kind: CompanionMessageKindV2.AUDIO,
          id: 'turn-ix-1',
          seq: helper.audioQueue.length,
          path: `/tmp/cache_${Date.now()}.mp3`,
        })
      }
    }

    // 断言: Helper clip 已被即刻切换为 talking_happy
    assert.equal(helper.currentClip, 'talking_happy')
    // 断言: 音频队列已入队分句片段
    assert.ok(helper.audioQueue.length > 0 || helper.currentPlaying !== null)
    assert.equal(helper.isTalking, true)
  })
})
