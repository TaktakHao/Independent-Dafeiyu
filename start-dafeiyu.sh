#!/usr/bin/env bash
# ==============================================================================
# 🐋 CyberFish 大肥鱼桌面伴侣 & QQ NapCat 机器人一键全量启动脚本
# ==============================================================================

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

mkdir -p runtime/logs napcat-data/qq napcat-data/config

echo ""
echo "================================================================================"
echo "      🐋 CyberFish 大肥鱼桌面伴侣 & QQ 机器人 · 一键启动中..."
echo "================================================================================"
echo "  • 大肥鱼控制台:  http://127.0.0.1:7788"
echo "  • NapCat 控制台: http://127.0.0.1:6099/webui?token=dafeiyu888"
echo "  • QQ 直连端口:   ws://127.0.0.1:3001"
echo "================================================================================"
echo ""

# 1. 确保 OrbStack / Docker 正在运行
echo "🐳 [1/3] 正在检查 QQ 机器人容器 (NapCat)..."
if ! docker info >/dev/null 2>&1; then
  echo "⚡ 正在唤醒 OrbStack..."
  open -a OrbStack || true
  for k in {1..15}; do
    if docker info >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

# 检查容器状态
if ! docker ps -f name=dafeiyu-napcat --format '{{.Names}}' | grep -q "dafeiyu-napcat"; then
  echo "🚀 启动 NapCat 容器..."
  docker start dafeiyu-napcat 2>/dev/null || docker run -d \
    --name dafeiyu-napcat \
    --restart unless-stopped \
    -p 3001:3001 \
    -p 6099:6099 \
    -e MODE=ws \
    -e WEBUI_TOKEN=dafeiyu888 \
    -v "$PROJECT_DIR/napcat-data/qq:/app/.config/QQ" \
    -v "$PROJECT_DIR/napcat-data/config:/app/napcat/config" \
    mlikiowa/napcat-docker:latest
else
  echo "✅ NapCat 容器运行正常"
fi

# 2. 清理 7788 端口历史进程并启动大肥鱼
OLD_PID=$(lsof -ti :7788 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  echo "⚠️ 清理 7788 端口旧进程 (PID: $OLD_PID)..."
  kill -9 $OLD_PID 2>/dev/null || true
  sleep 1
fi

echo "🚀 [2/3] 正在启动大肥鱼伴侣进程..."
node --experimental-strip-types src/standalone/main.ts --mode companion > runtime/logs/companion.log 2>&1 &
MAIN_PID=$!

cleanup() {
  echo ""
  echo "🛑 正在停止大肥鱼伴侣..."
  kill -TERM "$MAIN_PID" 2>/dev/null || true
  wait "$MAIN_PID" 2>/dev/null || true
  echo "✅ 大肥鱼已安全休眠 🌙"
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# 3. 轮询等待大肥鱼控制台就绪
echo "⏳ 等待大肥鱼控制台就绪..."
for i in {1..20}; do
  if curl -s http://127.0.0.1:7788/ >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
echo "✅ [3/3] 服务全链路就绪！"

# 4. 自动在浏览器打开控制台与扫码页
if which open >/dev/null 2>&1; then
  open "http://127.0.0.1:7788"
  open "http://127.0.0.1:6099/webui?token=dafeiyu888"
fi

echo ""
echo "================================================================================"
echo "🎉 全套服务已一键就绪！"
echo "  1. 浏览器已自动打开【NapCat 控制台】，手机 QQ 扫码即可登录小号；"
echo "  2. 登录后回到【大肥鱼控制台】，点击「保存并连接 QQ 网关」即可完成配对；"
echo "  3. 将小号拉入 QQ 群，群友 @大肥鱼 或叫名字即可互动并在电脑屏幕上触发动作！"
echo "================================================================================"
echo "✨ 按 [Ctrl + C] 随时停止大肥鱼伴侣进程。"
echo ""

wait "$MAIN_PID"
