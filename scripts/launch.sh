#!/usr/bin/env bash
# ==============================================================================
# CyberFish Daughter (大肥鱼独立伴侣) 一键启动器
# ==============================================================================

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "=========================================================="
echo " 🐋 CyberFish Daughter (大肥鱼赛博女儿) 独立版 v2.0"
echo "=========================================================="

# 1. 检查 Node.js 环境
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js，请先安装 Node.js 22+ (推荐 22.x/26.x)"
  exit 1
fi

NODE_MAJOR=$(node -v | cut -d'.' -f1 | sed 's/v//')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "⚠️ 当前 Node.js 版本为 $(node -v)，建议使用 v22+ 获得原生类型支持"
fi

# 2. 检查并编译 macOS 原生 Helper (如果不存在)
HELPER_BIN="runtime/bin/darwin/dsh-dafeiyu-helper.app/Contents/MacOS/dsh-dafeiyu-helper"
if [ ! -f "$HELPER_BIN" ]; then
  echo "🔨 未检测到原生动画渲染 Helper，正在自动编译..."
  npm run build:native
fi

# 3. 检查语音合成引擎
if command -v edge-tts >/dev/null 2>&1; then
  echo "🎙️ 语音引擎: Edge-TTS (微软云端小艺音色已就绪)"
else
  echo "🎙️ 语音引擎: macOS 原生 say 语音引擎 (建议: pip3 install edge-tts 以获得超拟人女声)"
fi

# 4. 解析运行模式参数
MODE="companion"
HEADLESS=""

for arg in "$@"; do
  case $arg in
    --live|-l)
      MODE="live"
      shift
      ;;
    --headless|-h)
      HEADLESS="--headless"
      shift
      ;;
    *)
      ;;
  esac
done

MODE_UPPER=$(echo "$MODE" | tr '[:lower:]' '[:upper:]')
echo "🚀 启动模式: [${MODE_UPPER}]"
if [ "$MODE" = "live" ]; then
  echo "📺 主播安全控制台地址: http://127.0.0.1:7788"
  echo "🔒 直播物理隐私隔离已自动激活"
fi

echo "=========================================================="
echo ""

if [ -n "$HEADLESS" ]; then
  exec node --experimental-strip-types src/standalone/main.ts --mode "$MODE" --headless
else
  exec node --experimental-strip-types src/standalone/main.ts --mode "$MODE"
fi
