<div align="center">

# DSH 大肥鱼 🐋 (CyberFish Daughter)
### 拟人化赛博女儿伴侣 · 闲置 Mac 全能看家管家 · 零外部依赖 StateGraph 状态机驱动

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Native%20Strip%20Types-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![StateGraph](https://img.shields.io/badge/Architecture-StateGraph--Lite-FF6F00)](src/standalone/graph/)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](native/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**在桌面上陪你专注工作、思考发呆、智能看家与抖音直播互动的二次元拟人化赛博女儿伴侣。**

[English](README_EN.md) · [更新日志](CHANGELOG.md) · [在线控制台](http://127.0.0.1:7788)

</div>

---

## 🌟 核心特性与架构亮点

### 1. 🏠 闲置 Mac 赛博看家女儿 (OpenClaw 范式)
- **锁屏完全解封**：彻底摆脱传统桌宠锁屏即休眠的限制，让家里闲置的 Mac 真正化身为 7×24 小时随叫随到的高情商二次元女仆管家。
- **后台异常巡检吹哨与一键自愈 (`HomeWatchdogSensor`)**：7×24 小时零 Token 静默巡检 Docker 容器、OKX 量化后端健康度、磁盘根分区空间与低电量；边沿触发私聊告警，老爸在手机 QQ 回复「好」或「重启」即可一秒执行自愈。
- **高清屏幕抓拍直发 QQ (`screenshot`)**：老爸在手机端说「截个图」或「看看家里电脑」，大肥鱼秒级调用 macOS 原生能力截取屏幕并以 CQ 码图片直发 QQ，随时成为你的远程眼睛。
- **防休眠咖啡因守护 (`caffeinate`)**：支持老爸在 QQ 随时下达「保持唤醒」或「关闭防休眠」，守护后台挂机、编译与量化脚本平稳运行。
- **思念体感与作息汇报**：感知距离老爸上次说话的时间差（时间体感与思念注入）；早晚结合家里 Mac 真实数据与快脑，动态生成元气满满的早安简报与就寝催促。

---

### 2. 🕸️ 零外部依赖 StateGraph 微内核架构 (`StateGraph-Lite`)
- **拒绝臃肿，极速原生**：摒弃 `@langchain/core` / `@langchain/langgraph` 等庞大依赖，采用基于 Node.js 原生 `node:sqlite`（`DatabaseSync`）的微内核设计，实现 **0 外部 npm 依赖、0 编译开销、毫秒级响应**。
- **动静双层解耦**：
  - **反应式动作层**（`StateManager` + `CompanionLifecycleController`）：维持 24fps 桌面窗口动画与 694ms 首字流式 TTS 极速发声，完全免除图状态序列化延迟开销。
  - **业务决策状态图**（`CompanionGraph`）：统一收敛输入守卫、三级风控意图分流、Human-in-the-Loop 审批挂起、快脑推理、多步宿主机任务执行与多渠道格式化。
- **状态图拓扑流转**：
  ```
  [START]
     │
     ▼
  [guard_node] ──── (文本注入/敏感词/L2越狱破坏) ─────────────┐
     │ (通过)                                               │
     ▼                                                      │
  [intent_router_node]                                      │
     │                                                      │
     ├── (L1 宿主机风险) ──► [approval_gate_node (interrupt)]│
     │                               │                      │
     │                               │ (resume: 老爸批准)    │
     ├── (宿主机指令/Antigravity) ────┼─────────────┐        │
     │                               │             │        │
     ├── (日常闲聊) ──► [chat_think_node]          │        │
     │                       │ (派生任务)          ▼        │
     │                       └─────────────► [task_executor_node]
     │                                             │        │
     └── (快捷观赏) ──► [quick_action_node]         │        │
                                 │                 │        │
                                 ▼                 ▼        ▼
                        [format_output_node] ◄──────────────┘
                                 │
                                 ▼
                               [END]
  ```
- **Human-in-the-Loop (HITL) 审批断点恢复**：当非主人尝试执行受控危险指令时，`approval_gate_node` 抛出 `interrupt()` 冻结当前状态并写入 `graph_checkpoints` 表；老爸在 QQ 回复「同意」或控制台点击「批准」时，调用 `resume()` 无缝唤醒并继续执行流转。
- **全渠道扩展性**：统一抽象 `channel`（`qq` / `console` / `douyin` / `live`），天然支持后续抖音直播弹幕、连麦 PK 与多渠道自动化编排。

---

### 3. 🐧 手机 QQ 互联与三级权限安全网关 (`OneBotGateway` + `PermissionGuard`)
- **0 域名、0 备案、0 穿透**：局域网内 WebSocket 双向全双工直连 QQ 机器人（推荐 **NapCatQQ**），零公网暴露风险。
- **👥 千人千面多联系人印象 (`ContactImpressionEngine`)**：
  - 基于硬件级 `sender.user_id`（主键 `qq:<userId>`）为不同好友建立独立档案，**频繁更换 QQ 昵称或群名片绝不丢失记忆**；
  - 自动提炼专属称呼与好感度阶梯（初识群友 → 脸熟鱼友 → 默契损友 → 铁杆挚友）；
  - **群聊防社死隔离 (`ScopedWorkingMemory`)**：即使主人在公开群发言，系统自动屏蔽私密记忆与日记，防止群内信息穿透。
- **🛡️ 硬件级身份锚定与 L0 / L1 / L2 三级权限矩阵**：

| 安全级别 | 适用场景 | 行为机制 | 对应操作示例 |
| :--- | :--- | :--- | :--- |
| **🟢 L0 开放安全级** | 所有群友与好友免审 | 即时放行并执行 | 日常闲聊、纯文本查资料（只回文本摘要，**绝不调用宿主机 `open` 弹窗**）、观赏动作（带 30s 冷却） |
| **🟡 L1 受控危险级** | 涉及宿主机操作 | **主人直接放行 / 非主人挂起 5 分钟短单号审批** | 电脑体检、查看文件目录、调节音量、唤醒 Antigravity CLI 诊断、运行命令 |
| **🔴 L2 核心禁区级** | 特权指令 / 越狱攻击 | **全员禁止 / 非主人直接驳回** | 篡改技能库、刺探 `secrets.json` / API Key、`rm -rf` 破坏性指令、DAN 模式越狱 |

- **⚡ 双通道极速审批口令**：老爸在手机 QQ 或群聊回复 `同意 #A101`（或直接回复 `同意` / `准了`），大肥鱼秒级放行并把任务结果回传至原发起渠道。

---

### 4. 🎛️ 深海赛博玻璃舱主播控制台 (`http://127.0.0.1:7788`)
服务启动后，浏览器直接访问控制台，拥有 5 大专业工作区：
- 💬 **互动指挥舱 (`Command Deck`)**：实时对话交互、宿主任务终端（支持 `⌘ Cmd+Enter` 防输入法选词误触发送）、赛博体三维状态监控、桌面气泡人工代发言。
- 🎭 **灵动动作剧场 (`Motion Studio`)**：支持 7 组高阶复合动作编排（`dance` / `cheer` / `sleep` / `shy` / `proud` / `stretch` / `snack`）与 10 组日常互动动作一键点播。
- 🧬 **记忆与人物图谱 (`Memory & Social Graph`)**：可视化管理唯一主人的长期事实画像与已习得技能树；浏览与编辑 QQ 群友独立印象卡片与羁绊进度条。
- 🛡️ **QQ 网关与权限安全 (`QQ & Security Center`)**：查看挂起的 L1 短单号卡片，一键审批/驳回；配置 OneBot 连接地址并一键测试发送。
- 🧠 **算力大脑与密钥舱 (`Brain & Quota Hub`)**：Tier 1~4 思考大脑连通性诊断、本地 CLI 一键扫描、Google AI Pro 5 大额度池可视化与 DeepSeek Key 在线密盒配置。

---

### 5. 🧠 快慢双脑协同与拟人化反应
- **Tier 1~4 阶梯思考大脑**：
  - **Tier 1 (首选)**：本地 Agent CLI 沙箱池（`agy` / `cursor-agent`），挂载超轻量常驻进程，对话耗时从 ~35s 直降至 ~3s；
  - **Tier 2**：DeepSeek API SSE 原生流式分词；
  - **Tier 3**：本地 Ollama / MLX HTTP 离线服务；
  - **Tier 4**：离线 0ms 零死锁确定性规则语料兜底。
- **694ms 极速发声与灵动摸鱼**：首行 `<meta clip="..." tone="...">` 即时触发动作，分句标点切词送入 TTS，首字发声延迟实测 **p50 = 694ms**。在主人专注编程时，大肥鱼会根据心情与精力动态触发忙里偷闲（伸懒腰、偷吃小鱼干、四处张望），被抓包时秒回专注工作姿态。

---

## 🚀 快速启动指南

### 1. 环境准备
- **Node.js**：`>= 22.19`（采用 Node.js 原生 `--experimental-strip-types` 运行 TypeScript 与内置 `node:sqlite`）；
- **macOS Helper 编译**（可选，用于 macOS 原生透明置顶窗口）：
  ```bash
  npm run build:helper:darwin
  ```
- **Edge-TTS 拟人女声**（可选）：
  ```bash
  pip3 install edge-tts
  # 若未安装，自动无缝降级使用 macOS 原生 say 语音引擎
  ```

### 2. 启动服务
```bash
# 方案 A：通过根目录一键启动脚本 (自动校验环境、拉起 NapCat 与独立伴侣)
./start-dafeiyu.sh

# 方案 B：直接启动独立伴侣桌面模式
npm start

# 方案 C：抖音直播伴侣模式 (物理隐私隔离 + 弹幕驱动)
npm run start:live
```

启动完成后，打开浏览器访问 **`http://127.0.0.1:7788`** 即可进入深海赛博控制台。

### 3. 连接手机 QQ 机器人 (NapCatQQ)
1. 下载并运行 [NapCatQQ](https://napcat.org/)，登录备用小号并启用「正向 WebSocket 服务」（默认端口 `3001`）；
2. 在大肥鱼控制台 `http://127.0.0.1:7788` 的 **「QQ 网关与安全中心」** 输入 `ws://127.0.0.1:3001` 并点击连接；
3. 将小号拉入你的 QQ 群，发送 `@大肥鱼 跳个舞看看`，大肥鱼即刻在电脑桌面上起舞并在群内回复！

---

## 🧪 自动化测试与质量保障

项目配备了工业级的端到端与状态机测试套件，可直接使用 Node.js 内置 Test Runner 运行：

```bash
# 1. 运行状态图微内核与独立伴侣核心集成测试 (38 项全部通过，耗时 ~170ms)
npm run test:standalone

# 2. 运行思考大脑与 CLI 沙箱连通性诊断
npm run check:brain

# 3. 运行 M2 极限高压与语音延迟回归测试 (15 项全部通过)
node --test test/m2-challenger-stress.test.js

# 4. 运行全量核心单元测试 (210 项用例)
npm test
```

---

## 📁 项目目录结构

```
dsh-dafeiyu/
├── assets/                     # 角色 WebP 序列帧、音效与光标素材
├── native/                     # macOS 原生 AppKit 置顶窗口 Swift 源码
├── src/standalone/             # 独立伴侣核心工程
│   ├── brain/                  # 思考大脑：PromptBuilder、TaskExecutor、TTS、MemeManager
│   ├── console/                # Web 控制台服务器与现代化深海赛博 UI
│   ├── core/                   # 状态机 (StateManager)、生命周期调度器、配置加载器
│   ├── events/                 # 优先级事件队列与对话管线 (DialoguePipeline)
│   ├── gateway/                # OneBot v11 QQ 机器人网关与 QQOrchestrator
│   ├── graph/                  # 零依赖 StateGraph 微内核与 CompanionGraph 业务状态图
│   │   ├── engine.ts           # StateGraph、CompiledGraph、interrupt()、maxSteps
│   │   ├── sqlite-checkpointer.ts # 基于 node:sqlite 的断点持久化存储
│   │   ├── companion-graph.ts  # 7 大业务节点拓扑构建器
│   │   └── index.ts            # 状态图统一出口
│   ├── memory/                 # 五层分层记忆系统：L1 环形、L2 摘要、L3 情景、L4 事实、L5 日记
│   ├── persona/                # 五态情绪状态机、内心独白循环、伴侣生命周期控制
│   ├── safety/                 # 输入输出守卫、三级权限判定 (PermissionGuard)、审批流 (ApprovalManager)
│   └── sensors/                # 看家哨兵 (HomeWatchdog)、定时任务 (ReminderManager)、屏幕 OCR
├── test/                       # 核心单元测试
│   └── standalone/             # 独立伴侣与 StateGraph 状态图专项集成测试套件
└── scripts/                    # 启动、构建与诊断自动化脚本
```

---

## 📄 开源许可

本项目代码遵循 [MIT 许可证](LICENSE)。角色形象素材来自开源社区作品。
