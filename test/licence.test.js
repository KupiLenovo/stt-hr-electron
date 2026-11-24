// PLT-22: fajl licenci trećih strana ide u instalaciju (pored exe-a) i prati package-lock.json.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lic = require('../scripts/licence-trecih-strana');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const FAJL = fs.readFileSync(lic.FAJL, 'utf8').replace(/\r\n?/g, '\n');

test('LIC.1 fajl ide u instalaciju pored exe-a (extraFiles) i nije u app.asar', () => {
    assert.deepEqual(PKG.build.extraFiles, [{ from: 'LICENCE-TRECIH-STRANA.txt', to: 'LICENCE-TRECIH-STRANA.txt' }]);
    assert.ok(!PKG.build.files.includes('LICENCE-TRECIH-STRANA.txt'));
});

test('LIC.2 spisak u fajlu = produkcijski paketi iz package-lock.json (bez dev paketa: electron, electron-builder)', () => {
    const paketi = lic.paketiIzLocka(LOCK);
    assert.deepEqual(lic.spisakIzFajla(FAJL), paketi.map(lic.red), 'pokreni `npm run licence` poslije promjene zavisnosti');
    const imena = new Set(paketi.map((p) => p.ime));
    for (const d of Object.keys(PKG.dependencies)) assert.ok(imena.has(d), `nema ${d}`);
    for (const d of Object.keys(PKG.devDependencies)) assert.ok(!imena.has(d), `dev paket ${d} ne ide u aplikaciju`);
    assert.match(FAJL, /LICENSE\.electron\.txt i LICENSES\.chromium\.html/, 'upućuje na licence Electrona i Chromiuma');
});

test('LIC.3 svaki paket ima licencu i tekst (ili jasnu napomenu); s instaliranim paketima fajl je bajt-isti generisanom', () => {
    const paketi = lic.paketiIzLocka(LOCK);
    for (const p of paketi) {
        assert.ok(p.licenca && p.licenca !== 'nepoznata', `${p.ime}: licenca`);
        assert.ok(FAJL.includes(`\n${p.ime} ${p.verzija} (${p.licenca})\n`), `${p.ime}: odjeljak teksta`);
    }
    const instalirano = paketi.every((p) => fs.existsSync(path.join(ROOT, p.putanja)));
    if (!instalirano) return;   // npr. lokalno bez npm ci — build.yml svakako radi --provjeri
    assert.equal(lic.sastavi(paketi).tekst, FAJL);
});

test('LIC.4 sastavljanje: nedostajući paket se prijavi, prazan tekst dobije napomenu', () => {
    const paketi = [{ ime: 'a', verzija: '1.0.0', licenca: 'MIT', putanja: 'node_modules/a' }, { ime: 'b', verzija: '2.0.0', licenca: 'ISC', putanja: 'node_modules/b' }];
    const r = lic.sastavi(paketi, (p) => (p.endsWith('/a') ? '' : null));
    assert.deepEqual(r.nema, ['b@2.0.0']);
    assert.match(r.tekst, /Paket nema fajl licence; licenca prema package.json: MIT\./);
    assert.deepEqual(lic.spisakIzFajla(r.tekst), ['  a 1.0.0 — MIT', '  b 2.0.0 — ISC']);
});
