const { app, BrowserWindow, Menu, shell, dialog, Notification, ipcMain, net, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { normalizujAdresu, STARI_SERVER, STT_SERVER } = require('./lib/server-adresa');
const LOKALNI_EKRANI = pathToFileURL(__dirname + path.sep).href;   // file:///…/aiERP/resources/app.asar/

let mainWindow;
let rucnaProvjera = false; // v4.0.1: true dok korisnik rucno klikne "Provjeri azuriranja" (vidljiv feedback)

// Razvoj/test: odvojen profil (npr. „prvo pokretanje" bez diranja pravog). Mora prije svega ostalog.
if (process.env.AIERP_USER_DATA) app.setPath('userData', process.env.AIERP_USER_DATA);

// ==========================================
// SERVER FIRME (v4.2.0)
// ==========================================
// Do 4.1.3 adresa je bila zakucana na http://46.101.96.28:3737 — STT-ov server, NESIFROVANO, pa je
// takav exe mogao koristiti samo STT. Sad je adresa postavka ovog racunara (userData/aierp-server.json):
//   - nova instalacija pri prvom pokretanju pita adresu firme (povezivanje.html);
//   - stara STT instalacija tiho prelazi na https://app.aierp.ba i prenosi localStorage (prelazSaStareVerzije);
//   - STT_SERVER_URL (env) i dalje nadjacava sve — samo za razvoj.
const KONFIG = () => path.join(app.getPath('userData'), 'aierp-server.json');
// Trag stare verzije se hvata PRIJE nego sto Chromium otvori profil: 4.0–4.1.x su uvijek ucitavale web app,
// a web app cita localStorage → folder „Local Storage" postoji samo ako je aplikacija vec radila ovdje.
const STARA_INSTALACIJA = !fs.existsSync(KONFIG()) && fs.existsSync(path.join(app.getPath('userData'), 'Local Storage'));

function snimljenaAdresa() {
    try { return normalizujAdresu(JSON.parse(fs.readFileSync(KONFIG(), 'utf8')).url).url || null; }
    catch { return null; }
}
function snimiAdresu(url, dodatno = {}) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(KONFIG(), JSON.stringify({ url, snimljeno: new Date().toISOString(), verzija: app.getVersion(), ...dodatno }, null, 2));
}
function trenutniServer() {
    const env = process.env.STT_SERVER_URL;
    return env ? env.replace(/\/+$/, '') : snimljenaAdresa();
}

// Procitaj/upisi localStorage jednog origina BEZ mreze: sesija za trenutak servira praznu stranicu na tom
// originu (protocol.handle), pa se nad njom izvrsi JS. localStorage je vezan za origin — ovo je jedini
// nacin da prijava, zapamcen pristupni kod i registracija kiosk uredjaja predju sa starog na novi origin.
async function naOriginu(origin, js) {
    const sema = new URL(origin).protocol.slice(0, -1);
    const adresa = origin + '/__aierp_prenos';
    const ses = session.defaultSession;
    ses.protocol.handle(sema, (req) => (req.url === adresa
        ? new Response('<!doctype html><meta charset="utf-8"><title>aiERP</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
        : net.fetch(req, { bypassCustomProtocolHandlers: true })));
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
        await win.loadURL(adresa);
        return await win.webContents.executeJavaScript(js);
    } finally {
        win.destroy();
        ses.protocol.unhandle(sema);
    }
}

