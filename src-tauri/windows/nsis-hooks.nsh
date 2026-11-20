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
;
; A qooti.exe that Windows still holds can't be replaced: an update stops on "Error
; opening file for writing", and a silent install (/S, bloot apps) skips the file, so
; the old program stays under the new version number. 2026-11-11: a qooti that had quit
; stayed stuck half-exited and held qooti.exe until Windows restarted. A held file can't
; be written or deleted, but it can be renamed, so PREINSTALL moves it aside and puts a
; plain copy back: Tauri's copy step then writes over a free file, and if the install
; stops early qooti.exe is still there. qooti deletes the moved-aside file at its next
; start (updater.rs remove_moved_aside), the uninstaller too.

!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "${__FILEDIR__}\bloot-apps-version.nsh"

!macro QOOTI_UNLOCK_PROGRAM
  Push $R6
  Push $R7
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ClearErrors
    FileOpen $R6 "$INSTDIR\${MAINBINARYNAME}.exe" a     ; opens for writing, changes nothing
    ${If} ${Errors}
      System::Call 'kernel32::GetTickCount() i .R7'
      ClearErrors
      Rename "$INSTDIR\${MAINBINARYNAME}.exe" "$INSTDIR\${MAINBINARYNAME}.exe.$R7.old"
      ${IfNot} ${Errors}
        CopyFiles /SILENT "$INSTDIR\${MAINBINARYNAME}.exe.$R7.old" "$INSTDIR\${MAINBINARYNAME}.exe"
        DetailPrint "${MAINBINARYNAME}.exe was held by another program: moved it aside"
      ${EndIf}
    ${Else}
      FileClose $R6
    ${EndIf}
  ${EndIf}
  Pop $R7
  Pop $R6
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro QOOTI_UNLOCK_PROGRAM
!macroend

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
  ; Copies QOOTI_UNLOCK_PROGRAM moved aside, once nothing holds them.
  Delete "$INSTDIR\${MAINBINARYNAME}.exe.*.old"
  RMDir "$INSTDIR"
!macroend
