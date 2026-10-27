// MAL-2 (N-1) — UGOVOR OFFLINE MOSTA KASE: lib/kasa-offline-ugovor.json je BAJT-PO-BAJT kopija serverskog (stt-hr-server, isti put)
// uz lib/kasa-offline-ugovor.sha256. Serverski CI posao `offline-ogledalo` poredi desktop main kopiju sa serverskom; ovaj test veže
// ugovor za desktop kod: most window.posOffline (preload.js), tijelo sinhronizacije smjene (lib/kasa-offline.js tijeloSynca) i
// račune iz reda (lib/pos-kes.js nesinhronizovani). Ako test padne zbog ugovora, ugovor se NE mijenja samo ovdje — ide u oba repoa
// istim PR parom (stt-hr-server docs/desktop/offline-ugovor.md, „Redoslijed izmjene mosta").
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pokreniPreload } = require('./helpers/preload');
const { napraviDriver } = require('./helpers/sqlite');
const posKes = require('../lib/pos-kes');
const ko = require('../lib/kasa-offline');

const ROOT = path.join(__dirname, '..');
const UGOVOR_PUT = path.join(ROOT, 'lib', 'kasa-offline-ugovor.json');
const SHA_PUT = path.join(ROOT, 'lib', 'kasa-offline-ugovor.sha256');
const UGOVOR = JSON.parse(fs.readFileSync(UGOVOR_PUT, 'utf8'));
const METODE = UGOVOR.most.metode;
const lf = (s) => s.replace(/\r\n/g, '\n');   // Windows checkout (autocrlf) → kanonski hash je LF (.gitattributes eol=lf)
const zapisaniSha = () => fs.readFileSync(SHA_PUT, 'utf8').trim().split(/\s+/)[0];
const json = (x) => JSON.parse(JSON.stringify(x));   // ono što stvarno ode serveru (undefined polja otpadaju)

// ---- 1. fajl ugovora ----
test('UG.1 kasa-offline-ugovor.sha256 je SHA-256 ugovora (LF)', () => {
    assert.match(zapisaniSha(), /^[0-9a-f]{64}$/);
    const izracunat = crypto.createHash('sha256').update(lf(fs.readFileSync(UGOVOR_PUT, 'utf8')), 'utf8').digest('hex');
    assert.equal(izracunat, zapisaniSha(), 'ugovor promijenjen bez ažuriranja .sha256 (ili obrnuto)');
});

test('UG.2 ugovor je kasa-offline-most, LF sa završnim redom', () => {
    const tekst = fs.readFileSync(UGOVOR_PUT, 'utf8');
    assert.equal(UGOVOR.ugovor, 'kasa-offline-most');
    assert.equal(UGOVOR.most.globalno, 'window.posOffline');
    assert.ok(tekst.endsWith('\n'), 'završni red');
    assert.ok(!lf(tekst).includes('\r'), 'samo LF');
});

// ---- 2. most window.posOffline (pravi preload.js, sandbox require) ----
const most = () => pokreniPreload().mostovi.posOffline;

test('UG.3 obavezne metode postoje u mostu', () => {
    const m = most();
    const obavezne = Object.keys(METODE).filter((k) => METODE[k].obavezna);
    assert.deepEqual(obavezne.sort(), ['citajKatalog', 'dodajURed', 'dostupan', 'nesinhronizovani', 'oznaciPoslan', 'spremiKatalog']);
    for (const ime of obavezne) assert.ok(ime in m, `obavezna ${ime} nedostaje`);
    assert.equal(m.dostupan, true);
});

test('UG.4 metode koje klijent zove postoje (osim u_desktopu: false — buduće izdanje)', () => {
    const m = most();
    for (const [ime, d] of Object.entries(METODE)) {
        if (!d.klijent_zove) continue;
        if (d.u_desktopu === false) { assert.ok(!(ime in m), `${ime} ima u_desktopu:false, a most je izlaže — ažuriraj ugovor u oba repoa`); continue; }
        assert.equal(typeof m[ime], 'function', `klijent zove ${ime}, desktop je nema`);
    }
});

