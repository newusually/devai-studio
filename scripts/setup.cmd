# ============================================================================
#  DevAI Studio —— 两台电脑部署脚本
# ----------------------------------------------------------------------------
#  用法：把整个 dev-ai 文件夹拷到第二台电脑，双击本脚本即可。
#
#  脚本做 4 件事：
#   ① 检查 Node.js（没有就用 E 盘那份；有就用系统的）
#   ② 检查 Ollama（没有就装到 F:\dev-ai\ollama）
#   ③ 安装依赖 + 构建
#   ④ 拉取本地免费模型（中文 qwen3:4b + 代码 qwen2.5-coder:7b）
#
#  模型会下到 F:\ollama-models（不在 C 盘）。
# ============================================================================
@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
set "NODE_DIR=E:\dev\nodejs"
set "OLLAMA_DIR=F:\dev-ai\ollama"
set "MODELS_DIR=F:\ollama-models"

echo.
echo ============================================================
echo   DevAI Studio 部署脚本
echo ============================================================
echo.

REM ---------- ① Node.js ----------
echo [1/4] 检查 Node.js...
set "NODE_EXE="
if exist "%NODE_DIR%\node.exe" (
  set "NODE_EXE=%NODE_DIR%\node.exe"
  echo       找到 E 盘 Node: %NODE_EXE%
) else (
  where node >nul 2>&1
  if %ERRORLEVEL%==0 (
    for /f "delims=" %%i in ('where node') do (
      if not defined NODE_EXE set "NODE_EXE=%%i"
    )
    echo       找到系统 Node: %NODE_EXE%
  )
)

if not defined NODE_EXE (
  echo       [X] 没找到 Node.js
  echo.
  echo       请下载 Node.js 20+ 并安装到 E:\dev\nodejs：
  echo       https://nodejs.org/zh-cn/download
  echo.
  echo       或直接安装默认路径即可（脚本会自动识别）。
  pause
  exit /b 1
)

for %%i in ("%NODE_EXE%") do set "NODE_DIR=%%~dpi"
echo       版本:
"%NODE_EXE%" -v

REM ---------- ② Ollama ----------
echo.
echo [2/4] 检查 Ollama...
set "OLLAMA_EXE="
if exist "%OLLAMA_DIR%\ollama.exe" (
  set "OLLAMA_EXE=%OLLAMA_DIR%\ollama.exe"
  echo       找到 F 盘 Ollama
) else (
  where ollama >nul 2>&1
  if %ERRORLEVEL%==0 (
    for /f "delims=" %%i in ('where ollama') do (
      if not defined OLLAMA_EXE set "OLLAMA_EXE=%%i"
    )
    echo       找到系统 Ollama: %OLLAMA_EXE%
  ) else (
    echo       没找到 Ollama，请先安装：https://ollama.com/download
    echo       安装后重新运行本脚本即可。
    pause
    exit /b 1
  )
)

if not exist "%MODELS_DIR%" mkdir "%MODELS_DIR%" 2>nul

REM ---------- ③ 安装依赖 + 构建 ----------
echo.
echo [3/4] 安装依赖并构建（首次约 3-5 分钟）...
cd /d "%ROOT%"
call "%NODE_EXE%" -e "process.exit(0)"
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo       [X] npm install 失败
  pause
  exit /b 1
)

REM npm 11 默认拦截 install scripts（electron/esbuild 的 postinstall）
call npm install-scripts approve electron esbuild >nul 2>&1
call npm rebuild electron esbuild >nul 2>&1

call npm run build
if errorlevel 1 (
  echo       [X] 构建失败
  pause
  exit /b 1
)
echo       构建完成

REM ---------- ④ 拉模型 ----------
echo.
echo [4/4] 拉取本地免费模型（中文 + 代码）...
set "OLLAMA_MODELS=%MODELS_DIR%"
set "OLLAMA_HOST=127.0.0.1:11434"

REM 先确保 ollama 服务在跑
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find "ollama.exe" >nul
if errorlevel 1 (
  echo       启动 Ollama 服务...
  start "" /min "%OLLAMA_EXE%" serve
  timeout /t 6 /nobreak >nul
)

"%OLLAMA_EXE%" list 2>nul | find "qwen3:4b" >nul
if errorlevel 1 (
  echo       下载 qwen3:4b （中文强，2.5GB）...
  "%OLLAMA_EXE%" pull qwen3:4b
) else (
  echo       qwen3:4b 已存在
)

"%OLLAMA_EXE%" list 2>nul | find "qwen2.5-coder:7b" >nul
if errorlevel 1 (
  echo       下载 qwen2.5-coder:7b （代码专用，4.7GB）...
  "%OLLAMA_EXE%" pull qwen2.5-coder:7b
) else (
  echo       qwen2.5-coder:7b 已存在
)

echo.
echo ============================================================
echo   部署完成！
echo.
echo   启动方式：双击 scripts\start.cmd
echo   安装包：  npm run dist  → release\DevAI-Studio-Setup-1.0.0-x64.exe
echo   模型目录：%MODELS_DIR%
echo ============================================================
echo.
pause
