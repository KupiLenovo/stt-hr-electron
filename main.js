const { app, BrowserWindow, Menu, shell, dialog, Notification, ipcMain } = require('electron');
const path = require('path');

let mainWindow;

// ==========================================
// CLOUD SERVER INFO (ne pokrecemo lokalni vise)
// ==========================================
const CLOUD_SERVER_IP = '46.101.96.28';
const CLOUD_SERVER_PORT = 3737;

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
    // Print directly without save dialog
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
        title: 'STT HR Menadzment',
        backgroundColor: '#f9fafb',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        show: false,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    });

    mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
        // Otvori DevTools samo u dev modu
        if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
            mainWindow.webContents.openDevTools();
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('blob:') || url.startsWith('data:')) {
            return { action: 'allow' };
        }
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
            { label: 'DevTools', accelerator: 'F12', click: () => { if (mainWindow) mainWindow.webContents.toggleDevTools(); } },
            { type: 'separator' },
            { label: 'Info o serveru', click: () => {
                dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'Server Info',
                    message: 'STT HR - Cloud Server',
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

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
