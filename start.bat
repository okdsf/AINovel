@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title NovelWeb
echo ========================================
echo   NovelWeb
echo   Starting / 正在启动...
echo ========================================
echo.

set MIN_NODE_MAJOR=18

REM ────────────────────────────────────────────────────────────────────
REM Step 1 — Check Node.js presence + version (>= 18 for Vite 8)
REM ────────────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    call :NodeMissing
    exit /b !errorlevel!
)

REM Parse "v20.10.0" → 20
for /f "tokens=*" %%i in ('node --version 2^>nul') do set NODE_VER=%%i
set NODE_VER=%NODE_VER:v=%
for /f "tokens=1 delims=." %%a in ("%NODE_VER%") do set NODE_MAJOR=%%a

if %NODE_MAJOR% LSS %MIN_NODE_MAJOR% (
    echo [!] Node.js %NODE_VER% is too old.
    echo [!] Node.js %NODE_VER% 版本太旧（需要 %MIN_NODE_MAJOR% 或以上）。
    echo.
    call :TryWingetInstall force
    exit /b !errorlevel!
)
goto :NodeOK

:NodeMissing
echo [!] Node.js not detected on this machine.
echo [!] 未检测到 Node.js。
echo.
call :TryWingetInstall fresh
exit /b !errorlevel!

:TryWingetInstall
where winget >nul 2>&1
if errorlevel 1 (
    echo Cannot auto-install — winget unavailable on this Windows.
    echo 无法自动安装 —— 当前 Windows 没有 winget。
    echo.
    echo Please install / upgrade Node.js manually from:
    echo 请手动安装/升级 Node.js：
    echo     https://nodejs.org/
    pause
    exit /b 1
)

if "%1"=="force" (
    echo Upgrading Node.js via winget...
    echo 通过 winget 升级 Node.js...
    winget install OpenJS.NodeJS.LTS --force --silent --accept-package-agreements --accept-source-agreements
) else (
    echo Installing Node.js via winget...
    echo 通过 winget 安装 Node.js...
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
)

if errorlevel 1 (
    echo.
    echo [X] winget operation failed. Please install Node.js manually:
    echo [X] winget 操作失败，请手动安装 Node.js：
    echo     https://nodejs.org/
    pause
    exit /b 1
)

echo.
echo ========================================
echo [✓] Node.js operation complete.
echo [✓] Node.js 操作完成。
echo.
echo PATH was updated — restart this script to pick up the new PATH.
echo PATH 已更新，请重启脚本以加载新 PATH。
echo Please double-click start.bat again. / 请重新双击 start.bat。
echo ========================================
pause
exit /b 0

:NodeOK
echo [✓] Node.js %NODE_VER% detected.

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
