// MAL-20 / MAL-21 — kasa bez interneta (lib/kasa-offline.js): keš radnje po računaru, offline prijava PIN-om (72 h, samo radnici radnje,
// brava poslije 5 pogrešnih), samo prodaja i smjena, brisanje keša na odjavu uređaja i promjenu radnje, smjena na disku kase i primopredaja.
// Baza: better-sqlite3 (CI) ili node:sqlite adapter (lokalno) — test/helpers/sqlite.js. BEZ Electrona.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { napraviDriver } = require('./helpers/sqlite');
const posKes = require('../lib/pos-kes');
const ko = require('../lib/kasa-offline');

const Db = napraviDriver();
let dir;
const SAT = 3600 * 1000;
const T0 = Date.parse('2026-10-05T06:00:00.000Z');   // „zadnja veza" — fiksno vrijeme (test ne zavisi od sata)
const u = (ms) => ({ sada: () => ms });

// Isti zapis kao server (stt-hr-server lib/kasa-pin.js zapisZaKasu): 'kasa1$<sol>$<scrypt(PIN, sol)>' — parametri moraju biti isti.
function serverskiZapis(pin) {
    const sol = crypto.randomBytes(16);
    const h = crypto.scryptSync(String(pin), sol, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `kasa1$${sol.toString('base64url')}$${h.toString('base64url')}`;
}
const Z = { ana: serverskiZapis('1234'), bojan: serverskiZapis('5678'), vedad: serverskiZapis('2468') };
const paket = (lok = 1, radnici) => ({
    verzija: 1, rok_offline_sati: 72, dozvole_offline: ['prodaja', 'smjena'], skladiste_id: lok * 10, lokacija_id: lok,
    kase: [{ id: lok * 10, sifra: `K${lok}`, naziv: `Kasa ${lok}` }, { id: lok * 10 + 1, sifra: `K${lok}b`, naziv: `Kasa ${lok}b` }],
    radnici: radnici || [
        { id: 6, ime: 'Ana', prezime: 'A', uloga: 'radnik', offline_pin_hash: Z.ana },
        { id: 4, ime: 'Bojan', prezime: 'B', uloga: 'voditelj', offline_pin_hash: Z.bojan },
    ],
    granice_popusta: { max_rabat_bp_radnik: 500, max_rabat_bp_voditelj: 2000 },
    vrste_placanja: [{ naziv: 'Gotovina', oznaka_uredjaja: 'Gotovina', uloga_konta: 'blagajna', u_kasi: 1 }],
    granica_gotovine_firma_fening: 1000000,
});

before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-offline-'));
    assert.equal(posKes.init(dir, Db), true);
    assert.equal(ko.init(posKes.baza()), true);
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ } });

test('KO.1 paket kase u keš računara: radnici radnje bez serverskog zapisa u izvornom obliku, postavke, zadnja veza', () => {
    const r = ko.spremiPaket(paket(1), u(T0));
    assert.equal(r.radnika, 2);
    const st = ko.stanje(u(T0 + SAT));
    assert.equal(st.zadnja_veza_at, new Date(T0).toISOString());
    assert.equal(st.rok_do, new Date(T0 + 72 * SAT).toISOString());
    assert.equal(st.istekao, false);
    assert.equal(st.lokacija_id, 1);
    const redovi = posKes.baza().prepare('SELECT * FROM kes_radnik').all();
    for (const x of redovi) {
        assert.ok(!Object.keys(x).includes('pin_hash'), 'nema kolone glavnog zapisa PIN-a');
        assert.ok(![Z.ana, Z.bojan].includes(x.pin_zapis), 'serverski zapis se ne čuva takav kakav je stigao (sol računara)');
        assert.ok(!JSON.stringify(x).includes(Z.ana.split('$')[2]), 'ni hash serverskog zapisa');
    }
    assert.deepEqual(ko.radnici(10).map((x) => x.id).sort(), [4, 6]);
    assert.deepEqual(Object.keys(ko.radnici(10)[0]).sort(), ['id', 'ime', 'prezime', 'uloga'], 'ekran prijave ne dobija zapise PIN-a');
    assert.equal(ko.postavke().granice_popusta.max_rabat_bp_radnik, 500);
    // radnik bez zapisa za kasu ne ide u keš
    ko.spremiPaket(paket(1, [...paket(1).radnici, { id: 9, ime: 'Bez', uloga: 'radnik', offline_pin_hash: null }]), u(T0));
    assert.ok(!ko.radnici(10).some((x) => x.id === 9));
});

