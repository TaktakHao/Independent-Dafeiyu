#!/usr/bin/env bash
# ==============================================================================
# 💤 macOS 挂机防休眠与常驻优化配置脚本
# ==============================================================================

set -e

GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
BOLD="\033[1m"
RESET="\033[0m"

echo -e "${CYAN}${BOLD}"
echo "================================================================================"
echo "    🍏 macOS 闲置挂机电源策略优化工具"
echo "================================================================================"
echo -e "${RESET}"

echo "本脚本将帮助你的 Mac 在闲置、锁屏、合盖（需接电源）时保持网络与后台服务活跃，"
echo "避免因系统深度睡眠导致 QQ 掉线。"
echo ""

echo -e "${YELLOW}请选择操作:${RESET}"
echo "1) 设置【长期挂机模式】（显示器可关，系统不休眠，连接网络不中断，需输入密码授权）"
echo "2) 临时挂机保持（使用系统的 caffeinate 命令，窗口关闭即恢复，不改动系统配置）"
echo "3) 恢复 macOS 默认电源节能配置"
echo "4) 退出"
echo ""
read -r -p "请输入序号 [1-4]: " choice

case "$choice" in
  1)
    echo "⚡ 正在配置系统电源管理策略..."
    # sleep 0: 关闭闲置系统睡眠
    # tcpkeepalive 1: 保持网络连接不断
    # displaysleep 10: 10分钟后自动关闭显示器以节能
    sudo pmset -a sleep 0
    sudo pmset -a tcpkeepalive 1
    sudo pmset -a displaysleep 10
    echo -e "${GREEN}✅ 设置成功！Mac 现在闲置时将保持内核与网络活跃，同时屏幕仍会自动关屏省电。${RESET}"
    ;;
  2)
    echo -e "${GREEN}☕ 已启动 caffeinate 临时防休眠模式！${RESET}"
    echo "此终端窗口保持打开状态即可阻止 Mac 休眠；按 [Ctrl+C] 随时退出恢复正常。"
    caffeinate -disu
    ;;
  3)
    echo "🔄 正在恢复系统默认电源设置..."
    sudo pmset -a sleep 15
    sudo pmset -a displaysleep 10
    echo -e "${GREEN}✅ 已恢复系统默认休眠配置。${RESET}"
    ;;
  *)
    echo "已取消。"
    exit 0
    ;;
esac
