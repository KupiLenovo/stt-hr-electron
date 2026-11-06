const { app, BrowserWindow, Menu, shell, dialog, Notification, ipcMain, net, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { normalizujAdresu, STARI_SERVER } = require('./lib/server-adresa');
const ulazFirme = require('./lib/ulaz-firme');
const pauzaFirme = require('./lib/pauza-firme');
const LOKALNI_EKRANI = pathToFileURL(__dirname + path.sep).href;   // file:///…/aiERP/resources/app.asar/ (folder = build.productName)

// R73 (odluka Eldina 06.11.2026): prikazani naziv proizvoda je „Vault aiERP" — naslov prozora, dijalozi, notifikacije.
// build.productName („aiERP"), build.appId i `name` („stt-hr") OSTAJU: od njih zavise instalacioni folder, ime exe-a,
// ključ za ažuriranje i userData (%APPDATA%\stt-hr) — promjena bi „izgubila" profil i zapamćenu firmu.
const NAZIV_PROIZVODA = 'Vault aiERP';
app.setAboutPanelOptions({ applicationName: NAZIV_PROIZVODA, copyright: '(c) 2026 STT d.o.o.' });

let mainWindow;
let rucnaProvjera = false; // v4.0.1: true dok korisnik rucno klikne "Provjeri azuriranja" (vidljiv feedback)

// Razvoj/test: odvojen profil (npr. „prvo pokretanje" bez diranja pravog). Mora prije svega ostalog.
if (process.env.AIERP_USER_DATA) app.setPath('userData', process.env.AIERP_USER_DATA);

// ==========================================
// SERVER FIRME (v4.2.0)
// ==========================================
// Do 4.1.3 adresa je bila zakucana na http://46.101.96.28:3737 — server jedne firme, NESIFROVANO, pa je
// takav exe mogla koristiti samo ta firma. Sad je adresa postavka ovog racunara (userData/aierp-server.json):
//   - nova instalacija pri prvom pokretanju pita ŠIFRU firme (povezivanje.html): ulaz portala (zadano https://aierp.ba,
//     AIERP_PORTAL_URL ili `portal` u konfiguraciji) daje adresu instance i naziv firme (R68, PLT-45: lib/ulaz-firme.js);
//     firma na vlastitom serveru i dalje može upisati punu adresu;
//   - stara instalacija (4.1.x, bez konfiguracije) od 4.6.0 NE prelazi tiho ni na jedan server: dobija ekran „Šifra firme" kao nova
//     (odluka Eldina 05.11.2026 (10) — proizvod ne pretpostavlja nijednu firmu); zapis pamti samo trag prelaza (prelaz_sa);
//   - STT_SERVER_URL (env) i dalje nadjacava sve — samo za razvoj.
const KONFIG = () => path.join(app.getPath('userData'), 'aierp-server.json');
// Trag stare verzije se hvata PRIJE nego sto Chromium otvori profil: 4.0–4.1.x su uvijek ucitavale web app,
// a web app cita localStorage → folder „Local Storage" postoji samo ako je aplikacija vec radila ovdje.
// Od 4.6.0 trag služi samo da ekran povezivanja kaže zašto opet pita (aplikacija je ažurirana) — localStorage starog origina se ne
// prenosi: prijava i kod starog servera ne smiju završiti na originu firme koju korisnik tek izabere.
const STARA_INSTALACIJA = !fs.existsSync(KONFIG()) && fs.existsSync(path.join(app.getPath('userData'), 'Local Storage'));

function konfiguracija() {
    try { const k = JSON.parse(fs.readFileSync(KONFIG(), 'utf8')); return k && typeof k === 'object' ? k : {}; }
    catch { return {}; }
}
function snimljenaAdresa() {
    return normalizujAdresu(konfiguracija().url).url || null;
}
// R68 (PLT-45): `portal` (ručno upisan u konfiguraciju, npr. probni portal) preživljava svako snimanje i „Promijeni firmu"
function snimiAdresu(url, dodatno = {}) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const { portal } = konfiguracija();
    fs.writeFileSync(KONFIG(), JSON.stringify({ url, snimljeno: new Date().toISOString(), verzija: app.getVersion(), ...(portal ? { portal } : {}), ...dodatno }, null, 2));
}
// Naziv firme iz ulaza (samo za prikaz) — važi samo dok je adresa ista (STT_SERVER_URL u razvoju ga ne prikazuje)
function nazivFirme() {
    const k = konfiguracija();
    return !process.env.STT_SERVER_URL && k.naziv && snimljenaAdresa() ? String(k.naziv) : null;
}
function trenutniServer() {
    const env = process.env.STT_SERVER_URL;
    return env ? env.replace(/\/+$/, '') : snimljenaAdresa();
}

