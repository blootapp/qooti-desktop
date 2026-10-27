; Custom NSIS hooks for qooti.
;
; Tauri's built-in fileAssociations register ".qooti" but always point the
; DefaultIcon at the app executable (this Tauri/tauri-utils version has no
; per-association `icon` field). We want ".qooti" documents to show their own
; document icon (assets/file.png -> icons/qooti-file.ico, shipped via
; bundle.resources into $INSTDIR). This hook runs AFTER Tauri writes its
; association keys, so our values win.
;
; SHCTX resolves to HKLM or HKCU depending on the install mode (currentUser
; -> HKCU), matching how Tauri wrote the rest of the keys.
;
; bloot apps: qooti's account comes from it (MD/bloot-apps-licensing.md §13.1), so
; the installer brings it along — installed silently (per user, no prompt) when it
; is missing or older than the copy bundled in this build. Uninstalling qooti leaves
; it alone: other bloot apps use it too. scripts/fetch-bloot-apps.mjs puts the
; installer in bloot-apps\ and its version in bloot-apps-version.nsh.

!include "WordFunc.nsh"
!include "${__FILEDIR__}\bloot-apps-version.nsh"

!macro BLOOT_APPS_INSTALL
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\bloot apps" "DisplayVersion"
  StrCmp $R0 "" blootAppsInstall 0
  ${VersionCompare} "${BLOOT_APPS_VERSION}" "$R0" $R1     ; 1 = the bundled one is newer
  StrCmp $R1 "1" blootAppsInstall blootAppsDone
  blootAppsInstall:
    DetailPrint "Installing bloot apps ${BLOOT_APPS_VERSION}"
    ExecWait '"$INSTDIR\bloot-apps\bloot-apps-setup.exe" /S' $R2
    DetailPrint "bloot apps installer finished ($R2)"
  blootAppsDone:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering qooti document icon"
  WriteRegStr SHCTX "Software\Classes\.qooti" "" "qooti.collection"
  WriteRegStr SHCTX "Software\Classes\qooti.collection" "" "qooti collection"
  WriteRegStr SHCTX "Software\Classes\qooti.collection\DefaultIcon" "" "$INSTDIR\icons\qooti-file.ico"
  WriteRegStr SHCTX "Software\Classes\qooti.collection\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ; Tell the shell the association changed so icons refresh without a reboot.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  !insertmacro BLOOT_APPS_INSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\qooti.collection"
  DeleteRegValue SHCTX "Software\Classes\.qooti" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
