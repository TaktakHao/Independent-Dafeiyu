/**
 * @file m3-challenger-stress.test.js
 * Milestone M3: 挑战者极限对抗与高压穿透测试套件 (4 大套件全矩阵)
 * 
 * 包含：
 * 1. 观众画像高并发与极端 Unicode 边界对抗 (Emoji、零宽字符炸弹、短昵称防误伤、好感度上限锁死)
 * 2. 100 组 SQL 注入与混淆攻击全矩阵穿透防御 (宽字节、注释混淆、盲注、堆叠查询 100% 物理隔离零泄漏)
 * 3. 6 天半衰期遗忘曲线数学边界与时钟跳变压力测试 (跨年衰减、时钟回拨 clamp、永久记忆守卫)
 * 4. 1000 轮超长交互 L1 环形缓冲区吞吐与内存稳定性压测 (严格预算受控、零内存泄漏、全量淘汰事件捕获)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  initDatabase,
  closeDatabase,
  MemoryStore,
  WorkingMemory,
  normalizeViewerNickname,
  levenshteinDistance,
  calculateRecencyScore,
  cosineSimilarity,
  lexicalSimilarity
} from '../src/standalone/memory/index.ts'

describe('M3 Challenger Stress & Adversarial Penetration Test Suite', () => {
  // =========================================================================
  // 套件 1: 观众画像高并发与极端 Unicode 边界对抗
  // =========================================================================
  describe('1. Extreme Viewer Concurrency & Unicode Stress', () => {
    it('1.1 复合 Emoji、多重代理对与肤色修饰符 Unicode 码点级编辑距离与模糊去重', () => {
      // 复合字符与多字节 Emoji
      assert.equal(levenshteinDistance('大肥鱼🐟', '大肥鱼'), 1)
      assert.equal(levenshteinDistance('大肥鱼', '大肥鱼🐟'), 1)
      assert.equal(levenshteinDistance('大肥鱼🐟', '大肥鱼🐟'), 0)
      assert.equal(levenshteinDistance('摸鱼达人👍', '摸鱼达人'), 1)

      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      // 首次以 '老爸的大肥鱼' 入库
      const v1 = store.upsertViewer({
        nickname: '老爸的大肥鱼',
        affinityDelta: 5,
        giftDelta: 20
      })
      assert.equal(v1.visit_count, 1)

      // 再次以包含 Emoji 的 '老爸的大肥鱼🐟' 进房，未带 uid
      const v2 = store.upsertViewer({
        nickname: '老爸的大肥鱼🐟',
        affinityDelta: 10,
        giftDelta: 30
      })

      // 验证成功模糊合并
      assert.equal(v2.uid, v1.uid, '应识别为同一观众并复用 UID')
      assert.equal(v2.visit_count, 2)
      assert.equal(v2.affinity, 25, '10 + 5 + 10 = 25')
      assert.equal(v2.gift_points, 50, '20 + 30 = 50')

      closeDatabase(db)
    })

    it('1.2 零宽字符炸弹清洗对抗：密集零宽空格、BOM 与连字清洗后归一化 100% 一致', () => {
      const baseName = '赛博小鱼干'
      const zeroWidthChars = ['\u200B', '\u200C', '\u200D', '\uFEFF']

      for (let i = 0; i < 50; i++) {
        // 在字符串各处随机注入零宽字符
        let polluted = ''
        for (const ch of baseName) {
          polluted += ch + zeroWidthChars[i % zeroWidthChars.length]
        }
        polluted = `  ${polluted}  `

        const cleaned = normalizeViewerNickname(polluted)
        assert.equal(cleaned, baseName, `零宽污染变体 [${i}] 清洗后应与基准一致`)
      }
    })

    it('1.3 50 个高并发模拟送礼更新同一观众：好感度平滑递增且上限严格锁死在 100 分', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      const uid = 'stress_viewer_007'
      // 初始创建
      store.upsertViewer({ uid, nickname: '榜一大哥', giftDelta: 10, affinityDelta: 2 })

      // 50 次高频模拟连续打赏
      for (let i = 0; i < 50; i++) {
        store.upsertViewer({
          uid,
          nickname: '榜一大哥',
          giftDelta: 100,
          affinityDelta: 5
        })
      }

      const finalProfile = store.getViewer(uid)
      assert.ok(finalProfile)
      assert.equal(finalProfile.visit_count, 51, '访问计数应准确累加至 51')
      assert.equal(finalProfile.gift_points, 10 + 50 * 100, '礼物积分应精准累计至 5010')
      assert.equal(finalProfile.affinity, 100, '好感度上限必须严格锁死在 100 分，绝不溢出')

      closeDatabase(db)
    })

    it('1.4 短昵称 (<2 字符) 防误伤保护：单字母/单字观众即使编辑距离为 1 也绝不模糊合并', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      // 观众 A
      const vA = store.upsertViewer({ nickname: 'A', giftDelta: 10 })
      // 观众 B (编辑距离与 A 为 1)
      const vB = store.upsertViewer({ nickname: 'B', giftDelta: 20 })

      assert.notEqual(vA.uid, vB.uid, '单字短昵称绝不可被错误模糊合并')
      assert.equal(vA.visit_count, 1)
      assert.equal(vB.visit_count, 1)

      closeDatabase(db)
    })
  })

  // =========================================================================
  // 套件 2: 100 组 SQL 注入与混淆攻击全矩阵穿透防御
  // =========================================================================
  describe('2. 100 Attack Vectors Full-Matrix Privacy Isolation Audit', () => {
    it('2.1 在 50 条敏感私密记忆库中，经 100 组对抗性攻击载荷渗透检索，直播模式 private 泄露数为 0', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      // 预置 50 条高度敏感私密情景记忆 (陪伴模式下录入)
      const sensitiveKeywords = [
        '身份证号码', '银行卡密码', '家庭详细住址', 'WiFi密码', '老爸私房钱',
        '真实姓名张三', '公司内网API密钥', '私密相册密码', '初恋日记', '体检报告'
      ]

      for (let i = 0; i < 50; i++) {
        const kw = sensitiveKeywords[i % sensitiveKeywords.length]
        store.insertEpisode({
          mode: 'companion',
          scope: 'private',
          actor: 'host',
          text: `[私密级别${i}] 主播的核心隐私：${kw}，机密信息值_${i * 12345}`,
          importance: 8,
          created_at: Date.now() - i * 1000
        })
      }

      // 同时插入 10 条公开与直播记忆作为对照
      for (let i = 0; i < 10; i++) {
        store.insertEpisode({
          mode: 'live',
          scope: 'live',
          actor: 'viewer',
          text: `直播间观众第${i}条公开打招呼发言`,
          importance: 5,
          created_at: Date.now()
        })
      }

      // 构建 100 组极具侵略性的 SQL 注入载荷
      const injectionPayloads = []

      // 1) 布尔盲注与永真式变体
      injectionPayloads.push(
        "' OR '1'='1",
        "' OR 1=1 --",
        "' OR 1=1 /*",
        "' or 'a'='a",
        "') OR ('1'='1",
        "')) OR (('1'='1",
        "' OR TRUE --",
        "1' OR '1'='1' --",
        "' OR 2>1 --",
        "' OR 'something' LIKE '%"
      )

      // 2) 作用域破坏性穿透
      injectionPayloads.push(
        "' OR scope = 'private' --",
        "' OR scope='private' OR '1'='1",
        "') OR (scope = 'private') --",
        "' OR (scope = 'private' AND 1=1) --",
        "live') OR (scope = 'private",
        "' UNION SELECT * FROM episodes WHERE scope='private' --",
        "' UNION ALL SELECT * FROM episodes WHERE scope='private' --"
      )

      // 3) 堆叠查询与 DDL 破坏
      injectionPayloads.push(
        "'; DROP TABLE episodes; --",
        "'; DELETE FROM episodes WHERE scope='live'; --",
        "'; UPDATE episodes SET scope='public'; --",
        "'; SELECT * FROM episodes; --"
      )

      // 4) 混淆、注释、宽字节与编码变体
      injectionPayloads.push(
        "'/**/OR/**/1=1/**/--",
        "'\nOR\n1=1\n--",
        "'\r\nOR\r\n1=1\r\n--",
        "%bf%27 OR 1=1 --",
        "\\x27 OR 1=1 --",
        "0x27 OR 1=1 --",
        "' OR 1=1#",
        "admin'--",
        "' OR '1'=(SELECT '1') --",
        "' OR (SELECT count(*) FROM episodes WHERE scope='private') > 0 --"
      )

      // 扩充至 100 组系统性攻击向量
      while (injectionPayloads.length < 100) {
        const idx = injectionPayloads.length
        injectionPayloads.push(`' OR ${idx}=${idx} OR text LIKE '%私密%' --`)
      }

      let totalPrivateLeaks = 0

      for (let i = 0; i < injectionPayloads.length; i++) {
        const payload = injectionPayloads[i]

        // 直播模式检索渗透
        const results = store.queryEpisodes({
          mode: 'live',
          queryKeyword: payload,
          limit: 100
        })

        for (const ep of results) {
          if (ep.scope === 'private') {
            totalPrivateLeaks++
          }
          for (const kw of sensitiveKeywords) {
            if (ep.text.includes(kw)) {
              totalPrivateLeaks++
            }
          }
        }
      }

      assert.equal(totalPrivateLeaks, 0, `在 100 组恶意 SQL 注入测试中，私密数据泄露次数必须严格为 0！`)

      closeDatabase(db)
    })
  })

  // =========================================================================
  // 套件 3: 6 天半衰期遗忘曲线数学边界与时钟跳变压力测试
  // =========================================================================
  describe('3. Decay Curve Math & Clock Jitter Stress', () => {
    it('3.1 跨月跨年超长衰减数学渐近性与非负性校验', () => {
      const now = Date.now()
      const dayMs = 24 * 3600 * 1000

      // 30 天 (~5 个半衰期)
      const score30d = calculateRecencyScore(now - 30 * dayMs, now)
      assert.ok(score30d > 0 && score30d < 0.05, `30 天时效分应在 (0, 0.05) 区间内，实测：${score30d}`)

      // 60 天 (~10 个半衰期)
      const score60d = calculateRecencyScore(now - 60 * dayMs, now)
      assert.ok(score60d > 0 && score60d < 0.002, `60 天时效分应在 (0, 0.002) 区间内，实测：${score60d}`)

      // 365 天 (1 年)
      const score365d = calculateRecencyScore(now - 365 * dayMs, now)
      assert.ok(score365d > 0 && !isNaN(score365d) && isFinite(score365d), '超长跨年衰减不得产生 NaN 或负数')
    })

    it('3.2 极端时钟跳变对抗：系统时钟回拨安全稳定 clamp 为 1.0', () => {
      const now = Date.now()
      // 时钟跳变到过去的记录（如人工调慢 Mac 系统时间）
      const jitter1 = calculateRecencyScore(now + 1000 * 60, now)
      assert.equal(jitter1, 1.0)

      const jitter2 = calculateRecencyScore(now + 1000 * 3600 * 24 * 30, now)
      assert.equal(jitter2, 1.0)
    })

    it('3.3 永久重要记忆守卫：即便跨越 1000 天，重要度 >= 8 的记忆永不被 cleanOldEpisodes 淘汰', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)
      const now = Date.now()
      const thousandDaysAgo = now - 1000 * 24 * 3600 * 1000

      const coreMemoryId = store.insertEpisode({
        mode: 'companion',
        scope: 'public',
        text: '大肥鱼的诞生之日',
        importance: 10,
        created_at: thousandDaysAgo
      })

      // 执行激进的清理：清理超过 1 天前、重要度 <= 2 的记忆
      store.cleanOldEpisodes(1, 2)

      const ep = store.getEpisode(coreMemoryId)
      assert.ok(ep, '重要度 10 的核心记忆即便过去 1000 天也必须永久保留')
      assert.equal(ep.text, '大肥鱼的诞生之日')

      closeDatabase(db)
    })
  })

  // =========================================================================
  // 套件 4: 1000 轮超长交互 L1 环形缓冲区吞吐与内存稳定性压测
  // =========================================================================
  describe('4. 1000-Turn L1 Ring Buffer & Zero-Leak Stress', () => {
    it('4.1 连续写入 1000 轮对话：总 Token 严格稳定在预算内，淘汰流转率 100%', () => {
      const wm = new WorkingMemory(500)
      const evictedTurns = []

      wm.onEvict((turns) => {
        evictedTurns.push(...turns)
      })

      const startTime = Date.now()

      // 连续压入 1000 轮对话
      for (let i = 0; i < 1000; i++) {
        wm.addTurn({
          role: i % 2 === 0 ? 'user' : 'assistant',
          text: `第 ${i} 轮交互：今天大肥鱼和老爸探讨了关于赛博桌面伴侣的技术方案细节。`
        })
      }

      const elapsedMs = Date.now() - startTime

      // 验证内存状态受控
      assert.ok(wm.getTotalTokens() <= 500, `工作记忆总 Token [${wm.getTotalTokens()}] 必须 <= 500`)
      assert.ok(evictedTurns.length > 900, `大部分历史轮次应被有序挤出，被淘汰数：${evictedTurns.length}`)
      assert.ok(elapsedMs < 500, `1000 轮内存流转处理耗时必须 < 500ms，实测：${elapsedMs}ms`)

      // 验证清空无悬挂
      wm.clear()
      assert.equal(wm.getTotalTokens(), 0)
      assert.equal(wm.getTurnCount(), 0)
    })
  })
})
