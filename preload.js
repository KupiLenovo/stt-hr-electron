const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// C-Fiskalni (MAL-03): verzija protokola iz kanonskog lib/fiskalni/tring.js + sha bajt-po-bajt kopije (lib/fiskalni/tring.sha256).
// Kasa (pos.tsx) poredi verziju s potrebnom i pokaže traku ako je instalirani desktop stariji. Čist read, bez I/O prema uređaju.
let PROTOKOL = { verzija: null, sha: null };
try {
    const tring = require('./lib/fiskalni/tring');
    const sha = fs.readFileSync(path.join(__dirname, 'lib', 'fiskalni', 'tring.sha256'), 'utf8').trim().split(/\s+/)[0] || null;
    PROTOKOL = { verzija: tring.PROTOKOL_VERZIJA || null, sha };
} catch { /* van desktopa ili fajl nedostupan → ostaje null */ }

contextBridge.exposeInMainWorld('electronAPI', {
    showNotification: (naslov, poruka, stranica) => {
        ipcRenderer.send('system-notif', { naslov, poruka, stranica });
    },
    saveHtml: (html, filename) => {
        ipcRenderer.send('save-html', { html, filename });
    },
    // Auto-update
    onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_e, info)     => cb(info)),
    onUpdateProgress:   (cb) => ipcRenderer.on('update-progress',   (_e, progress) => cb(progress)),
    onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_e, info)     => cb(info)),
    installUpdate: () => ipcRenderer.send('install-update'),
    // v4.0.0: offline ekran "Pokusaj ponovo" → ponovo ucitaj novi UI sa servera
    retryConnection: () => ipcRenderer.send('retry-connection'),
});

// v4.2.0: izbor servera firme — SAMO lokalni ekrani aplikacije (povezivanje, offline). Web app sa servera
// ovo ne dobija: stranica koja moze promijeniti adresu servera moze preusmjeriti i prijavu (main.js to
// provjerava i sam, po adresi stranice koja salje zahtjev).
if (location.protocol === 'file:') {
    contextBridge.exposeInMainWorld('aierpPostavke', {
        trenutni: () => ipcRenderer.invoke('server:trenutni'),
        povezi: (adresa) => ipcRenderer.invoke('server:povezi', adresa),
        otvoriPovezivanje: () => ipcRenderer.send('server:otvori-povezivanje'),
    });
}

// C-Fiskalni: drajver most (renderer → main → localhost:8085 TFS). Dostupan SAMO u desktop appu (browser = undefined).
contextBridge.exposeInMainWorld('fiskalniDrajver', {
    dostupan: true,
    protokol: PROTOKOL,   // { verzija, sha } — kasa poredi s potrebnom verzijom protokola
    testVeze: () => ipcRenderer.invoke('fiskalni:test'),
    statusUredjaja: () => ipcRenderer.invoke('fiskalni:status'),
    inicijalizacija: (op = 0, loz = 0) => ipcRenderer.invoke('fiskalni:init', { op, loz }),
    fiskalizuj: (racun) => ipcRenderer.invoke('fiskalni:fiskalizuj', racun),
    reklamiraj: (racun, original_broj) => ipcRenderer.invoke('fiskalni:reklamiraj', { racun, original_broj }),
    unosNovca: (vrsta, iznos_fening) => ipcRenderer.invoke('fiskalni:unos-novca', { vrsta, iznos_fening }),
    povratNovca: (vrsta, iznos_fening) => ipcRenderer.invoke('fiskalni:povrat-novca', { vrsta, iznos_fening }),
    presjekStanja: () => ipcRenderer.invoke('fiskalni:presjek'),
    dnevniIzvjestaj: () => ipcRenderer.invoke('fiskalni:dnevni'),
    osnovneInformacije: () => ipcRenderer.invoke('fiskalni:osnovne'),
    // MAL-04: naplati je JEDINI put računa do uređaja (protokol ≥ 4.3.0) — main upiše račun na disk (pos-kes.db) PRIJE štampe,
    // pošalje, upiše rezultat i TEK ONDA vrati. Kasa poslije javi serveru. duplikat/periodicni/rezim: nove komande uređaja.
    naplati: (posiljka) => ipcRenderer.invoke('fiskalni:naplati', posiljka),
    duplikat: (broj, tip = 'fiskalni') => ipcRenderer.invoke('fiskalni:duplikat', { broj, tip }),
    periodicniOdDo: (od, doDatum) => ipcRenderer.invoke('fiskalni:periodicni', { od, do: doDatum }),
    provjeriRezim: () => ipcRenderer.invoke('fiskalni:rezim'),
});

// C-POS skelet Faza 2: lokalni keš + offline queue most (renderer → main → better-sqlite3).
// Dostupan SAMO u desktop appu (browser = undefined → POS radi online-only, bez offline keša).
contextBridge.exposeInMainWorld('posOffline', {
    dostupan: true,
    spremiKatalog: (skladiste_id, artikli) => ipcRenderer.invoke('pos:katalog-save', { skladiste_id, artikli }),
    citajKatalog: (skladiste_id) => ipcRenderer.invoke('pos:katalog-get', { skladiste_id }),
    dodajURed: (racun) => ipcRenderer.invoke('pos:queue-add', racun),
    nesinhronizovani: () => ipcRenderer.invoke('pos:queue-pending'),
    oznaciPoslan: (lokalni_uid, server_id) => ipcRenderer.invoke('pos:queue-mark', { lokalni_uid, server_id }),
    // MAL-20: kasa bez interneta — paket kase u keš računara, offline prijava PIN-om (72 h, samo prodaja i smjena), tiha obnova prijave
    kasaPaketSpremi: (paket) => ipcRenderer.invoke('kasa:paket-spremi', paket),
    kasaStanje: () => ipcRenderer.invoke('kasa:stanje'),
    kasaKase: () => ipcRenderer.invoke('kasa:kase'),
    kasaRadnici: (skladiste_id) => ipcRenderer.invoke('kasa:radnici', skladiste_id),
    kasaPrijava: (u) => ipcRenderer.invoke('kasa:prijava', u),
    kasaOdjava: () => ipcRenderer.invoke('kasa:odjava'),
    kasaObrisiRadnike: () => ipcRenderer.invoke('kasa:obrisi-radnike'),
    kasaObnoviSesiju: () => ipcRenderer.invoke('kasa:obnovi-sesiju'),
    // MAL-21: smjena na disku kase (otvaranje, zatvaranje, primopredaja) i sync smjene
    smjenaOtvori: (u) => ipcRenderer.invoke('smjena:otvori', u),
    smjenaZatvori: (u) => ipcRenderer.invoke('smjena:zatvori', u),
    smjenaPrimopredaja: (u) => ipcRenderer.invoke('smjena:primopredaja', u),
    smjenaAktivna: (skladiste_id) => ipcRenderer.invoke('smjena:aktivna', skladiste_id),
    smjeneNesinhronizovane: () => ipcRenderer.invoke('smjena:nesinhronizovane'),
    smjenaOznaci: (lokalni_uid, o) => ipcRenderer.invoke('smjena:oznaci', { lokalni_uid, server_id: o && o.server_id, sukob: !!(o && o.sukob) }),
    smjenaPredajServeru: (lokalni_uid) => ipcRenderer.invoke('smjena:predaj-serveru', lokalni_uid),
});
