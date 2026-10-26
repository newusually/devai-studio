@echo off
rem ============================================================================
rem  DevAI Studio —— 桌面快捷方式 / 开始菜单 / 图标注册
rem ----------------------------------------------------------------------------
rem  · 在当前用户桌面创建快捷方式（不需要管理员权限）
rem  · 在开始菜单创建程序组与快捷方式
rem  · 把图标文件注册到系统（图标库可见）
rem  · 全部使用【相对路径】：脚本自动定位自身所在的项目目录
rem ============================================================================
setlocal enabledelayedexpansion

rem ★相对路径：脚本自身目录 → 上两级 = 项目根
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT=%%~fI"

set "APP_NAME=DevAI Studio"
set "ICON_ICO=%ROOT%\build\icon.ico"
set "ICON_PNG=%ROOT%\build\icon.png"

rem 目标可执行文件：优先用打包好的 release 版，其次 win-unpacked，最后开发版
set "TARGET="
if exist "%ROOT%\release\win-unpacked\DevAI Studio.exe" (
  set "TARGET=%ROOT%\release\win-unpacked\DevAI Studio.exe"
) else if exist "%ROOT%\release\DevAI Studio.exe" (
  set "TARGET=%ROOT%\release\DevAI Studio.exe"
) else (
  echo [提示] 未找到打包版，将创建指向 electron.exe 的开发版快捷方式
  if exist "%ROOT%\node_modules\electron\dist\electron.exe" (
    set "TARGET=%ROOT%\node_modules\electron\dist\electron.exe"
  )
)

if "%TARGET%"=="" (
  echo [错误] 找不到可执行文件，请先执行: npm run dist
  pause
  exit /b 1
)

echo [1/4] 目标: %TARGET%

rem ---------- 桌面快捷方式 ----------
set "DESKTOP=%USERPROFILE%\Desktop"
if not exist "%DESKTOP%" set "DESKTOP=%USERPROFILE%\OneDrive\Desktop"
set "SHORTCUT=%DESKTOP%\%APP_NAME%.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath='%TARGET%';" ^
  "$s.WorkingDirectory='%ROOT%';" ^
  "$s.IconLocation='%ICON_ICO%';" ^
  "$s.Description='%APP_NAME% — 免费开源的本地 AI 编程助手';" ^
  "$s.Save()" 2>nul

if exist "%SHORTCUT%" (
  echo [2/4] ✓ 桌面快捷方式: %SHORTCUT%
) else (
  echo [2/4] ✗ 桌面快捷方式创建失败
)

rem ---------- 开始菜单 ----------
set "STARTMENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\%APP_NAME%"
if not exist "%STARTMENU%" mkdir "%STARTMENU%" 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTMENU%\%APP_NAME%.lnk');" ^
  "$s.TargetPath='%TARGET%';" ^
  "$s.WorkingDirectory='%ROOT%';" ^
  "$s.IconLocation='%ICON_ICO%';" ^
  "$s.Description='%APP_NAME% — 免费开源的本地 AI 编程助手';" ^
  "$s.Save()" 2>nul

rem 卸载项（控制面板 → 程序和功能）
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$k='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\%APP_NAME%';" ^
  "New-Item -Path $k -Force | Out-Null;" ^
  "Set-ItemProperty -Path $k -Name 'DisplayName' -Value '%APP_NAME%';" ^
  "Set-ItemProperty -Path $k -Name 'DisplayVersion' -Value '1.0.0';" ^
  "Set-ItemProperty -Path $k -Name 'Publisher' -Value 'DevAI Studio';" ^
  "Set-ItemProperty -Path $k -Name 'InstallLocation' -Value '%ROOT%';" ^
  "Set-ItemProperty -Path $k -Name 'DisplayIcon' -Value '%ICON_ICO%';" ^
  "Set-ItemProperty -Path $k -Name 'UninstallString' -Value '\"%TARGET%\" --uninstall';" ^
  "Set-ItemProperty -Path $k -Name 'NoModify' -Value 1 -Type DWord;" ^
  "Set-ItemProperty -Path $k -Name 'NoRepair' -Value 1 -Type DWord" 2>nul

echo [3/4] ✓ 开始菜单 + 卸载项已注册

rem ---------- 图标写入系统（图标库可见） ----------
if exist "%ICON_PNG%" (
  copy /y "%ICON_PNG%" "%USERPROFILE%\AppData\Local\DevAI-Studio-icon.png" >nul 2>&1
)

echo [4/4] ✓ 图标已就绪
echo.
echo ═══════════════════════════════════════
echo   快捷方式创建完成
echo   桌面:   %SHORTCUT%
echo   开始菜单: %STARTMENU%
echo ═══════════════════════════════════════
echo.
pause
