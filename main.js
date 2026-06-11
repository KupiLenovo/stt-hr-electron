const { app, BrowserWindow, Menu, shell, dialog, Notification, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

let mainWindow;
let rucnaProvjera = false; // v4.0.1: true dok korisnik rucno klikne "Provjeri azuriranja" (vidljiv feedback)

// ==========================================
// CLOUD SERVER INFO
// ==========================================
const CLOUD_SERVER_IP = '46.101.96.28';
const CLOUD_SERVER_PORT = 3737;

// v4.0.0 CUTOVER: Electron vise ne ucitava lokalni app/index.html (stari UI),
// nego NOVI UI direktno sa servera. URL je konfigurabilan preko env varijable
// da prelazak na domenu bude 1 linija + minor release.
// TODO (B.2 Batch 5): kad app.aierp.ba dobije A-record + TLS (Caddy),
//   default postaje 'https://app.aierp.ba'. IP ostaje fallback tokom tranzicije.
const SERVER_URL = process.env.STT_SERVER_URL || `http://${CLOUD_SERVER_IP}:${CLOUD_SERVER_PORT}`;

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
                detail: `STT Business Manager v${app.getVersion()}`
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

// v4.0.0: offline ekran "Pokusaj ponovo" dugme — ponovo ucitaj novi UI sa servera
ipcMain.on('retry-connection', () => {
    if (mainWindow) mainWindow.loadURL(SERVER_URL);
});

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
                mainWindow.webContents.executeJavaScript(`
                    window._navigateTo && window._navigateTo('${stranica}');
                `).catch(() => {});
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
    printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    printWin.webContents.once('did-finish-load', () => {
        printWin.webContents.print({ silent: false, printBackground: true }, (success) => {
            printWin.close();
        });
    });
});

ipcMain.on('system-notif', (event, { naslov, poruka, stranica }) => {
    showSystemNotif(naslov, poruka, stranica);
});

// ==========================================
// KREIRANJE PROZORA
// ==========================================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: 'STT Business Manager',
        backgroundColor: '#DEECF9',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        show: false,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    });

    // v4.0.0 CUTOVER: novi UI sa servera (ne vise lokalni app/index.html)
    mainWindow.loadURL(SERVER_URL);

    // Ako server nije dostupan — lokalni offline ekran (poruka + retry), ne bijeli ekran.
    // errorCode -3 = ABORTED (npr. redirect/reload u toku) — ignorisi, nije prava greska.
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        mainWindow.loadFile(path.join(__dirname, 'offline.html'));
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
                dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'Server Info',
                    message: 'STT Business Manager - Cloud Server',
                    detail: `Status: Aktivan\nServer: ${CLOUD_SERVER_IP}:${CLOUD_SERVER_PORT}\nLokacija: DigitalOcean Frankfurt\n\nSvi racunari se spajaju na ovaj cloud server.`
                });
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
    createWindow();
    setupAutoUpdater();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
