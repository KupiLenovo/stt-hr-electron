; STT HR - Custom NSIS installer script
; Otvara firewall port 3737 i postavlja autostart

!macro customInstall
    ; Otvori port 3737 u Windows Firewall-u
    DetailPrint "Konfigurišem Windows Firewall za STT HR Server..."
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="STT HR Server"'
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="STT HR Server" dir=in action=allow protocol=TCP localport=3737 description="STT HR Menadžment Server"'
    
    ; Postavi autostart — app se pokreće sa Windowsom (opcionalno, zakomentirano)
    ; WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "STT HR" "$INSTDIR\STT HR.exe"
    
    DetailPrint "Port 3737 otvoren za STT HR Server."
!macroend

!macro customUnInstall
    ; Zatvori port pri deinstalaciji
    DetailPrint "Uklanjam firewall pravilo..."
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="STT HR Server"'
    DetailPrint "Firewall pravilo uklonjeno."
!macroend
