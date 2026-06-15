const { contextBridge, ipcRenderer } = require('electron');

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

// C-Fiskalni: drajver most (renderer → main → localhost:8085 TFS). Dostupan SAMO u desktop appu (browser = undefined).
contextBridge.exposeInMainWorld('fiskalniDrajver', {
    dostupan: true,
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
});