test('UG.5 most nema ništa van ugovora — ni kad main ne da listu metoda', () => {
    for (const m of [most(), pokreniPreload({ sendSync: () => ({}) }).mostovi.posOffline]) {
        for (const ime of Object.keys(m)) assert.ok(Object.hasOwn(METODE, ime), `posOffline.${ime} nije u ugovoru`);
    }
});

test('UG.6 most se gradi iz ugovora: metoda izbačena iz ugovora nestaje iz mosta', () => {
    const { podaciZaPreload } = require('../lib/preload-podaci');
    const p = podaciZaPreload();
    assert.deepEqual(p.ugovor.metode, Object.keys(METODE));
    assert.equal(p.ugovor.verzija, UGOVOR.verzija);
    const bez = { ...p, ugovor: { ...p.ugovor, metode: p.ugovor.metode.filter((x) => x !== 'kasaOdjava') } };
    const m = pokreniPreload({ sendSync: () => bez }).mostovi.posOffline;
    assert.ok(!('kasaOdjava' in m));
    assert.equal(typeof m.dodajURed, 'function');
});

test('UG.7 broj argumenata svake IPC funkcije = argumenti.length; svojstvo nije funkcija', () => {
    const m = most();
    for (const [ime, d] of Object.entries(METODE)) {
        if (!(ime in m)) continue;
        if (d.svojstvo) { assert.equal(typeof m[ime], d.svojstvo, `${ime} je svojstvo tipa ${d.svojstvo}`); continue; }
        assert.equal(typeof m[ime], 'function', ime);
        assert.equal(m[ime].length, d.argumenti.length, `${ime}: preload prima ${m[ime].length}, ugovor ${d.argumenti.length} argumenta`);
    }
});

test('UG.8 objekte koje metoda prima preload čita samo po ključevima iz `polja`', () => {
    const { mostovi, pozivi } = pokreniPreload();
    const m = mostovi.posOffline;
    for (const [ime, d] of Object.entries(METODE)) {
        if (typeof m[ime] !== 'function') continue;
        const procitano = [];
        const arg = d.argumenti.map((a, i) => (a.polja
            ? new Proxy({}, { get: (_t, k) => { if (typeof k === 'string') procitano.push([i, k]); return undefined; } })
            : (/number/.test(a.tip) ? 7 : a.tip === 'string' ? 'uid-1' : [])));
        const prije = pozivi.length;
        m[ime](...arg);
        assert.equal(pozivi.length, prije + 1, `${ime} zove IPC tačno jednom`);
        assert.equal(pozivi[prije].vrsta, 'invoke');
        for (const [i, k] of procitano) {
            assert.ok(d.argumenti[i].polja.includes(k), `${ime}: preload čita ${d.argumenti[i].ime}.${k}, a toga nema u polja`);
        }
    }
});

