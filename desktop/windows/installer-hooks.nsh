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

; Runs the Electron install's own uninstaller, which closes the old app and
; deletes its files, shortcuts and registry keys. It runs from a copy, as
; electron-builder's own upgrades do: it stops every process started from the
; install folder, which would include itself. `_?=` makes ExecWait wait for it.
; A failure (an all-users install whose elevation prompt was declined) leaves
; the old install beside the new one rather than blocking the update.
!macro REMOVE_ELECTRON_INSTALL ROOT MODE
  ClearErrors
  ReadRegStr $R0 ${ROOT} "${ELECTRON_UNINSTALL_KEY}" "UninstallString"
  ReadRegStr $R1 ${ROOT} "${ELECTRON_INSTALL_KEY}" "InstallLocation"
  ${If} $R0 != ""
  ${AndIf} $R1 != ""
  ${AndIf} ${FileExists} "$R1\${ELECTRON_UNINSTALLER}"
    DetailPrint "Removing the previous Cogpit from $R1"
    InitPluginsDir
    CopyFiles /SILENT "$R1\${ELECTRON_UNINSTALLER}" "$PLUGINSDIR\old-uninstaller.exe"
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA ${MODE} _?=$R1' $R2
    DetailPrint "The previous Cogpit's uninstaller finished with $R2"
  ${EndIf}
  ClearErrors
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro REMOVE_ELECTRON_INSTALL HKCU "/currentuser"
  !insertmacro REMOVE_ELECTRON_INSTALL HKLM "/allusers"
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
