; Hooks for the Windows installer (tauri.windows.conf.json).
;
; Cogpit up to 3.6.x was an Electron app installed by electron-builder. Its
; updater runs this installer as `<setup>.exe --updated /S --force-run`, so
; this installer removes that install (keeping the user's data, which lives in
; %APPDATA%\Cogpit either way) and starts the app when asked to.

; electron-builder names its registry keys with a UUID v5 of the app id (com.cogpit.app).
!define ELECTRON_INSTALL_KEY "Software\aae6629b-529f-5ab6-8d5b-554c8d88d3d4"
!define ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\aae6629b-529f-5ab6-8d5b-554c8d88d3d4"
!define ELECTRON_UNINSTALLER "Uninstall Cogpit.exe"

; Runs the Electron install's own uninstaller, which closes the old app, deletes
; its files, shortcuts and registry keys. `_?=` makes it run in place so ExecWait
; waits for it; that leaves the uninstaller itself behind, removed afterwards.
!macro REMOVE_ELECTRON_INSTALL ROOT
  ClearErrors
  ReadRegStr $R0 ${ROOT} "${ELECTRON_UNINSTALL_KEY}" "QuietUninstallString"
  ReadRegStr $R1 ${ROOT} "${ELECTRON_INSTALL_KEY}" "InstallLocation"
  ${If} $R0 != ""
  ${AndIf} $R1 != ""
  ${AndIf} ${FileExists} "$R1\${ELECTRON_UNINSTALLER}"
    DetailPrint "Removing the previous Cogpit from $R1"
    ExecWait '$R0 /KEEP_APP_DATA _?=$R1' $R2
    ${If} $R2 = 0
      Delete "$R1\${ELECTRON_UNINSTALLER}"
      RMDir "$R1"
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro REMOVE_ELECTRON_INSTALL HKCU
  !insertmacro REMOVE_ELECTRON_INSTALL HKLM
  ; The old install may have been in this folder.
  SetOutPath $INSTDIR
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $R0
  ${IfNot} ${Errors}
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
  ClearErrors
!macroend