// ---- 3. tijelo sinhronizacije smjene (tijeloSynca) po pravilima ugovora ----
const prazno = (v) => v === undefined || v === null || v === '';
/** Tijelo kakvo ugovor propisuje za lokalnu smjenu s (iz / rezerva, prazno:"izostaje", ako/jednako, polja objekta, dodaje:"klijent"). */
function poUgovoru(polja, s) {
    const out = {};
    for (const [ime, p] of Object.entries(polja)) {
        if (p.dodaje === 'klijent') continue;                  // racuni: dodaje klijent
        if (p.ako !== undefined) {
            const v = s[p.ako];
            if (p.jednako !== undefined ? v !== p.jednako : !v) continue;
        }
        if (p.polja) { out[ime] = poUgovoru(p.polja, s); continue; }
        if (p.iz === null || p.iz === undefined) continue;    // desktop ga ne šalje (npr. zatvaranje.razlika_tereti)
        let v = s[p.iz];
        if (prazno(v) && p.rezerva) v = s[p.rezerva];
        if (p.prazno === 'izostaje' && prazno(v)) continue;
        out[ime] = v;
    }
    return out;
}
const TIP = { string: 'string', number: 'number', objekt: 'object' };
function provjeriTipove(polja, tijelo, gdje = '') {
    for (const [ime, p] of Object.entries(polja)) {
        if (p.obavezno) assert.ok(!prazno(tijelo[ime]), `${gdje}${ime} je obavezno`);
        if (!Object.hasOwn(tijelo, ime) || tijelo[ime] === null) continue;
        if (p.polja) { provjeriTipove(p.polja, tijelo[ime], `${gdje}${ime}.`); continue; }
        if (TIP[p.tip]) assert.equal(typeof tijelo[ime], TIP[p.tip], `${gdje}${ime} je ${p.tip}`);
    }
}
const POLJA_SMJENE = UGOVOR.sinhronizacija.smjena.polja;
const SMJENA = {
    lokalni_uid: 'L-1', skladiste_id: 10, server_id: null, status: 'otvorena', otvorio_radnik_id: 6, otvoreno_at: '2026-10-05 08:00:00',
    pocetni_fond_fening: 5000, prebrojano_fening: null, zatvoreno_at: null, sukob: 0, zatvorio_radnik_id: null, napomena: null,
    napomena_zatvaranja: null, uredjaj: null, prethodna_uid: null, sinhronizovana: 0, sync_at: null,
};
const SLUCAJEVI = {
    'otvorena, bez server_id i napomene': {},
    'otvorena online (server_id), s napomenom': { server_id: 77, napomena: 'Polog iz trezora' },
    'otvorena, prazna napomena': { napomena: '' },
    'zatvorena, bez uređaja i napomene': { status: 'zatvorena', zatvoreno_at: '2026-10-05 16:00:00', zatvorio_radnik_id: 4, prebrojano_fening: 12345 },
    'zatvorena, s uređajem i napomenom': { status: 'zatvorena', zatvoreno_at: '2026-10-05 16:00:00', zatvorio_radnik_id: 6, prebrojano_fening: 0,
        napomena_zatvaranja: 'Manjak 2 KM', uredjaj: { z_broj: 12, gotovina: 100 }, server_id: 9 },
    'zatvorena, bez zatvorio_radnik_id (bez rezerve), prebrojano null': { status: 'zatvorena', zatvoreno_at: '2026-10-05 16:00:00', napomena_zatvaranja: '' },
};

test('UG.9 tijeloSynca daje tačno polja iz sinhronizacija.smjena.polja (svaki slučaj)', () => {
    for (const [naziv, izmjena] of Object.entries(SLUCAJEVI)) {
        const s = { ...SMJENA, ...izmjena };
        const tijelo = json(ko.tijeloSynca(s));
        assert.deepEqual(tijelo, json(poUgovoru(POLJA_SMJENE, s)), `slučaj: ${naziv}`);
        provjeriTipove(POLJA_SMJENE, tijelo, `${naziv}: `);
        assert.ok(!('racuni' in tijelo), 'racuni dodaje klijent');
        if (s.status !== 'zatvorena') assert.ok(!('zatvaranje' in tijelo), `${naziv}: zatvaranje samo za zatvorenu smjenu`);
        else assert.ok(!('razlika_tereti' in tijelo.zatvaranje), 'razlika_tereti desktop ne šalje (iz: null)');
    }
});

test('UG.10 tijeloSynca ne šalje ništa van ugovora', () => {
    const dozvoljena = (polja) => new Set(Object.keys(polja));
    for (const izmjena of Object.values(SLUCAJEVI)) {
        const t = json(ko.tijeloSynca({ ...SMJENA, ...izmjena }));
        for (const k of Object.keys(t)) assert.ok(dozvoljena(POLJA_SMJENE).has(k), `tijelo.${k} nije u ugovoru`);
        if (t.zatvaranje) for (const k of Object.keys(t.zatvaranje)) assert.ok(dozvoljena(POLJA_SMJENE.zatvaranje.polja).has(k), `zatvaranje.${k} nije u ugovoru`);
    }
});

// ---- 4. pravi tok na disku kase: smjena → nesinhronizovaneSmjene → tijelo; dodajURed → nesinhronizovani ----
const Db = napraviDriver();
let dir;
before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-ugovor-'));
    assert.equal(posKes.init(dir, Db), true);
    assert.equal(ko.init(posKes.baza()), true);
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ } });
const u = (ms) => ({ sada: () => ms });
const T0 = Date.parse('2026-10-05T06:00:00.000Z');

