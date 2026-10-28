<div align="center">

# DSH 大肥鱼 🐋 (CyberFish Daughter 独立伴侣与直播版)

**在桌面上陪你工作、思考与抖音直播的拟人化赛博女儿伴侣。**

[English](README_EN.md) · [npm](https://www.npmjs.com/package/dsh-dafeiyu) · [更新日志](CHANGELOG.md)

</div>

> 🚀 **v2.0 独立桌面伴侣与抖音直播版全新升级**：
> 已彻底剥离 DSH / Cordis 宿主依赖！支持独立常驻桌面，具备 **4 级阶梯大脑（Agent CLI 优先 / DeepSeek 流式 / 本地 LLM / 离线规则）**、**SQLite 5 级记忆与直播物理隐私隔离**、**三轴情绪状态机**、**屏幕弹幕 OCR 识别**与**本地主播控制台（http://127.0.0.1:7788）**。

---

## 快速启动 (独立桌面与直播伴侣)

### 1. 编译 macOS 原生端 Helper
```bash
# 编译 arm64 + x86_64 通用原生 AppKit 置顶窗口二进制
npm run build:native
```

### 2. 语音引擎就绪 (可选，高拟人少女音色)
```bash
# 安装微软云端 Edge-TTS (音色: zh-CN-XiaoyiNeural，幼态灵动女声)
pip3 install edge-tts
# (若未安装 edge-tts，系统将自动无缝降级使用 macOS 原生 say 离线引擎)
```

### 3. 一键快捷启动
```bash
# 日常桌面陪伴模式 (默认)
./scripts/launch.sh
# 或
npm start

# 抖音直播伴侣模式 (物理隐私隔离 + 弹幕驱动 + 控制台)
./scripts/launch.sh --live
# 或
npm run start:live
```

### 4. 主播安全控制台
服务启动后，浏览器访问：
👉 **`http://127.0.0.1:7788`**
提供：
- 🚨 **一键紧急拉闸急停**：清空事件队列、中断正在播放的语音并切回默认待机动作
- 💬 **人工代她说**：主播输入指定台词与动作，即时打字机展示并语音播放
- 🍙 **在线投喂**：增加饱食度与心情值
- 📊 **实时生理指标**：心情、饱食、精力、当前思考引擎与活跃记忆条目监控
- 🧪 **测试弹幕与礼物注入**：联调测试全链路流式反应与 0-Token 模板应答

---

## 核心架构与特性 (v2.0)

1. **表现层 (Swift Helper Protocol v2)**：
   - 点名播放 16 组 WebP 动作序列，支持 `maxMs` 动态毫秒级截断与平滑淡出。
   - 自适应多行、大字号（≥16pt）打字机流式气泡渲染。
   - 基于 `AVFoundation` 的持久化音频播放队列，支持即时打断插播与 `audio_event` 回调。
   - 底部 RPG 状态栏实时显示饱食度（🍙）、心情值（❤️）与精力值（⚡）。
   - `NSWorkspace` 捕获活跃应用类别切换，无轮询感知写代码、浏览器与工作状态。

2. **多级思考大脑 (TieredBrainRouter)**：
   - **Tier 1 (首选)**：本地 Agent CLI 沙箱池（支持 `agy` 与 `cursor-agent`），安全子目录运行，带 `EXHAUSTED` 额度超限自愈。
   - **Tier 2**：DeepSeek API SSE 原生流式分词，前缀缓存优化与每日硬限额风控。
   - **Tier 3**：本地 Ollama / MLX HTTP 大模型离线服务。
   - **Tier 4**：离线 0ms 零死锁确定性规则语料兜底。
   - **流式驱动管道**：首行 `<meta clip="..." tone="...">` 即时触发动作，分句标点切词送入 TTS，首字发声延迟实测 **p50 = 694ms**。

3. **分层记忆系统与直播隐私隔离 (SQLite MemoryStore)**：
   - 基于 Node.js 原生 `node:sqlite`（零 C++ 原生编译依赖），具备 WAL 并发模式与自动迁移。
   - 贯通 L1 环形工作记忆、L2 增量滚动摘要、L3 情景事件、L4 语义事实库与 L5 睡前第一人称日记。
   - **直播模式物理级隔离硬红线**：底层 SQL 强制参数化注入 `WHERE (scope IN ('live', 'public'))`，私密记忆绝对不出库。
   - 观众档案基于编辑距离 Levenshtein ≤ 1 自动识别合并老粉，记录好感度。

4. **拟人化情绪引擎与主动交互 (Persona Engine)**：
   - 5 态迟滞情绪状态机（`HAPPY`、`TSUNDERE`、`GRUMPY`、`SULKING`、`SLEEPY`），防抖防抖动。
   - 直播模式强制限制心情下限（≥30）且绝不进入消极罢工的 `SULKING` 态。
   - 单观众每分钟心情操控钳制（≤ ±6），全场每分钟累计钳制（≤ ±15）。
   - 内心独白循环（`InnerThoughtLoop`）与 30 句历史滑动窗口防台词重复。
   - 专注关怀：检测连续写代码达 60 分钟贴心提醒喝水。

5. **屏幕弹幕 OCR 识别与主播安全控制台 (Console & Sensor)**：
   - 最长公共后缀（LCS）增量去重算法，精准识别滚动弹幕。
   - 0-Token 模板快速应答点赞、进房与小礼物，快捷动作（摸头/戳一戳/投喂）即时直发。
   - 输入输出安全守卫：提示词注入攻击拦截、黑名单过滤、主播敏感信息动态遮蔽。
   - 本地主播控制台（`http://127.0.0.1:7788`）：一键急停清空队列、人工代她说、在线喂小鱼干、实时身体数值监控。

---

大肥鱼由 DSH 插件启动，随 DSH 一起退出。透明、无边框、始终置顶的原生窗口，让你在编辑器、浏览器或其他应用中也能看到 Agent 的工作状态。

> **当前稳定版：0.1.21。** 新增 macOS 跨显示器拖动修复；右键菜单里的大小、气泡大小和减少动态在 DSH 设置写入失败时也会保留，并把失败原因写进 Helper 日志。继续包含 0.1.20 的透明区域点击穿透与 0.1.19 的 Helper 冷启动诊断。安装时填写 `dsh-dafeiyu@0.1.21`，离线安装请从[最新版下载页](https://github.com/QCYTSN/dsh-dafeiyu/releases/latest)选择 **`dsh-dafeiyu-0.1.21.tgz`**；Windows、Linux 与 macOS 共用这一个包。GitHub 自动生成的 **Source code (zip / tar.gz)** 是源码，不是安装包。

<img src="docs/images/balance-preview.png" width="460" alt="大肥鱼在任务状态卡底部显示 API 余额">

*原生 Windows 窗口实拍；余额为演示数据。当前角色素材来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。*

## 能做什么

- 显示真实任务状态：思考、查找、修改、执行、验证、等待确认、完成和错误。
- 展示项目、步骤、多任务和 DSH 提供的待办进度；没有真实进度时显示阶段。
- 在状态气泡和设置页显示 DeepSeek 余额，区分 API Key 与已登录账户。
- 兼容 WebUI 与官方桌面端的共享客户端；两个客户端使用各自的插件配置。
- 支持拖动、摸头、戳身体、碰尾巴，以及大小、气泡、声音和减少动态设置。
- 可选在 DSH 页面右下角显示轻量角色，默认关闭。

状态来自 DSH 会话事件。大肥鱼不会读取屏幕；推理强度与进度只显示上游实际提供的信息。

## 先选你的 DSH 客户端

| 使用方式 | 安装位置 | 设置入口（DSH 0.2） | 角色右键菜单的打开目标 |
| --- | --- | --- | --- |
| 浏览器 WebUI | `web` profile | 左侧插件 → dsh-dafeiyu | WebUI，默认 `http://127.0.0.1:3080/` |
| 官方桌面端 | `desktop` profile | 左侧插件 → dsh-dafeiyu | 通过 `dsh://open` 唤起桌面应用 |

**WebUI 中安装的插件不会自动出现在桌面端。** 两边都启用会各自启动原生角色，可以在其中一个 profile 关闭“大肥鱼”。第三方桌面包装器可能仍使用 `web` profile，请以它的实际启动方式为准。

客户端包中的 `platform: web` 也适用于官方桌面端：官方 Electron 应用使用同一套 Web 客户端。原生角色由对应 Host 启动。

## 安装

使用命令行安装、升级或移除前，先**完全退出对应 DSH Host**；操作后重新启动。通过桌面应用内的插件管理操作时，按应用提示重启。

### 浏览器 WebUI

已全局安装 DSH：

```powershell
dsh plugin --profile web add dsh-dafeiyu@0.1.21
dsh web
```

使用 `npx`，无需全局安装 DSH：

```powershell
npx -y @deepseek-ai/dsh plugin --profile web add dsh-dafeiyu@0.1.21
npx -y @deepseek-ai/dsh web
```

从 DeepSeek Harness 源码运行的用户，在 Harness 仓库中执行：

```powershell
pnpm dsh plugin --profile web add dsh-dafeiyu@0.1.21
pnpm dsh web
```

### 官方桌面端

推荐直接在应用内安装：

1. 打开官方 DeepSeek Harness 桌面应用，点击左侧 **插件**。
2. 点击 **添加插件**，输入 `dsh-dafeiyu@0.1.21`，点击 **安装**。
3. 安装成功后点击 **立即启用**，大肥鱼会出现在桌面上。
4. 在插件列表打开 **dsh-dafeiyu**，调整角色、气泡和余额设置，修改实时生效。

这套流程使用桌面应用自带的安装环境，用户无需安装 Node.js 或执行 npm 命令。若应用提示刷新或重启，按提示操作；失败时展开 **查看安装详情** 并保留日志。

也可以只填 `dsh-dafeiyu` 获取安装源中的最新版。新版本刚发布时，默认安装源可能仍返回旧版；指定版本可以避免装错。安装后核对详情页中的版本号。

使用命令安装时：

1. 先启动一次官方桌面应用，让它初始化 `desktop` profile，然后完全退出。
2. 使用桌面应用**自带的 `dsh` 命令**。支持命令注册的版本可从应用菜单的 **Manage dsh command… / 管理 dsh 命令**入口配置；也可直接调用安装目录的 `resources/runtime/cli/bin/dsh`（Windows 为 `dsh.cmd`）。
3. 执行：

   ```powershell
   dsh plugin --profile desktop add dsh-dafeiyu@0.1.21
   ```

4. 重新打开桌面应用，在左侧插件 → dsh-dafeiyu 调整角色。

**这里的 `dsh` 必须来自桌面应用。** 独立安装的 npm / `npx @deepseek-ai/dsh` CLI 不能修改官方桌面端的 profile。请参考 [DSH 官方桌面端说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.zh.md#bundled-command-runtime)。

### 使用 Release 安装包

打开[最新版下载页](https://github.com/QCYTSN/dsh-dafeiyu/releases/latest)，在 **Assets** 中下载 **`dsh-dafeiyu-0.1.21.tgz`**，用对应客户端的命令安装；**无需解压**。不要选择历史版本，也不要下载 **Source code** 作为安装包：

```powershell
# WebUI；文件路径替换为实际下载路径
npx -y @deepseek-ai/dsh plugin --profile web add "C:\Downloads\dsh-dafeiyu-0.1.21.tgz"

# 官方桌面端；必须使用应用自带的 dsh
dsh plugin --profile desktop add "C:\Downloads\dsh-dafeiyu-0.1.21.tgz"
```

桌面端也可在 **添加插件** 的输入框填写 `.tgz` 的完整路径。

## 余额显示

余额默认出现在**大肥鱼状态气泡底部和设置页**，查询逻辑由两个客户端共用。设置页可查看总余额、赠送和充值，并手动刷新。

| 来源 | 凭据来自哪里 | 查询内容 |
| --- | --- | --- |
| 自动（默认） | 优先使用 DSH 模型设置中的 DeepSeek API Key；未配置时尝试已登录账户 | 对应来源的余额 |
| API Key | DSH 的凭据服务；旧 Host 无该服务时读取启动环境 | DeepSeek `/user/balance` |
| 已登录账户 | DSH 的 DeepSeek 账户服务 | 账户充值与赠送钱包 |

- 在 **DSH 模型／账户设置**中配置凭据；大肥鱼设置页不需要再填写 API Key。
- API 余额与账户余额分别标明来源；CNY / USD 分别显示。
- 每分钟自动刷新，同一 Host 内共享缓存；手动刷新最快每 5 秒一次。
- 服务失败时保留上次成功结果，并标明“上次查询”；未配置、授权失败和网络失败分别提示。
- 自定义网关需要实现相同的 `/user/balance` 接口；不支持时显示查询失败。
- API Key、登录凭据和上游原始错误不会进入余额页面、角色消息或事件流。
- 没有余额凭据也能正常显示任务状态；可关闭“显示 DeepSeek 余额”。

账户余额和 API 余额的查询方式参考了 [keshing/balance-display](https://github.com/keshing/balance-display) 与 DSH 的公开账户服务。插件不会发起模型调用。

## 常用设置

| 设置 | 作用 |
| --- | --- |
| 启用大肥鱼 | 开关当前 profile 的原生角色 |
| 角色大小 / 气泡大小 | 独立调整；小气泡保留基本字号 |
| 安静 / 标准 / 活泼 | 每次待机动作结束后，分别休息 45～90 / 25～45 / 12～22 秒 |
| 减少动态 | 固定角色姿势，停止待机与点击动画；状态和提示仍实时更新 |
| 提示音 | 完成／出错时播放声音 |
| 气泡显示 | 常驻、隐藏，或仅在指定状态显示 |
| 子 Agent | 允许子 Agent 状态参与显示 |
| 页面内角色 | 在 DSH 页面右下角显示轻量角色 |
| 打开目标 | 自动、WebUI 或官方桌面端 |
| 显示余额 / 余额来源 | 开关与选择余额查询来源 |

设置页修改实时生效。右键菜单可调整大小、减少动态、打开对应 DSH 客户端，或仅在本次运行隐藏／关闭角色。

点击动作会完整播完，再回到当前任务状态；新任务可立即打断装饰动作。拖拽期间只播放悬空姿势，松手后完整落地。具体触发、频率和衔接规则见 [动作说明](docs/animation-behavior.md)。

若 WebUI 使用自定义地址，可在启动 Host 时设置 `DSH_DAFEIYU_WEBUI_URL`；它优先于自动推断的默认地址。

## 平台与运行环境

| 平台 | 原生角色 |
| --- | --- |
| Windows 10 / 11 x64 | 随包提供 Helper；WSL2 可通过 Windows 互操作启动 |
| Linux x64 | 随包提供 Qt Helper，需要图形桌面；glibc 2.35+，Ubuntu 24.04 有验收记录 |
| Linux arm64 | 包里**没有**随架构 Helper，会自动回退到 Python Helper，需要 `python3` 与 `PySide6>=6.7,<7`；缺失时会写明确日志 |
| macOS 12+ | 原生 Swift / AppKit Helper，Universal 构建；实验性支持 |

标准安装包已包含 Helper，**不需要自己安装 Python 或运行 Helper**。从源码使用时需自行构建。macOS 小字号与拖动边缘已修复并通过 CI，仍需真实机器验证视觉效果与多屏操作。

原生角色显示在 **Host 所在的桌面**：远程服务器、无图形环境和浏览器客户端不在同一台机器时，请先确认 Host 的运行位置。页面内角色可在浏览器中显示。

## 更新与排错

WebUI 用户完全退出 DSH 后执行：

```powershell
npx -y @deepseek-ai/dsh plugin --profile web update dsh-dafeiyu
```

官方桌面端 **0.2.0-rc.2 暂不支持应用内自动更新**。在插件页面卸载大肥鱼，再添加 `dsh-dafeiyu@0.1.21` 并立即启用；也可以完全退出应用后使用自带的命令：

```powershell
dsh plugin --profile desktop update dsh-dafeiyu
```

然后重新启动对应客户端。回退、移除、DSH 迁移后恢复大小，以及 Windows `EPERM` 的处理见 [更新与回退](docs/UPDATING.md)。

- DSH 0.2 设置页变化：安装当前稳定版，通过左侧插件 → dsh-dafeiyu 打开设置；较旧 Host 保留原设置入口。
- 桌面端安装只显示 `[exit 1]`：该信息不足以确定原因，请附上插件安装详细日志（如 `hub.log`）、DSH 版本、系统和安装方式。
- 余额查询失败：检查 DSH 中的凭据及所用网关是否支持余额接口。
- 角色不出现：检查 profile、插件是否启用，以及 Host 是否有可用图形桌面。Helper 的启动原因现在会写入日志：
  - Windows：`%LOCALAPPDATA%\dsh-dafeiyu\logs\helper.log`
  - macOS：`~/Library/Logs/dsh-dafeiyu/helper.log`
  - Linux：`${XDG_STATE_HOME:-~/.local/state}/dsh-dafeiyu/helper.log`

  首次启动需要把约 100 MB 的 Qt 运行库解压到临时目录，杀毒软件实时扫描可能让冷启动明显变慢；首次就绪等待上限已放宽到 180 秒（之后 60 秒）。解压临时目录在 Windows 位于 `%LOCALAPPDATA%\dsh-dafeiyu\tmp`、Linux 位于 `~/.cache/dsh-dafeiyu/tmp`，其中超过一天的陈旧 `_MEI*` 目录会在下次启动时清理。需要更详细输出时可用 `DSH_DAFEIYU_LOG_FILE=<路径>` 改日志位置，或设为 `off` 关闭；报告问题时可以附上该日志（只含本地路径与启动错误，不含凭据）。

[GitHub issue / PR 处理清单](https://github.com/QCYTSN/dsh-dafeiyu/blob/main/docs/GITHUB_TRIAGE.md)记录已处理和仍需补充证据的问题；[验收记录](https://github.com/QCYTSN/dsh-dafeiyu/blob/main/docs/ACCEPTANCE.md)保留实际测试结果。这些记录中的旧版本号用于追溯，不是安装建议。

## 源码开发

```powershell
pnpm install --frozen-lockfile
npm test
npm run test:python
npm run build:helper
npm run test:helper:packaged
```

开发 Python Helper 需要 `requirements.txt` 中的依赖；macOS Helper 需要 Xcode Command Line Tools。纯 Swift 核心测试运行 `swift test`。修改原生代码后应重新构建 Helper，再安装本地打包产物。

CI 还会隔离安装 DSH 0.2.0-rc.2 并运行 `scripts/test-dsh-settings.mjs`，验证新设置接口。该检查不读取用户 profile 或凭据，文件写入使用测试适配器。

项目通过 GitHub Actions 构建三个平台的 Helper 并发布；维护者操作见 [发布说明](https://github.com/QCYTSN/dsh-dafeiyu/blob/main/docs/RELEASING.md)。

## 素材与授权

当前动态素材来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，以来源的 **24 fps** 转成透明 WebP 帧。当前清单含 16 组动作、3,444 帧，帧画布为 412 × 344；清单记录了上游版本、视频校验值和取帧范围。

软件代码与角色素材适用不同授权，请完整阅读 [ASSET_LICENSE.md](ASSET_LICENSE.md)、[素材来源许可证](assets/dsh-pet-LICENSE.txt)和 [LICENSE](LICENSE)。旧版素材及社区拖拽图片保留于 `legacy/`，不随当前 npm 包分发。

感谢社区在动画、macOS、WSL 和兼容性方面的贡献。想接收更新通知，请订阅仓库 **Watch → Custom → Releases**；Star 只收藏项目。
