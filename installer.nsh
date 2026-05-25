; STT Business Manager - Custom NSIS installer script
; Otvara firewall port 3737 i cleanup za legacy konfiguraciju.
; Napomena: aplikacija je sada cloud-only (v2.0+), port 3737 vise nije
; potreban lokalno. Pravilo se i dalje cleanup-uje radi urednosti.

!macro customInstall
    DetailPrint "Konfigurisem Windows Firewall za STT Business Manager..."
    ; Obrisi i legacy ime ("STT HR Server" iz starijih verzija) i novo ime
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="STT HR Server"'
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="STT Business Manager"'
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="STT Business Manager" dir=in action=allow protocol=TCP localport=3737 description="STT Business Manager - lokalni port (legacy)"'

    ; Autostart sa Windowsom (opcionalno, zakomentarisano)
    ; WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "STT Business Manager" "$INSTDIR\STT Business Manager.exe"

    DetailPrint "Firewall konfigurisan."
!macroend

!macro customUnInstall
    DetailPrint "Uklanjam firewall pravila..."
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="STT HR Server"'
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="STT Business Manager"'
    DetailPrint "Firewall pravila uklonjena."
!macroend
