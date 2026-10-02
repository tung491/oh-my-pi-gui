; Remove the Electron build before the Tauri build installs, so Apps & features
; keeps one Sai ATLAS entry. electron-builder registered that install under the
; pinned GUID 9d72fc94-91dd-54d1-8fda-3b6e5e8d23f2 (UUIDv5 of the old app id),
; per user (HKCU) or per machine (HKLM). Its uninstaller keeps the profile
; (deleteAppDataOnUninstall: false), so settings survive.
!define SAI_ATLAS_ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\9d72fc94-91dd-54d1-8fda-3b6e5e8d23f2"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "${SAI_ATLAS_ELECTRON_UNINSTALL_KEY}" "QuietUninstallString"
  ReadRegStr $R1 HKCU "${SAI_ATLAS_ELECTRON_UNINSTALL_KEY}" "InstallLocation"
  StrCmp $R0 "" 0 +3
    ReadRegStr $R0 HKLM "${SAI_ATLAS_ELECTRON_UNINSTALL_KEY}" "QuietUninstallString"
    ReadRegStr $R1 HKLM "${SAI_ATLAS_ELECTRON_UNINSTALL_KEY}" "InstallLocation"
  StrCmp $R0 "" +6 0
    DetailPrint "Removing the previous Sai ATLAS install"
    ; An NSIS uninstaller copies itself to %TEMP% and returns at once unless
    ; _?= names its directory, so pass it to make ExecWait really wait.
    StrCmp $R1 "" 0 +3
      ExecWait '$R0 /S'
      Goto +2
      ExecWait '$R0 /S _?=$R1'
!macroend
