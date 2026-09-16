// MAL-04 — fiskalni most (lib/fiskalni-most.js) protiv LAŽNOG TFS-a + pos-kes.db na disku. BEZ Electrona, BEZ uređaja.
// Sigurnosno pravilo: račun se upiše na disk PRIJE štampe; istek/prekid → 'nepoznato' (NIKAD ponovna štampa); oporavak čita brojač.
// Padne na starom kodu: nema fiskalni-most.js, ni naplati/oporaviRedove, ni fiskalnih stanja u queue_racun.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { napraviDriver } = require('./helpers/sqlite');
const { napraviTFS, osnovneXml, racunOkXml } = require('./helpers/tfs');

const OSN = '/osnovneinformacije';
const FISK = '/stampatifiskalniracun';
const REK = '/stampatireklamiraniracun';
const DUP = '/stampatiduplikatracuna';

const stavke = [{ naziv: 'Kafa', jm: 'kom', cijena_fening: 250, stopa_oznaka: 'E', kolicina_mili: 2000 }];
const gotovina = (f) => [{ vrsta: 'Gotovina', iznos_fening: f }];

let tfs, drajver, posKes, most, tmpDir;

before(async () => {
    tfs = napraviTFS();
    const port = await tfs.start();
    process.env.TRING_HOST = '127.0.0.1';
    process.env.TRING_PORT = String(port);
    process.env.TRING_TIMEOUT_MS = '300';   // spor odgovor → istek za 0,3 s (ne čeka 35 s)
    drajver = require('../fiskalni-drajver').napraviDrajver('tring');
    posKes = require('../lib/pos-kes');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mal04-most-'));
    assert.equal(posKes.init(tmpDir, napraviDriver()), true, 'pos-kes init');
    most = require('../lib/fiskalni-most').napraviMost({ drajver, posKes });
});
after(() => { tfs.stop(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows drži fajl */ } });

// TEST 1 — TFS vrati uspjeh; proces „padne" PRIJE poziva servera → red na disku već je 'fiskalizovan_lokalno' s brojem.
test('MOST.1 naplati OK → red na disku fiskalizovan_lokalno s brojem PRIJE bilo kakvog javljanja serveru', async () => {
    tfs.reset();
    tfs.odgovori(OSN, { body: osnovneXml({ bf: 41, cash: 100000 }) });
    tfs.odgovori(FISK, { body: racunOkXml(42) });
    const uid = 'UID-OK-1';
    const r = await most.naplati({ lokalni_uid: uid, skladiste_id: 3, smjena_id: 9, tip: 'fiskalni', stavke, placanja: gotovina(500), iznos_fening: 500 });
    assert.equal(r.ishod, 'fiskalizovan');
    assert.equal(r.fiskalni_broj, '42');
    // „pad" = ništa se ne javi serveru; red je već na disku (naplati ga je upisao PRIJE nego vratio rendereru)
    const red = posKes.redRacuna(uid);
    assert.equal(red.stanje, 'fiskalizovan_lokalno');
    assert.equal(red.fiskalni_broj, '42');
    assert.equal(red.poslan, 0, 'nije još javljen serveru, ali je fiskalizovan na disku');
    assert.equal(tfs.broj(FISK), 1, 'tačno jedan poziv štampe');
});

// TEST 2 — TFS ne odgovori (istek) → red 'nepoznato'; start s last_BF+1 → 'fiskalizovan_lokalno', a TFS je primio TAČNO JEDAN račun.
test('MOST.2 istek → nepoznato; oporavak po brojaču (last_BF+1) → fiskalizovan_lokalno, tačno JEDAN /stampatifiskalniracun', async () => {
    tfs.reset();
    tfs.odgovori(OSN, { body: osnovneXml({ bf: 41, cash: 100000 }) });   // snimak prije
    tfs.odgovori(FISK, { delayMs: 1500, body: racunOkXml(42) });          // uređaj štampa, ali odgovor kasni > 300 ms → istek
    const uid = 'UID-TIMEOUT-2';
    const r = await most.naplati({ lokalni_uid: uid, skladiste_id: 3, smjena_id: 9, tip: 'fiskalni', stavke, placanja: gotovina(500), iznos_fening: 500 });
    assert.equal(r.ishod, 'nepoznato', 'istek/prekid → nepoznato, NIKAD ponovna štampa');
    assert.equal(posKes.redRacuna(uid).stanje, 'nepoznato');
    assert.equal(tfs.broj(FISK), 1, 'račun poslan tačno jednom');

    // start: uređaj je u međuvremenu odštampao (last_BF 41 → 42, cash +5,00). Oporavak čita SAMO brojač.
    tfs.odgovori(OSN, { body: osnovneXml({ bf: 42, cash: 100500 }) });
    const rez = await most.oporaviRedove(Date.now() + 46000);   // preskoči 45 s čekanje deterministički
    assert.equal(rez.fiskalizovano, 1);
    const red = posKes.redRacuna(uid);
    assert.equal(red.stanje, 'fiskalizovan_lokalno');
    assert.equal(red.fiskalni_broj, '42', 'broj s brojača uređaja');
    assert.equal(red.fiskalni_potvrda, 'brojac');
    assert.equal(tfs.broj(FISK), 1, 'oporavak NE štampa ponovo — i dalje tačno jedan /stampatifiskalniracun');
});

