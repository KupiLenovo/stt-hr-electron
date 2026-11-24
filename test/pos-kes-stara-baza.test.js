// 4.8.0-beta.2 — prelaz better-sqlite3 → node:sqlite: offline red računa sa STARIJE verzije mora ostati čitljiv i poslije ažuriranja.
// Fajlovi u test/podaci/ je napravio STARI kod iz gita (tagovi v4.2.0 i v4.8.0-beta.1) STARIM drajverom (better-sqlite3 11.10.0) —
// test/podaci/napravi-stare-baze.js. Ovdje ih otvara NOVI kod tačno kao aplikacija (posKes.init(userData) bez ubrizganog drajvera).
//   - pos-kes-4.2.0.db: šema MAL-03 (bez MAL-04 kolona), uredno zatvorena aplikacija;
//   - pos-kes-4.8.0-beta.1.db + .db-wal: aplikacija pala usred rada — dio reda postoji SAMO u -wal fajlu.
// Fixture se ne mijenja: ako ovaj test padne, nova verzija bi na kasi izgubila ili pokvarila neposlane račune.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BazaSqlite } = require('../lib/sqlite');

const PODACI = path.join(__dirname, 'podaci');
const MODULI = ['../lib/pos-kes', '../lib/kasa-offline'].map((m) => require.resolve(m));

// Nova instanca aplikacije (pos-kes i kasa-offline drže bazu u modulu) nad userData folderom
function pokreni(userData) {
    for (const m of MODULI) delete require.cache[m];
    const posKes = require(MODULI[0]);
    const kasaOffline = require(MODULI[1]);
    assert.equal(posKes.init(userData), true, 'pos-kes se otvara zadanim (aplikacijskim) drajverom');
    kasaOffline.init(posKes.baza());
    return { posKes, kasaOffline };
}
function folderSa(fajlovi) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stara-baza-'));
    for (const [izvor, cilj] of fajlovi) fs.copyFileSync(path.join(PODACI, izvor), path.join(dir, cilj));
    return dir;
}
const ukloni = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } };
const uidovi = (posKes) => posKes.nesinhronizovani().racuni.map((r) => r.lokalni_uid).sort();

test('STB.1 baza iz 4.2.0 (better-sqlite3, šema MAL-03): offline red i katalog na mjestu, kolone MAL-04 dodane, upis radi', () => {
    const dir = folderSa([['pos-kes-4.2.0.db', 'pos-kes.db']]);
    try {
        let { posKes } = pokreni(dir);
        const db = posKes.baza();
        assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
        assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
        assert.equal(posKes.nesinhronizovaniBroj(), 2);
        assert.deepEqual(uidovi(posKes), ['stari-420-1', 'stari-420-2']);
        const r2 = posKes.nesinhronizovani().racuni.find((r) => r.lokalni_uid === 'stari-420-2');
        assert.deepEqual(r2, { lokalni_uid: 'stari-420-2', skladiste_id: 7, smjena_id: 31, ukupno_fening: 500, stavke: [{ artikal_id: 1, kolicina: 2 }] },
            'payload starog reda ide serveru netaknut (bez fiskalnih polja — stari red nema stanje)');
        const poslan = posKes.redRacuna('stari-420-poslan');
        assert.equal(poslan.poslan, 1);
        assert.equal(poslan.server_id, 900);
        assert.equal(poslan.stanje, null);
        const kolone = db.prepare("SELECT name FROM pragma_table_info('queue_racun')").all().map((x) => x.name);
        for (const k of ['stanje', 'kanal', 'fiskalni_broj', 'pokusaj_ms', 'rezultat']) assert.ok(kolone.includes(k), `kolona ${k} dodana`);
        const kat = posKes.citajKatalog(7);
        assert.equal(kat.artikli.length, 1);
        assert.deepEqual(kat.artikli[0], { id: 1, sifra: 'A1', naziv: 'Kafa', jm: 'kom', stopa: 17, cijena_fening: 250, barkodovi: ['3870001'] });
        assert.ok(kat.synced_at);
        // novi kod piše u isti fajl: nova naplata i slanje starog reda
        posKes.pripremiNaplatu({ lokalni_uid: 'novi-1', skladiste_id: 7, smjena_id: 32, iznos_fening: 100, placanja: [], payload: { lokalni_uid: 'novi-1' } });
        posKes.oznaciPoslan('stari-420-1', 1001);
        db.close();
        // ponovo pokrenuta aplikacija vidi isto
        ({ posKes } = pokreni(dir));
        assert.equal(posKes.redRacuna('stari-420-1').server_id, 1001);
        assert.equal(posKes.redRacuna('novi-1').stanje, 'priprema');
        assert.deepEqual(uidovi(posKes), ['stari-420-2'], 'novi-1 je u pripremi (ne ide serveru), stari-420-1 je poslan');
        posKes.baza().close();
    } finally { ukloni(dir); }
});