test('KO.2 offline prijava ispravnim PIN-om radnika radnje 2 h poslije zadnje veze → uspjeh; 73 h → offline_istekao; radnik druge radnje → odbijeno', () => {
    ko.spremiPaket(paket(1), u(T0));
    const ok = ko.prijava({ skladiste_id: 10, radnik_id: 6, pin: '1234' }, u(T0 + 2 * SAT));
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.radnik.id, 6);
    assert.deepEqual(ok.dozvole, ['prodaja', 'smjena']);
    assert.equal(ok.vazi_do, new Date(T0 + 72 * SAT).toISOString());
    const istekao = ko.prijava({ skladiste_id: 10, radnik_id: 6, pin: '1234' }, u(T0 + 73 * SAT));
    assert.equal(istekao.ok, false);
    assert.equal(istekao.error, 'offline_istekao');
    // radnik druge radnje: u kešu je samo radnja 1; radnik 7 (radnja 2) nije u kešu → odbijen i s tačnim PIN-om
    const drugi = ko.prijava({ skladiste_id: 10, radnik_id: 7, pin: '2468' }, u(T0 + 2 * SAT));
    assert.equal(drugi.ok, false);
    assert.equal(drugi.error, 'radnik_druge_radnje');
    assert.equal(ko.prijava({ skladiste_id: 99, radnik_id: 6, pin: '1234' }, u(T0 + 2 * SAT)).error, 'kasa_nije_u_kesu');
    assert.equal(ko.prijava({ skladiste_id: 10, radnik_id: 6, pin: '1235' }, u(T0 + 2 * SAT)).error, 'pogresan_pin');
    ko.prijava({ skladiste_id: 10, radnik_id: 6, pin: '1234' }, u(T0 + 2 * SAT));   // tačan PIN briše brojač
});

test('KO.3 5 pogrešnih PIN-ova offline → brava 15 min zapisana u pos-kes.db (preživi restart); poslije 15 min tačan PIN prolazi', () => {
    ko.spremiPaket(paket(1), u(T0));
    const t = T0 + 3 * SAT;
    for (let i = 1; i <= 4; i++) assert.equal(ko.prijava({ skladiste_id: 10, radnik_id: 4, pin: '0000' }, u(t + i)).error, 'pogresan_pin');
    const peti = ko.prijava({ skladiste_id: 10, radnik_id: 4, pin: '0000' }, u(t + 5));
    assert.equal(peti.error, 'zakljucan');
    assert.equal(peti.zakljucan_do, new Date(t + 5 + 15 * 60 * 1000).toISOString());
    // zapis je na disku: drugi konekcijom na isti fajl (kao nova instanca aplikacije poslije restarta)
    const druga = new Db(path.join(dir, 'pos-kes.db'));
    const b = druga.prepare('SELECT zakljucan_do FROM kes_brava WHERE radnik_id=4').get();
    druga.close();
    assert.equal(b.zakljucan_do, new Date(t + 5 + 15 * 60 * 1000).toISOString());
    assert.equal(ko.prijava({ skladiste_id: 10, radnik_id: 4, pin: '5678' }, u(t + 10 * 60 * 1000)).error, 'zakljucan', 'i tačan PIN čeka bravu');
    assert.equal(ko.prijava({ skladiste_id: 10, radnik_id: 6, pin: '1234' }, u(t + 60)).ok, true, 'brava je po radniku');
    assert.equal(ko.prijava({ skladiste_id: 10, radnik_id: 4, pin: '5678' }, u(t + 16 * 60 * 1000)).ok, true);
});