// ==========================================
// PAUZIRANA FIRMA (F8, odluka Eldina 05.11.2026 (9)) — logika u lib/pauza-firme.js
// ==========================================
// Server pauziranoj firmi odbija svaki upis (423 firma_pauzirana), a čitanje radi. Desktop stanje pauze pamti u aierp-server.json
// (`pauza`), pa kasa i bez interneta ne prima NOVU prodaju (offline red, naplata bez računa sa servera, nova smjena); pregled radi,
// a već odštampani računi ostaju u redu na disku i idu serveru kad pauza prestane. Provjera: pri učitavanju servera, svakih 5 min i
// odmah poslije svakog 423 sa servera firme. Server je sudac — nepoznato (bez interneta) ne mijenja zapamćeno stanje.
function trenutnaPauza() {
    return pauzaFirme.iz(konfiguracija(), trenutniServer());
}
function zapamtiPauzu(p) {
    const { pauza: _staro, ...ostalo } = konfiguracija();
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(KONFIG(), JSON.stringify({ ...ostalo, ...(p ? { pauza: p } : {}) }, null, 2));
}
let zadnjaObavijestPauze = 0;
// Jasna poruka kasirki (sistemski dijalog — kasa sa servera i lokalna kasa ga vide isto). Prigušeno: najviše jednom u minuti.
function javiPauzu(vrsta = 'prodaja', { uvijek = false } = {}) {
    const p = trenutnaPauza();
    if (!p || !mainWindow || (!uvijek && !pauzaFirme.trebaObavijest(zadnjaObavijestPauze))) return;
    zadnjaObavijestPauze = Date.now();
    dialog.showMessageBox(mainWindow, { type: 'warning', title: pauzaFirme.PORUKE.naslov, message: pauzaFirme.PORUKE.naslov,
        detail: pauzaFirme.poruka(p, vrsta), buttons: ['U redu'] }).catch(() => {});
}
let provjeraPauzeUToku = null;
function osvjeziPauzu() {
    const server = trenutniServer();
    if (!server) return Promise.resolve(null);
    if (provjeraPauzeUToku) return provjeraPauzeUToku;
    const k = konfiguracija();
    const sifra = !process.env.STT_SERVER_URL && k.sifra ? k.sifra : null;
    provjeraPauzeUToku = pauzaFirme.provjeri({ server, sifra, portal: sifra ? ulazFirme.portalAdresa({ env: process.env, konfig: k }) : null,
        dohvati: async (url, init) => {
            const odg = await net.fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
            return { ok: odg.ok, status: odg.status, json: await odg.json().catch(() => null) };
        } }).then((n) => {
        const staro = trenutnaPauza();
        const novo = pauzaFirme.sljedece(staro, n, { server });
        if (n.pauzirana == null || trenutniServer() !== server) return staro;   // niko ne zna ili je firma u međuvremenu promijenjena
        zapamtiPauzu(novo);
        if (novo && !staro) javiPauzu('prodaja', { uvijek: true });
        if (!novo && staro && Notification.isSupported()) new Notification({ title: NAZIV_PROIZVODA, body: pauzaFirme.PORUKE.nastavak }).show();
        return novo;
    }).catch(() => trenutnaPauza()).finally(() => { provjeraPauzeUToku = null; });
    return provjeraPauzeUToku;
}
let odgodaPauze = null;
function osvjeziPauzuUskoro(ms = 1500) {
    if (odgodaPauze) return;
    odgodaPauze = setTimeout(() => { odgodaPauze = null; osvjeziPauzu(); }, ms);
}

function otvoriPovezivanje() {
    if (mainWindow) mainWindow.loadFile(path.join(__dirname, 'povezivanje.html'));
}
function ucitajServer() {
    const url = trenutniServer();
    if (!mainWindow) return;
    if (url) mainWindow.loadURL(url); else otvoriPovezivanje();
}

