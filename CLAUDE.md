# aiERP — Electron (desktop) klijent

## Šta je ovo

Desktop aplikacija **aiERP** — proizvod koji se prodaje i iznajmljuje firmama; **STT d.o.o. Sarajevo je firma 0** (Eldin 10.09.2026: „exe mi je potreban jer ćemo prodavati i iznajmljivati software"). Tanak omotač: UI se učitava sa servera firme, a desktop dodaje fiskalni printer (Tring, IPC), offline kasu (`lib/pos-kes.js`, better-sqlite3) i auto-update.

**Verzija:** 4.5.0 (postavke fiskalnog uređaja po računaru, pokretanje bez administratora, ažuriranje na potvrdu)

**Načelo vlasnika (01.11.2026):** desktop je samo prozor aiERP-a s mostom do fiskalnog uređaja — bez zasebnih ekrana za rad. Postavke uređaja, test veze, naplata, Z izvještaj… su ekrani aiERP-a (client-v2); desktop daje samo most i provjeru u glavnom procesu.

## Server firme (v4.2.0) — adresa NIJE zakucana

- Do 4.1.3 je bila zakucana na `http://46.101.96.28:3737` — STT-ov server, **nešifrovano** (PIN i token internetom kao čist tekst), pa je exe mogao koristiti samo STT.
- Od 4.2.0 adresa je postavka računara: `userData/aierp-server.json` (`{ "url": "https://…" }`). `userData` = `%APPDATA%\stt-hr` (ime iz polja `name` u package.json — `productName` je u `build` sekciji, pa ne utiče na folder; **ne mijenjati `name`**, profil bi „nestao").
- **Nova instalacija** → `povezivanje.html` pita adresu (npr. `firma.aierp.ba`; jedna riječ = `<kod>.aierp.ba`), provjeri `GET /api/ping` → `{ok:true}` pa snimi. Samo https (http samo za localhost).
- **Stara STT instalacija (4.1.x)** → tiho `https://app.aierp.ba` + prenos localStorage sa starog origina (prijava, `aierp-pristup`, `stt-device` kiosk veza): `main.js → prelazSaStareVerzije()`, bez mreže (`protocol.handle` servira praznu stranicu na originu). Trag stare verzije se hvata PRIJE nego Chromium otvori profil (on sam pravi „Local Storage" folder na startu).
- Meni: **Aplikacija → Promijeni server firme…** i **Info o serveru**; offline ekran ima „Promijeni adresu servera".
- IPC za izbor servera prima samo lokalne ekrane (`file://`) — web app sa servera ne smije mijenjati adresu. Prozor je zaključan na origin servera (`will-navigate`); eksterni linkovi idu u sistemski browser.
- Razvoj: `STT_SERVER_URL` nadjačava sve; `AIERP_USER_DATA` daje odvojen profil (test prvog pokretanja).

## Fiskalni uređaj — ugovor mosta (v4.5.0, R62)

Ugovor FIS ↔ DSK: `window.fiskalniDrajver` (preload) — postojeće funkcije ostaju, dodato:
- `verzija` — verzija aplikacije (string). aiERP prepoznaje nove postavke po `typeof fiskalniDrajver.sacuvajPostavke === 'function'`.
- `postavke()` → `{ proizvodjac: 'tring', host, port, izvor: 'sacuvano'|'zadano'|'env' }` (zadano `127.0.0.1:8085`; env `TRING_HOST`/`TRING_PORT` ima prednost — samo razvoj).
- `sacuvajPostavke({ proizvodjac, host, port })` → `{ ok: true, postavke }` ili `{ ok: false, greska: 'host_neispravan'|'port_neispravan'|'proizvodjac_nepodrzan', poruka }`.
  Pamti se **na tom računaru** (`userData/fiskalni-uredjaj.json`), ne na serveru. Dozvoljeno: loopback, privatna LAN adresa (10.x, 172.16–31.x, 192.168.x, IPv6 fc00::/7),
  ime računara u mreži (jedna riječ, npr. `KASA-1`, ili `.local`/`.lan`/…). **Nikad javna adresa** — provjera u glavnom procesu (`lib/fiskalni-postavke.js`),
  a drajver je ponavlja pri svakom zahtjevu i provjerava i adresu u koju se ime razriješi. Proizvođač: samo `tring` (`eset` → „uskoro").
- `testVeze()` → `{ ok, poruka, uredjaj?: { serijski_broj?, ibfm?, sat_uredjaja?, model? } }` — poslije `GET /` čita OsnovneInformacije (bez štampe);
  polje koje TFS ne da se izostavi. Emulator daje `ibfm`; nazivi za serijski broj, sat i model zavise od firmvera (traži se više BS/EN imena) — **potvrditi na stvarnom uređaju**.
- Ekran postavki je u aiERP-u (client-v2 `fiskalni-test.tsx`), ne u desktopu. Testovi: `test/fiskalni-postavke.test.js`.

## Prava, ažuriranje i potpis (v4.5.0, PLT-39 N-3 / S-4)

- **Pokretanje s pravima običnog korisnika** (`requestedExecutionLevel: asInvoker`). Do 4.4.0 je bilo `requireAdministrator` (UAC pri svakom pokretanju),
  a ništa u aplikaciji ne traži administratora: TFS je HTTP na 127.0.0.1/LAN, offline keš je u `userData`. Instalacija „za sve korisnike" sama traži UAC (NSIS);
  `installer.nsh` briše stara firewall pravila — bez administratora (instalacija samo za mene) to se tiho preskoči, što je u redu.
- **Ažuriranje se ne instalira samo:** preuzme se u pozadini, pa dijalog s trenutnom i novom verzijom („Instaliraj sada" / „Kasnije", zadano Kasnije).
  `autoInstallOnAppQuit = false`; `install-update` iz web aplikacije ide kroz isti dijalog (`lib/azuriranje.js`, `test/izdanje.test.js`).
- **Ime/opis bez firme kupca:** `description` = „aiERP kasa" (Windows to pokazuje kao opis exe-a), `author`/`copyright` neutralni. `name` (`stt-hr`) i `appId`
  (`ba.stt.business`) se NE mijenjaju — po `name` je folder `userData` (profil, keš kase), po `appId` instalacija prepoznaje staru za ažuriranje.
- **Potpisivanje certifikatom (code signing) — VANJSKI KORAK, nije urađeno.** Exe i instalacija trenutno NISU potpisani (Windows SmartScreen upozorava
  „Nepoznat izdavač"). Treba: certifikat za potpis koda (OV ili EV) na pravno lice koje prodaje aiERP; zatim u GitHub Actions tajne `CSC_LINK` (certifikat .pfx, base64)
  i `CSC_KEY_PASSWORD`; za EV certifikat na USB/HSM tokenu potpis ide kroz `win.sign`/uslugu dobavljača. Za Mac: Apple Developer ID + notarizacija
  (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Kad certifikat postoji, `author` uskladiti s imenom izdavača u certifikatu.
  Ne izmišljati certifikat niti ga držati u repou.

## Struktura foldera

```
stt-hr-electron/
├── main.js               # main process: prozor, meni, auto-update, IPC, server firme + prelaz 4.1.x
├── preload.js            # most prema rendereru: electronAPI, fiskalniDrajver (+ postavke, R62), posOffline, aierpPostavke (samo file://)
│                         #   SANDBOX: require samo 'electron' — podatke s diska daje main (lib/preload-podaci.js, sendSync)
├── povezivanje.html      # ekran „Poveži aplikaciju sa svojom firmom" (v4.2.0) — MORA biti u build.files
├── offline.html          # „Nema veze sa serverom" + promjena adrese
├── fiskalni-drajver.js   # Tring TFS (zadano 127.0.0.1:8085; adresa iz postavki računara) (lib/fiskalni/tring.js)
├── lib/fiskalni-postavke.js # R62: adresa/port TFS-a po računaru (userData/fiskalni-uredjaj.json), provjera — nikad javna adresa
├── lib/azuriranje.js     # R62: auto-update — preuzimanje u pozadini, instalacija tek na potvrdu (dijalog s verzijom)
├── lib/pos-kes.js        # offline kasa (better-sqlite3, userData/pos-kes.db)
├── lib/kasa-offline.js   # kasa bez interneta (4.4.0): keš radnje, offline prijava PIN-om, smjena na disku, tijeloSynca
├── lib/kasa-offline-ugovor.json  # ugovor mosta posOffline — BAJT-PO-BAJT kopija serverskog (+ .sha256); mijenja se u OBA repoa
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
npm test           :: svi testovi, uklj. test/kaos.test.js (simulator Tring uređaja sa stanjem, padovi aplikacije/TFS-a, offline sync)
node scripts/kaos-sa-serverom.js   :: jednokratno, NE CI: 10 offline računa prema PRAVOM stt-hr-serveru (privremena baza)

:: izdanje = tag; GitHub Actions pravi Windows + Mac instalaciju i OBJAVI release
:: (instalirane aplikacije ga odmah vide) — zato tag tek kad je sve provjereno
git tag vX.Y.Z && git push origin vX.Y.Z
```

Lokalna provjera pakovanja: `npx electron-builder --win --dir -c.npmRebuild=false -c.directories.output=dist-test` (od 4.5.0 aplikacija ne traži administratora — `requestedExecutionLevel: asInvoker`).

## Stilske konvencije

1. **`installer.nsh` samo ASCII** (NSIS): ć→c, č→c, š→s, ž→z, đ→dj. JS i HTML su UTF-8 — tu ide pravi bosanski.
2. **Bosnian language UI** — sve UI string-ove pisati na bosanskom (ne hrvatskom, ne srpskom).
3. **Adresa servera se NIKAD ne zakucava** u kod — isti exe radi za svaku firmu (vidi „Server firme").
4. **Lokalni ekrani (povezivanje, offline) ne koriste localStorage** — po postojanju „Local Storage" foldera main.js prepoznaje staru 4.1.x instalaciju.
5. **U inline skriptama ne koristiti globalno ime `status`** (i sl. `name`, `top`) — `var status` je `window.status` (string) i element se izgubi. Obje stranice su to imale.
6. **NE dodavati nove npm dependencies** osim ako je apsolutno neophodno. Klijent treba ostati lagan.
7. **Most `window.posOffline` samo iz ugovora** (`lib/kasa-offline-ugovor.json`, kopija serverskog — CI `offline-ogledalo` u server repou poredi desktop main bajt po bajt). Nova metoda/polje: prvo ugovor u OBA repoa (desktop PR se spaja prvi), pa preload; `test/kasa-offline-ugovor.test.js` veže ugovor za preload, `tijeloSynca` i red računa. Uputa: server repo `docs/desktop/offline-ugovor.md`.
8. **Preload je u sandboxu** — u `preload.js` nikad `require` osim `'electron'` (`test/preload.test.js`); fajlove čita main.

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
