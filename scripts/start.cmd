@echo off
rem ============================================================================
rem  DevAI Studio 启动脚本（Windows）
rem ----------------------------------------------------------------------------
rem  ★关键：必须清除 ELECTRON_RUN_AS_NODE
rem     部分 IDE / CI 环境会设置 ELECTRON_RUN_AS_NODE=1，
rem     那会让 Electron 退化成纯 Node（require('electron') 拿不到 app 对象），
rem     表现为 "Cannot read properties of undefined (reading 'isPackaged')"。
rem ============================================================================
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE=1"

cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] 未找到 Electron，请先执行: npm install
  pause
  exit /b 1
)

REM 打包后的可执行文件直接启动，开发模式走 electron.exe .
if exist "dist\main\index.js" (
  if exist "%~dp0node_modules\.bin\electron.cmd" (
    call "%~dp0node_modules\.bin\electron.cmd" "%~dp0" %*
  ) else (
    "%~dp0node_modules\electron\dist\electron.exe" "%~dp0" %*
  )
) else (
  echo [ERROR] 未构建，请先执行: npm run build
  pause
  exit /b 1
)