test('KO.4 samo prodaja i smjena offline (bez storna, povrata, bona i nivelacije); online sesija ide po pravilima servera', () => {
    const sesija = { radnik_id: 6 };
    assert.equal(ko.dozvoljeno(sesija, 'prodaja'), true);
    assert.equal(ko.dozvoljeno(sesija, 'smjena'), true);
    for (const a of ['storno', 'povrat', 'bon', 'nivelacija', 'novac_kase']) assert.equal(ko.dozvoljeno(sesija, a), false, a);
    assert.equal(ko.dozvoljeno(null, 'povrat'), true);
});

test('KO.5 PLT-13: odjava uređaja (server 403 obrisi_kes) i promjena radnje brišu keš radnika — prijava bez interneta više ne prolazi', () => {
    ko.spremiPaket(paket(1), u(T0));
    assert.equal(ko.obrisiRadnike().obrisano, 2);
    assert.equal(ko.prijava({ skladiste_id: 10, radnik_id: 6, pin: '1234' }, u(T0 + SAT)).error, 'radnik_druge_radnje');
    ko.spremiPaket(paket(1), u(T0));
    // kasa je prebačena u radnju 2: novi paket (druga radnja) briše radnike radnje 1 i njihove brave
    posKes.baza().prepare("INSERT OR REPLACE INTO kes_brava (radnik_id, pogresnih, zakljucan_do) VALUES (6, 3, NULL)").run();
    ko.spremiPaket(paket(2, [{ id: 7, ime: 'Vedad', uloga: 'radnik', offline_pin_hash: Z.vedad }]), u(T0));
    assert.deepEqual(posKes.baza().prepare('SELECT radnik_id FROM kes_radnik').all().map((x) => x.radnik_id), [7]);
    assert.equal(posKes.baza().prepare('SELECT COUNT(*) c FROM kes_brava').get().c, 0);
    assert.equal(ko.prijava({ skladiste_id: 20, radnik_id: 6, pin: '1234' }, u(T0 + SAT)).error, 'radnik_druge_radnje');
    assert.equal(ko.prijava({ skladiste_id: 20, radnik_id: 7, pin: '2468' }, u(T0 + SAT)).ok, true);
    ko.spremiPaket(paket(1), u(T0));
});

test('KO.6 tiha obnova prijave: PIN offline sesije ide na /api/auth/pin tek kad se veza vrati; odbijena prijava ne briše red', async () => {
    ko.spremiPaket(paket(1), u(T0));
    const p = ko.prijava({ skladiste_id: 10, radnik_id: 6, pin: '1234' }, u(T0 + SAT));
    let sesija = ko.napraviSesiju(p, '1234', u(T0 + SAT));
    const pozivi = [];
    const bez = await ko.obnoviPrijavu({ server: 'https://firma.aierp.ba', sesija, dohvati: async () => { throw new Error('ENOTFOUND'); } });
    assert.equal(bez.error, 'bez_veze');
    const ok = await ko.obnoviPrijavu({ server: 'https://firma.aierp.ba', sesija, dohvati: async (url, init) => { pozivi.push({ url, init }); return { ok: true, status: 200, json: { ok: true, privremeni: false, radnik: { id: 6 } } }; } });
    assert.equal(ok.ok, true);
    assert.equal(pozivi[0].url, 'https://firma.aierp.ba/api/auth/pin');
    assert.equal(pozivi[0].init.headers['X-Requested-With'], 'XMLHttpRequest');
    assert.deepEqual(JSON.parse(pozivi[0].init.body), { radnik_id: 6, pin: '1234' });
    const odbijen = await ko.obnoviPrijavu({ server: 'https://firma.aierp.ba', sesija, dohvati: async () => ({ ok: false, status: 401, json: { error: 'drugi_faktor_obavezan' } }) });
    assert.equal(odbijen.ok, false);
    assert.equal(odbijen.error, 'drugi_faktor_obavezan');
    sesija = ko.ocistiSesiju(sesija);
    assert.equal(sesija, null);
});