test('UG.11 smjena s diska: oblik LokalnaSmjena i tijelo po ugovoru (otvorena, zatvorena, primopredaja)', () => {
    const o = ko.otvoriSmjenu({ skladiste_id: 10, radnik_id: 6, pocetni_fond_fening: 5000, napomena: 'Jutro' }, u(T0));
    assert.equal(o.ok, true);
    const p = ko.primopredaja({ lokalni_uid: o.smjena.lokalni_uid, predaje_radnik_id: 6, preuzima_radnik_id: 4, prebrojano_fening: 7000 }, u(T0 + 3600e3));
    assert.equal(p.ok, true);
    const z = ko.zatvoriSmjenu({ lokalni_uid: p.nova.lokalni_uid, radnik_id: 4, prebrojano_fening: 9000, uredjaj: { z_broj: 3 } }, u(T0 + 7200e3));
    assert.equal(z.ok, true);
    ko.otvoriSmjenu({ skladiste_id: 11, radnik_id: 6, pocetni_fond_fening: 0 }, u(T0 + 7300e3));
    const obavezna = Object.keys(UGOVOR.oblici.LokalnaSmjena.polja).filter((k) => !k.endsWith('?'));
    const smjene = ko.nesinhronizovaneSmjene();
    assert.equal(smjene.length, 3);
    for (const s of smjene) {
        for (const k of obavezna) assert.ok(Object.hasOwn(s, k), `LokalnaSmjena.${k} nedostaje u redu s diska`);
        const tijelo = json(ko.tijeloSynca(s));
        assert.deepEqual(tijelo, json(poUgovoru(POLJA_SMJENE, s)));
        provjeriTipove(POLJA_SMJENE, tijelo);
    }
    assert.ok(smjene.some((s) => s.status === 'zatvorena' && ko.tijeloSynca(s).zatvaranje.uredjaj), 'zatvorena s uređajem je pokrivena');
});

test('UG.12 nesinhronizovani() vraća payload iz dodajURed neizmijenjen, uz najviše polja_iz_reda', () => {
    const { polja_klijenta: klijent, polja_iz_reda: izReda } = UGOVOR.sinhronizacija.racun;
    assert.deepEqual(UGOVOR.most.metode.dodajURed.argumenti[0].polja, klijent, 'dodajURed.polja = polja_klijenta');
    const racun = (uid) => Object.fromEntries(klijent.map((k) => [k, k === 'lokalni_uid' ? uid : k === 'stavke' ? [{ artikal_id: 1, kolicina: 2 }]
        : k === 'placanja' ? [{ vrsta: 'Gotovina', iznos_fening: 300 }] : /_id$/.test(k) ? 5 : k === 'smjena_lokalni_uid' ? 'L-9' : `v-${k}`]));
    const obican = racun('R-obican');
    const fisk = racun('R-fiskalizovan');
    posKes.dodajURed(obican);
    posKes.pripremiNaplatu({ ...fisk, payload: fisk });
    posKes.upisiRezultat('R-fiskalizovan', { stanje: 'fiskalizovan_lokalno', fiskalni_broj: '123', fiskalni_datum: '05.10.2026', fiskalni_vrijeme: '08:01',
        qr_kod: 'qr', rezultat: { raw: 'BF 123' } });
    const { racuni } = posKes.nesinhronizovani();
    const po = Object.fromEntries(racuni.map((r) => [r.lokalni_uid, r]));
    for (const [poslan, r] of [[obican, po['R-obican']], [fisk, po['R-fiskalizovan']]]) {
        assert.ok(r, `${poslan.lokalni_uid} je u redu`);
        for (const [k, v] of Object.entries(poslan)) assert.deepEqual(r[k], v, `${poslan.lokalni_uid}.${k} izmijenjen`);
        for (const k of Object.keys(r)) assert.ok(Object.hasOwn(poslan, k) || izReda.includes(k), `${poslan.lokalni_uid}.${k} nije ni iz dodajURed ni u polja_iz_reda`);
    }
    assert.deepEqual(Object.keys(po['R-obican']).sort(), Object.keys(obican).sort(), 'račun bez štampe ide bez fiskalnih polja');
    assert.equal(po['R-fiskalizovan'].fiskalni_broj, '123');
});