// IPC za izbor servera prima SAMO lokalne ekrane aplikacije (file://). Web app sa servera ne smije
// mijenjati adresu — stranica koja moze preusmjeriti app na drugi server moze preusmjeriti i prijavu.
const izLokalneStranice = (e) => { try { return new URL(e.senderFrame.url).protocol === 'file:'; } catch { return false; } };
ipcMain.handle('server:trenutni', (e) => {
    if (!izLokalneStranice(e)) return {};
    const k = konfiguracija();
    const url = trenutniServer();
    // 4.6.0: stara (4.1.x) instalacija bez izabrane firme — ekran kaže da je aplikacija ažurirana i da sad pita šifru firme
    return { url, naziv: nazivFirme(), sifra: nazivFirme() ? (k.sifra || null) : null, verzija: app.getVersion(), stara_verzija: !url && !!k.prelaz_sa && !k.zaboravljeno };
});
ipcMain.on('server:otvori-povezivanje', (e) => { if (izLokalneStranice(e)) otvoriPovezivanje(); });
ipcMain.handle('server:povezi', async (e, unos) => {
    if (!izLokalneStranice(e)) return { ok: false, poruka: 'Nije dozvoljeno.' };
    // R68 (PLT-45): jedna riječ = ŠIFRA FIRME → ulaz portala daje adresu instance (samo https://<subdomena>.<domen portala>) i naziv.
    // Zahtjev ide bez kolačića (credentials: 'omit'); s ulaza se pamti samo adresa i naziv — ulaz ne izdaje token.
    let n;
    let firma = {};
    let ulazPauzirana = false;
    if (ulazFirme.jeSifra(unos)) {
        const portal = ulazFirme.portalAdresa({ env: process.env, konfig: konfiguracija() });
        const u = await ulazFirme.poveziSifrom({ unos, portal, dohvati: async (url, init) => {
            const odg = await net.fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
            return { ok: odg.ok, status: odg.status, json: await odg.json().catch(() => null) };
        } });
        if (!u.ok) return { ok: false, poruka: u.poruka };
        n = { url: u.url };
        firma = { naziv: u.naziv, sifra: u.sifra };
        ulazPauzirana = u.pauzirana === true;
    } else {
        n = normalizujAdresu(unos);
        if (n.greska) return { ok: false, poruka: n.poruka };
    }
    // /api/ping je javni odziv Vault aiERP servera — potvrda da na toj adresi stvarno radi Vault aiERP
    try {
        const r = await net.fetch(n.url + '/api/ping', { signal: AbortSignal.timeout(10000), cache: 'no-store' });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || j.ok !== true) return { ok: false, poruka: `Na toj adresi se javlja server, ali nije ${NAZIV_PROIZVODA}.` };
    } catch {
        return { ok: false, poruka: 'Server na toj adresi se ne javlja. Provjeri adresu i internet.' };
    }
    // F8: ulaz javlja pauziranu firmu (pauzirana: true) — kasa to zna od prvog trenutka; snimiAdresu briše pauzu prethodne firme
    snimiAdresu(n.url, { ...firma, ...(firma.sifra && ulazPauzirana ? { pauza: pauzaFirme.sljedece(null, { pauzirana: true, izvor: 'ulaz' }, { server: n.url }) } : {}) });
    if (mainWindow) mainWindow.loadURL(n.url);
    return { ok: true, url: n.url, naziv: firma.naziv || null };
});
// R68 (PLT-45): „Promijeni firmu" briše zapamćenu firmu (adresu i naziv). Zapis ostaje (bez adrese), da se računar poslije ne prepozna
// kao stara 4.1.x instalacija (STARA_INSTALACIJA gleda samo postoji li konfiguracija) — sljedeće pokretanje opet pita šifru.
ipcMain.handle('server:zaboravi', (e) => {
    if (!izLokalneStranice(e)) return { ok: false, poruka: 'Nije dozvoljeno.' };
    snimiAdresu(null, { zaboravljeno: new Date().toISOString() });
    return { ok: true };
});

// ==========================================
// AUTO-UPDATER
// ==========================================
function setupAutoUpdater() {
    // v4.0.0: repo je PUBLIC → auto-update ne treba token (rijesen stari hardkodirani
    // PAT iz v3.7.0 audita). Stari token revoke-ovati na github.com/settings/tokens.
    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'KupiLenovo',
        repo: 'stt-hr-electron'
    });

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null; // tiho u produkciji

    autoUpdater.on('update-available', (info) => {
        if (mainWindow) mainWindow.webContents.send('update-available', info);
        if (rucnaProvjera) {
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Azuriranje',
                message: `Dostupno je novo azuriranje (v${info.version}).`,
                detail: 'Preuzimam u pozadini — javicu kad bude spremno za instalaciju.'
            });
        }
    });

    autoUpdater.on('download-progress', (progress) => {
        if (mainWindow) mainWindow.webContents.send('update-progress', progress);
    });

    // v4.0.1: vidljiv feedback kad je korisnik RUCNO provjerio i nema novog azuriranja
    autoUpdater.on('update-not-available', () => {
        if (rucnaProvjera) {
            rucnaProvjera = false;
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Azuriranje',
                message: 'Koristite najnoviju verziju.',
                detail: `${NAZIV_PROIZVODA} v${app.getVersion()}`
            });
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        if (mainWindow) mainWindow.webContents.send('update-downloaded', info);
        // Restart ponuda samo na rucnu provjeru; auto-download tiho instalira na izlazu.
        if (rucnaProvjera) {
            rucnaProvjera = false;
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Azuriranje spremno',
                message: `Azuriranje (v${info.version}) je preuzeto.`,
                detail: 'Restartujte aplikaciju da primijenite.',
                buttons: ['Restartuj sad', 'Kasnije'],
                defaultId: 0,
                cancelId: 1
            }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
        }
    });

    autoUpdater.on('error', (err) => {
        if (process.argv.includes('--dev')) console.error('Updater error:', err);
        if (rucnaProvjera) {
            rucnaProvjera = false;
            dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Azuriranje',
                message: 'Nije moguce provjeriti azuriranja.',
                detail: 'Provjeri internet konekciju pa pokusaj ponovo.'
            });
        }
    });

    // Auto-provjera 3s nakon pokretanja (tiha — daje app vremena da se ucita)
    setTimeout(() => {
        rucnaProvjera = false;
        autoUpdater.checkForUpdates().catch(() => {});
    }, 3000);
}

ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall();
});

// Preload je u sandboxu (ne može čitati fajlove) — podatke s diska mu daje main, jednom, sinhrono (lib/preload-podaci.js).
const { podaciZaPreload } = require('./lib/preload-podaci');
const PODACI_PRELOAD = podaciZaPreload();
ipcMain.on('preload:podaci', (e) => { e.returnValue = PODACI_PRELOAD; });

