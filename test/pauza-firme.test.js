// F8 + odluka Eldina 05.11.2026 (9): pauzirana firma na desktopu — kasa javlja pauzu, ne prima NOVU prodaju, pregled radi,
// a već odštampani računi iz reda se ne gube (lib/pauza-firme.js, main.js, lib/pos-kes.js redProred).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pauza = require('../lib/pauza-firme');
const posKes = require('../lib/pos-kes');
const { napraviDriver } = require('./helpers/sqlite');

const SERVER = 'https://prva.aierp.ba';
const PORTAL = { url: 'https://aierp.ba', domena: 'aierp.ba' };

// Lažni server + ulaz: mapa url → odgovor ({ ok, status, json }) ili funkcija; zapisuje svaki poziv.
function lazni(odgovori) {
    const pozivi = [];
    const dohvati = async (url, init = {}) => {
        pozivi.push({ url, init });
        const o = odgovori[url];
        if (o === undefined || o === 'mreza') throw new Error('mreža');
        return typeof o === 'function' ? o(init) : o;
    };
    return { dohvati, pozivi };
}
const PING = { ok: true, status: 200, json: { ok: true, time: '2026-11-05T10:00:00Z', portal_url: 'https://aierp.ba' } };
const MENI = (p) => ({ ok: true, status: 200, json: { moduli: [], zakljucane: [], ...(p ? { pauza: p } : {}) } });

test('PZ1 izvori: ping samo s izričitim poljem, meni po polju pauza, ulaz samo za istu instancu', () => {
    assert.equal(pauza.izPinga(PING.json), null, 'današnji /api/ping pauzu ne javlja → nepoznato');
    assert.deepEqual(pauza.izPinga({ ok: true, pauzirana: false }), { pauzirana: false, od: null, razlog: null });
    assert.equal(pauza.izPinga({ ok: true, pauzirana: true }).pauzirana, true);
    assert.deepEqual(pauza.izMenija(MENI({ razlog: 'Neplaćen račun', od: '01.11.2026. 10:00' })),
        { pauzirana: true, od: '01.11.2026. 10:00', razlog: 'Neplaćen račun' });
    assert.equal(pauza.izMenija(MENI(null)).pauzirana, false, 'meni bez polja pauza = firma radi');
    assert.equal(pauza.izMenija({ ok: false, status: 401, json: { error: 'nije_prijavljen' } }), null, 'neprijavljen → nepoznato');
    assert.equal(pauza.izMenija({ ok: true, status: 200, json: { nesto: 1 } }), null, 'nije meni → nepoznato');
    const ulaz = (json) => ({ ok: true, status: 200, json });
    assert.equal(pauza.izUlaza(ulaz({ url: 'https://prva.aierp.ba/', pauzirana: true }), SERVER).pauzirana, true);
    assert.equal(pauza.izUlaza(ulaz({ url: 'https://prva.aierp.ba/' }), SERVER).pauzirana, false);
    assert.equal(pauza.izUlaza(ulaz({ url: 'https://druga.aierp.ba/', pauzirana: true }), SERVER), null, 'druga instanca ne govori o ovoj');
    assert.equal(pauza.izUlaza({ ok: false, status: 404, json: {} }, SERVER), null);
});

test('PZ2 provjeri: ping → meni (kolačić) → ulaz (bez kolačića); niko ne zna → nepoznato', async () => {
    let l = lazni({ [SERVER + '/api/ping']: PING, [SERVER + '/api/v1/meni']: MENI({ razlog: null, od: '01.11.2026.' }) });
    let n = await pauza.provjeri({ server: SERVER, dohvati: l.dohvati });
    assert.equal(n.pauzirana, true);
    assert.equal(n.izvor, 'meni');
    assert.equal(l.pozivi[1].init.credentials, 'include', 'meni traži prijavu (kolačić)');

    l = lazni({ [SERVER + '/api/ping']: { ok: true, status: 200, json: { ok: true, pauzirana: false } } });
    n = await pauza.provjeri({ server: SERVER, sifra: 'prva', portal: PORTAL, dohvati: l.dohvati });
    assert.deepEqual([n.pauzirana, n.izvor, l.pozivi.length], [false, 'ping', 1], 'ping s poljem odlučuje odmah');

    l = lazni({ [SERVER + '/api/ping']: PING, [SERVER + '/api/v1/meni']: { ok: false, status: 401, json: {} },
        'https://aierp.ba/api/ulaz': { ok: true, status: 200, json: { url: 'https://prva.aierp.ba/', subdomena: 'prva', naziv: 'Prva', pauzirana: true } } });
    n = await pauza.provjeri({ server: SERVER, sifra: 'prva', portal: PORTAL, dohvati: l.dohvati });
    assert.deepEqual([n.pauzirana, n.izvor], [true, 'ulaz']);
    const ulaz = l.pozivi[2];
    assert.equal(ulaz.init.method, 'POST');
    assert.equal(ulaz.init.credentials, 'omit', 'ulaz bez kolačića');
    assert.deepEqual(JSON.parse(ulaz.init.body), { sifra: 'prva' });

    l = lazni({});   // bez interneta
    n = await pauza.provjeri({ server: SERVER, sifra: 'prva', portal: PORTAL, dohvati: l.dohvati });
    assert.deepEqual(n, { pauzirana: null, izvor: null });
    assert.deepEqual(await pauza.provjeri({ server: null, dohvati: l.dohvati }), { pauzirana: null, izvor: null });
});

