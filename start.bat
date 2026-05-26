@echo off
chcp 65001 >nul
title NovelWeb - AI小说工作台
echo ========================================
echo   NovelWeb - AI小说工作台
echo   正在启动...
echo ========================================
echo.

REM Use npm's own sentinel — only present after a successful install.
REM Plain "if not exist node_modules" misses half-installed states.
if not exist node_modules\.package-lock.json (
    echo   正在安装依赖，请稍候...
    npm install
    echo.
)

echo   前端: http://localhost:5173
echo   后端: http://localhost:3001
echo.
echo   按 Ctrl+C 停止服务
echo ========================================
npm run dev
pause