test('STB.2 baza iz 4.8.0-beta.1 poslije pada (red djelimično samo u -wal): novi kod vidi SVE, oporavak i smjena rade', () => {
    // Dokaz da fixture stvarno nosi dio reda u -wal: bez njega računa iz zadnjih upisa nema.
    const bezWal = folderSa([['pos-kes-4.8.0-beta.1.db', 'pos-kes.db']]);
    try {
        const b = new BazaSqlite(path.join(bezWal, 'pos-kes.db'));
        const ima = b.prepare("SELECT lokalni_uid FROM queue_racun WHERE lokalni_uid IN ('beta1-samo-wal','beta1-usred-stampe')").all();
        b.close();
        assert.deepEqual(ima, [], 'ti računi su samo u -wal fajlu');
    } finally { ukloni(bezWal); }

    const dir = folderSa([['pos-kes-4.8.0-beta.1.db', 'pos-kes.db'], ['pos-kes-4.8.0-beta.1.db-wal', 'pos-kes.db-wal']]);
    try {
        let { posKes, kasaOffline } = pokreni(dir);
        assert.equal(posKes.baza().pragma('integrity_check', { simple: true }), 'ok');
        // redoslijed iz main.js createWindow: zatečeno pri startu (pad usred štampe → nepoznato), pa prored
        assert.deepEqual(posKes.zatecenoPriStartu(), { greska: 0, nepoznato: 1 });
        posKes.zurnalProred(90);
        posKes.redProred(90);
        assert.deepEqual(uidovi(posKes), ['beta1-fiskalizovan', 'beta1-offline', 'beta1-samo-wal', 'beta1-usred-stampe']);
        const izReda = Object.fromEntries(posKes.nesinhronizovani().racuni.map((r) => [r.lokalni_uid, r]));
        assert.deepEqual(izReda['beta1-samo-wal'], { lokalni_uid: 'beta1-samo-wal', skladiste_id: 7, smjena_id: 31, ukupno_fening: 750, stavke: [{ artikal_id: 1, kolicina: 3 }] });
        const f = izReda['beta1-fiskalizovan'];
        assert.equal(f.fiskalni_status, 'fiskalizovan');
        assert.equal(f.fiskalni_broj, '42');
        assert.equal(f.raw_odgovor, '<odgovor broj="42"/>');
        assert.deepEqual(f.uredjaj_prije, { last_BF: 41 });
        assert.deepEqual(f.stavke, [{ artikal_id: 1, kolicina: 2 }]);
        assert.equal(izReda['beta1-usred-stampe'].fiskalni_status, 'nepoznato', 'odštampan možda — nikad ne ide kao nefiskalizovan');
        // oporavak po brojaču: red pada usred štampe, s vremenom pokušaja (Number, tačno) i snimkom brojača prije
        const op = posKes.redoviZaOporavak();
        assert.equal(op.length, 1);
        assert.equal(op[0].lokalni_uid, 'beta1-usred-stampe');
        assert.equal(op[0].pokusaj_ms, 1795000300000);
        assert.equal(op[0].pokusaja, 1);
        assert.deepEqual(JSON.parse(op[0].uredjaj_prije), { last_BF: 42 });
        assert.equal(posKes.kasnijiPokusaj('beta1-fiskalizovan', 1795000000000), true);
        // kasa bez interneta: smjena sa diska kase
        const sm = kasaOffline.aktivnaSmjena(7);
        assert.equal(sm.lokalni_uid, 'smjena-beta1');
        assert.equal(sm.pocetni_fond_fening, 10000);
        assert.equal(sm.otvorio_radnik_id, 4);
        // poslan red je i dalje poslan (dedup)
        assert.equal(posKes.redRacuna('beta1-poslan').server_id, 901);
        posKes.baza().close();
        assert.ok(!fs.existsSync(path.join(dir, 'pos-kes.db-wal')) || fs.statSync(path.join(dir, 'pos-kes.db-wal')).size === 0,
            'uredno zatvaranje prenese WAL u glavni fajl');
        // ponovo pokrenuta aplikacija (sada bez -wal) — sve i dalje na mjestu
        ({ posKes } = pokreni(dir));
        assert.deepEqual(uidovi(posKes), ['beta1-fiskalizovan', 'beta1-offline', 'beta1-samo-wal', 'beta1-usred-stampe']);
        assert.equal(posKes.redRacuna('beta1-usred-stampe').stanje, 'nepoznato');
        posKes.baza().close();
    } finally { ukloni(dir); }
});
