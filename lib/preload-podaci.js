// Podaci s diska koje preload glavnog prozora treba, a ne može ih sam pročitati.
//
// Glavni prozor nema `sandbox: false`, pa je od Electrona 20 preload u SANDBOXU: njegov `require` zna samo 'electron' (i events,
// timers, url) — ni 'fs' ni lokalne fajlove. Preload iz 4.3.0 je na vrhu imao `require('fs')`: u pravoj aplikaciji to baca
// „module not found: fs", preload stane i prozor ne dobije NIJEDAN most (electronAPI, fiskalniDrajver, posOffline).
// Zato fajlove čita main (ovaj modul) i daje ih preloadu sinhrono: ipcRenderer.sendSync('preload:podaci') (main.js).
//   protokol — verzija Tring protokola iz kanonskog lib/fiskalni/tring.js + sha bajt-po-bajt kopije (lib/fiskalni/tring.sha256);
// Čist Node (bez Electrona) — test/preload.test.js ga zove isto kao main.
'use strict';
const fs = require('fs');
const path = require('path');

const KORIJEN = path.join(__dirname, '..');

function podaciZaPreload(korijen = KORIJEN) {
    let protokol = { verzija: null, sha: null };
    try {
        const tring = require(path.join(korijen, 'lib', 'fiskalni', 'tring'));
        const sha = fs.readFileSync(path.join(korijen, 'lib', 'fiskalni', 'tring.sha256'), 'utf8').trim().split(/\s+/)[0] || null;
        protokol = { verzija: tring.PROTOKOL_VERZIJA || null, sha };
    } catch { /* fajl nedostupan → ostaje null (kasa pokaže traku za staru verziju) */ }

    return { protokol };
}

module.exports = { podaciZaPreload };
