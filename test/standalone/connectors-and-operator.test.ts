import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OkxDogConnector,
  formatOkxDogSnapshot,
  DockerConnector,
  formatDockerContainers,
  resolveQueryTopic,
  isRiskyTask,
} from '../../src/standalone/brain/connectors.ts'
import {
  buildOperatorArgs,
} from '../../src/standalone/brain/task-executor.ts'
import {
  parseStreamingMeta,
  normalizeReplyIntent,
} from '../../src/standalone/brain/streaming.ts'

test('OkxDogConnector 只读白名单限制与数据拉取', async () => {
  const calls: string[] = []
  const mockFetch = async (url: string) => {
    calls.push(url)
    if (url.includes('/positions')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: [
            { inst_id: 'BTC-USDT-SWAP', pos_side: 'net', pos: '0.5', upl: '120.5', upl_ratio: '0.05', lever: '10' },
          ],
        }),
      }
    }
    if (url.includes('/balance')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            total_equity_usdt: 10500,
            available_balance_usdt: 9500,
            unrealized_pnl_usdt: 120.5,
            today_pnl_usdt: 250,
            today_pnl_ratio: 0.025,
            is_live_mode: false,
          },
        }),
      }
    }
    if (url.includes('/auto-pilot')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            is_running: true,
            running_seconds: 7200,
            total_pnl_usdt: 500,
            total_pnl_ratio: 0.05,
            total_trades_count: 10,
            win_rate: 0.7,
            max_drawdown_pct: 1.2,
          },
        }),
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: {} }),
    }
  }

  const connector = new OkxDogConnector({
    baseUrl: 'http://127.0.0.1:8000',
    fetchImpl: mockFetch as any,
  })

  // 1. 验证拒绝非白名单接口
  await assert.rejects(
    async () => {
      await connector.read('close_position' as any)
    },
    /不在只读白名单内/
  )

  // 2. 验证 snapshot 数据聚合与格式化
  const snap = await connector.snapshot()
  assert.equal(snap.reachable, true)
  assert.equal(snap.isLiveMode, false)
  assert.equal(snap.positions?.length, 1)

  const text = formatOkxDogSnapshot(snap)
  assert.match(text, /模拟盘/)
  assert.match(text, /总权益 10500 U/)
  assert.match(text, /BTC-USDT-SWAP/)
  assert.match(text, /自动操盘：运行中 2.0h/)
})

test('DockerConnector 解析与格式化', async () => {
  const mockExec = async (cmd: string, args: string[]) => {
    if (args[0] === 'ps') {
      return 'okx-dog-backend\tokx-dog-backend\tUp 2 hours\t0.0.0.0:8000->8000/tcp\nokx-dog-frontend\tokx-dog-frontend\tUp 2 hours\t0.0.0.0:3000->80/tcp\n'
    }
    if (args[0] === 'stats') {
      return 'okx-dog-backend\t0.5%\t120MiB / 16GiB\n'
    }
    return ''
  }

  const docker = new DockerConnector({ execFileImpl: mockExec as any })
  const containers = await docker.listContainers()
  assert.equal(containers.length, 2)
  assert.equal(containers[0].name, 'okx-dog-backend')
  assert.equal(containers[0].cpu, '0.5%')

  const formatted = formatDockerContainers(containers, 'okx')
  assert.match(formatted, /在跑 2 个容器/)
  assert.match(formatted, /okx-dog-backend/)
})

test('resolveQueryTopic 与 isRiskyTask 意图判别', () => {
  // okx 关键词覆盖
  assert.equal(resolveQueryTopic(undefined, '现在okx持仓怎么样了'), 'okx')
  assert.equal(resolveQueryTopic(undefined, '量化机器人今天盈亏多少'), 'okx')
  assert.equal(resolveQueryTopic('chat', '狗狗项目赚了吗'), 'okx')

  // docker 关键词覆盖
  assert.equal(resolveQueryTopic(undefined, '看一下docker跑着哪些项目'), 'docker')
  assert.equal(resolveQueryTopic('other', '查看当前运行的容器'), 'docker')

  // 高危任务判别
  assert.equal(isRiskyTask('帮我把桌面没用的删掉'), true)
  assert.equal(isRiskyTask('sudo rm -rf /tmp/a'), true)
  assert.equal(isRiskyTask('帮我平掉BTC的仓位'), true)
  assert.equal(isRiskyTask('docker compose down'), true)

  // 普通任务放行
  assert.equal(isRiskyTask('把下载目录里的pdf整理到一个文件夹里'), false)
  assert.equal(isRiskyTask('帮我看看代码哪里有bug'), false)
})

test('buildOperatorArgs 满足无 sandbox 且带 --dangerously-skip-permissions 需求', () => {
  const args = buildOperatorArgs('整理下载目录', 'dafeiyu-operator', {
    sandbox: false,
    skipPermissions: true,
    timeoutSec: 300,
    model: 'gemini-3.8-flash-medium',
  })

  // 1. 确认无 --sandbox
  assert.equal(args.includes('--sandbox'), false, '任务/查询模式应当去掉 --sandbox')
  // 2. 确认有免确认权限
  assert.equal(args.includes('--dangerously-skip-permissions'), true)
  // 3. 确认超时参数
  assert.equal(args.includes('300s'), true)
  // 4. 确认模型
  assert.equal(args.includes('gemini-3.8-flash-medium'), true)
})

test('parseStreamingMeta 解析新扩充的 intent/topic/task 意图元数据', () => {
  const metaLine = '<meta clip="working_command" tone="happy" moodIntent="1" fed="false" intent="query" topic="okx" task="查询当前持仓"/>等本鱼看看~'
  const meta = parseStreamingMeta(metaLine)
  assert.ok(meta)
  assert.equal(meta.intent, 'query')
  assert.equal(meta.topic, 'okx')
  assert.equal(meta.task, '查询当前持仓')

  const norm = normalizeReplyIntent({ intent: 'invalid' })
  assert.equal(norm.intent, 'chat')
})
