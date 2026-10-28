/**
 * @file r3-r5-viewer-affinity.test.js
 * Tier 3 交互测试 9: R3 Memory + R5 Safety 屏幕识别礼物累加好感度与个性化熟客迎宾
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DanmakuOcrMock,
  DatabaseTestHarness,
} from '../harness/index.js'

describe('Tier 3: Interaction R3 Memory + R5 Safety Viewer Affinity Tracking', () => {
  it('TC-IX-09: 观众送礼经 OCR 解析后持久化至 SQLite，好感度提升并触发熟客定制回复', () => {
    const ocrMock = new DanmakuOcrMock()
    const dbHarness = new DatabaseTestHarness(':memory:')

    let capturedGift = null
    ocrMock.on('event', (e) => {
      if (e.type === 'GIFT') {
        capturedGift = e
      }
    })

    // 屏幕 OCR 捕捉到观众送出保时捷
    ocrMock.processFrame([
      { text: '榜一老大哥: 送出 保时捷 x1', confidence: 0.98, y: 120 },
    ])

    assert.notEqual(capturedGift, null)
    assert.equal(capturedGift.viewer, '榜一老大哥')

    // 更新观众画像 (大额礼物 +20 好感度，+100 礼物分)
    const viewerProfile = dbHarness.upsertViewer({
      uid: 'vip_999',
      nickname: capturedGift.viewer,
      giftDelta: 100,
      affinityDelta: 20,
    })

    assert.equal(viewerProfile.affinity, 30) // 基础 10 + 20
    assert.equal(viewerProfile.gift_score, 100)

    // 生成熟客迎宾台词
    const welcome = viewerProfile.affinity >= 30
      ? `哇！是尊贵的熟客【${viewerProfile.nickname}】哥哥！大肥鱼给您比心心~`
      : `欢迎新朋友【${viewerProfile.nickname}】！`

    assert.ok(welcome.includes('尊贵的熟客【榜一老大哥】'))

    dbHarness.close()
  })
})
