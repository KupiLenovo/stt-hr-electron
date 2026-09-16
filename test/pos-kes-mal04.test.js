// MAL-04 — nove pos-kes funkcije: fiskalni tok reda (priprema→salje_uredjaju→rezultat), sync s fiskalnim rezultatom, žurnal.
// Padne na starom kodu (nema pripremiNaplatu/oznaciSaljeUredjaju/upisiRezultat/redoviZaOporavak/zurnal*).
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal04-poskes-'));
    assert.equal(posKes.init(tmpDir, napraviDriver()), true);
});
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('PK04.1 pripremiNaplatu → red na disku u stanju priprema (prije ijednog poziva uređaju)', () => {
    posKes.pripremiNaplatu({ lokalni_uid: 'A', skladiste_id: 3, smjena_id: 9, tip: 'fiskalni', iznos_fening: 500, placanja: [{ vrsta: 'Gotovina', iznos_fening: 500 }], payload: { lokalni_uid: 'A', stavke: [] } });
    const r = posKes.redRacuna('A');
    assert.equal(r.stanje, 'priprema');
    assert.equal(r.iznos_fening, 500);
    assert.equal(r.poslan, 0);
});

test('PK04.2 salje_uredjaju → snimak prije + pokušaj +1; upisiRezultat → fiskalizovan_lokalno', () => {
    posKes.oznaciSaljeUredjaju('A', { last_BF: 41 }, '2026-09-16 10:00:00', 1000);
    let r = posKes.redRacuna('A');
    assert.equal(r.stanje, 'salje_uredjaju');
    assert.equal(r.pokusaja, 1);
    assert.ok(JSON.parse(r.uredjaj_prije).last_BF === 41);
    posKes.upisiRezultat('A', { stanje: 'fiskalizovan_lokalno', fiskalni_broj: '42', fiskalni_potvrda: 'uredjaj', rezultat: JSON.stringify({ raw: '<x/>' }) });
    r = posKes.redRacuna('A');
    assert.equal(r.stanje, 'fiskalizovan_lokalno');
    assert.equal(r.fiskalni_broj, '42');
});

test('PK04.3 nesinhronizovani spaja fiskalni rezultat iz reda (za /racuni/sync)', () => {
    const red = posKes.nesinhronizovani().racuni.find((x) => x.lokalni_uid === 'A');
    assert.ok(red, 'račun je u redu za sync');
    assert.equal(red.fiskalni_status, 'fiskalizovan', 'fiskalizovan_lokalno → fiskalizovan za server');
    assert.equal(red.fiskalni_broj, '42');
    assert.equal(red.fiskalni_potvrda, 'uredjaj');
});

test('PK04.4 oznaciPoslan → stanje poslan i pending -1', () => {
    const prije = posKes.nesinhronizovaniBroj();
    posKes.oznaciPoslan('A', 555);
    assert.equal(posKes.redRacuna('A').stanje, 'poslan');
    assert.equal(posKes.nesinhronizovaniBroj(), prije - 1);
});

test('PK04.5 redoviZaOporavak vraća samo salje_uredjaju/nepoznato (ne fiskalizovan/poslan)', () => {
    posKes.pripremiNaplatu({ lokalni_uid: 'B', skladiste_id: 3, tip: 'fiskalni', iznos_fening: 100, placanja: [{ vrsta: 'Gotovina', iznos_fening: 100 }], payload: { lokalni_uid: 'B' } });
    posKes.oznaciSaljeUredjaju('B', { last_BF: 42 }, '2026-09-16 10:05:00', 2000);
    posKes.upisiRezultat('B', { stanje: 'nepoznato' });
    const uidovi = posKes.redoviZaOporavak().map((r) => r.lokalni_uid);
    assert.ok(uidovi.includes('B'), 'nepoznato je za oporavak');
    assert.ok(!uidovi.includes('A'), 'poslan/fiskalizovan nije za oporavak');
});

test('PK04.6 dodajURed (stari offline red) i dalje radi bez fiskalnih polja', () => {
    posKes.dodajURed({ lokalni_uid: 'OFF', skladiste_id: 1, stavke: [{ x: 1 }] });
    const r = posKes.nesinhronizovani().racuni.find((x) => x.lokalni_uid === 'OFF');
    assert.ok(r);
    assert.equal(r.fiskalni_status, undefined, 'stari red bez fiskalnog statusa (backward-compat)');
});

test('PK04.8 kanal „fiskalizovano" (VP/storno) NIJE u POS sync-u (ne pravi lažan pos_racun)', () => {
    posKes.pripremiNaplatu({ lokalni_uid: 'vp:123', skladiste_id: 3, kanal: 'fiskalizovano', tip: 'fiskalni', iznos_fening: 5000, placanja: [{ vrsta: 'Virman', iznos_fening: 5000 }], payload: { lokalni_uid: 'vp:123' } });
    posKes.upisiRezultat('vp:123', { stanje: 'fiskalizovan_lokalno', fiskalni_broj: '7' });
    const uidovi = posKes.nesinhronizovani().racuni.map((x) => x.lokalni_uid);
    assert.ok(!uidovi.includes('vp:123'), 'fiskalizovano red ne ide kroz /racuni/sync');
});

test('PK04.7 žurnal: dodaj + broj + prored (svjež ostaje)', () => {
    const prije = posKes.zurnalBroj();
    posKes.zurnalDodaj({ lokalni_uid: 'A', komanda: '/stampatifiskalniracun', fiskalni_broj: '42', raw: '<KasaOdgovor/>' });
    assert.equal(posKes.zurnalBroj(), prije + 1);
    assert.equal(posKes.zurnalProred(90).obrisano, 0);
});