// ==========================================
// C-FISKALNI — drajver (TANAK omotač oko lib/fiskalni/tring.js). Renderer poziva preko invoke.
// Sva logika u lib-u; ovdje samo HTTP na localhost:8085 (TFS). Greška/timeout → vraćamo objekat, ne bacamo.
// ==========================================
const { napraviDrajver } = require('./fiskalni-drajver');
const fiskalni = napraviDrajver(process.env.FISKALNI_DRAJVER || 'tring');
const fiskalniHandler = (fn) => async (_e, arg) => {
    try { return await fn(arg); }
    catch (e) { return { uspjeh: false, status: 'greska', greska: { poruka: e.message } }; }
};
ipcMain.handle('fiskalni:test', fiskalniHandler(() => fiskalni.testVeze()));
ipcMain.handle('fiskalni:status', fiskalniHandler(() => fiskalni.statusUredjaja()));
ipcMain.handle('fiskalni:init', fiskalniHandler((a) => fiskalni.inicijalizacija(a && a.op, a && a.loz)));
// F8: stari put drajvera (bez računa i lokalni_uid-a) — dok je firma pauzirana ništa novo ne ide uređaju
const bezPauzeDrajvera = (fn) => (a) => { const b = pauzaFirme.blokadaDrajvera(trenutnaPauza()); if (b) { javiPauzu('prodaja'); return b; } return fn(a); };
ipcMain.handle('fiskalni:fiskalizuj', fiskalniHandler(bezPauzeDrajvera((racun) => fiskalni.fiskalizuj(racun))));
ipcMain.handle('fiskalni:reklamiraj', fiskalniHandler(bezPauzeDrajvera((a) => (!kasaOffline.dozvoljeno(offlineSesija, 'povrat') ? OFFLINE_POVRAT : fiskalni.reklamiraj(a.racun, a.original_broj)))));
ipcMain.handle('fiskalni:unos-novca', fiskalniHandler((a) => fiskalni.unosNovca(a.vrsta, a.iznos_fening)));
ipcMain.handle('fiskalni:povrat-novca', fiskalniHandler((a) => fiskalni.povratNovca(a.vrsta, a.iznos_fening)));
ipcMain.handle('fiskalni:presjek', fiskalniHandler(() => fiskalni.presjekStanja()));
ipcMain.handle('fiskalni:dnevni', fiskalniHandler(() => fiskalni.dnevniIzvjestaj()));
ipcMain.handle('fiskalni:osnovne', fiskalniHandler(() => fiskalni.osnovneInformacije()));

// ==========================================
// C-POS skelet Faza 2 — LOKALNI KEŠ + OFFLINE QUEUE (better-sqlite3). Init u createWindow (treba userData).
// Renderer vozi sync (ima JWT); ovdje samo lokalna baza. Greška → {ok:false}, ne bacamo.
// ==========================================
const posKes = require('./lib/pos-kes');
const posHandler = (fn) => async (_e, arg) => { try { return { ok: true, ...fn(arg) }; } catch (e) { return { ok: false, greska: e.message }; } };
ipcMain.handle('pos:spreman', () => ({ ok: true, spreman: posKes.spreman() }));
ipcMain.handle('pos:katalog-save', posHandler((a) => posKes.spremiKatalog(a.skladiste_id, a.artikli)));
ipcMain.handle('pos:katalog-get', posHandler((a) => posKes.citajKatalog(a.skladiste_id)));
// F8: pauzirana firma — NOV račun ne ulazi u offline red (ponovljen poziv za račun koji je već u redu prolazi)
ipcMain.handle('pos:queue-add', posHandler((racun) => {
    const b = pauzaFirme.blokadaReda(trenutnaPauza(), !!(racun && posKes.redRacuna(racun.lokalni_uid)));
    if (b) { javiPauzu('prodaja'); return b; }
    return posKes.dodajURed(racun);
}));
ipcMain.handle('pos:queue-pending', posHandler(() => posKes.nesinhronizovani()));
ipcMain.handle('pos:queue-mark', posHandler((a) => posKes.oznaciPoslan(a.lokalni_uid, a.server_id)));

