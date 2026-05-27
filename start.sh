#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# NovelWeb startup script for macOS / Linux
#
# Mirrors start.bat behavior:
#   1. Ensure Node.js >= 18 is installed (auto-install via the platform's
#      package manager when possible; otherwise direct user to nodejs.org)
#   2. Run `npm install` if node_modules is missing or incomplete
#   3. Launch the dev server
#
# Usage:
#   bash start.sh
#   # or, if executable bit is set:
#   ./start.sh
# ──────────────────────────────────────────────────────────────────────

MIN_NODE_MAJOR=18

cd "$(dirname "$0")"

echo "========================================"
echo "  NovelWeb"
echo "  Starting / 正在启动..."
echo "========================================"
echo ""

# ── helpers ────────────────────────────────────────────────────────────
have()    { command -v "$1" >/dev/null 2>&1; }
node_ok() { have node && [ "$(node --version | sed 's/^v//' | cut -d. -f1)" -ge "$MIN_NODE_MAJOR" ]; }

manual_install_msg() {
    echo "Please install / upgrade Node.js >= $MIN_NODE_MAJOR manually:"
    echo "请手动安装 / 升级 Node.js >= $MIN_NODE_MAJOR："
    echo ""
    echo "    https://nodejs.org/"
    echo ""
    echo "Or via a version manager such as nvm:"
    echo "或使用 nvm 之类的版本管理器："
    echo ""
    echo "    https://github.com/nvm-sh/nvm"
}

install_node_macos() {
    if have brew; then
        echo "Installing / upgrading Node via Homebrew..."
        echo "通过 Homebrew 安装/升级 Node..."
        brew install node 2>/dev/null || brew upgrade node || true
    else
        echo "Homebrew not found. Install Homebrew first:"
        echo "未找到 Homebrew，请先安装："
        echo ""
        echo "    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        echo ""
        manual_install_msg
        return 1
    fi
}

install_node_linux() {
    if have apt; then
        echo "Detected apt — using NodeSource setup for Node $MIN_NODE_MAJOR LTS."
        echo "检测到 apt，使用 NodeSource 安装当前 LTS Node。"
        echo "(Will prompt for sudo password / 需要 sudo 密码)"
        echo ""
        if ! have curl; then
            sudo apt update && sudo apt install -y curl
        fi
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt install -y nodejs
    elif have dnf; then
        echo "Detected dnf / 检测到 dnf"
        sudo dnf install -y nodejs npm
    elif have pacman; then
        echo "Detected pacman / 检测到 pacman"
        sudo pacman -S --noconfirm nodejs npm
    elif have zypper; then
        echo "Detected zypper / 检测到 zypper"
        sudo zypper install -y nodejs npm
    else
        echo "[X] No known package manager (apt / dnf / pacman / zypper) detected."
        echo "[X] 未识别到任何已知的包管理器。"
        echo ""
        manual_install_msg
        return 1
    fi
}

# ── Step 1: Node.js presence + version ────────────────────────────────
if node_ok; then
    NODE_VER=$(node --version | sed 's/^v//')
    echo "[✓] Node.js $NODE_VER detected."
else
    if have node; then
        NODE_VER=$(node --version | sed 's/^v//')
        echo "[!] Node.js $NODE_VER is too old (need >= $MIN_NODE_MAJOR)."
        echo "[!] Node.js $NODE_VER 版本太旧（需要 $MIN_NODE_MAJOR 或以上）。"
    else
        echo "[!] Node.js not detected."
        echo "[!] 未检测到 Node.js。"
    fi
    echo ""

    OS=$(uname -s)
    case "$OS" in
        Darwin) install_node_macos || exit 1 ;;
        Linux)  install_node_linux || exit 1 ;;
        *)
            echo "[X] Unsupported OS: $OS"
            echo "[X] 不支持的系统: $OS"
            echo ""
            manual_install_msg
            exit 1
            ;;
    esac

    echo ""
    # Re-check after install attempt
    if node_ok; then
        NODE_VER=$(node --version | sed 's/^v//')
        echo "[✓] Node.js $NODE_VER ready."
    else
        echo "[X] Node still missing or too old after install attempt."
        echo "[X] 安装尝试后 Node 仍然缺失或版本太旧。"
        echo ""
        manual_install_msg
        echo ""
        echo "If you just installed Node, you may need to restart your shell."
        echo "如果刚装完 Node，请重启终端再运行 bash start.sh。"
        exit 1
    fi
fi

# ── Step 2: dependencies ──────────────────────────────────────────────
if [ ! -f node_modules/.package-lock.json ]; then
    echo ""
    echo "Installing dependencies / 正在安装依赖..."
    npm install || { echo "[X] npm install failed. / npm install 失败"; exit 1; }
fi

# ── Step 3: pick free ports so multiple instances can coexist ──────────
# find-ports.mjs probes upward from the defaults (5173 / 3001) and prints
# KEY=VALUE lines. If another NovelWeb is already running, it hands back the
# next free pair; vite.config.js + server/index.js read these env vars so the
# frontend proxy always targets this instance's backend.
NOVELWEB_WEB_PORT=5173
NOVELWEB_API_PORT=3001
while IFS='=' read -r k v; do
    [ -n "$k" ] && export "$k=$v"
done < <(node scripts/find-ports.mjs 2>/dev/null)

if [ "$NOVELWEB_WEB_PORT" != "5173" ]; then
    echo "[i] Ports 5173/3001 busy — another instance is running."
    echo "    Using free ports instead. / 检测到已有实例，改用空闲端口。"
fi

# ── Step 4: launch ────────────────────────────────────────────────────
echo ""
echo "Frontend / 前端: http://localhost:$NOVELWEB_WEB_PORT"
echo "Backend  / 后端: http://localhost:$NOVELWEB_API_PORT"
echo ""
echo "Press Ctrl+C to stop. / 按 Ctrl+C 停止服务"
echo "========================================"

# Open browser after a brief delay (gives the server time to spin up)
(
    sleep 3
    if have open; then
        open "http://localhost:$NOVELWEB_WEB_PORT" 2>/dev/null
    elif have xdg-open; then
        xdg-open "http://localhost:$NOVELWEB_WEB_PORT" 2>/dev/null
    fi
) &

exec npm run dev
