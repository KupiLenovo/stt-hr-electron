// preload.js u sandboxu (Electron 20+ zadano — glavni prozor nema `sandbox: false`): `require` zna samo 'electron'.
// Preload iz 4.3.0 je na vrhu imao `require('fs')` → u pravoj aplikaciji „module not found: fs", preload stane i prozor ne dobije
// nijedan most (electronAPI, fiskalniDrajver, posOffline). Provjereno u pravom Electronu 28. Ovaj test pokreće preload s istim
// ograničenim `require` (test/helpers/preload.js) i drži da se to ne vrati.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pokreniPreload, PRELOAD } = require('./helpers/preload');

const ROOT = path.join(__dirname, '..');

test('PRE.1 preload u sandboxu izlaže sve mostove (electronAPI, fiskalniDrajver, posOffline)', () => {
    const { mostovi } = pokreniPreload();
    for (const ime of ['electronAPI', 'fiskalniDrajver', 'posOffline']) assert.ok(mostovi[ime], `nema mosta ${ime}`);
    assert.equal(mostovi.aierpPostavke, undefined, 'web app sa servera ne dobija izbor servera');
    assert.ok(pokreniPreload({ protokolStranice: 'file:' }).mostovi.aierpPostavke, 'lokalni ekran dobija izbor servera');
});

test('PRE.2 preload ne traži modul koji sandbox nema (samo electron)', () => {
    // bez komentara (komentar smije spominjati stari require('fs'))
    const kod = fs.readFileSync(PRELOAD, 'utf8').split(/\r?\n/).filter((r) => !r.trim().startsWith('//')).join('\n');
    const trazi = [...kod.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(trazi)], ['electron'], `preload traži: ${trazi.join(', ')}`);
});

test('PRE.3 protokol Tringa stiže iz maina (verzija + sha kopije), kao do sada', () => {
    const { mostovi, pozivi } = pokreniPreload();
    const tring = require('../lib/fiskalni/tring');
    const sha = fs.readFileSync(path.join(ROOT, 'lib', 'fiskalni', 'tring.sha256'), 'utf8').trim().split(/\s+/)[0];
    assert.deepEqual(mostovi.fiskalniDrajver.protokol, { verzija: tring.PROTOKOL_VERZIJA, sha });
    assert.equal(pozivi.filter((p) => p.vrsta === 'sendSync').length, 1, 'jedan sinhroni poziv pri učitavanju');
});

test('PRE.4 main bez kanala (ili greška) → preload i dalje izlaže mostove, protokol null', () => {
    const { mostovi } = pokreniPreload({ sendSync: () => { throw new Error('nema kanala'); } });
    // objekat je iz vm konteksta preloada (drugi prototip) → poređenje preko JSON-a
    assert.deepEqual(JSON.parse(JSON.stringify(mostovi.fiskalniDrajver.protokol)), { verzija: null, sha: null });
    assert.equal(mostovi.posOffline.dostupan, true);
    assert.equal(typeof mostovi.posOffline.dodajURed, 'function');
});

test('PRE.5 main.js odgovara na preload:podaci iz lib/preload-podaci.js', () => {
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(main, /require\('\.\/lib\/preload-podaci'\)/);
    assert.match(main, /ipcMain\.on\('preload:podaci',\s*\(e\)\s*=>\s*\{\s*e\.returnValue\s*=/);
});