// ==========================================
// MAL-20 / MAL-21 — KASA BEZ INTERNETA: keš radnje po računaru, offline prijava PIN-om (72 h od zadnje veze, samo prodaja i smjena),
// smjena na disku kase i tiha obnova prijave kad se veza vrati. Logika u lib/kasa-offline.js (ista pos-kes.db), ekran kase iz kopije
// client-v2 builda (lib/lokalna-kasa.js) kad se server ne javi.
// ==========================================
const kasaOffline = require('./lib/kasa-offline');
const lokalnaKasa = require('./lib/lokalna-kasa');
const LJUSKA = () => path.join(app.getPath('userData'), 'kasa-ljuska');
let offlineSesija = null;          // { radnik_id, skladiste_id, od, vazi_do, pin (Buffer) } — samo u memoriji, PIN nikad na disk
let lokalnaKasaAktivna = false;    // prozor radi nad kopijom ekrana kase (protocol.handle na originu servera)
let zadnjeOsvjezavanjeLjuske = 0;
ipcMain.handle('kasa:paket-spremi', posHandler((paket) => kasaOffline.spremiPaket(paket)));
ipcMain.handle('kasa:stanje', posHandler(() => ({ ...kasaOffline.stanje(), lokalna_kasa: lokalnaKasaAktivna, sesija: offlineSesija ? { radnik_id: offlineSesija.radnik_id, od: offlineSesija.od } : null })));
ipcMain.handle('kasa:kase', posHandler(() => ({ kase: kasaOffline.kase() })));
ipcMain.handle('kasa:radnici', posHandler((skladisteId) => ({ radnici: kasaOffline.radnici(skladisteId) })));
ipcMain.handle('kasa:prijava', async (_e, u) => {
    try {
        const r = kasaOffline.prijava(u || {});
        if (!r.ok) return r;
        offlineSesija = kasaOffline.ocistiSesiju(offlineSesija) || kasaOffline.napraviSesiju(r, u.pin);
        // PLT-13: offline sesija ne dijeli token — kolačić prijave prethodnog korisnika se briše, da zahtjevi bez interneta (pa ni prvi poslije
        // veze) ne odu u ime nekog drugog. Novi kolačić dolazi tihom obnovom (kasa:obnovi-sesiju).
        const server = trenutniServer();
        if (server) await session.defaultSession.cookies.remove(server, 'stt_token').catch(() => {});
        return { ok: true, radnik: r.radnik, skladiste_id: r.skladiste_id, dozvole: r.dozvole, vazi_do: r.vazi_do };
    } catch (e) { return { ok: false, error: 'greska', poruka: e.message }; }
});
ipcMain.handle('kasa:odjava', () => { offlineSesija = kasaOffline.ocistiSesiju(offlineSesija); return { ok: true }; });
ipcMain.handle('kasa:obrisi-radnike', posHandler(() => { offlineSesija = kasaOffline.ocistiSesiju(offlineSesija); return kasaOffline.obrisiRadnike(); }));
ipcMain.handle('kasa:obnovi-sesiju', async () => {
    const server = trenutniServer();
    const r = await kasaOffline.obnoviPrijavu({ server, sesija: offlineSesija, dohvati: async (url, init) => {
        const odg = await net.fetch(url, { ...init, credentials: 'include', signal: AbortSignal.timeout(10000) });
        return { ok: odg.ok, status: odg.status, json: await odg.json().catch(() => null) };
    } });
    if (r.ok) {
        offlineSesija = kasaOffline.ocistiSesiju(offlineSesija);
        kasaOffline.zabiljeziVezu();
        ugasiLokalnuKasu();   // veza je tu: dalje sve ide sa servera (stranica ostaje otvorena, bez ponovnog učitavanja)
    }
    return r;
});
// F8: pauzirana firma — nova smjena (otvaranje, primopredaja) ne; zatvaranje smjene radi
const bezPauzeSmjene = (fn) => (u) => { const b = pauzaFirme.blokadaSmjene(trenutnaPauza()); if (b) { javiPauzu('smjena'); return b; } return fn(u); };
ipcMain.handle('smjena:otvori', posHandler(bezPauzeSmjene((u) => kasaOffline.otvoriSmjenu(u))));
ipcMain.handle('smjena:zatvori', posHandler((u) => kasaOffline.zatvoriSmjenu(u)));
ipcMain.handle('smjena:primopredaja', posHandler(bezPauzeSmjene((u) => kasaOffline.primopredaja(u))));
ipcMain.handle('smjena:aktivna', posHandler((skladisteId) => ({ smjena: kasaOffline.aktivnaSmjena(skladisteId) })));
ipcMain.handle('smjena:nesinhronizovane', posHandler(() => ({ smjene: kasaOffline.nesinhronizovaneSmjene().map((x) => ({ ...x, tijelo: kasaOffline.tijeloSynca(x) })) })));
ipcMain.handle('smjena:oznaci', posHandler((a) => kasaOffline.oznaciSmjenu(a.lokalni_uid, { server_id: a.server_id, sukob: a.sukob })));
ipcMain.handle('smjena:predaj-serveru', posHandler((uid) => kasaOffline.predajServeru(uid)));