test('PZ3 stanje: nepoznato zadržava pauzu (kasa bez interneta), „radi" je briše; važi samo za svoju instancu', () => {
    const p = pauza.sljedece(null, { pauzirana: true, od: '01.11.2026.', razlog: 'Neplaćen račun', izvor: 'meni' }, { server: SERVER + '/', sadaMs: 0 });
    assert.deepEqual(p, { od: '01.11.2026.', razlog: 'Neplaćen račun', provjereno: '1970-01-01T00:00:00.000Z', izvor: 'meni', server: SERVER });
    assert.equal(pauza.sljedece(p, { pauzirana: null }), p, 'bez interneta pauza ostaje');
    assert.equal(pauza.sljedece(p, { pauzirana: false }), null, 'server kaže da radi → pauze nema');
    assert.equal(pauza.sljedece(p, { pauzirana: true, izvor: 'ulaz' }, { server: SERVER }).razlog, 'Neplaćen račun', 'ulaz bez razloga ne briše razlog');
    assert.equal(pauza.iz({ url: SERVER, pauza: p }, SERVER).razlog, 'Neplaćen račun');
    assert.equal(pauza.iz({ url: SERVER, pauza: p }, 'https://druga.aierp.ba'), null, 'druga firma ne nasljeđuje pauzu');
    assert.equal(pauza.iz({ url: SERVER, pauza: p }, null), null, 'bez servera nema pauze');
    assert.equal(pauza.iz({ url: SERVER }, SERVER), null);
});

test('PZ4 poruka: jasna, bosanski, bez podataka jedne firme; od i razlog kad postoje', () => {
    const p = { od: '01.11.2026.', razlog: 'Neplaćen račun.' };
    const t = pauza.poruka(p, 'prodaja');
    assert.match(t, /^Firma je privremeno pauzirana \(od 01\.11\.2026\.\) — nova prodaja na ovoj kasi nije moguća\./);
    assert.match(t, /Pregled podataka radi/);
    assert.match(t, /već odštampani računi ostaju sačuvani/);
    assert.match(t, /Razlog: Neplaćen račun\. Za ponovno uključenje/);
    assert.match(pauza.poruka({}, 'smjena'), /nova smjena se ne otvara/);
    assert.equal(pauza.poruka(null), null);
    for (const x of [t, ...Object.values(pauza.PORUKE)]) assert.doesNotMatch(x, /STT|app\.aierp\.ba/);
});

test('PZ5 blokade: nova prodaja bez servera ne; račun koji je server upisao i već fiskalizovan račun da; pregled/zatvaranje nisu blokirani', () => {
    const p = { od: null, razlog: null };
    assert.equal(pauza.blokadaNaplate(null, { lokalni_uid: 'X' }), null, 'firma radi');
    const b = pauza.blokadaNaplate(p, { lokalni_uid: 'X', racun_id: null, tip: 'fiskalni' });
    assert.equal(b.uspjeh, false);
    assert.equal(b.ishod, 'blokirano');
    assert.equal(b.greska.kod, 'firma_pauzirana');
    assert.equal(b.lokalni_uid, 'X');
    assert.match(b.poruka, /pauzirana/);
    assert.equal(pauza.blokadaNaplate(p, { lokalni_uid: 'X', racun_id: 77 }), null, 'server je račun upisao → firma radi (server je sudac)');
    assert.equal(pauza.blokadaNaplate(p, { lokalni_uid: 'X' }, { fiskalni_broj: '42' }), null, 'već fiskalizovan → most vraća „vec", ništa se ne štampa');
    assert.equal(pauza.blokadaNaplate(p, { lokalni_uid: 'X' }, { fiskalni_broj: null, stanje: 'greska' }).ishod, 'blokirano');
    assert.deepEqual(Object.keys(pauza.blokadaReda(p, false)).sort(), ['error', 'greska', 'ok', 'poruka']);
    assert.equal(pauza.blokadaReda(p, false).ok, false, 'klijent gleda qq.ok === false (nema štampe)');
    assert.equal(pauza.blokadaReda(p, true), null, 'račun koji je već u redu (ponovljen poziv) ne blokira');
    assert.equal(pauza.blokadaReda(null, false), null);
    assert.equal(pauza.blokadaSmjene(p).error, 'firma_pauzirana');
    assert.equal(pauza.blokadaSmjene(null), null);
    assert.equal(pauza.blokadaDrajvera(p).greska.kod, 'firma_pauzirana');
    assert.equal(pauza.trebaObavijest(0, 1000), true);
    assert.equal(pauza.trebaObavijest(1000, 30000), false, 'najviše jedna obavijest u minuti');
    assert.equal(pauza.trebaObavijest(1000, 61001), true);
});

