// MAL-03 — offline kasa (lib/pos-kes.js): idempotentan red računa i keš kataloga.
// Baza: better-sqlite3 (CI, Node 20) ili node:sqlite adapter (lokalno, Node 22+) — vidi test/helpers/sqlite.js. BEZ Electrona.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { napraviDriver } = require('./helpers/sqlite');
const posKes = require('../lib/pos-kes');

let tmpDir;
before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-kes-test-'));
    const ok = posKes.init(tmpDir, napraviDriver());
    assert.equal(ok, true, 'pos-kes init mora uspjeti (better-sqlite3 ili node:sqlite)');
});
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* baza možda još drži fajl (Windows) */ } });

test('POSKES.1 init uspješan i baza spremna', () => {
    assert.equal(posKes.spreman(), true);
});

test('POSKES.2 dodajURed dva puta isti lokalni_uid → jedan red (idempotentno)', () => {
    const prije = posKes.nesinhronizovaniBroj();
    posKes.dodajURed({ lokalni_uid: 'UID-A', skladiste_id: 1, iznos: 1 });
    const r2 = posKes.dodajURed({ lokalni_uid: 'UID-A', skladiste_id: 1, iznos: 2 });
    assert.equal(r2.pending, prije + 1, 'drugi put isti uid NE dodaje novi red');
    const redovi = posKes.nesinhronizovani().racuni.filter((x) => x.lokalni_uid === 'UID-A');
    assert.equal(redovi.length, 1, 'samo jedan red za taj uid');
});

test('POSKES.3 oznaciPoslan smanjuje pending', () => {
    posKes.dodajURed({ lokalni_uid: 'UID-B', skladiste_id: 1 });
    const prije = posKes.nesinhronizovaniBroj();
    const r = posKes.oznaciPoslan('UID-B', 555);
    assert.equal(r.pending, prije - 1, 'označen kao poslan → pending -1');
});

test('POSKES.4 spremiKatalog/citajKatalog round-trip (barkodovi JSON, cijena, synced_at)', () => {
    posKes.spremiKatalog(7, [{ id: 10, sifra: 'A1', naziv: 'Espresso', jm: 'kom', stopa: 1700, cijena_fening: 250, barkodovi: ['3800', '1111'] }]);
    const kat = posKes.citajKatalog(7);
    assert.equal(kat.artikli.length, 1);
    assert.deepEqual(kat.artikli[0].barkodovi, ['3800', '1111'], 'barkodovi kroz JSON tam-i-nazad');
    assert.equal(kat.artikli[0].cijena_fening, 250);
    assert.ok(kat.synced_at, 'synced_at postavljen');
});

test('POSKES.5 nesinhronizovani vraća payload računa iz reda', () => {
    posKes.dodajURed({ lokalni_uid: 'UID-C', skladiste_id: 3, stavke: [{ x: 1 }] });
    const nadjen = posKes.nesinhronizovani().racuni.find((x) => x.lokalni_uid === 'UID-C');
    assert.ok(nadjen, 'račun je u redu');
    assert.equal(nadjen.skladiste_id, 3);
});
