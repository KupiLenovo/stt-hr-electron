// Pokreće preload.js BEZ Electrona, s istim ograničenjima kao sandbox preload u pravoj aplikaciji: `require` zna samo 'electron'
// (contextBridge, ipcRenderer) i events/timers/url; sve ostalo baca „module not found: <ime>" kao Electron.
// Vraća mostove koje je preload izložio (exposeInMainWorld) i dnevnik IPC poziva (invoke/send/sendSync).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PRELOAD = path.join(__dirname, '..', '..', 'preload.js');
const DOZVOLJENI = new Set(['events', 'timers', 'url']);

/**
 * @param {object} o
 * @param {(kanal:string)=>any} [o.sendSync] odgovor maina na sendSync (zadano: kao main.js — lib/preload-podaci.js)
 * @param {string} [o.protokolStranice] location.protocol ('https:' = web app sa servera, 'file:' = lokalni ekran)
 */
function pokreniPreload(o = {}) {
    const mostovi = {};
    const pozivi = [];
    const { podaciZaPreload } = require('../../lib/preload-podaci');
    const sendSync = o.sendSync || ((kanal) => (kanal === 'preload:podaci' ? podaciZaPreload() : undefined));
    const electron = {
        contextBridge: { exposeInMainWorld: (ime, obj) => { mostovi[ime] = obj; } },
        ipcRenderer: {
            invoke: (kanal, ...arg) => { pozivi.push({ vrsta: 'invoke', kanal, arg }); return Promise.resolve({ ok: true }); },
            send: (kanal, ...arg) => { pozivi.push({ vrsta: 'send', kanal, arg }); },
            on: (kanal) => { pozivi.push({ vrsta: 'on', kanal }); },
            sendSync: (kanal, ...arg) => { pozivi.push({ vrsta: 'sendSync', kanal, arg }); return sendSync(kanal, ...arg); },
        },
    };
    const sandboxRequire = (ime) => {
        if (ime === 'electron') return electron;
        if (DOZVOLJENI.has(ime)) return require(ime);
        throw new Error(`module not found: ${ime}`);
    };
    const kod = fs.readFileSync(PRELOAD, 'utf8');
    const fn = vm.runInNewContext(`(function (require, location) {\n${kod}\n})`, {}, { filename: PRELOAD });
    fn(sandboxRequire, { protocol: o.protokolStranice || 'https:' });
    return { mostovi, pozivi };
}

module.exports = { pokreniPreload, PRELOAD };
