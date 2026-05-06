const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    showNotification: (naslov, poruka, stranica) => {
        ipcRenderer.send('system-notif', { naslov, poruka, stranica });
    },
    saveHtml: (html, filename) => {
        ipcRenderer.send('save-html', { html, filename });
    }
});
