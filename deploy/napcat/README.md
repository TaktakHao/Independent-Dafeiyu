# 🐱 NapCat-Headless for macOS

> 专为 **macOS（Apple Silicon / Intel）** 量身打造的 NapCatQQ 无头容器化、开机自愈、一键挂机部署套件。
> 适合将闲置的 Mac mini / MacBook / iMac 打造为 7x24 小时高可用的 QQ 机器人网关。

---

## ✨ 核心特性

- 🚀 **极简一键部署**：仅需单行命令，自动初始化数据持久化、自动生成配置、自动拉取官方最新镜像。
- 🍏 **Mac 挂机深度适配**：支持 Apple Silicon（M1/M2/M3/M4）与 Intel 芯片架构，针对闲置 Mac 挂机场景提供防休眠优化。
- 🔄 **开机自愈与故障重启**：配置容器 `unless-stopped` 守护，机器断电、系统重启或网络断线均可自愈。
- 📱 **远程 WebUI 扫码控制**：支持局域网其他设备直接访问 WebUI，免去连接显示器或 VNC 远程桌面的繁琐步骤。
- 💾 **凭证安全持久化**：QQ 登录 Session 独立保存在 `./data/qq`，升级镜像或重启系统终身免重复扫码。
- 🔌 **原生 OneBot v11 协议**：开箱即用，已预配置正向 WebSocket（端口 `3001`），无缝对接大肥鱼、NoneBot、Koishi 等主流机器人框架。

---

## 📋 前置要求

在运行前，请确保目标 Mac 上已安装容器环境：
- **强烈推荐**：[OrbStack](https://orbstack.dev/)（极其轻量、内存占用仅为官方 Docker Desktop 的 1/5，静音省电）
- **或官方版本**：[Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/)

---

## ⚡ 快速开始（三步极速就绪）

### 1. 克隆或下载本仓库
```bash
git clone <你的GitHub仓库地址>.git
cd napcat-standalone
```

### 2. 执行一键安装启动
```bash
chmod +x *.sh
./install.sh
```

### 3. 手机扫码登录
脚本执行完毕后，控制台会输出控制台地址：
- **本机访问**：`http://127.0.0.1:6099/webui?token=dafeiyu888`
- **局域网其他设备访问**：`http://<该Mac的IP>:6099/webui?token=dafeiyu888`

拿出手机 QQ 扫描网页中的二维码即可完成登录！

---

## 🛠️ 运维与管理常用命令

项目内置了便捷运维管理脚本 `./manage.sh`：

```bash
# 实时跟踪运行日志（扫码二维码与收发消息）
./manage.sh logs

# 查看容器运行状态与内存占用
./manage.sh status

# 重启机器人服务
./manage.sh restart

# 停止机器人
./manage.sh stop

# 拉取官方最新镜像并热升级
./manage.sh update
```

---

## 💤 挂机 Mac 防休眠配置

长期挂机的 Mac 建议配置防闲置深度睡眠，避免断开 Wi-Fi 导致掉线：

```bash
./prevent-sleep.sh
```
选择 `1` 即可将 Mac 配置为**长期挂机模式**（显示器定时关闭省电，但系统内核与网络持续活跃保持在线）。

---

## 🌐 端口与配置说明

| 端口号 | 协议 / 模式 | 作用说明 | 默认访问 Token |
| :--- | :--- | :--- | :--- |
| **`3001`** | WebSocket | OneBot v11 正向 WS 接入点 | 无（可自行在 `data/config/onebot11.json` 设置） |
| **`6099`** | HTTP / WebUI | NapCat 可视化管理后台与扫码面板 | `dafeiyu888`（可在 `docker-compose.yml` 修改） |

---

## 📄 目录结构

```text
napcat-standalone/
├── docker-compose.yml    # 标准容器编排定义
├── install.sh            # 一键自动化部署向导
├── manage.sh             # 日常启停、看日志、更新镜像运维工具
├── prevent-sleep.sh      # macOS 闲置挂机防休眠辅助
├── config/               # 预设配置文件模板 (onebot11.json / webui.json)
├── data/                 # 运行时数据目录 (自动生成，已加 .gitignore 保护凭证隐私)
│   ├── qq/               # QQ 登录凭证与会话持久化
│   └── config/           # NapCat 运行时配置
└── README.md             # 本说明文档
```

---

## 🔒 隐私与安全提示

- `./data/` 目录中包含敏感的 QQ 登录凭证，请勿将其上传到公开的 GitHub 仓库。
- 仓库已内置 `.gitignore`，默认会自动忽略 `data/` 目录。
