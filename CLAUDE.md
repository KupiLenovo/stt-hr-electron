# aiERP — Electron (desktop) klijent

## Šta je ovo

Desktop aplikacija **aiERP** — proizvod koji se prodaje i iznajmljuje firmama; **STT d.o.o. Sarajevo je firma 0** (Eldin 10.09.2026: „exe mi je potreban jer ćemo prodavati i iznajmljivati software"). Tanak omotač: UI se učitava sa servera firme, a desktop dodaje fiskalni printer (Tring, IPC), offline kasu (`lib/pos-kes.js`, better-sqlite3) i auto-update.

**Verzija:** 4.2.0

## Server firme (v4.2.0) — adresa NIJE zakucana

- Do 4.1.3 je bila zakucana na `http://46.101.96.28:3737` — STT-ov server, **nešifrovano** (PIN i token internetom kao čist tekst), pa je exe mogao koristiti samo STT.
- Od 4.2.0 adresa je postavka računara: `userData/aierp-server.json` (`{ "url": "https://…" }`). `userData` = `%APPDATA%\stt-hr` (ime iz polja `name` u package.json — `productName` je u `build` sekciji, pa ne utiče na folder; **ne mijenjati `name`**, profil bi „nestao").
- **Nova instalacija** → `povezivanje.html` pita adresu (npr. `firma.aierp.ba`; jedna riječ = `<kod>.aierp.ba`), provjeri `GET /api/ping` → `{ok:true}` pa snimi. Samo https (http samo za localhost).
- **Stara STT instalacija (4.1.x)** → tiho `https://app.aierp.ba` + prenos localStorage sa starog origina (prijava, `aierp-pristup`, `stt-device` kiosk veza): `main.js → prelazSaStareVerzije()`, bez mreže (`protocol.handle` servira praznu stranicu na originu). Trag stare verzije se hvata PRIJE nego Chromium otvori profil (on sam pravi „Local Storage" folder na startu).
- Meni: **Aplikacija → Promijeni server firme…** i **Info o serveru**; offline ekran ima „Promijeni adresu servera".
- IPC za izbor servera prima samo lokalne ekrane (`file://`) — web app sa servera ne smije mijenjati adresu. Prozor je zaključan na origin servera (`will-navigate`); eksterni linkovi idu u sistemski browser.
- Razvoj: `STT_SERVER_URL` nadjačava sve; `AIERP_USER_DATA` daje odvojen profil (test prvog pokretanja).

## Struktura foldera

```
stt-hr-electron/
├── main.js               # main process: prozor, meni, auto-update, IPC, server firme + prelaz 4.1.x
├── preload.js            # most prema rendereru: electronAPI, fiskalniDrajver, posOffline, aierpPostavke (samo file://)
├── povezivanje.html      # ekran „Poveži aplikaciju sa svojom firmom" (v4.2.0) — MORA biti u build.files
├── offline.html          # „Nema veze sa serverom" + promjena adrese
├── fiskalni-drajver.js   # Tring TFS na localhost:8085 (lib/fiskalni/tring.js)
├── lib/pos-kes.js        # offline kasa (better-sqlite3, userData/pos-kes.db)
├── lib/server-adresa.js  # normalizacija adrese servera (čist Node — test/server-adresa.test.js)
├── installer.nsh         # NSIS (ASCII!) — od 4.2.0 samo briše stara firewall pravila
└── build/                # ikone za electron-builder (ne ide u app.asar)
```

## Tehnologije

- **Electron 28** · **electron-builder 24** (NSIS + DMG) · **electron-updater** (GitHub Releases, javni repo)
- **UI nije ovdje** — to je `client-v2` (React + Vite) u server repou; desktop ga učitava sa servera firme.

## Server (drugi repo)

- **STT server:** `https://app.aierp.ba` (nginx ispred Node-a na DigitalOcean dropletu)
- **Repo:** https://github.com/KupiLenovo/stt-hr-server (private), lokalno `C:\Users\rober\stt-hr-server`
- Nova ruta ide u taj repo, ne ovdje.

## Build, test i izdanje

```cmd
npm ci
npm start          :: iz koda
npm test           :: testovi adrese servera (lib/server-adresa.js)

:: izdanje = tag; GitHub Actions pravi Windows + Mac instalaciju i OBJAVI release
:: (instalirane aplikacije ga odmah vide) — zato tag tek kad je sve provjereno
git tag vX.Y.Z && git push origin vX.Y.Z
```

Lokalna provjera pakovanja bez UAC-a: `npx electron-builder --win --dir -c.npmRebuild=false -c.win.requestedExecutionLevel=asInvoker -c.directories.output=dist-test` (pravi build traži administratora — `requestedExecutionLevel: requireAdministrator`).

## Stilske konvencije

1. **`installer.nsh` samo ASCII** (NSIS): ć→c, č→c, š→s, ž→z, đ→dj. JS i HTML su UTF-8 — tu ide pravi bosanski.
2. **Bosnian language UI** — sve UI string-ove pisati na bosanskom (ne hrvatskom, ne srpskom).
3. **Adresa servera se NIKAD ne zakucava** u kod — isti exe radi za svaku firmu (vidi „Server firme").
4. **Lokalni ekrani (povezivanje, offline) ne koriste localStorage** — po postojanju „Local Storage" foldera main.js prepoznaje staru 4.1.x instalaciju.
5. **U inline skriptama ne koristiti globalno ime `status`** (i sl. `name`, `top`) — `var status` je `window.status` (string) i element se izgubi. Obje stranice su to imale.
6. **NE dodavati nove npm dependencies** osim ako je apsolutno neophodno. Klijent treba ostati lagan.

## Historija — v2.0.0 (stari UI u app/index.html, prije v4.0.0 cutovera)

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