test('PZ6 main.js: nova prodaja i nova smjena idu kroz pauzu; zatvaranje smjene, red za sync i pregled ne', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const red = (kanal) => main.split(/\r?\n/).find((l) => l.includes(`ipcMain.handle('${kanal}'`)) || '';
    assert.match(main, /ipcMain\.handle\('pos:queue-add', posHandler\(\(racun\) => \{\s*const b = pauzaFirme\.blokadaReda\(/);
    assert.match(red('fiskalni:naplati'), /naplatiUzPauzu\(p\)/);
    assert.match(main, /function naplatiUzPauzu\(p\) \{[\s\S]{0,200}pauzaFirme\.blokadaNaplate\(/);
    assert.match(red('fiskalni:fiskalizuj'), /bezPauzeDrajvera/);
    assert.match(red('fiskalni:reklamiraj'), /bezPauzeDrajvera/);
    assert.match(red('smjena:otvori'), /bezPauzeSmjene/);
    assert.match(red('smjena:primopredaja'), /bezPauzeSmjene/);
    for (const k of ['smjena:zatvori', 'pos:queue-pending', 'pos:queue-mark', 'pos:katalog-get', 'kasa:prijava', 'fiskalni:duplikat', 'fiskalni:dnevni', 'fiskalni:presjek']) {
        assert.doesNotMatch(red(k), /Pauz/, `${k} ne smije zavisiti od pauze (pregled i postojeći red rade)`);
    }
    assert.match(main, /statusCode === 423[\s\S]{0,120}osvjeziPauzuUskoro\(\)/, 'svaki 423 sa servera firme → provjera pauze');
    assert.match(main, /setInterval\(\(\) => \{ osvjeziPauzu\(\); \}, 5 \* 60 \* 1000\)/);
    assert.match(main, /offline\.html'\), \{ query: \{ server: server \|\| '', \.\.\.\(pauza \? \{ pauza: pauzaFirme\.poruka\(pauza, 'prodaja'\) \}/);
});

// ---- red računa: pauza ne smije izgubiti već odštampan račun ----
let tmpDir;
before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pauza-firme-'));
    assert.equal(posKes.init(tmpDir, napraviDriver()), true);
});
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function racun(uid, { stanje = 'fiskalizovan_lokalno', kanal = 'mp', broj = '42', dana = 200 } = {}) {
    posKes.pripremiNaplatu({ lokalni_uid: uid, skladiste_id: 3, kanal, tip: 'fiskalni', iznos_fening: 500, placanja: [{ vrsta: 'Gotovina', iznos_fening: 500 }], payload: { lokalni_uid: uid, stavke: [] } });
    posKes.upisiRezultat(uid, { stanje, fiskalni_broj: stanje === 'fiskalizovan_lokalno' ? broj : null });
    posKes.baza().prepare("UPDATE queue_racun SET kreiran_at = datetime('now','localtime','-' || ? || ' days') WHERE lokalni_uid=?").run(dana, uid);
}

test('PZ7 red: odštampan neposlan račun preživi pauzu (prored ga ne briše), a sync ga i dalje nudi', () => {
    racun('P-STAMPAN');                                        // odštampan prije pauze, server ga (423) još nema
    racun('P-GRESKA', { stanje: 'greska' });                   // nije odštampan, ali je prodaja koju server još nema
    racun('P-POSLAN', { broj: '43' }); posKes.oznaciPoslan('P-POSLAN', 9);
    racun('P-VP', { kanal: 'fiskalizovano', broj: '44' });     // VP/storno: server ga dobija mimo reda
    const r = posKes.redProred(90);
    assert.equal(r.obrisano, 2, 'samo poslan i završen VP red');
    assert.ok(posKes.redRacuna('P-STAMPAN'), 'odštampan račun ostaje na disku i poslije 90 dana');
    assert.ok(posKes.redRacuna('P-GRESKA'));
    assert.equal(posKes.redRacuna('P-POSLAN'), null);
    assert.equal(posKes.redRacuna('P-VP'), null);
    const zaSync = posKes.nesinhronizovani().racuni.map((x) => x.lokalni_uid);
    assert.deepEqual(zaSync.sort(), ['P-GRESKA', 'P-STAMPAN']);
    assert.equal(posKes.nesinhronizovani().racuni.find((x) => x.lokalni_uid === 'P-STAMPAN').fiskalni_broj, '42', 'ide serveru s fiskalnim brojem');
    // Pauza: novi račun ne ulazi u red, a ponovljen poziv za račun koji je već u redu prolazi (blokadaReda gleda redRacuna)
    const p = { od: null, razlog: null };
    assert.equal(pauza.blokadaReda(p, !!posKes.redRacuna('NOVI')).ok, false);
    assert.equal(pauza.blokadaReda(p, !!posKes.redRacuna('P-STAMPAN')), null);
    assert.equal(posKes.redRacuna('NOVI'), null, 'blokiran račun nije upisan');
});
