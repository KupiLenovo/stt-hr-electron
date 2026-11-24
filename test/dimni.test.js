// PLT-22: dimni test spakovane aplikacije (`--smoke`). Pravi Electron se pokreće u build.yml (poslije pakovanja) i lokalno
// (`npm run dimni-test`); ovdje se drži ocjena rezultata i da dimni test nikad ne dira pravi profil kase.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dimni = require('../lib/dimni-test');
const { komanda } = require('../scripts/dimni-test');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

const DOBRO = {
    verzija: '4.7.0', electron: '28.3.3', spakovana: true, nazivProizvoda: 'Vault aiERP',
    ucitan: true, vidljiv: true, url: 'file:///C:/Program%20Files/aiERP/resources/app.asar/povezivanje.html', naslov: 'Vault aiERP — Povezivanje s firmom',
    kesSpreman: true, kesUpis: true, mostovi: { electronAPI: 'object', fiskalniDrajver: 'object', posOffline: 'object', aierpPostavke: 'object' },
};

test('DIM.1 sve u redu → DIMNI TEST OK (izlaz 0)', () => {
    const r = dimni.ocijeni(DOBRO);
    assert.equal(r.ok, true);
    assert.match(r.redovi[0], /^DIMNI TEST OK — verzija 4\.7\.0, Electron 28\.3\.3, spakovana aplikacija$/);
    assert.ok(r.redovi.slice(1).every((x) => x.startsWith('OK ')));
});

test('DIM.2 pada kad: nativni modul (better-sqlite3) ne radi, most fali, prozor nije prikazan ili je otišao na mrežu', () => {
    for (const [izmjena, trag] of [
        [{ kesSpreman: false, kesUpis: false, greskaKesa: 'NODE_MODULE_VERSION' }, /better-sqlite3/],
        [{ mostovi: { ...DOBRO.mostovi, posOffline: 'undefined' } }, /most posOffline/],
        [{ mostovi: null }, /most electronAPI/],
        [{ vidljiv: false }, /prikazan/],
        [{ url: 'https://firma.example/' }, /lokalni ekran/],
        [{ ucitan: false, greskaUcitavanja: '-6 ERR_FILE_NOT_FOUND' }, /učitao — -6/],
        [{ naslov: 'Electron' }, /naslov/],
    ]) {
        const r = dimni.ocijeni({ ...DOBRO, ...izmjena });
        assert.equal(r.ok, false, JSON.stringify(izmjena));
        assert.match(r.redovi[0], /^DIMNI TEST PAO/);
        assert.ok(r.redovi.some((x) => x.startsWith('NE ') && trag.test(x)), `${JSON.stringify(izmjena)} → ${r.redovi.join(' | ')}`);
    }
});

test('DIM.3 provjera upisa u bazu kase', () => {
    assert.deepEqual(dimni.provjeriUpis(null), { ok: false, greska: 'baza nije otvorena' });
    const redovi = [];
    const lazna = {
        exec: () => {},
        prepare: (sql) => ({ run: (t) => redovi.push(t), get: () => (/SELECT/.test(sql) ? { t: redovi.at(-1) } : undefined) }),
    };
    assert.deepEqual(dimni.provjeriUpis(lazna), { ok: true });
    assert.equal(dimni.provjeriUpis({ exec: () => { throw new Error('disk pun'); } }).greska, 'disk pun');
    // izraz za renderer pita samo tipove mostova
    // eslint-disable-next-line no-new-func
    const tipovi = new Function('window', `return ${dimni.IZRAZ_MOSTOVA};`)({ electronAPI: {}, posOffline: {} });
    assert.deepEqual(tipovi, { electronAPI: 'object', fiskalniDrajver: 'undefined', posOffline: 'object', aierpPostavke: 'undefined' });
});

test('DIM.4 main.js: --smoke postavi privremeni profil PRIJE prvog čitanja userData, bez servera firme i bez ažuriranja', () => {
    const iSmoke = MAIN.indexOf("app.setPath('userData', DIMNI_PROFIL)");
    assert.ok(iSmoke > 0, 'dimni test postavlja userData');
    const prvoCitanje = MAIN.indexOf("app.getPath('userData')");
    assert.ok(iSmoke < prvoCitanje, 'privremeni profil prije prvog app.getPath(userData) (STARA_INSTALACIJA)');
    assert.match(MAIN, /if \(DIMNI_TEST\) \{ app\.setPath\('userData', DIMNI_PROFIL\); delete process\.env\.STT_SERVER_URL; \}/);
    assert.match(MAIN, /if \(DIMNI_TEST\) return pokreniDimniTest\(\);[^\n]*\n\s*setupAutoUpdater\(\);/);
});

test('DIM.5 pokretač: uvijek --smoke; spakovana aplikacija mora postojati', () => {
    // CI testova nema Electron (npm ci --omit=dev) — „spakovana aplikacija" je ovdje bilo koji postojeći fajl
    const k = komanda([__filename]);
    assert.ok(k.args.includes('--smoke'));
    assert.ok(k.cmd === path.resolve(__filename) || k.args.includes(path.resolve(__filename)), 'pokreće baš zadani exe (ili kroz xvfb-run)');
    assert.throws(() => komanda([path.join(ROOT, 'nema', 'aiERP.exe')]), /Nema spakovane aplikacije/);
});
