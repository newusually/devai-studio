@echo off
rem ============================================================================
rem  DevAI Studio —— 修复快捷方式指向 launcher.exe（而不是 DevAI Studio.exe）
rem ----------------------------------------------------------------------------
rem  背景（2026-10-26）：本机 WorkBuddy 会话会注入 ELECTRON_RUN_AS_NODE=1，
rem  直接运行 "DevAI Studio.exe" 会让它退化成纯 node（无窗口、秒退）。
rem  launcher.exe 的唯一职责就是剥掉该变量再拉起主程序。
rem  所以桌面/开始菜单快捷方式必须指向 launcher.exe。
rem ============================================================================
setlocal enabledelayedexpansion

set "APP_NAME=DevAI Studio"
set "INSTALL_DIR=%LOCALAPPDATA%\Programs\%APP_NAME%"
set "LAUNCHER=%INSTALL_DIR%\launcher.exe"
set "ICON_ICO=%INSTALL_DIR%\resources\icon.ico"

if not exist "%ICON_ICO%" set "ICON_ICO=%INSTALL_DIR%\DevAI Studio.exe,0"

if not exist "%LAUNCHER%" (
  echo [ERROR] 未找到 %LAUNCHER%
  exit /b 1
)

echo [1/3] 目标启动器: %LAUNCHER%

rem ---------- 桌面快捷方式 ----------
set "DESKTOP=%USERPROFILE%\Desktop"
if not exist "%DESKTOP%" set "DESKTOP=%USERPROFILE%\OneDrive\Desktop"
set "SHORTCUT=%DESKTOP%\%APP_NAME%.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath='%LAUNCHER%';" ^
  "$s.WorkingDirectory='%INSTALL_DIR%';" ^
  "$s.IconLocation='%ICON_ICO%';" ^
  "$s.Description='%APP_NAME% — 免费开源的本地 AI 编程助手';" ^
  "$s.Save()" 2>nul

if exist "%SHORTCUT%" (echo [2/3] OK 桌面快捷方式已指向 launcher.exe) else (echo [2/3] FAIL 桌面快捷方式)

rem ---------- 开始菜单 ----------
set "STARTMENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\%APP_NAME%"
if not exist "%STARTMENU%" mkdir "%STARTMENU%" 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTMENU%\%APP_NAME%.lnk');" ^
  "$s.TargetPath='%LAUNCHER%';" ^
  "$s.WorkingDirectory='%INSTALL_DIR%';" ^
  "$s.IconLocation='%ICON_ICO%';" ^
  "$s.Description='%APP_NAME% — 免费开源的本地 AI 编程助手';" ^
  "$s.Save()" 2>nul

if exist "%STARTMENU%\%APP_NAME%.lnk" (echo [3/3] OK 开始菜单快捷方式已指向 launcher.exe) else (echo [3/3] FAIL 开始菜单)

echo.
echo 完成。今后请通过桌面/开始菜单快捷方式启动（内部走 launcher.exe）。
exit /b 0
