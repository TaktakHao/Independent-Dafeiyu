#!/usr/bin/env bash
# ==============================================================================
# 🛠️ NapCat-Headless 运维管理快捷工具
# ==============================================================================

set -e

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BASE_DIR"

CONTAINER_NAME="napcat-server"

usage() {
  echo "用法: ./manage.sh [start|stop|restart|logs|status|update]"
  echo ""
  echo "可用命令:"
  echo "  start    - 启动 NapCat 容器"
  echo "  stop     - 停止 NapCat 容器"
  echo "  restart  - 重启 NapCat 服务"
  echo "  logs     - 实时查看运行日志 (按 Ctrl+C 退出)"
  echo "  status   - 查看容器运行状态与内存占用"
  echo "  update   - 拉取官方最新镜像并重启"
  echo ""
  exit 1
}

case "$1" in
  start)
    echo "🚀 正在启动 $CONTAINER_NAME..."
    docker start "$CONTAINER_NAME" 2>/dev/null || ./install.sh
    echo "✅ 已启动"
    ;;
  stop)
    echo "🛑 正在停止 $CONTAINER_NAME..."
    docker stop "$CONTAINER_NAME"
    echo "✅ 已安全停止"
    ;;
  restart)
    echo "🔄 正在重启 $CONTAINER_NAME..."
    docker restart "$CONTAINER_NAME"
    echo "✅ 重启完成"
    ;;
  logs)
    echo "📋 正在跟踪容器日志 (按 Ctrl+C 退出)..."
    docker logs -f --tail 100 "$CONTAINER_NAME"
    ;;
  status)
    echo "📊 容器状态:"
    docker ps -f "name=$CONTAINER_NAME"
    echo ""
    echo "📈 资源占用:"
    docker stats --no-stream "$CONTAINER_NAME" 2>/dev/null || echo "容器未运行"
    ;;
  update)
    echo "🔄 正在拉取 NapCat 官方最新镜像..."
    docker pull mlikiowa/napcat-docker:latest
    echo "🚀 重新应用部署..."
    ./install.sh
    echo "✅ 已更新并重启至最新版本！"
    ;;
  *)
    usage
    ;;
esac