// Lokalna kasa: kopija ekrana kase servirana na originu servera — localStorage, kasa i dnevnik štampe ostaju isti; /api/* ide na mrežu.
function otvoriLokalnuKasu() {
    const server = trenutniServer();
    if (!server || !mainWindow) return false;
    const origin = new URL(server).origin;
    const sema = new URL(server).protocol.slice(0, -1);
    const dir = LJUSKA();
    try { session.defaultSession.protocol.unhandle(sema); } catch { /* nije bio postavljen */ }
    session.defaultSession.protocol.handle(sema, (req) => {
        try {
            const u = new URL(req.url);
            if (u.origin === origin) {
                const o = lokalnaKasa.odgovor(dir, u.pathname);
                if (o) return new Response(o.tijelo, { headers: { 'content-type': o.tip, 'cache-control': 'no-store' } });
            }
        } catch { /* ide na mrežu */ }
        return net.fetch(req, { bypassCustomProtocolHandlers: true });
    });
    lokalnaKasaAktivna = true;
    mainWindow.loadURL(lokalnaKasa.adresaKase(server));
    return true;
}
function ugasiLokalnuKasu() {
    if (!lokalnaKasaAktivna) return;
    const server = trenutniServer();
    try { if (server) session.defaultSession.protocol.unhandle(new URL(server).protocol.slice(0, -1)); } catch { /* već ugašen */ }
    lokalnaKasaAktivna = false;
}
// Poslije uspješnog učitavanja servera: kopija ekrana kase se osvježi u pozadini (najviše jednom u 30 min; samo kad se build promijeni).
function osvjeziLjuskuUPozadini() {
    const server = trenutniServer();
    if (!server || lokalnaKasaAktivna || Date.now() - zadnjeOsvjezavanjeLjuske < 30 * 60 * 1000) return;
    zadnjeOsvjezavanjeLjuske = Date.now();
    lokalnaKasa.osvjeziLjusku({ server, dir: LJUSKA(), dohvati: async (url) => {
        const r = await net.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
        const bajtovi = Buffer.from(await r.arrayBuffer());
        return { ok: r.ok, status: r.status, bajtovi, tekst: bajtovi.toString('utf8') };
    } }).catch((e) => { if (process.argv.includes('--dev')) console.error('kasa-ljuska:', e.message); });
}

// ==========================================
// C-FISKALNI MOST (MAL-04) — račun na disk PRIJE štampe, oporavak pri startu, žurnal. Sva logika u lib/fiskalni-most.js.
// fiskalni:naplati je JEDINI put računa do uređaja za protokol ≥ 4.3.0 (renderer tek poslije javi serveru).
// ==========================================
const { napraviMost } = require('./lib/fiskalni-most');
const fiskalniMost = napraviMost({ drajver: fiskalni, posKes });
// MAL-20: offline sesija smije samo prodaju i smjenu — povrat (reklamirani račun) na uređaj ne ide dok radnik nije prijavljen na serveru
const OFFLINE_POVRAT = { uspjeh: false, status: 'greska', greska: { kod: 'offline_samo_prodaja', poruka: 'Bez interneta kasa radi samo prodaju i smjenu — povrat i storno idu kad se veza vrati.' } };
// F8: pauzirana firma — naplata bez računa sa servera (offline) ne ide uređaju; račun koji je server upisao (racun_id) znači da firma
// radi (server je sudac) → štampa se, a stanje pauze se odmah provjerava ponovo
function naplatiUzPauzu(p) {
    const pauza = trenutnaPauza();
    if (pauza) {
        const b = pauzaFirme.blokadaNaplate(pauza, p, p && p.lokalni_uid ? posKes.redRacuna(p.lokalni_uid) : null);
        if (b) { javiPauzu('prodaja'); return b; }
        osvjeziPauzuUskoro(0);
    }
    return fiskalniMost.naplati(p);
}
ipcMain.handle('fiskalni:naplati', fiskalniHandler((p) => ((p && p.tip === 'reklamirani' && !kasaOffline.dozvoljeno(offlineSesija, 'povrat')) ? OFFLINE_POVRAT : naplatiUzPauzu(p))));
ipcMain.handle('fiskalni:duplikat', fiskalniHandler((a) => fiskalniMost.duplikat(a)));
ipcMain.handle('fiskalni:periodicni', fiskalniHandler((a) => fiskalniMost.periodicni(a)));
ipcMain.handle('fiskalni:rezim', fiskalniHandler(() => fiskalniMost.provjeriRezim()));

// v4.0.0: offline ekran "Pokusaj ponovo" dugme — ponovo ucitaj novi UI sa servera
ipcMain.on('retry-connection', () => { ugasiLokalnuKasu(); ucitajServer(); });

// ==========================================
// SYSTEM NOTIFIKACIJE
// ==========================================
function showSystemNotif(naslov, poruka, stranica) {
    if (!Notification.isSupported()) return;
    const notif = new Notification({
        title: naslov,
        body: poruka,
        icon: path.join(__dirname, 'build', 'icon.png'),
        silent: false,
    });
    notif.on('click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            if (stranica && mainWindow.webContents) {
                // e2 (revizija): `stranica` dolazi s renderera preko IPC-a bez provjere — u string se ubacuje kao
                // JSON literal, ne golim umetanjem u kod (apostrof u imenu stranice = ubrizgan JS).
                mainWindow.webContents.executeJavaScript(
                    `window._navigateTo && window._navigateTo(${JSON.stringify(String(stranica))});`
                ).catch(() => {});
            }
        }
    });
    notif.show();
}

