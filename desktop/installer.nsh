; The runtime lives outside the install folder. Remove it on a real uninstall,
; never when the uninstaller runs as part of an update.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\Still Motion Studio\runtime"
  ${endIf}
!macroend
