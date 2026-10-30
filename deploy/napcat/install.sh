#!/usr/bin/env bash
# ==============================================================================
# 🐱 NapCat-Headless: macOS 专属一键自动安装与挂机启动脚本
# ==============================================================================

set -e

# 获取脚本所在根目录
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BASE_DIR"

# 终端彩色输出定义
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RED="\033[31m"
BOLD="\033[1m"
RESET="\033[0m"

echo -e "${CYAN}${BOLD}"
echo "================================================================================"
echo "    🐱 NapCat-Headless for Mac · 一键挂机自动化部署向导"
echo "================================================================================"
echo -e "${RESET}"

# 1. 检查操作系统与架构
OS="$(uname -s)"
ARCH="$(uname -m)"
echo -e "${YELLOW}🔍 [1/5] 检查系统环境...${RESET}"
echo "  • 系统内核: $OS"
echo "  • 芯片架构: $ARCH"

if [ "$OS" != "Darwin" ] && [ "$OS" != "Linux" ]; then
  echo -e "${RED}❌ 错误: 本脚本仅支持 macOS 或 Linux 系统。${RESET}"
  exit 1
fi

# 2. 检查并确保 Docker / OrbStack 就绪
echo -e "${YELLOW}🐳 [2/5] 检查容器引擎 (Docker / OrbStack)...${RESET}"
if ! command -v docker >/dev/null 2>&1; then
  echo -e "${RED}❌ 未检测到 Docker 命令行工具！${RESET}"
  echo "👉 强烈建议在 Mac 上安装轻量级、低能耗的 OrbStack: https://orbstack.dev"
  echo "   或者安装 Docker Desktop: https://www.docker.com/products/docker-desktop/"
  exit 1
fi

# 检查 Docker 守护进程是否已启动
if ! docker info >/dev/null 2>&1; then
  echo -e "⚡ 正在尝试唤醒 Docker 服务..."
  if [ "$OS" = "Darwin" ]; then
    open -a OrbStack 2>/dev/null || open -a Docker 2>/dev/null || true
  fi
  
  WAIT_SUCCESS=false
  for i in {1..20}; do
    if docker info >/dev/null 2>&1; then
      WAIT_SUCCESS=true
      break
    fi
    echo -n "."
    sleep 1
  done
  echo ""

  if [ "$WAIT_SUCCESS" != "true" ]; then
    echo -e "${RED}❌ 无法连接到 Docker 守护进程，请先手动启动 OrbStack 或 Docker Desktop。${RESET}"
    exit 1
  fi
fi
echo -e "${GREEN}✅ Docker 引擎运行正常！${RESET}"

# 3. 初始化持久化存储与配置
echo -e "${YELLOW}📁 [3/5] 初始化持久化数据目录...${RESET}"
mkdir -p "$BASE_DIR/data/qq"
mkdir -p "$BASE_DIR/data/config"

# 如果配置目录不存在默认文件，则从预设模板复制
if [ ! -f "$BASE_DIR/data/config/webui.json" ]; then
  if [ -f "$BASE_DIR/config/webui.json" ]; then
    cp "$BASE_DIR/config/webui.json" "$BASE_DIR/data/config/webui.json"
  fi
fi

if [ ! -f "$BASE_DIR/data/config/onebot11.json" ]; then
  if [ -f "$BASE_DIR/config/onebot11.json" ]; then
    cp "$BASE_DIR/config/onebot11.json" "$BASE_DIR/data/config/onebot11.json"
  fi
fi
echo -e "${GREEN}✅ 持久化目录与预设配置初始化就绪。${RESET}"

# 4. 端口占用检查
echo -e "${YELLOW}🔌 [4/5] 检查端口占用 (3001, 6099)...${RESET}"
check_port() {
  local port=$1
  if lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    local p_info
    p_info=$(lsof -ti :"$port" 2>/dev/null | tr '\n' ' ')
    # 检查是否已经是当前容器占用的端口
    if ! docker ps -q --filter "name=napcat-server" | grep -q . ; then
      echo -e "${YELLOW}⚠️ 警告: 端口 $port 已被本地进程占用 (PID: $p_info)。如果不是当前 NapCat 容器，请先释放端口。${RESET}"
    fi
  fi
}
check_port 3001
check_port 6099

# 5. 启动或更新 NapCat 容器服务
echo -e "${YELLOW}🚀 [5/5] 部署并启动 NapCat 挂机服务...${RESET}"
if command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker-compose"
elif docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker compose"
else
  DOCKER_COMPOSE_CMD=""
fi

if [ -n "$DOCKER_COMPOSE_CMD" ]; then
  $DOCKER_COMPOSE_CMD up -d
else
  # 兼容纯 docker run 运行
  docker stop napcat-server 2>/dev/null || true
  docker rm napcat-server 2>/dev/null || true
  docker run -d \
    --name napcat-server \
    --restart unless-stopped \
    -p 3001:3001 \
    -p 6099:6099 \
    -e MODE=ws \
    -e WEBUI_TOKEN=dafeiyu888 \
    -v "$BASE_DIR/data/qq:/app/.config/QQ" \
    -v "$BASE_DIR/data/config:/app/napcat/config" \
    mlikiowa/napcat-docker:latest
fi

# 获取本机局域网 IP
LAN_IP="127.0.0.1"
if [ "$OS" = "Darwin" ]; then
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1")
else
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
fi

WEBUI_LOCAL_URL="http://127.0.0.1:6099/webui?token=dafeiyu888"
WEBUI_LAN_URL="http://${LAN_IP}:6099/webui?token=dafeiyu888"
WS_LAN_URL="ws://${LAN_IP}:3001"

echo ""
echo -e "${GREEN}${BOLD}================================================================================"
echo "🎉 NapCat 挂机服务已成功启动并常驻后台！"
echo "================================================================================"
echo -e "${RESET}"
echo -e "📱 ${BOLD}【手机 QQ 扫码登录】${RESET}"
echo -e "   • 本机快速打开:  ${CYAN}${WEBUI_LOCAL_URL}${RESET}"
echo -e "   • 局域网其他电脑: ${CYAN}${WEBUI_LAN_URL}${RESET}"
echo ""
echo -e "🔗 ${BOLD}【机器人连接地址 (OneBot v11 正向 WS)】${RESET}"
echo -e "   • 本机连接:     ${CYAN}ws://127.0.0.1:3001${RESET}"
echo -e "   • 远程连接:     ${CYAN}${WS_LAN_URL}${RESET}"
echo ""
echo -e "⚙️ ${BOLD}【开机与断网自愈说明】${RESET}"
echo "   • 容器已配置 --restart unless-stopped，系统重启或断线会自动拉起并重连！"
echo "   • 登录成功后，数据已保存在 ./data/ 目录中，终身免重复扫码。"
echo "================================================================================"
echo ""

# 如果在有图形界面的 Mac 上，自动打开扫码页面
if [ "$OS" = "Darwin" ] && command -v open >/dev/null 2>&1; then
  echo "🌐 正在为你自动打开扫码控制台..."
  open "$WEBUI_LOCAL_URL" 2>/dev/null || true
fi