test('KO.7 smjena na disku kase: otvori (jedna po kasi), zatvori s prebrojanim i snimkom uređaja, tijelo za /smjena/sync, oznaka poslije synca', () => {
    const o = ko.otvoriSmjenu({ skladiste_id: 10, radnik_id: 6, pocetni_fond_fening: 5000 }, u(T0 + SAT));
    assert.equal(o.ok, true);
    assert.equal(ko.otvoriSmjenu({ skladiste_id: 10, radnik_id: 4 }, u(T0 + SAT)).error, 'smjena_vec_otvorena');
    assert.equal(ko.aktivnaSmjena(10).lokalni_uid, o.smjena.lokalni_uid);
    const uid = o.smjena.lokalni_uid;
    assert.ok(ko.nesinhronizovaneSmjene().some((s) => s.lokalni_uid === uid), 'otvorena smjena čeka sync');
    const z = ko.zatvoriSmjenu({ lokalni_uid: uid, radnik_id: 6, prebrojano_fening: 8000, napomena: 'kraj dana', uredjaj: { vrsta: 'Z', raw: { z_number: 7 } } }, u(T0 + 10 * SAT));
    assert.equal(z.smjena.status, 'zatvorena');
    const t = ko.tijeloSynca(ko.nesinhronizovaneSmjene().find((s) => s.lokalni_uid === uid));
    assert.equal(t.lokalni_uid, uid);
    assert.equal(t.skladiste_id, 10);
    assert.equal(t.otvorio_korisnik_id, 6);
    assert.equal(t.pocetni_fond_fening, 5000);
    assert.equal(t.zatvaranje.prebrojano_fening, 8000);
    assert.equal(t.zatvaranje.zatvorio_korisnik_id, 6);
    assert.deepEqual(t.zatvaranje.uredjaj, { vrsta: 'Z', raw: { z_number: 7 } });
    assert.match(t.otvoreno_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(ko.zatvoriSmjenu({ lokalni_uid: uid }, u(T0 + 11 * SAT)).vec, true, 'drugo zatvaranje ne mijenja ništa');
    ko.oznaciSmjenu(uid, { server_id: 321, sukob: false });
    assert.ok(!ko.nesinhronizovaneSmjene().some((s) => s.lokalni_uid === uid), 'zatvorena i poslana smjena je gotova');
    // smjena otvorena online, zatvorena bez interneta → lokalni zapis sa server_id; sync je zatvara na serveru (smjena_id)
    const zo = ko.zatvoriSmjenu({ server_id: 55, skladiste_id: 11, radnik_id: 4, prebrojano_fening: 100, pocetni_fond_fening: 100, otvorio_radnik_id: 4 }, u(T0 + 12 * SAT));
    assert.equal(zo.ok, true);
    assert.equal(ko.tijeloSynca(zo.smjena).smjena_id, 55);
});

test('KO.8 primopredaja bez interneta (MAL-32 isti tok): zatvori smjenu predavaoca i otvori smjenu preuzimaoca, sync redom', () => {
    const a = ko.otvoriSmjenu({ skladiste_id: 10, radnik_id: 6, pocetni_fond_fening: 3000 }, u(T0 + 20 * SAT)).smjena;
    assert.equal(ko.primopredaja({ lokalni_uid: a.lokalni_uid, predaje_radnik_id: 6, preuzima_radnik_id: 6, prebrojano_fening: 1 }, u(T0 + 21 * SAT)).error, 'preuzimalac_obavezan');
    const p = ko.primopredaja({ lokalni_uid: a.lokalni_uid, predaje_radnik_id: 6, preuzima_radnik_id: 4, prebrojano_fening: 7000 }, u(T0 + 24 * SAT));
    assert.equal(p.ok, true);
    assert.equal(p.zatvorena.status, 'zatvorena');
    assert.equal(p.zatvorena.prebrojano_fening, 7000);
    assert.equal(p.nova.status, 'otvorena');
    assert.equal(p.nova.otvorio_radnik_id, 4);
    assert.equal(p.nova.prethodna_uid, a.lokalni_uid);
    assert.equal(p.nova.pocetni_fond_fening, 7000, 'preuzimalac preuzima prebrojan novac');
    const red = ko.nesinhronizovaneSmjene().map((s) => s.lokalni_uid);
    assert.ok(red.indexOf(a.lokalni_uid) < red.indexOf(p.nova.lokalni_uid), 'predata smjena ide serveru prva');
});