// IPC — frontend salje notifikaciju mainProcess-u
ipcMain.on('save-html', async (event, { html, filename }) => {
    const { BrowserWindow } = require('electron');
    const printWin = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    // e2 (revizija): skriveni prozor se zatvarao SAMO iz callbacka print(); ako `did-finish-load` nikad ne stigne
    // (pokvaren HTML, prekinut load) ostajao je zauvijek. Sad se zatvara i na grešku učitavanja i po roku.
    const zatvori = () => { if (!printWin.isDestroyed()) printWin.close(); };
    const rok = setTimeout(zatvori, 120000);
    printWin.on('closed', () => clearTimeout(rok));
    printWin.webContents.once('did-fail-load', zatvori);
    printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    printWin.webContents.once('did-finish-load', () => {
        printWin.webContents.print({ silent: false, printBackground: true }, () => zatvori());
    });
});

ipcMain.on('system-notif', (event, { naslov, poruka, stranica }) => {
    showSystemNotif(naslov, poruka, stranica);
});

// ==========================================
// KREIRANJE PROZORA
// ==========================================
function createWindow() {
    try {
        posKes.init(app.getPath('userData'));
        kasaOffline.init(posKes.baza());   // MAL-20/21: keš radnje, offline prijava i smjena nad istom pos-kes.db
        // MAL-04: PRVO razriješi račune poslane uređaju bez potvrde (pad usred štampe / istek) — čita SAMO brojač, BEZ nove štampe.
        // Best-effort i bez blokiranja prozora; renderer poslije (sinhronizuj) šalje razriješene rezultate serveru.
        // Kaos test (4.3.0): prvo (sinhrono) red ostavljen usred naplate → greska/nepoznato, da ga sync ne pošalje kao nefiskalizovan.
        fiskalniMost.zateceno();
        fiskalniMost.pokretanje().catch((e) => { if (process.argv.includes('--dev')) console.error('oporavak reda:', e.message); });
        try { posKes.zurnalProred(90); posKes.redProred(90); } catch { /* prored žurnala/reda nije kritičan */ }
    } catch (e) { if (process.argv.includes('--dev')) console.error('pos-kes init:', e.message); }
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: `${NAZIV_PROIZVODA} — poslovni sistem`,
        backgroundColor: '#DEECF9',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            // e2 (nezavisna revizija III): `webSecurity: false` je stajao od prvog commita (2.0.0), kad se UI učitavao
            // s file:// i pozivao cloud server cross-origin. Od 4.2.0 UI dolazi SA SERVERA (same-origin), /api/ping
            // ide kroz main (net.fetch), a fiskalni drajver kroz IPC — nijedan renderer ne treba zaobići same-origin.
            // Isključena same-origin politika bi tuđem sadržaju (iframe, blob: prozor s naslijeđenim preloadom) otvorila
            // put do fiskalnog printera i lokalne baze kase. Default je true; piše se izričito da se ne vrati slučajno.
            webSecurity: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        show: false,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    });

    // v4.2.0: UI sa servera FIRME (postavka ovog racunara); bez postavke → ekran za povezivanje
    ucitajServer();

    // Ako server nije dostupan — lokalni offline ekran (poruka + retry), ne bijeli ekran.
    // errorCode -3 = ABORTED (npr. redirect/reload u toku) — ignorisi, nije prava greska.
    // MAL-20: računar kase s kešom radnje (radnici, rok 72 h od zadnje veze) i kopijom ekrana kase otvara LOKALNU KASU — radnik se prijavi
    // PIN-om i prodaje bez interneta. Ostali (ili kad ni lokalna kasa ne uspije) dobijaju offline.html kao i do sada.
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        const server = trenutniServer();
        let odluka = 'offline';
        try { odluka = lokalnaKasaAktivna ? 'offline' : lokalnaKasa.odlukaPriGresci({ server, stanjeKesa: kasaOffline.stanje(), ljuska: lokalnaKasa.ljuskaSpremna(LJUSKA(), server) }); } catch { odluka = 'offline'; }
        if (odluka === 'lokalna_kasa' && otvoriLokalnuKasu()) return;
        ugasiLokalnuKasu();
        const pauza = trenutnaPauza();
        mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { server: server || '', ...(pauza ? { pauza: pauzaFirme.poruka(pauza, 'prodaja') } : {}) } });
    });
    // Server se učitao: kopija ekrana kase za dane bez interneta (u pozadini, ne koči prozor)
    mainWindow.webContents.on('did-finish-load', () => {
        try { const server = trenutniServer(); if (server && mainWindow.webContents.getURL().startsWith(server)) { osvjeziLjuskuUPozadini(); osvjeziPauzu(); } } catch { /* nije kritično */ }
    });
    // F8: svaki 423 sa servera firme (firma_pauzirana, ali i modul/licenca — tijelo se ovdje ne vidi) → provjera pauze odmah
    session.defaultSession.webRequest.onCompleted((d) => {
        try { const server = trenutniServer(); if (d.statusCode === 423 && server && new URL(d.url).origin === new URL(server).origin) osvjeziPauzuUskoro(); } catch { /* nije kritično */ }
    });

    // v4.2.0: prozor ostaje na serveru firme. Preload daje stranici fiskalni printer i POS kes, pa
    // tudja stranica u ovom prozoru ne smije ni da se otvori — eksterni link ide u sistemski browser.
    // (loadURL/loadFile iz main procesa ne prolaze ovdje — samo navigacija koju pokrene stranica.)
    mainWindow.webContents.on('will-navigate', (event, url) => {
        let cilj;
        try { cilj = new URL(url); } catch { return event.preventDefault(); }
        // vlastiti lokalni ekrani (povezivanje, offline) — web stranica do file:// ionako ne moze (Chromium)
        if (cilj.protocol === 'file:' && url.startsWith(LOKALNI_EKRANI)) return;
        const server = trenutniServer();
        if (server && cilj.origin === new URL(server).origin) return;
        event.preventDefault();
        // web → sistemski browser; mailto:/tel: (mail i telefon partnera) → sistemske aplikacije
        if (['https:', 'http:', 'mailto:', 'tel:'].includes(cilj.protocol)) shell.openExternal(url);
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
        if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
            mainWindow.webContents.openDevTools();
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        // Novi UI stampa zapisnik/potvrde preko window.open('','_blank') + w.print()
        // (url = 'about:blank') i otvara PDF/Excel kao blob:/data:. Sve to mora ostati
        // U APP-u (ne shell), inace stampa pukne ili se otvori prazan browser tab.
        if (!url || url === 'about:blank' || url.startsWith('blob:') || url.startsWith('data:')) {
            return { action: 'allow' };
        }
        // Pravi eksterni linkovi (npr. lager_url dobavljaca) → sistemski browser.
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
        ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
        { label: 'Aplikacija', submenu: [
            { label: 'Osvjezi', accelerator: 'F5', click: () => { if (mainWindow) mainWindow.reload(); } },
            { type: 'separator' },
            { label: 'Provjeri azuriranja', click: () => {
                // v4.0.1: rucna provjera daje vidljiv rezultat (azurni / dostupno / spremno / greska)
                // preko autoUpdater evenata (update-not-available / available / downloaded / error).
                rucnaProvjera = true;
                autoUpdater.checkForUpdates().catch(() => {}); // gresku pokazuje 'error' event
            }},
            { type: 'separator' },
            { label: 'DevTools', accelerator: 'F12', click: () => { if (mainWindow) mainWindow.webContents.toggleDevTools(); } },
            { type: 'separator' },
            { label: 'Info o serveru', click: () => {
                const url = trenutniServer();
                dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'Server firme',
                    message: `${NAZIV_PROIZVODA} — server firme`,
                    detail: `${nazivFirme() ? `Firma: ${nazivFirme()}\n` : ''}Server: ${url || 'nije postavljen'}\nVeza: ${url && url.startsWith('https://') ? 'šifrovana (https)' : 'nešifrovana'}\n${trenutnaPauza() ? 'Stanje firme: pauzirana (samo pregled, bez nove prodaje)\n' : ''}Verzija aplikacije: ${app.getVersion()}`
                });
            }},
            { label: 'Promijeni firmu…', click: async () => {
                const r = await dialog.showMessageBox(mainWindow, {
                    type: 'question',
                    title: 'Promijeni firmu',
                    message: 'Povezati ovaj računar s drugom firmom?',
                    detail: `Sada: ${nazivFirme() ? `${nazivFirme()} (${trenutniServer()})` : (trenutniServer() || 'nije postavljen')}\n\nTreba samo kad se aplikacija instalira za drugu firmu ili se firma seli na drugi server.`,
                    buttons: ['Promijeni', 'Odustani'],
                    defaultId: 1,
                    cancelId: 1
                });
                if (r.response === 0) otvoriPovezivanje();
            }},
            ...(!isMac ? [{ type: 'separator' }, { role: 'quit', label: 'Zatvori' }] : [])
        ]},
        { label: 'Prikaz', submenu: [
            { role: 'resetZoom', label: 'Normalna velicina' },
            { role: 'zoomIn', label: 'Povecaj' },
            { role: 'zoomOut', label: 'Smanji' },
            { type: 'separator' },
            { role: 'togglefullscreen', label: 'Puni ekran' }
        ]}
    ];
    return Menu.buildFromTemplate(template);
}

// ==========================================
// APP LIFECYCLE
// ==========================================
app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    // Prvi start (nova instalacija ili 4.6.0 poslije 4.1.x): zapis bez adrese, da odluka „stara/nova" pada samo jednom — ekran za
    // povezivanje dalje sam pita šifru firme. 4.6.0 (odluka 10): stara instalacija više ne ide tiho na server jedne firme; pamti se
    // samo trag prelaza (ekran kaže da je aplikacija ažurirana). Ništa od ovoga ne smije spriječiti otvaranje prozora.
    if (!process.env.STT_SERVER_URL && !fs.existsSync(KONFIG())) {
        try { snimiAdresu(null, STARA_INSTALACIJA ? { prelaz_sa: STARI_SERVER } : {}); }
        catch (e) { if (process.argv.includes('--dev')) console.error('prvi start:', e.message); }
    }
    createWindow();
    setupAutoUpdater();
    setInterval(() => { osvjeziPauzu(); }, 5 * 60 * 1000);   // F8: pauza se vidi i dok je ekran otvoren (bez novog učitavanja)

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
