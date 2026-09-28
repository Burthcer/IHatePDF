; Lets phones reach "Share to phone" (QR over Wi-Fi / this PC's hotspot) without
; Windows ever showing a firewall prompt: one rule for IHatePDF only, TCP, and
; only from devices on this PC's own local networks. Also clears any block rule
; Windows saved if someone clicked "Deny" on an earlier version's prompt.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name=all program="$INSTDIR\IHatePDF.exe"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="IHatePDF Share to phone" dir=in action=allow program="$INSTDIR\IHatePDF.exe" enable=yes protocol=TCP remoteip=localsubnet profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="IHatePDF Share to phone"'
!macroend