// TEST 3 — oznaka plaćanja van šifrarnika (normPlacanje baca) → greška PRIJE slanja uređaju; ništa nije poslano ni upisano.
test('MOST.3 „Kartično WEB" (van PLACANJA) → greška prije uređaja; TFS bez računa, nema reda', async () => {
    tfs.reset();
    tfs.odgovori(OSN, { body: osnovneXml({ bf: 50 }) });   // ne bi smjelo ni doći do snimka
    const uid = 'UID-BADPAY-3';
    const r = await most.naplati({ lokalni_uid: uid, skladiste_id: 3, tip: 'fiskalni', stavke, placanja: [{ vrsta: 'Kartično WEB', iznos_fening: 500 }], iznos_fening: 500 });
    assert.equal(r.ishod, 'greska');
    assert.match(r.greska.poruka, /nepoznata_vrsta_placanja|Kartično WEB/);
    assert.equal(tfs.broj(FISK), 0, 'uređaj NIJE dobio račun');
    assert.equal(tfs.broj(OSN), 0, 'ni snimak brojača nije tražen');
    assert.equal(posKes.redRacuna(uid), null, 'ništa nije upisano na disk');
});

// TEST 4 — duplikat po BrojRacuna: šalje BrojRacuna i NE mijenja stanje reda.
test('MOST.4 duplikat šalje <BrojRacuna> i ne mijenja red', async () => {
    tfs.reset();
    // pripremi jedan fiskalizovan red
    tfs.odgovori(OSN, { body: osnovneXml({ bf: 41, cash: 100000 }) });
    tfs.odgovori(FISK, { body: racunOkXml(77) });
    const uid = 'UID-DUP-4';
    await most.naplati({ lokalni_uid: uid, skladiste_id: 3, tip: 'fiskalni', stavke, placanja: gotovina(500), iznos_fening: 500 });
    const prije = posKes.redRacuna(uid);

    tfs.reset();
    tfs.odgovori(DUP, { body: '<KasaOdgovor><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>' });
    await most.duplikat({ broj: 77, tip: 'fiskalni' });
    const zahtjev = tfs.zadnji(DUP);
    assert.ok(zahtjev, 'duplikat je otišao na uređaj');
    assert.match(zahtjev.body, /<BrojRacuna>77<\/BrojRacuna>/, 'duplikat nosi BrojRacuna');

    const poslije = posKes.redRacuna(uid);
    assert.equal(poslije.stanje, prije.stanje, 'stanje reda nepromijenjeno');
    assert.equal(poslije.fiskalni_broj, prije.fiskalni_broj, 'broj reda nepromijenjen');
});

// DEDUP — već fiskalizovan račun se NE šalje ponovo (isti lokalni_uid).
test('MOST.5 naplati istog uid-a dva puta → drugi put „vec", bez novog /stampatifiskalniracun', async () => {
    tfs.reset();
    tfs.odgovori(OSN, { body: osnovneXml({ bf: 41, cash: 100000 }) });
    tfs.odgovori(FISK, { body: racunOkXml(88) });
    const uid = 'UID-DEDUP-5';
    const posiljka = { lokalni_uid: uid, skladiste_id: 3, tip: 'fiskalni', stavke, placanja: gotovina(500), iznos_fening: 500 };
    const r1 = await most.naplati(posiljka);
    assert.equal(r1.ishod, 'fiskalizovan');
    assert.equal(tfs.broj(FISK), 1);
    const r2 = await most.naplati(posiljka);
    assert.equal(r2.ishod, 'fiskalizovan');
    assert.equal(r2.vec, true, 'prepoznat kao već fiskalizovan');
    assert.equal(tfs.broj(FISK), 1, 'uređaj NIJE dobio drugi račun');
});

// Uređaj bez veze pri snimku → račun se NE šalje (nedostupan), ništa nije odštampano.
test('MOST.6 snimak brojača padne (uređaj bez veze) → nedostupan, bez štampe', async () => {
    tfs.reset();
    tfs.odgovori(OSN, { drop: true });   // prekid veze na snimak
    const uid = 'UID-DOWN-6';
    const r = await most.naplati({ lokalni_uid: uid, skladiste_id: 3, tip: 'fiskalni', stavke, placanja: gotovina(500), iznos_fening: 500 });
    assert.equal(r.ishod, 'nedostupan');
    assert.equal(tfs.broj(FISK), 0, 'račun nije poslan');
    assert.equal(posKes.redRacuna(uid).stanje, 'greska', 'red ostaje greška — ništa nije odštampano, smije ponovo');
});

// Žurnal — raw odgovor uređaja se čuva (poređenje s uređajem); prored briše starije od 90 dana.
test('MOST.7 žurnal bilježi raw odgovor; prored ne dira svjež zapis', async () => {
    tfs.reset();
    tfs.odgovori(OSN, { body: osnovneXml({ bf: 41, cash: 100000 }) });
    tfs.odgovori(FISK, { body: racunOkXml(99) });
    await most.naplati({ lokalni_uid: 'UID-ZURN-7', skladiste_id: 3, tip: 'fiskalni', stavke, placanja: gotovina(500), iznos_fening: 500 });
    assert.ok(posKes.zurnalBroj() >= 1, 'raw odgovor u žurnalu');
    const p = posKes.zurnalProred(90);
    assert.equal(p.obrisano, 0, 'svjež zapis ostaje');
});
