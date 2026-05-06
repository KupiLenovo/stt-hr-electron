# STT HR Menadžment — Electron Klijent

## Šta je ovo

Desktop aplikacija (Electron) za upravljanje HR procesima u STT d.o.o. Sarajevo. Aplikaciju koriste više lokacija (STUP - sjedište, Tutto Capsule SCC, Tutto Capsule Merkator, Kupilenovo Shop SCC, VP Skladište).

**Verzija:** 2.0.0 (cloud client only — bez lokalnog server-a)

## Arhitektura

Klijent-server arhitektura preko HTTP-a:

```
┌──────────────────────┐         HTTPS/HTTP        ┌────────────────────────┐
│  Electron Klijent    │ ────────────────────────> │  DigitalOcean Cloud    │
│  (ovaj projekt)      │   API calls (REST)        │  46.101.96.28:3737     │
│                      │ <──────────────────────── │  Express + SQLite      │
│  app/index.html      │   JSON responses          │  /opt/stt-hr/server.js │
└──────────────────────┘                            └────────────────────────┘
```

**Klijent NE drži podatke lokalno.** Sve ide preko REST API-ja na cloud.

## Struktura foldera

```
stt-hr-electron/
├── main.js                    # Electron main process (BrowserWindow, menu, IPC)
├── preload.js                 # Preload bridge (Node API exposed to renderer)
├── package.json               # v2.0.0, samo electron + electron-builder
├── app/
│   ├── index.html             # ~9006 linija, monolithic HTML+React (Babel CDN)
│   ├── index.html.backup      # backup od prije cloud migracije
│   └── ...
├── build/
│   └── icon.png               # app ikona
├── dist/                      # build output (.exe, win-unpacked/)
├── main.js.backup             # pre-cloud-migration main.js
└── package.json.backup        # pre-cloud-migration package.json
```

## Tehnologije

- **Electron 28.3.0** — desktop wrapper
- **electron-builder 24.13.3** — pakovanje u .exe
- **React 18 (preko Babel CDN)** — frontend, sve u jednom HTML fajlu
- **Vanilla JS + Tailwind via CDN** — styling

⚠️ **NEMA build koraka za frontend.** Sve je u `app/index.html` direktno, Babel transpiluje JSX in-browser. Promjene su instant — F5 u app reload-uje.

## Cloud server info

- **IP:** `46.101.96.28`
- **Port:** `3737`
- **Tech:** Node.js 20 + Express + better-sqlite3 + helmet + CORS
- **Repo:** https://github.com/KupiLenovo/stt-hr-server (private)
- **Lokalni clone (na ovom laptopu):** `C:\Users\rober\stt-hr-server`
- **API_URL u klijentu:** `http://46.101.96.28:3737`
- **86 routes** — Centrala, Evidencija rada, Polog pazara, Dopuna MP/VP, Sales Leadovi, Servisni prijem, Loyalty, Vozila, Odmori...

Ako trebaš dodati novu route — to ide u `server.js` u tom drugom repo-u (`C:\Users\rober\stt-hr-server`), ne ovdje.

## Build i deploy klijenta

```cmd
:: Dev mode (live test)
npm start

:: Production build (.exe instaler)
npm run build:win

:: Output: dist/STT HR Setup 2.0.0.exe (~76 MB)
```

## Stilske konvencije

1. **NE editovati `index.html.backup`, `main.js.backup`, `package.json.backup`** — to su backup fajlovi od prije cloud migracije.
2. **Komentari na bosanskom/hrvatskom su OK** ali bez ćiriličnih i specijalnih karaktera (problem sa NSIS instalerom). Koristi: ć→c, č→c, š→s, ž→z, đ→dj.
3. **Bosnian language UI** — sve UI string-ove pisati na bosanskom (ne hrvatskom, ne srpskom).
4. **API_URL je hardkodiran** na `46.101.96.28:3737` ali postoji fallback u `getSavedServerIP()` koji čita iz `localStorage.stt_server_ip`.
5. **Auto-migration logic** — ako je u localStorage `localhost` ili `127.0.0.1`, automatski se prebacuje na cloud IP. Ne dirati tu logiku.
6. **NE dodavati nove npm dependencies** osim ako je apsolutno neophodno. Klijent treba ostati lagan (76 MB instaler).

## Kontekst — šta je promijenjeno u v2.0.0

- ❌ Uklonjen lokalni server (`fork('server/server.js')` iz main.js)
- ❌ Uklonjeni server-only deps (`better-sqlite3`, `express`, `cors`, `exceljs`, `pdfkit`)
- ❌ Obrisan `server/` folder
- ✅ Dodan auto-migration localhost → cloud IP
- ✅ Renamed UI: "Glavni racunar (STUP)" → "Spoji se na cloud server"
- ✅ DevTools sad samo u dev modu (F12 ili `--dev` flag), ne auto-otvara
- ✅ Menu "Info o serveru" pokazuje cloud info

## Trenutni TO-DO / pending

- [x] Bug: datum se prikazuje kao "2026 M05 6, Wed" — FIXED: bs-BA locale zamijenjen manualnim formatiranjem (DANI_BS, KRATKI_MJES_BS konstante)
- [x] Session timeout (45 min inactivity → auto-odjava, warning modal na 42 min)
- [x] Mute dugme za notifikacijske zvukove (localStorage perzistencija)
- [x] Auto-close smjene starije od 12h (provjerava se pri svakom loadu)
- [x] Toast notifikacijski sistem (info/success/warning/error, 4s trajanje)
- [x] Offline queue — POST akcije se čuvaju kad je server offline, sync kad se vrati
- [x] Audit log — localStorage-based, stranica za admina sa search + CSV export
- [x] CSV export — Evidencija rada, Polozi pazara, Radnici
- [x] exportCSV() utility — globalna funkcija za sve tablice
- [x] SIGURNOST: Auto-login bypass uklonjen — LoginPage sada uvijek prikazuje PinPad
- [x] SIGURNOST: Ctrl+Shift+D debug panel zaštićen (?debug=1 query param)
- [x] ConfirmModal sistem — zamjena za sve window.confirm() (14 mjesta)
- [x] window.alert() → showAlert() toast (sve greške, validacije, success poruke)
- [x] prompt() u sidebar PIN promjeni → pravi modal sa password inputima
- [x] Error toasti u loadAllData za kritične API pozive
- [x] useMemo za radniciMap + lokacijeMap — O(1) lookup umjesto O(n) radnici.find()
- [ ] electron-updater + GitHub Releases za auto-update
- [ ] GitHub Actions workflow za auto-build .exe na push
- [ ] (Opcionalno) Re-enable PIN auth sistema
- [ ] (Niski prioritet) Cleanup — ukloniti `app/index.html.backup`, `main.js.backup` itd. nakon što potvrdimo da nova verzija radi savršeno

## Workflow za nove izmjene

1. Edituj `app/index.html` (ili `main.js` za Electron-level)
2. `npm start` → testiraj u live app-u (F5 reload)
3. Kad si zadovoljan: `npm run build:win`
4. Test instalera u `dist/`
5. Distribuiraj na lokacije (kasnije, nakon više testiranja)

## Test cloud konekcije

```cmd
curl http://46.101.96.28:3737/health
```

Treba vratiti: `{"status":"ok",...}`

## Ko radi na ovome

- **Eldin Hota** (vlasnik), STT d.o.o. Sarajevo
- Email: maloprodaja@stt.ba
- Komunikacija: bosanski/hrvatski jezik
- Stil: voli copy-paste-ready rješenja, brže od excessive objašnjenja