// Prvo pokretanje 4.2.0 poslije auto-update sa 4.1.x. Svaka instalacija starija od 4.2.0 je STT-ova
// (drugih kupaca jos nema), pa ide na https://app.aierp.ba bez pitanja. Vraca false ako ovo NIJE
// koristena 4.1.x instalacija (stari origin prazan) — tada ekran za povezivanje pita kao za novu.
// Prenos localStorage je „najbolje sto moze": ako padne, aplikacija ipak radi — samo se prijava i kod
// unesu ponovo; a ako se stari origin ne da ni procitati, racunar je najvjerovatnije STT-ov.
let prelazUToku = false;   // skriveni prozori prelaza nisu „svi prozori zatvoreni" (vidi window-all-closed)
async function prelazSaStareVerzije() {
    prelazUToku = true;
    try { return await prelaz(); } finally { prelazUToku = false; }
}
async function prelaz() {
    let stari;
    try {
        stari = JSON.parse(await naOriginu(STARI_SERVER,
            'JSON.stringify(Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).map((k) => [k, localStorage.getItem(k)])))'));
    } catch (e) {
        snimiAdresu(STT_SERVER, { prelaz_sa: STARI_SERVER, preneseno_kljuceva: 0, greska_prenosa: e.message });
        return true;
    }
    if (!Object.keys(stari).length) return false;
    let preneseno = 0;
    let greska = null;
    try {
        preneseno = await naOriginu(STT_SERVER,
            `(function (d) { var n = 0; for (var k in d) { if (localStorage.getItem(k) === null) { localStorage.setItem(k, d[k]); n++; } } return n; })(${JSON.stringify(stari)})`);
        session.defaultSession.flushStorageData();
    } catch (e) { greska = e.message; }
    snimiAdresu(STT_SERVER, { prelaz_sa: STARI_SERVER, preneseno_kljuceva: preneseno, ...(greska ? { greska_prenosa: greska } : {}) });
    return true;
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
ipcMain.handle('server:trenutni', (e) => (izLokalneStranice(e) ? { url: trenutniServer(), verzija: app.getVersion() } : {}));
ipcMain.on('server:otvori-povezivanje', (e) => { if (izLokalneStranice(e)) otvoriPovezivanje(); });
ipcMain.handle('server:povezi', async (e, unos) => {
    if (!izLokalneStranice(e)) return { ok: false, poruka: 'Nije dozvoljeno.' };
    const n = normalizujAdresu(unos);
    if (n.greska) return { ok: false, poruka: n.poruka };
    // /api/ping je javni odziv aiERP servera — potvrda da na toj adresi stvarno radi aiERP
    try {
        const r = await net.fetch(n.url + '/api/ping', { signal: AbortSignal.timeout(10000), cache: 'no-store' });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || j.ok !== true) return { ok: false, poruka: 'Na toj adresi se javlja server, ali nije aiERP.' };
    } catch {
        return { ok: false, poruka: 'Server na toj adresi se ne javlja. Provjeri adresu i internet.' };
    }
    snimiAdresu(n.url);
    if (mainWindow) mainWindow.loadURL(n.url);
    return { ok: true, url: n.url };
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
                detail: `aiERP v${app.getVersion()}`
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
ipcMain.handle('fiskalni:fiskalizuj', fiskalniHandler((racun) => fiskalni.fiskalizuj(racun)));
ipcMain.handle('fiskalni:reklamiraj', fiskalniHandler((a) => fiskalni.reklamiraj(a.racun, a.original_broj)));
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
ipcMain.handle('pos:queue-add', posHandler((racun) => posKes.dodajURed(racun)));
ipcMain.handle('pos:queue-pending', posHandler(() => posKes.nesinhronizovani()));
ipcMain.handle('pos:queue-mark', posHandler((a) => posKes.oznaciPoslan(a.lokalni_uid, a.server_id)));

// v4.0.0: offline ekran "Pokusaj ponovo" dugme — ponovo ucitaj novi UI sa servera
ipcMain.on('retry-connection', () => ucitajServer());

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
    try { posKes.init(app.getPath('userData')); } catch (e) { if (process.argv.includes('--dev')) console.error('pos-kes init:', e.message); }
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: 'aiERP — poslovni sistem',
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
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { server: trenutniServer() || '' } });
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
                    message: 'aiERP — server firme',
                    detail: `Server: ${url || 'nije postavljen'}\nVeza: ${url && url.startsWith('https://') ? 'šifrovana (https)' : 'nešifrovana'}\nVerzija aplikacije: ${app.getVersion()}`
                });
            }},
            { label: 'Promijeni server firme…', click: async () => {
                const r = await dialog.showMessageBox(mainWindow, {
                    type: 'question',
                    title: 'Promijeni server firme',
                    message: 'Povezati ovaj računar s drugim serverom?',
                    detail: `Sada: ${trenutniServer() || 'nije postavljen'}\n\nTreba samo kad se firma seli na drugi server ili se aplikacija instalira za drugu firmu.`,
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
app.whenReady().then(async () => {
    Menu.setApplicationMenu(buildMenu());
    // v4.2.0: prvi start poslije 4.1.x → STT server + prenos postavki; prvi start nove instalacije →
    // zapis bez adrese, da odluka „stara/nova" pada samo jednom (ekran za povezivanje dalje sam pita)
    // Ništa od ovoga ne smije spriječiti otvaranje prozora: bez postavke → ekran za povezivanje.
    if (!process.env.STT_SERVER_URL && !fs.existsSync(KONFIG())) {
        try {
            const bilaStara = STARA_INSTALACIJA && await prelazSaStareVerzije();
            if (!bilaStara) snimiAdresu(null);
        } catch (e) { if (process.argv.includes('--dev')) console.error('prvi start:', e.message); }
    }
    createWindow();
    setupAutoUpdater();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    // v4.2.0: prelaz sa 4.1.x otvara i zatvara skrivene prozore PRIJE glavnog — to nije izlazak iz
    // aplikacije (bez ove provjere app.quit() je prekidao prenos postavki na pola)
    if (prelazUToku) return;
    if (process.platform !== 'darwin') app.quit();
});
