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

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering qooti document icon"
  WriteRegStr SHCTX "Software\Classes\.qooti" "" "qooti.collection"
  WriteRegStr SHCTX "Software\Classes\qooti.collection" "" "qooti collection"
  WriteRegStr SHCTX "Software\Classes\qooti.collection\DefaultIcon" "" "$INSTDIR\icons\qooti-file.ico"
  WriteRegStr SHCTX "Software\Classes\qooti.collection\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ; Tell the shell the association changed so icons refresh without a reboot.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\qooti.collection"
  DeleteRegValue SHCTX "Software\Classes\.qooti" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
