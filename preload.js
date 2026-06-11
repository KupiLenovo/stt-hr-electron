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
