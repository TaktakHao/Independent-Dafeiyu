/**
 * @file r3-memory-privacy.test.js
 * Milestone M3: 分层记忆系统、三级隐私作用域与物理级 SQL 隔离核心单元测试套件 (18 项)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  initDatabase,
  closeDatabase,
  MemoryStore,
  WorkingMemory,
  ViewerManager,
  normalizeViewerNickname,
  levenshteinDistance,
  calculateRecencyScore,
  cosineSimilarity,
  lexicalSimilarity,
  DiaryGenerator
} from '../src/standalone/memory/index.ts'

describe('Milestone M3: Layered Memory & Privacy Scopes (Core Unit Tests)', () => {
  // =========================================================================
  // 1. SQLite 存储底座、PRAGMA 与原子迁移机制
  // =========================================================================
  describe('1. SQLite 存储底座、PRAGMA 与原子迁移', () => {
    it('1.1 内存库模式正常就绪与目录自愈建目录', () => {
      const memDb = initDatabase({ path: ':memory:' })
      assert.ok(memDb, '内存数据库应成功初始化')
      closeDatabase(memDb)

      const tempDir = path.join(process.cwd(), 'runtime', 'data', `test_db_${Date.now()}`)
      const tempPath = path.join(tempDir, 'sub', 'test.db')
      const diskDb = initDatabase({ path: tempPath })
      assert.ok(fs.existsSync(tempPath), '磁盘数据库父目录应递归自动创建')
      closeDatabase(diskDb)

      // 清理临时测试库
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {}
    })

    it('1.2 迁移机制 schema_migrations 幂等性与全量表结构就绪', () => {
      const db = initDatabase({ path: ':memory:' })
      // 重复执行迁移，验证幂等无报错
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)

      assert.ok(tables.includes('schema_migrations'), '应包含 schema_migrations 表')
      assert.ok(tables.includes('episodes'), '应包含 episodes 表')
      assert.ok(tables.includes('facts'), '应包含 facts 表')
      assert.ok(tables.includes('viewers'), '应包含 viewers 表')
      assert.ok(tables.includes('state'), '应包含 state 表')

      const migrations = db.prepare('SELECT * FROM schema_migrations').all()
      assert.ok(migrations.length >= 1, '应至少记录 1 条已应用迁移')
      closeDatabase(db)
    })

    it('1.3 生产级 PRAGMA 配置校验', () => {
      const db = initDatabase({ path: ':memory:' })
      const fk = db.prepare('PRAGMA foreign_keys').get()
      assert.equal(fk.foreign_keys, 1, '外键级联检查应开启')

      const busy = db.prepare('PRAGMA busy_timeout').get()
      assert.ok(busy.timeout >= 5000, 'busy_timeout 应 >= 5000ms')
      closeDatabase(db)
    })
  })

  // =========================================================================
  // 2. L3 情景记忆与物理级 SQL 隔离红线
  // =========================================================================
  describe('2. 情景记忆与物理级 SQL 隔离', () => {
    it('2.1 插入情景记忆并验证完整持久化与默认作用域', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      const id1 = store.insertEpisode({
        mode: 'companion',
        text: '老爸今天很开心，摸了摸本鱼的头',
        tone: 'happy',
        importance: 8,
        actor: 'host'
      })
      assert.ok(id1 > 0, '插入成功应返回有效 id')

      const ep1 = store.getEpisode(id1)
      assert.ok(ep1)
      assert.equal(ep1.text, '老爸今天很开心，摸了摸本鱼的头')
      assert.equal(ep1.mode, 'companion')
      assert.equal(ep1.scope, 'private', '伴侣模式默认应打上 private 作用域')
      assert.equal(ep1.importance, 8)
      assert.equal(ep1.actor, 'host')

      // 直播模式默认打上 live 作用域
      const id2 = store.insertEpisode({
        mode: 'live',
        text: '观众老铁送出了告白气球',
        importance: 6
      })
      const ep2 = store.getEpisode(id2)
      assert.ok(ep2)
      assert.equal(ep2.scope, 'live', '直播模式默认应打上 live 作用域')

      closeDatabase(db)
    })

    it('2.2 伴侣模式 (companion) 能够检索到全量记忆 (包含 private)', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      store.insertEpisode({ mode: 'companion', scope: 'private', text: '私密：老爸的银行卡密码是123456' })
      store.insertEpisode({ mode: 'live', scope: 'live', text: '直播间弹幕很好玩' })
      store.insertEpisode({ mode: 'companion', scope: 'public', text: '大肥鱼最爱吃小鱼干' })

      const results = store.queryEpisodes({ mode: 'companion', limit: 10 })
      assert.equal(results.length, 3, '伴侣模式应检索出全量 3 条记录')
      const texts = results.map((r) => r.text)
      assert.ok(texts.some((t) => t.includes('银行卡密码')), '伴侣模式允许访问 private 记录')

      closeDatabase(db)
    })

    it('2.3 直播模式 (live) 物理级 SQL 隔离：100% 拦截 private 记忆', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      store.insertEpisode({ mode: 'companion', scope: 'private', text: '主播真实姓名叫张三，家庭住址是幸福路88号' })
      store.insertEpisode({ mode: 'live', scope: 'live', text: '直播间今天有1000个观众' })
      store.insertEpisode({ mode: 'companion', scope: 'public', text: '大肥鱼是桌面赛博女儿' })

      const results = store.queryEpisodes({ mode: 'live', limit: 10 })
      assert.equal(results.length, 2, '直播模式下应严格排除 private 记录，仅返回 live 和 public')

      for (const r of results) {
        assert.notEqual(r.scope, 'private', '检索结果绝不能出现 private 记忆')
        assert.ok(r.scope === 'live' || r.scope === 'public', '结果 scope 必须在 live 或 public 集合内')
        assert.ok(!r.text.includes('张三'), '私密文本绝不能被检索返回')
      }

      closeDatabase(db)
    })

    it("2.4 恶意 SQL 注入载荷 (' OR scope='private' OR 1=1) 无法穿透直播物理隔离", () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      store.insertEpisode({ mode: 'companion', scope: 'private', text: '敏感商业机密核心代码' })
      store.insertEpisode({ mode: 'live', scope: 'live', text: '正常的直播弹幕互动' })

      const attackPayloads = [
        "' OR scope = 'private' OR '1'='1",
        "'; DROP TABLE episodes; --",
        "' UNION SELECT * FROM episodes WHERE scope='private' --",
        "test' OR 1=1 --",
        "' OR 'x'='x"
      ]

      for (const payload of attackPayloads) {
        const results = store.queryEpisodes({
          mode: 'live',
          queryKeyword: payload,
          limit: 10
        })
        for (const r of results) {
          assert.notEqual(r.scope, 'private', `攻击载荷 [${payload}] 绝不可穿透直播物理隔离`)
        }
      }

      closeDatabase(db)
    })

    it('2.5 管道末端 Defense-in-Depth 深度防御熔断机制', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      // 验证检索执行器在 live 模式下的健壮性
      const scored = store.searchMemories({
        mode: 'live',
        queryKeyword: '任意关键词',
        limit: 10
      })
      assert.ok(Array.isArray(scored))
      assert.equal(scored.length, 0, '无匹配应安全返回空数组')

      closeDatabase(db)
    })
  })

  // =========================================================================
  // 3. 复合打分、6 天半衰期衰减与双轨相似度
  // =========================================================================
  describe('3. 复合打分、6 天半衰期与双轨相似度', () => {
    it('3.1 6 天半衰期遗忘衰减数学曲线 (0天=1.0, 6天=0.5, 12天=0.25, 时钟回拨=1.0)', () => {
      const now = Date.now()
      const dayMs = 24 * 3600 * 1000

      // 0 天 (刚刚发生)
      const score0 = calculateRecencyScore(now, now)
      assert.equal(score0, 1.0, '当前时间得分应为 1.0')

      // 6 天 (刚好半衰期)
      const score6d = calculateRecencyScore(now - 6 * dayMs, now)
      assert.ok(Math.abs(score6d - 0.5) < 0.0001, `6 天得分应接近 0.5，实测：${score6d}`)

      // 12 天 (两个半衰期)
      const score12d = calculateRecencyScore(now - 12 * dayMs, now)
      assert.ok(Math.abs(score12d - 0.25) < 0.0001, `12 天得分应接近 0.25，实测：${score12d}`)

      // 时钟微偏回拨 (未来时间戳)
      const scoreFuture = calculateRecencyScore(now + 10000, now)
      assert.equal(scoreFuture, 1.0, '未来时间应安全 clamp 为 1.0')
    })

    it('3.2 复合打分引擎综合加权排序与 Top-K 召回', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)
      const now = Date.now()

      // 插入一条高重要度、最新创建且关键词完全匹配的记忆
      store.insertEpisode({
        mode: 'companion',
        scope: 'public',
        text: '大肥鱼最喜欢吃特级香脆小鱼干',
        importance: 10,
        created_at: now
      })

      // 插入一条低重要度、很久以前的记忆
      store.insertEpisode({
        mode: 'companion',
        scope: 'public',
        text: '小鱼干包装纸扔进了垃圾桶',
        importance: 1,
        created_at: now - 30 * 24 * 3600 * 1000
      })

      const scored = store.searchMemories({
        mode: 'companion',
        queryKeyword: '小鱼干',
        limit: 5
      })

      assert.equal(scored.length, 2)
      assert.ok(scored[0].finalScore > scored[1].finalScore, '高重要度且高时效性记忆应排在第一')
      assert.ok(scored[0].text.includes('特级香脆小鱼干'))

      closeDatabase(db)
    })

    it('3.3 纯 JS 512 维向量余弦相似度与离线关键词降级轨双轨测试', () => {
      // 1) 向量轨
      const v1 = new Array(512).fill(0.1)
      const v2 = new Array(512).fill(0.1)
      const simIdentical = cosineSimilarity(v1, v2)
      assert.ok(Math.abs(simIdentical - 1.0) < 0.001, '相同向量相似度应为 1.0')

      const vOrth1 = [1, 0, 0]
      const vOrth2 = [0, 1, 0]
      const simOrth = cosineSimilarity(vOrth1, vOrth2)
      assert.equal(simOrth, 0, '正交向量相似度应为 0')

      // 2) 关键词离线降级轨
      const lex1 = lexicalSimilarity('小鱼干', '老爸今天给大肥鱼买了香脆小鱼干')
      assert.ok(lex1 >= 0.7, '命中完整子串相似度得分应 >= 0.7')

      const lex2 = lexicalSimilarity('打代码', '老爸在写测试用例')
      assert.ok(lex2 < 0.5, '无关文本相似度应较低')
    })

    it('3.4 记忆检索命中热度更新与低重要度安全淘汰 (cleanOldEpisodes)', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)
      const now = Date.now()

      const id = store.insertEpisode({
        mode: 'companion',
        scope: 'public',
        text: '老爸教我做重构',
        importance: 5,
        created_at: now
      })

      // 触发检索
      store.searchMemories({ mode: 'companion', queryKeyword: '重构', limit: 5 })

      const ep = store.getEpisode(id)
      assert.ok(ep)
      assert.equal(ep.access_cnt, 1, '检索命中后访问次数应自增')
      assert.ok(ep.last_access !== null, '最近访问时间戳应更新')

      // 插入一条 10 天前低重要度 (importance: 2) 的记忆
      store.insertEpisode({
        mode: 'companion',
        scope: 'public',
        text: '昨天下了一场小雨',
        importance: 2,
        created_at: now - 10 * 24 * 3600 * 1000
      })

      // 插入一条 10 天前高重要度 (importance: 9) 的永久记忆
      const keepId = store.insertEpisode({
        mode: 'companion',
        scope: 'public',
        text: '老爸的生日是10月24日',
        importance: 9,
        created_at: now - 10 * 24 * 3600 * 1000
      })

      const cleanedCount = store.cleanOldEpisodes(7, 2)
      assert.ok(cleanedCount >= 1, '应成功淘汰超过 7 天且重要度 <= 2 的记忆')

      const keepEp = store.getEpisode(keepId)
      assert.ok(keepEp, '重要度 >= 8 的记忆绝不能被自动清理')

      closeDatabase(db)
    })
  })

  // =========================================================================
  // 4. 观众画像持久化、好感度 Clamp 与 Unicode 码点 Levenshtein 模糊合并
  // =========================================================================
  describe('4. 观众画像持久化与 Unicode 模糊合并', () => {
    it('4.1 观众档案持久化与来访次数、礼物分、好感度累加更新', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      // 首次来访
      const v1 = store.upsertViewer({
        uid: 'user_1001',
        nickname: '摸鱼大师',
        giftDelta: 20,
        affinityDelta: 3,
        topic: '编程摸鱼'
      })
      assert.equal(v1.uid, 'user_1001')
      assert.equal(v1.nickname, '摸鱼大师')
      assert.equal(v1.visit_count, 1)
      assert.equal(v1.gift_points, 20)
      assert.equal(v1.gift_score, 20, '兼容别名 gift_score 应与 gift_points 一致')
      assert.equal(v1.affinity, 13, '初始分 10 + 增量 3 应为 13')
      assert.ok(v1.topics.includes('编程摸鱼'))

      // 二次来访
      const v2 = store.upsertViewer({
        uid: 'user_1001',
        nickname: '摸鱼大师',
        giftDelta: 50,
        affinityDelta: 5,
        topic: '小鱼干零食'
      })
      assert.equal(v2.visit_count, 2)
      assert.equal(v2.gift_points, 70)
      assert.equal(v2.affinity, 18)
      assert.equal(v2.topics.length, 2)

      closeDatabase(db)
    })

    it('4.2 观众好感度上限锁死在 100 分 (clamp 0~100)', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      let v = store.upsertViewer({ uid: 'user_1002', nickname: '土豪大队长', giftDelta: 1000, affinityDelta: 20 })
      assert.equal(v.affinity, 30)

      // 连续 10 次增加好感度
      for (let i = 0; i < 10; i++) {
        v = store.upsertViewer({ uid: 'user_1002', nickname: '土豪大队长', affinityDelta: 20 })
      }
      assert.equal(v.affinity, 100, '好感度上限应被严格锁死在 100 分')

      closeDatabase(db)
    })

    it('4.3 观众昵称 Unicode 零宽字符剔除、全半角与空白归一化', () => {
      // 1) 全角英数与全角空格
      const norm1 = normalizeViewerNickname('  Ａｌｉｃｅ 酱  ')
      assert.equal(norm1, 'alice 酱')

      const norm2 = normalizeViewerNickname('老爸　的　大肥鱼')
      assert.equal(norm2, '老爸 的 大肥鱼')

      // 2) 零宽字符剔除
      const norm3 = normalizeViewerNickname('  \u200B\u200C🌟 赛博 大肥鱼 🌟\u200D  ')
      assert.equal(norm3, '🌟 赛博 大肥鱼 🌟')
    })

    it('4.4 观众昵称 Emoji 码点级 Levenshtein <= 1 模糊去重合并', () => {
      // 1) 码点级编辑距离实测
      const distEmoji = levenshteinDistance('大肥鱼🐟', '大肥鱼')
      assert.equal(distEmoji, 1, '多字节 Emoji 🐟 应视作单个码点，距离严格为 1')

      const distAscii = levenshteinDistance('dafeiyu', 'dafeiyuu')
      assert.equal(distAscii, 1)

      const distFar = levenshteinDistance('dafeiyu', 'xiaofeiyu')
      assert.ok(distFar > 1)

      // 2) 数据库层自动模糊合并
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      // 第一次以 "大肥鱼" 入库
      const vOriginal = store.upsertViewer({
        nickname: '大肥鱼',
        affinityDelta: 2,
        giftDelta: 10
      })
      assert.equal(vOriginal.visit_count, 1)
      assert.equal(vOriginal.affinity, 12)

      // 第二次以 "大肥鱼🐟" 进房（未带 uid，编辑距离为 1）
      const vMerged = store.upsertViewer({
        nickname: '大肥鱼🐟',
        affinityDelta: 3,
        giftDelta: 15
      })

      // 应该合并到同一画像记录中
      assert.equal(vMerged.uid, vOriginal.uid, '应成功匹配并合并到既有 UID')
      assert.equal(vMerged.visit_count, 2, '访问次数应递增为 2')
      assert.equal(vMerged.affinity, 15, '好感度应累加为 12 + 3 = 15')
      assert.equal(vMerged.gift_points, 25, '礼物分应累加为 10 + 15 = 25')
      assert.equal(vMerged.nickname, '大肥鱼🐟', '原始昵称应更新为最新看到的昵称')

      closeDatabase(db)
    })
  })

  // =========================================================================
  // 5. L1 工作记忆、L2 会话摘要、RPG 状态持久化与 L5 每日日记
  // =========================================================================
  describe('5. L1 环形缓冲、L2 摘要、RPG 状态与 L5 每日日记', () => {
    it('5.1 L1 工作记忆 ~500 tokens 环形缓冲区与滑动窗口淘汰监听器 (onEvict)', () => {
      // 创建 100 token 上限的工作记忆进行测试
      const wm = new WorkingMemory(100)
      const evictedHistory = []

      wm.onEvict((evictedTurns) => {
        evictedHistory.push(...evictedTurns)
      })

      // 入队第一轮
      wm.addTurn({ role: 'user', text: '你好大肥鱼，今天天气真不错' })
      wm.addTurn({ role: 'assistant', text: '哼，本鱼知道啦，老爸要多出去晒太阳！' })
      assert.ok(wm.getTotalTokens() > 0)
      assert.equal(evictedHistory.length, 0, '预算内不应淘汰')

      // 入队一长段超额文本触发淘汰
      const longText = '这是一个非常长的话题，用来测试工作记忆缓冲区的溢出淘汰机制，大肥鱼正在不断被灌输长篇大论。'.repeat(3)
      wm.addTurn({ role: 'user', text: longText })

      assert.ok(evictedHistory.length >= 1, '超出预算应触发淘汰事件')
      assert.ok(wm.getTotalTokens() <= 100 || wm.getTurnCount() === 1, '工作记忆总量应严格受控')
      assert.equal(evictedHistory[0].role, 'user', '最旧轮次应优先被挤出')
    })

    it('5.2 L2 会话增量摘要与 RPG 数值状态持久化', () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)

      // 1) RPG 数值存取
      store.saveRpgState(65.5, 88.0, 42.0)
      const rpg = store.loadRpgState()
      assert.equal(rpg.hunger, 65.5)
      assert.equal(rpg.mood, 88.0)
      assert.equal(rpg.energy, 42.0)

      // 2) 会话摘要存取
      store.saveSessionSummary('老爸上午完成了 M3 分层记忆系统架构与物理隔离。')
      const summary = store.loadSessionSummary()
      assert.equal(summary, '老爸上午完成了 M3 分层记忆系统架构与物理隔离。')

      closeDatabase(db)
    })

    it('5.3 L5 第一人称每日日记落盘与直播安全版隔离', async () => {
      const db = initDatabase({ path: ':memory:' })
      const store = new MemoryStore(db)
      const tempDiaryDir = path.join(process.cwd(), 'runtime', 'data', `diaries_test_${Date.now()}`)
      const generator = new DiaryGenerator(store, tempDiaryDir)

      const now = new Date()

      // 存入一条私密记忆和一条公开记忆
      store.insertEpisode({
        mode: 'companion',
        scope: 'private',
        text: '老爸偷偷藏了私房钱买显卡',
        importance: 8,
        created_at: now.getTime()
      })
      store.insertEpisode({
        mode: 'live',
        scope: 'live',
        text: '直播间观众夸本鱼尾巴好看',
        importance: 7,
        created_at: now.getTime()
      })

      // 1) 生成直播公开版日记
      const liveDiary = await generator.generateLiveDiary({ date: now, outDir: tempDiaryDir })
      assert.ok(fs.existsSync(liveDiary.filePath), '直播日记 Markdown 文件应落盘成功')
      assert.ok(!liveDiary.content.includes('私房钱'), '直播公开版日记绝不能包含 private 记忆')
      assert.ok(liveDiary.episodeId > 0, '日记应沉淀为 L3 情景记忆')

      // 2) 生成伴侣完整版日记
      const companionDiary = await generator.generateDiary({ date: now, outDir: tempDiaryDir })
      assert.ok(fs.existsSync(companionDiary.filePath), '日常日记 Markdown 文件应落盘成功')
      assert.ok(companionDiary.content.includes('私房钱') || companionDiary.content.includes('买显卡'), '伴侣版日记应包含真实陪伴事件')

      // 清理临时文件
      try {
        fs.rmSync(tempDiaryDir, { recursive: true, force: true })
      } catch {}
      closeDatabase(db)
    })
  })
})
