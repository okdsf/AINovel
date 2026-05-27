@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title NovelWeb
echo ========================================
echo   NovelWeb
echo   Starting / 正在启动...
echo ========================================
echo.

REM ────────────────────────────────────────────────────────────────────
REM Step 1 — Check Node.js
REM ────────────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo [!] Node.js not detected on this machine.
    echo [!] 未检测到 Node.js。
    echo.

    REM Check whether winget is available (built-in on Win 10 1809+ / Win 11)
    where winget >nul 2>&1
    if errorlevel 1 (
        echo Cannot auto-install — winget unavailable on this Windows.
        echo 无法自动安装 —— 当前 Windows 没有 winget。
        echo.
        echo Please install Node.js manually from:
        echo 请手动从以下地址安装 Node.js：
        echo.
        echo     https://nodejs.org/
        echo.
        echo Then re-run start.bat. / 安装后重新运行 start.bat。
        pause
        exit /b 1
    )

    echo Attempting to install Node.js via winget...
    echo 正在通过 winget 自动安装 Node.js...
    echo.
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo.
        echo [X] winget install failed. Please install Node.js manually:
        echo [X] winget 安装失败，请手动安装 Node.js：
        echo     https://nodejs.org/
        pause
        exit /b 1
    )

    echo.
    echo ========================================
    echo [✓] Node.js installed successfully.
    echo [✓] Node.js 安装完成。
    echo.
    echo PATH was updated by the installer — this script needs to restart
    echo to pick up the new PATH. Please double-click start.bat again.
    echo.
    echo 系统 PATH 已更新，本脚本需要重启以加载新 PATH。
    echo 请重新双击 start.bat。
    echo ========================================
    pause
    exit /b 0
)

REM ────────────────────────────────────────────────────────────────────
REM Step 2 — Check node_modules (use npm's own install-success sentinel)
REM ────────────────────────────────────────────────────────────────────
if not exist node_modules\.package-lock.json (
    echo Installing dependencies / 正在安装依赖，请稍候...
    call npm install
    if errorlevel 1 (
        echo.
        echo [X] npm install failed. Check your internet connection.
        echo [X] npm install 失败，请检查网络连接。
        pause
        exit /b 1
    )
    echo.
)

REM ────────────────────────────────────────────────────────────────────
REM Step 3 — Launch
REM   (Fonts are auto-downloaded on first run by scripts/ensure-fonts.mjs)
REM ────────────────────────────────────────────────────────────────────
echo Frontend / 前端: http://localhost:5173
echo Backend  / 后端: http://localhost:3001
echo.
echo Press Ctrl+C to stop. / 按 Ctrl+C 停止服务
echo ========================================

REM Open browser after a short delay (gives server time to start)
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5173"

call npm run dev
pause
