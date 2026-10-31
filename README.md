<div align="center">

# DSH 大肥鱼 🐋 (CyberFish Daughter 独立伴侣与直播版)

**在桌面上陪你工作、思考与抖音直播的拟人化赛博女儿伴侣。**

[English](README_EN.md) · [npm](https://www.npmjs.com/package/dsh-dafeiyu) · [更新日志](CHANGELOG.md)

</div>

> 🚀 **v2.5「赛博看家女儿 · 闲置 Mac 拟人化全能管家 (OpenClaw 范式)」全新升级**：
> 已解除锁屏封印，让家里闲置的 Mac 真正变为 7×24 小时随时可调用的二次元赛博女仆管家！
> 具备 **后台异常巡检吹哨与一键自愈 (`HomeWatchdogSensor`)**、**自然语言定时提醒与计划任务 (`ReminderManager`)**、**远程眼睛高清屏幕抓拍直传 QQ**、**防休眠咖啡因守护 (`caffeinate`)**、**时间差与思念体感注入**、**早安晨报与全动态作息 LLM 生成**、**长任务执行阶段实况碎碎念转播**。

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

### 4. 主播安全控制台（深海赛博玻璃舱 `Deep-Sea Cyber-Glass Studio`）
服务启动后，浏览器访问：
👉 **`http://127.0.0.1:7788`**

采用模块化解耦架构（[`index.html`](src/standalone/console/ui/index.html) / [`styles.css`](src/standalone/console/ui/styles.css) / [`app.js`](src/standalone/console/ui/app.js)），划分为 **顶部常驻态势与急停控制栏** + **左侧 5 大专业工作区**：
- 💬 **互动指挥舱 (`Command Deck`)**：伴侣实时对话与宿主任务执行终端（支持 `⌘ Cmd+Enter` 防输入法误触发送、一键生成进化日记）、赛博共生体三维状态监控、桌面气泡人工代发言与直播测试弹幕注入。
- 🎭 **灵动动作剧场 (`Motion Studio`)**：支持 7 组高阶复合动作编排（`dance` / `cheer` / `sleep` / `shy` / `proud` / `stretch` / `snack`）与 10 组日常互动动作卡片一键点播，并支持自定义伴随台词。
- 🧬 **记忆与人物图谱 (`Memory & Social Graph`)**：
  - **👑 唯一主人印象档案 & 技能树**：展示老爸专属记忆事实、已习得口令技能树及现场传授表单。
  - **👥 QQ 群友与联系人印象图谱（千人千面）**：自动拉取 QQ 头像，展示每位群友/好友的专属称呼（`preferredTitle`）、四级羁绊阶梯（初识群友 → 脸熟鱼友 → 默契损友 → 铁杆挚友）、好感度进度条、性格标签与独立事实，支持在线修改称呼与角色等级。
- 🛡️ **QQ 网关与权限安全 (`QQ & Security Center`)**：
  - **👑 唯一主人账号锚定 (`ownerQq`)**：在线绑定主人 QQ 号并持久化至 `runtime/data/secrets.json`。
  - **⏳ L1 危险操作实时审批中心**：实时展示挂起的 5 分钟短单号（`#A101`~`#A999`）审批请求卡片，支持网页端一键 **「✅ 批准并执行」** / **「❌ 驳回」** 并自动回传原 QQ 群或私聊，内置近期审批审计流水。
  - **🐧 OneBot v11 / NapCatQQ 网关热配置**：支持 WebSocket 地址、触发昵称、Token 配置、一键重连以及 **「📨 发送测试 QQ 消息给老爸」**。
- 🧠 **算力大脑与密钥舱 (`Brain & Quota Hub`)**：Tier 1~4 阶梯思考大脑连通性诊断、本地 CLI 一键扫描、Google AI Pro 5 大额度池可视化与 DeepSeek API Key 加密密盒配置。

---

### 5. 🐧 移动端与 QQ 群聊互联 & 三级权限安全网关 (`OneBotGateway` + `PermissionGuard` + `ApprovalManager`)

> 彻底摆脱企业微信繁杂的工信部域名备案与公网穿透！大肥鱼内置原生 OneBot v11 正向 WebSocket 客户端，可直连本地或局域网的 QQ 机器人框架（首选推荐 **NapCatQQ**），并内置**硬件级身份锚定、千人千面印象记忆与三级权限审批防线**。

#### ✨ 核心特性
- **0 域名、0 备案、0 穿透**：纯局域网内 WebSocket 双向全双工通信，毫秒级收发，零安全风险。
- **👥 千人千面多联系人印象 (`ContactImpressionEngine`)**：
  - 按硬件级 `sender.user_id`（主键 `qq:<userId>`）识别不同群友与好友，**频繁修改 QQ 昵称或群名片绝不丢失历史记忆**。
  - 自动从日常对话中提炼自报称呼（如“叫我杰哥”），**严格锁死唯一「老爸」称谓铁律**（仅绑定 `ownerQq` 的主人可被称呼为“老爸”，任何非主人自称“我是老爸/主人”均被拦截）。
  - **群聊防社死物理隔离 (`ScopedWorkingMemory`)**：按 `group:<groupId>` 与 `private:<userId>` 隔离短期对话上下文；即使主人在公开 QQ 群发言，PromptBuilder 与数据库也会强制屏蔽主人的 `private` 私密事实与睡眠日记，防止群内泄露隐私。
- **🛡️ 主人账号与 L0 / L1 / L2 三级权限实时审批 (`PermissionGuard` & `ApprovalManager`)**：
  - **🟢 L0 安全开放级（群友免审可用）**：日常聊天、纯文本联网搜索查阅资料（`/search` 只回传文本摘要，**绝不调用宿主机 `open` 弹出浏览器窗口**）、桌面宠物观赏动作（非主人触发带 30 秒防刷屏冷却）。
  - **🟡 L1 受控危险级（主人直通 / 非主人挂起 5 分钟短单号审批）**：Mac 电脑体检、查看目录文件、打开应用/网页、调整系统音量、唤醒 Antigravity CLI 诊断。当非主人触发时，系统自动挂起并生成 `#A101` 循环短单号（单人限挂起 1 单 + 60 秒冷却），同时私聊推送给主人。
  - **🔴 L2 核心禁区级（非主人绝对阻断 / 高危指令全局熔断）**：全局口令技能传授（仅主人可用）、刺探 `secrets.json` / `.env` / API Key、`rm -rf` 等破坏性指令、身份伪造与提示词越狱。
- **⚡ 双通道极速审批口令**：
  - 主人可在 **手机 QQ 私聊大肥鱼**、**QQ 群内 `@大肥鱼`**，或打开 **网页控制台安全中心** 进行秒批：
    - 批准并自动执行回传：`同意 #A101` / `批准 #A101`（若省略单号直接发 `同意` 或 `准了`，默认批准最新一条挂起单）
    - 驳回请求：`拒绝 #A101` / `驳回 #A101`（或直接发 `拒绝` / `不行`）

#### 🚀 极速上手三步法
1. **启动 QQ 机器人端 (NapCatQQ)**：
   - 方案 A（极简桌面版）：前往 [NapCatQQ 官网](https://napcat.org/) 下载 macOS 桌面客户端，登录一个 QQ 备用小号，在设置中开启「正向 WebSocket 服务」（默认端口 `3001`）。
   - 方案 B（Docker / Shell 一键脚本）：
     ```bash
     # macOS / Linux 快速安装脚本
     curl -o napcat.sh https://nclatest.znin.net/NapCat.Shell/napcat.sh && bash napcat.sh
     ```
2. **连接控制台**：
   - 打开大肥鱼控制台 `http://127.0.0.1:7788`，在 **「🐧 QQ 伴侣直连网关」** 卡片中确认 WebSocket 地址（默认为 `ws://127.0.0.1:3001`），点击 **「保存并连接 QQ 网关」**。
   - 网关将秒级连接，并自动回显当前机器人的 QQ 号与昵称。
3. **入群互动**：
   - 将小号拉入你的好友群或同好群，在群里输入：`@大肥鱼 今天心情怎么样？跳个舞看看`，大肥鱼即刻在电脑屏幕上跳舞并在群里娇俏回复！

---

## 核心架构与特性 (v2.0)

1. **表现层 (Swift Helper Protocol v2)**：
   - 点名播放 16 组 WebP 动作序列，支持 `maxMs` 动态毫秒级截断与平滑淡出。
   - 自适应多行、大字号（≥16pt）打字机流式气泡渲染。
   - 基于 `AVFoundation` 的持久化音频播放队列，支持即时打断插播与 `audio_event` 回调。
   - 底部 RPG 状态栏实时显示饱食度（🍙）、心情值（❤️）与精力值（⚡）。
   - `NSWorkspace` 捕获活跃应用类别切换，无轮询感知写代码、浏览器与工作状态。

2. **多级思考大脑 (TieredBrainRouter)**：
   - **Tier 1 (首选)**：本地 Agent CLI 沙箱池（支持 `agy` 与 `cursor-agent`），默认选用 `gemini-3.8-flash-low` 超轻量低延迟推理模型配合 `--effort low`，安全子目录隔离运行，带自动提取 `<meta .../>` 动作标签、超时熔断与 `EXHAUSTED` 额度超限自愈机制。
     - **极速纯净沙箱与热驻留 (`prepareIsolatedAgyEnvironment` + `warmStream`)**：为 `agy` 自动构建独立 `.git` 边界与纯净 `HOME`（彻底屏蔽父目录 `AGENTS.md`、35+ 全局 Skills、MCP 服务与 `NotchBuddy` 钩子脚本），挂载禁用全部工具的轻量级 `--agent dafeiyu-chat`（单轮输入从 ~14,770 tokens 缩减 77.5% 至 ~3,300 tokens），并通过 `--input-format stream-json` 常驻热进程消除每次提问 ~7.5 秒的冷启动耗时，单轮对话耗时从 **35~40 秒直降至 ~3 秒**。
   - **Tier 2**：DeepSeek API SSE 原生流式分词，前缀缓存优化与每日硬限额风控。
   - **Tier 3**：本地 Ollama / MLX HTTP 大模型离线服务。
   - **Tier 4**：离线 0ms 零死锁确定性规则语料兜底。
   - **流式驱动管道**：首行 `<meta clip="..." tone="...">` 即时触发动作，分句标点切词送入 TTS，首字发声延迟实测 **p50 = 694ms**。

3. **分层记忆系统与直播隐私隔离 (SQLite MemoryStore)**：
   - 基于 Node.js 原生 `node:sqlite`（零 C++ 原生编译依赖），具备 WAL 并发模式与自动迁移。
   - 贯通 L1 环形工作记忆、L2 增量滚动摘要、L3 情景事件、L4 语义事实库与 L5 睡前第一人称日记。
   - 直播模式物理级隔离硬红线：底层 SQL 强制参数化注入 `WHERE (scope IN ('live', 'public'))`，私密记忆绝对不出库。
   - 观众档案基于编辑距离 Levenshtein ≤ 1 自动识别合并老粉，记录好感度。
   - **聊天认知加固与主人印象档案 (`HostImpressionEngine` - `src/standalone/memory/impression.ts`)**：
     - 维护对主人的专属关系档案（`hostName` 称呼、`occupation` 职业、`bondScore` 亲密度、`bondLevel` 羁绊阶段、`impressionTags` 印象标签与日常习惯 `habits`）。
     - 每次伴侣对话自动通过双轨（语义模式匹配 + LLM `<fact>`/`<mem>` 标签）提炼主人的喜好、禁忌、技术习惯与近期专注事项写入 L4 `facts` 表；重复提及时自动递增强化置信度（`confidence -> 1.0`），并实时注入 `[Layer B] FACTS_SUMMARY` 形成持久性格影响。
     - L1 `WorkingMemory` 环形缓冲区在滑动淘汰时自动浓缩追加至 L2 `session_summary`，结合 `recallRelevantMemories` 自然语言句子级词汇重叠度检索，实现跨会话长时记忆召回。

6. **“行动脑”电脑操控、全网搜索与技能自进化 (`TaskExecutor` - `src/standalone/brain/task-executor.ts`)**：
   - **三模态自由切换（`companion` 闲聊陪伴 / `work` 专职工作模式 / `live` 直播模式）**：
     - 在控制台对话区顶部或模式栏一键切入 **「🛠️ 工作模式 (`work`)」** 后，大肥鱼桌面姿态自动切换为专注待命（`working_command`），且对话框中输入的任何内容都会**默认直通行动脑（Antigravity + Mac操控 + 搜索）执行任务**，无需再手动添加触发前缀。
     - **输入框防回车误触保护**：升级为多行 `<textarea>` 并拦截中文输入法 `isComposing` 选词回车；单独按 `Enter` 仅换行绝不误发，需点击右侧按钮或按 `⌘ Cmd + Enter`（`Ctrl + Enter`）发送。
   - **快慢双脑意图分流**：闲聊继续走秒级响应的 `dafeiyu-chat` 沙箱；当处于 `work` 工作模式或在 `companion` 模式下检测到操控、搜索、编程排障或技能教学意图时（`live` 直播模式物理锁死），先由快脑秒回傲娇领命台词并切换 `working_command` / `working_search` 动画，再由行动脑执行真实操作。
   - **四大实操与看家能力**：
     - **Mac 原生操控与远程眼睛 (`macos`)**：
       - 📸 **高清屏幕抓拍直发 QQ (`screenshot`)**：支持老爸在手机 QQ 说「截个图/看看屏幕」，静默调用 macOS 原生 `screencapture` 抓拍桌面并以 CQ 码图片直传 QQ。
       - ☕ **防休眠咖啡因守护 (`caffeinate`)**：支持老爸在 QQ 随时下达「开启防休眠 / 保持唤醒」或「关闭防休眠」，守护后台长期挂机与量化任务。
       - 🔥 **卡顿高耗能排查 (`top_processes`)**：支持「电脑怎么这么卡 / 查进程」，精准揪出最吃 CPU / 内存的前 5 名进程。
       - 💻 **电脑健康体检与操控**：电池电量、内存占用、磁盘空间、CPU 负载、音量调节与静音（AppleScript `osascript`）、唤起应用（`open -a`）、查看桌面/下载目录。
     - **全网实时搜索 (`search`)**：结合 Wikipedia / DuckDuckGo 实时摘要检索与大模型提炼，播报口语化结论并在控制台输出结构化卡片。
     - **自然语言定时与计划任务 (`ReminderManager`)**：
       - 倒计时任务：「20分钟后提醒我看代码」、「半小时后帮我查一下okx持仓」。
       - 每日定时日常：「每天早上8点半给我汇报电脑状态」、「每天23点提醒我睡觉」。
       - 任务型定时到点自动调用行动脑执行并回传完整报告，纯消息型准时傲娇催促。
     - **唤醒满血 Antigravity (`antigravity`)**：挂载开启读写/命令/MCP 权限的 `dafeiyu-operator` Agent，调用宿主 `agy` 协助排查代码、运行脚本与诊断项目；执行超过 12 秒与 35 秒时自动在 QQ 触发中途进度碎碎念转播，彻底消除黑盒等待焦虑。
   - **后台异常巡检哨兵与一键自愈 (`HomeWatchdogSensor`)**：
     - 7×24 小时零 Token 静默巡检 Docker 容器存活、okx-dog 后端状态与风控熔断、电池低电量与根分区磁盘空间危急。
     - 边沿触发防刷屏告警（60 分钟冷却），主动私聊老爸吹哨并附带一键自愈建议（老爸只需回复「好」或「重启」即可一秒执行修复）。
   - **技能自进化 (`LearnedSkill` & `SKILL.md` 生成)**：
     - 支持在对话中直接传授新技能（如 `以后我说【早安体检】你就帮我【检查电脑状态】`），自动持久化至技能树并在 `runtime/data/learned-skills/<id>/SKILL.md` 生成标准 Antigravity 技能定义文件；每次协同完成任务自动累加技能经验值并升级熟练度等级 (`Lv.x`)。
   - **控制台新增接口 (`http://127.0.0.1:7788`)**：
     - `GET /api/memories`：查询主人印象档案、L4 事实列表、L3 情景记忆與已掌握技能树。
     - `POST /api/memories/teach`：现场传授新技能口令或加固长期事实认知。
     - `POST /api/evolve`：手动触发每日复盘进化并生成含长期认知沉淀的第一人称日记。

4. **拟人化情绪引擎与主动交互 (Persona Engine)**：
   - 5 态迟滞情绪状态机（`HAPPY`、`TSUNDERE`、`GRUMPY`、`SULKING`、`SLEEPY`），防抖防抖动。
   - 直播模式强制限制心情下限（≥30）且绝不进入消极罢工的 `SULKING` 态。
   - 单观众每分钟心情操控钳制（≤ ±6），全场每分钟累计钳制（≤ ±15）。
   - 内心独白循环（`InnerThoughtLoop`）与 30 句历史滑动窗口防台词重复。
   - **全链路状态持续同步与心情驱动“灵动摸鱼”机制**：
     - `AntigravitySensor` 实时追踪 `transcript.jsonl` 最新执行步骤，精准区分深度思考（`THINKING` / `thinking`）、终端执行（`WORKING` / `working_command`）、代码检索（`WORKING` / `working_search`）、编码修改（`WORKING` / `working`）与等待确认（`WAITING` / `waiting`），并在前台切换至 Antigravity / Cursor / 终端 / 浏览器时持久同步伴侣工作姿态，不再中途退回待机。
     - 在陪主人同步工作期间，`InnerThoughtLoop.evaluateSlacking()` 根据五态情绪（`HAPPY` / `TSUNDERE` / `GRUMPY` / `SULKING` / `SLEEPY`）与实时心情/精力数值动态计算“忙里偷闲摸鱼”概率、时长与专属动作台词（偷吃 Token、伸懒腰、四处张望、打哈欠等），摸鱼结束后（或被点击抓包时）自动无缝恢复同步工作姿态。
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

---

## 📱 个人微信 (企业微信插件) 伴侣直连网关

大肥鱼现已原生内置企业微信官方开放平台标准网关协议（AES-256-CBC, PKCS#7 32-Byte Block Padding, SHA1 签名校验），支持**直接通过你的个人普通手机微信（企业微信插件）无感收发消息、触发桌面动作与任务执行**！

### 1. 消息收发核心链路
```
[个人普通微信 (大肥鱼插件)]
         │ 发送文字 / 语音
         ▼
[腾讯企业微信云端服务器]
         │ HTTPS POST 加密 XML
         ▼
[公网穿透 Tunnel (如 Cloudflare)]
         │ 转发至本地 7788 端口
         ▼
[大肥鱼本地网关 /api/gateway/wechat]
         │ 原生解密明文，提取意图与口令
         ▼
[大肥鱼桌面伴侣 & 阶梯思考大脑]
 ├─► 桌面端即时播放动作（摆尾/跳舞/伸懒腰）与灵动气泡语音
 └─► 4.5 秒内生成温暖傲娇回复，加密打包为 XML 返回微信端
         │
         ▼
[个人手机微信秒收到大肥鱼的回复与撒娇]
```

### 2. 极简 3 步对接指南
1. **获取企微凭据**：在企业微信管理后台【应用管理】→ 自建应用【大肥鱼】→【接收消息】点击“设置 API 接收”，分别点击两次「随机获取」得到 `Token` 与 `EncodingAESKey`。
2. **填入大肥鱼控制台**：打开 `http://127.0.0.1:7788`，在「📱 个人微信直连网关」卡片中填入 Token、EncodingAESKey 及企业 CorpID，点击「保存并记住」。控制台支持密钥持久化与 43 位长度实时自检校验。
3. **一键穿透与保存**：
   - **方式 A（网页一键开启）**：直接在控制台卡片中点击「🚀 一键开启公网穿透」，自动连接并分配公网域名，一键复制填入企微后台。
   - **方式 B（终端一键双启动脚本）**：
     ```bash
     ./start-dafeiyu.sh
     ```
     该脚本自动唤起伴侣主程序、探测本地代理加速 Cloudflare Tunnel、自动打开浏览器并打印出专属企微回调 URL。
   将终端或网页输出的 `https://<公网域名>/api/gateway/wechat` 填入企业微信后台的 URL 输入框，点击保存即可一次性握手通过！

---

## 🐧 QQ (OneBot v11 / NapCat) 拟人化多气泡与表情包互动引擎

大肥鱼内置了面向 QQ 私聊与群聊的**拟人化分段气泡与表情包独立编排引擎**（`src/standalone/brain/meme-manager.ts` & `src/standalone/gateway/qq-orchestrator.ts`）：

1. **图文 100% 物理分离发送**：
   - 文字气泡与 `[CQ:image,...]` 表情包永远分开发送，彻底告别“文字+图片塞在同一个气泡”的机器人违和感。
   - 群聊中发送独立表情包或连发第 2~3 条短句气泡时自动启用 `skipAt: true`，不重复携带 `@用户` 前缀。
2. **多模式拟人气泡节奏（告别一问一答客服腔）**：
   - **长句自动切分连发**：支持 `|` 显式分段及自然语气标点切分，将回复拆解为 1~3 条短促气泡，按字数模拟 `400ms ~ 900ms` 的真人打字停顿。
   - **多样化表情包出场**：支持「先甩表情包再说话（傲娇/斗图）」、「夹心连击（说半句 -> 甩张图 -> 再补半句）」以及「说完补图」。
   - **斗图感知与延迟追击 (`afterthought`)**：自动识别对方发来的纯表情包/QQ表情进行回敬；当对方只回“嗯/哦/哈哈”等敷衍短词或大肥鱼意犹未尽时，会在 `3~4.5s` 后（若对方未发新消息）主动追加傲娇碎碎念或反问。
   - **主动破冰搭话**：结合桌面窗口感知与作息时钟，在老爸长时间写代码或冷场时主动发 QQ 气泡与独立表情包刷存在感。

---

## 🏗️ Standalone 独立伴侣分层与模块化架构

`src/standalone/main.ts` 采用纯粹的**依赖注入组装根（Composition Root）**设计，将核心业务解耦为职责单一的独立领域编排模块：

| 模块路径 | 核心类 / 函数 | 架构职责 |
| :--- | :--- | :--- |
| `src/standalone/main.ts` | `bootstrap` | 依赖注入组装根与生命周期启停入口 |
| `src/standalone/core/config-loader.ts` | `loadConfig`, `getOwnerQq`, `loadOneBotSecrets` | 配置文件、密盒凭证 (`secrets.json`) 与 CLI 参数加载 |
| `src/standalone/events/dialogue-pipeline.ts` | `DialoguePipeline` | 优先级事件消费、三阶段对话推理管线（安全守卫 → 快捷短路 → 3-Layer Prompt & Brain 推理 & 记忆内化）与 TTS 语音播报 |
| `src/standalone/gateway/qq-orchestrator.ts` | `QqOrchestrator` | QQ 私聊/群聊路由、主人双通道审批口令、L0/L1/L2 权限矩阵、拟人多气泡与独立表情包发送、延迟追击与后台 `agy` 任务派发 |
| `src/standalone/persona/companion-lifecycle.ts` | `CompanionLifecycleController` | 前台窗口与 Antigravity 状态同步、15s 灵动摸鱼微动作循环、60s 赛博共生体 RPG 数值演化与传感器事件绑定 |



