; Vault aiERP - Custom NSIS installer script
; (exe i folder i dalje nose build.productName "aiERP" - R73: ne mijenja se da ostanu putanje i userData)
; v4.2.0: aplikacija je cloud-only od v2.0 i NISTA ne slusa lokalno, pa installer vise NE otvara
; ulazni port 3737 na racunaru (bila je nepotrebna rupa u firewallu svakog PC-a u radnji).
; Samo brise pravila koja su ostavile starije verzije.

!macro customInstall
    DetailPrint "Uklanjam stara firewall pravila (port 3737 vise nije potreban)..."
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="STT HR Server"'
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="STT Business Manager"'

    ; Autostart sa Windowsom (opcionalno, zakomentarisano)
    ; WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Vault aiERP" "$INSTDIR\aiERP.exe"

    DetailPrint "Gotovo."
!macroend

!macro customUnInstall
    DetailPrint "Uklanjam firewall pravila..."
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="STT HR Server"'
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="STT Business Manager"'
    DetailPrint "Firewall pravila uklonjena."
!macroend
