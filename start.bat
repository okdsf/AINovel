@echo off
setlocal enabledelayedexpansion
title NovelWeb

REM --------------------------------------------------------------------
REM IMPORTANT: This file is INTENTIONALLY ASCII-ONLY.
REM
REM Windows .bat files are parsed by cmd.exe using the SYSTEM ANSI
REM codepage (CP936 on Chinese Windows, CP1252 on English Windows, etc.)
REM regardless of "chcp 65001". A .bat with UTF-8 multibyte sequences
REM (e.g. Chinese characters) gets mojibaked and commands like "winget"
REM end up parsed as "nget" -- the kind of failure that wastes hours.
REM
REM Keep this file ASCII-only. Bilingual messages live in start.sh
REM (bash handles UTF-8 natively on macOS / Linux).
REM --------------------------------------------------------------------

echo ========================================
echo   NovelWeb
echo   Starting...
echo ========================================
echo.

set MIN_NODE_MAJOR=18

REM --------------------------------------------------------------------
REM Step 1 - Check Node.js presence + version (Vite 8 needs Node 18+)
REM --------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    call :NodeMissing
    exit /b !errorlevel!
)

for /f "tokens=*" %%i in ('node --version 2^>nul') do set NODE_VER=%%i
set NODE_VER=%NODE_VER:v=%
for /f "tokens=1 delims=." %%a in ("%NODE_VER%") do set NODE_MAJOR=%%a

if %NODE_MAJOR% LSS %MIN_NODE_MAJOR% (
    echo [!] Node.js %NODE_VER% is too old. Need Node %MIN_NODE_MAJOR% or newer.
    echo.
    call :TryWingetInstall force
    exit /b !errorlevel!
)
goto :NodeOK

:NodeMissing
echo [!] Node.js not detected on this machine.
echo.
call :TryWingetInstall fresh
exit /b !errorlevel!

:TryWingetInstall
where winget >nul 2>&1
if errorlevel 1 (
    echo Cannot auto-install -- winget is unavailable on this Windows.
    echo Please install or upgrade Node.js manually from:
    echo.
    echo     https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if "%1"=="force" (
    echo Upgrading Node.js via winget...
    winget install OpenJS.NodeJS.LTS --force --silent --accept-package-agreements --accept-source-agreements
) else (
    echo Installing Node.js via winget...
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
)

if errorlevel 1 (
    echo.
    echo [X] winget operation failed.
    echo     Please install Node.js manually:  https://nodejs.org/
    pause
    exit /b 1
)

echo.
echo ========================================
echo [OK] Node.js operation complete.
echo.
echo PATH was updated by the installer. This script needs to restart
echo to pick up the new PATH. Please double-click start.bat again.
echo ========================================
pause
exit /b 0

:NodeOK
echo [OK] Node.js %NODE_VER% detected.

REM --------------------------------------------------------------------
REM Step 2 - Check dependencies (npm sentinel)
REM --------------------------------------------------------------------
if not exist node_modules\.package-lock.json (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo [X] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo.
)

REM --------------------------------------------------------------------
REM Step 3 - Launch (fonts auto-downloaded by scripts/ensure-fonts.mjs)
REM --------------------------------------------------------------------
echo.
echo Frontend: http://localhost:5173
echo Backend:  http://localhost:3001
echo.
echo Press Ctrl+C to stop.
echo ========================================

REM Open browser after a short delay (gives the server time to start)
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5173"

call npm run dev
pause
