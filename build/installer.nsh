; DevAI Studio 自定义 NSIS 片段
; 用原生启动器 launcher.exe 取代直接用 electron 主程序作为快捷方式目标，
; launcher.exe 会在启动时清除 ELECTRON_RUN_AS_NODE 等污染变量，确保以 Electron 模式启动。
; 注意：electron-builder 本版本只提供 customInstall 钩子（无 customCreateShortcuts），
; 且已通过 package.json 的 createDesktopShortcut/createStartMenuShortcut 关闭默认快捷方式。

!macro customInstall
  ; 桌面快捷方式 -> 启动器（封死 ELECTRON_RUN_AS_NODE）
  CreateShortCut "$DESKTOP\DevAI Studio.lnk" "$INSTDIR\launcher.exe" "" "$INSTDIR\DevAI Studio.exe" 0
  ; 开始菜单快捷方式（置于 DevAI Studio 分类目录下，与默认命名一致以便卸载清理）
  CreateDirectory "$SMPROGRAMS\DevAI Studio"
  CreateShortCut "$SMPROGRAMS\DevAI Studio\DevAI Studio.lnk" "$INSTDIR\launcher.exe" "" "$INSTDIR\DevAI Studio.exe" 0
!macroend
