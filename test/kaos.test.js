// KAOS TEST (4.3.0) — zamjena za provjere „na emulatoru/uređaju" iz master plana (MAL-01..04 „Ostaje"), BEZ hardvera:
//   • 20+ naplata kroz PRAVI fiskalni-drajver.js + lib/fiskalni-most.js + lib/pos-kes.js (pos-kes.db na disku), sa sjemenom za
//     nasumično gašenje aplikacije (7 tačaka pada) i kvarove TFS-a (ugašen, prekid prije/poslije štampe, spor odgovor preko praga,
//     prazan/prekinut odgovor, Greska, Upozorenje bez broja); poslije pada nova instanca nad istim pos-kes.db + pokretanje();
//   • 10 naplata bez interneta → red → server „dođe" → svaki račun tačno jednom (i kad se odgovor servera izgubi);
//   • IBFM van liste emulatora (scripts/test-emulator.js staje prije štampe), drugi uređaj / Z između → voditelj;
//   • web narudžba plaćena karticom → „Kartica" na traci simulatora.
// Uređaj je test/helpers/tring-simulator.js (brojači + traka); traka je istina po kojoj se provjerava svaki red kase.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { napraviDriver } = require('./helpers/sqlite');
const { napraviSimulator } = require('./helpers/tring-simulator');
const { pokreniAplikaciju, sinhronizuj, napraviServer, sjeme, TACKE_PADA } = require('./helpers/kasa');

const OSN = '/osnovneinformacije';
const FISK = '/stampatifiskalniracun';
const SPOR_MS = 1200;         // „odgovor poslije 35 s" — drajveru je prag skraćen na 400 ms (TRING_TIMEOUT_MS), bez stvarnog čekanja
const POSLIJE_45S = () => Date.now() + 46000;   // pokretanje „poslije" 45 s čekanja oporavka (bez stvarnog čekanja)

const Db = napraviDriver();
const folderi = [];
const simulatori = [];
const serveri = [];
function noviServer() { const s = napraviServer(); serveri.push(s); return s; }
const T = { timeout: 60000 };   // test koji visi (npr. naplata bez odgovora) pada, ne zaustavlja CI
function folder(ime) { const f = fs.mkdtempSync(path.join(os.tmpdir(), `kaos-${ime}-`)); folderi.push(f); return f; }
async function noviUredjaj(opcije) {
    const sim = napraviSimulator(opcije);
    const port = await sim.start();
    process.env.TRING_PORT = String(port);   // drajver čita port pri učitavanju — svaka nova instanca aplikacije vidi ovaj uređaj
    simulatori.push(sim);
    return sim;
}
before(() => {
    process.env.TRING_HOST = '127.0.0.1';
    process.env.TRING_TIMEOUT_MS = '400';
});
after(async () => {
    for (const s of simulatori) await s.stop();
    for (const s of serveri) await s.ugasi();
    for (const f of folderi) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* Windows drži fajl */ } }
});

function posiljka(uid, iznos, placanja, tip = 'fiskalni') {
    const stavke = [{ naziv: uid, jm: 'kom', cijena_fening: iznos, stopa_oznaka: 'E', kolicina_mili: 1000 }];
    return {
        lokalni_uid: uid, skladiste_id: 3, smjena_id: 9, tip, kanal: 'mp', stavke, placanja, iznos_fening: iznos,
        payload: { lokalni_uid: uid, skladiste_id: 3, smjena_id: 9, stavke: [{ artikal_id: 1, naziv: uid, kolicina_mili: 1000, cijena_fening: iznos }], placanja },
    };
}
const gotovina = (f) => [{ vrsta: 'Gotovina', iznos_fening: f }];
const karticaWeb = (f) => [{ vrsta: 'Kartično WEB', oznaka_uredjaja: 'Kartica', iznos_fening: f }];

// Kvarovi TFS-a (uređaj/servis) — pored 7 tačaka pada aplikacije (TACKE_PADA).
const KVAROVI_TFS = ['tfs_ugasen', 'snimak_prekid', 'prekid_prije', 'prekid_poslije', 'spor', 'prazan', 'prekinut', 'greska', 'upozorenje_bez_broja'];
const SVI_KVAROVI = [...TACKE_PADA, ...KVAROVI_TFS];

// ============================================================================================================================
// KAOS.1 — 3 sjemena × 22 naplate (66), nasumično gašenje aplikacije i TFS-a. Nikad dupli račun, nijedna prodaja izgubljena.
// ============================================================================================================================
async function kaos(seed, n, statistika) {
    const rnd = sjeme(seed);
    const sim = await noviUredjaj();
    const dir = folder(`s${seed}`);
    let app = null;
    const odgodjeni = [];   // „nepoznato" koje je kasir ostavio i nastavio prodaju (4.3.0 ne blokira druge račune)
    const prodaje = [];

    async function restart() {
        app = pokreniAplikaciju(dir, Db);
        const stampi = sim.brojStampi();
        const zahtjeviStampe = sim.broj(FISK);
        const rez = await app.most.pokretanje(POSLIJE_45S());
        assert.equal(sim.brojStampi(), stampi, 'oporavak pri startu NIKAD ne štampa');
        assert.equal(sim.broj(FISK), zahtjeviStampe, 'oporavak pri startu ne šalje ni zahtjev štampe');
        statistika.restarta++;
        statistika.brojac += rez.fiskalizovano + rez.greska;
        return rez;
    }
    // Voditelj gleda traku uređaja (ovdje: istina simulatora) — samo kad pravilo po brojaču ne može odlučiti.
    function voditelj(uid) {
        statistika.voditelj++;
        const na = sim.racuniZa(uid);
        if (na.length) app.posKes.razrijesiRed(uid, { stanje: 'fiskalizovan_lokalno', fiskalni_broj: String(na[0].broj), fiskalni_potvrda: 'voditelj' });
        else app.posKes.razrijesiRed(uid, { stanje: 'greska', fiskalni_potvrda: 'voditelj', fiskalni_greska: 'Voditelj: nema ga na traci.' });
    }
    let redniKvar = 0;
    const redoslijed = [...SVI_KVAROVI].sort(() => rnd() - 0.5);   // prvih 16 pokušaja pokrije SVAKI kvar bar jednom
    function izaberiKvar() {
        const k = redniKvar < redoslijed.length ? redoslijed[redniKvar] : (rnd() < 0.45 ? null : SVI_KVAROVI[Math.floor(rnd() * SVI_KVAROVI.length)]);
        redniKvar++;
        return k;
    }

    async function naplatiDoKraja(p, dozvoliOdgodu) {
        const uid = p.lokalni_uid;
        for (let pokusaj = 0; pokusaj < 25; pokusaj++) {
            const red = app.posKes.redRacuna(uid);
            if (red && red.stanje === 'fiskalizovan_lokalno') return;
            assert.ok(!red || red.stanje !== 'salje_uredjaju', `${uid}: poslije pokretanja nema reda „salje_uredjaju"`);
            if (red && red.stanje === 'nepoznato') { voditelj(uid); continue; }

            const kvar = izaberiKvar();
            if (kvar) statistika.kvarovi[kvar] = (statistika.kvarovi[kvar] || 0) + 1;
            let tacka = null;
            if (TACKE_PADA.includes(kvar)) tacka = kvar;
            else if (kvar === 'tfs_ugasen') await sim.ugasi();
            else if (kvar === 'snimak_prekid') sim.kvar(OSN, 'prekid_prije');
            else if (kvar === 'greska') sim.kvar(FISK, 'greska', { ime: 'PRINTER_ERR_NO_PAPER', kod: 503 });
            else if (kvar === 'spor') sim.kvar(FISK, 'spor', { ms: SPOR_MS });
            else if (kvar) sim.kvar(FISK, kvar);

            const naTraciPrije = sim.racuniZa(uid).length;
            const r = await app.naplati(p, tacka);
            sim.ocistiKvarove();
            if (!sim.ukljucen) await sim.upali();
            assert.ok(sim.racuniZa(uid).length <= 1, `${uid}: uređaj je račun odštampao DVAPUT (kvar ${kvar}, sjeme ${seed})`);

            if (r.krah) { statistika.padova++; await restart(); continue; }
            if (r.ishod === 'fiskalizovan') {
                const na = sim.racuniZa(uid);
                assert.equal(na.length, 1, `${uid}: fiskalizovan, a nema ga na traci`);
                assert.equal(r.fiskalni_broj, String(na[0].broj), `${uid}: broj u odgovoru = broj na traci`);
                return;
            }
            if (r.ishod === 'greska' || r.ishod === 'nedostupan') {
                assert.equal(sim.racuniZa(uid).length, naTraciPrije, `${uid}: „${r.ishod}" smije samo kad uređaj NIJE štampao`);
                assert.equal(naTraciPrije, 0, `${uid}: ponovni pokušaj račun koji je već na traci`);
                continue;   // ništa nije odštampano — kasir smije ponovo
            }
            if (r.ishod === 'blokirano') { statistika.blokirano++; await restart(); continue; }
            assert.equal(r.ishod, 'nepoznato', `${uid}: neočekivan ishod ${r.ishod}`);
            if (dozvoliOdgodu && rnd() < 0.4) { odgodjeni.push(p); statistika.odgodjeno++; return; }
            await restart();
        }
        assert.fail(`${uid}: nije završen ni za 25 pokušaja (sjeme ${seed})`);
    }

    await restart();
    for (let i = 0; i < n; i++) {
        const uid = `S${seed}-R${String(i).padStart(2, '0')}`;
        const iznos = [250, 500, 250, 750][Math.floor(rnd() * 4)];   // često ISTI iznos — tu je pravilo oporavka najosjetljivije
        const pl = rnd() < 0.3 ? karticaWeb(iznos) : gotovina(iznos);
        const p = posiljka(uid, iznos, pl);
        app.posKes.dodajURed(p.payload);   // offline: račun u lokalni red PRIJE naplate (pos.tsx, uRedu)
        prodaje.push(p);
        await naplatiDoKraja(p, true);
    }
    // kraj smjene: aplikacija se ponovo pokrene, voditelj razriješi ono što je kasir ostavio „nepoznato"
    await restart();
    for (const p of odgodjeni) await naplatiDoKraja(p, false);

    // ---- TVRDNJE nad istinom uređaja ----
    assert.equal(sim.traka.length, n, `na traci tačno ${n} računa (nijedan dupli, nijedan višak)`);
    for (const p of prodaje) {
        const na = sim.racuniZa(p.lokalni_uid);
        assert.equal(na.length, 1, `${p.lokalni_uid}: tačno jednom na traci`);
        const red = app.posKes.redRacuna(p.lokalni_uid);
        assert.ok(red, `${p.lokalni_uid}: prodaja nije izgubljena`);
        assert.equal(red.stanje, 'fiskalizovan_lokalno', `${p.lokalni_uid}: završno stanje`);
        assert.equal(red.fiskalni_broj, String(na[0].broj), `${p.lokalni_uid}: broj u redu kase = broj na traci (potvrda ${red.fiskalni_potvrda})`);
        assert.equal(na[0].iznos_fening, p.iznos_fening);
        const oznaka = p.placanja[0].oznaka_uredjaja || p.placanja[0].vrsta;
        assert.equal(na[0].placanja[0].oznaka, oznaka, `${p.lokalni_uid}: oznaka plaćanja na traci`);
    }
    const brojevi = prodaje.map((p) => app.posKes.redRacuna(p.lokalni_uid).fiskalni_broj);
    assert.equal(new Set(brojevi).size, n, 'nijedan fiskalni broj nije dodijeljen dvjema prodajama');

    // ---- internet se vraća: sync prema serveru, prvi odgovor se izgubi → ipak tačno jednom ----
    const srv = noviServer();
    await srv.rezervisiPort();
    const bezVeze = await sinhronizuj(app.posKes, srv.baza);
    assert.equal(bezVeze.prekid, true, 'server ne radi → ništa nije poslano');
    assert.equal(app.posKes.nesinhronizovaniBroj(), n);
    await srv.upali();
    srv.izgubiSljedeciOdgovor(1);
    await sinhronizuj(app.posKes, srv.baza);
    await sinhronizuj(app.posKes, srv.baza);
    await sinhronizuj(app.posKes, srv.baza);
    assert.equal(app.posKes.nesinhronizovaniBroj(), 0, 'red je prazan');
    assert.equal(srv.racuni.size, n, `server ima tačno ${n} računa`);
    for (const p of prodaje) {
        const s = srv.racuni.get(p.lokalni_uid);
        assert.equal(s.fiskalni_status, 'fiskalizovan', `${p.lokalni_uid}: na serveru fiskalizovan`);
        assert.equal(s.fiskalni_broj, String(sim.racuniZa(p.lokalni_uid)[0].broj));
    }
    await srv.ugasi();
    return statistika;
}

test('KAOS.1 3 sjemena × 22 naplate uz nasumično gašenje aplikacije i TFS-a → nikad dupli račun, ništa izgubljeno, tačni brojevi', T, async () => {
    const stat = { padova: 0, restarta: 0, voditelj: 0, brojac: 0, blokirano: 0, odgodjeno: 0, kvarovi: {} };
    for (const seed of [20260927, 4300, 77]) await kaos(seed, 22, stat);
    for (const k of SVI_KVAROVI) assert.ok(stat.kvarovi[k] >= 1, `kvar „${k}" se desio bar jednom`);
    assert.ok(stat.padova >= 7, 'aplikacija je pala bar 7 puta');
    assert.ok(stat.brojac >= 1, 'pravilo po brojaču je bar jednom samo razriješilo račun');
    // za pregled u izlazu testa
    console.log(`# kaos: ${JSON.stringify(stat)}`);
});

// ============================================================================================================================
// Pojedinačni slučajevi (svaki je i regresija za grešku koju je kaos našao — vidi komentare u lib/*).
// ============================================================================================================================
test('KAOS.2 nepoznato (NIJE odštampan) pa kasir nastavi račun ISTOG iznosa → oporavak NE smije dati tuđi broj (voditelj)', T, async () => {
    const sim = await noviUredjaj();
    const dir = folder('kasniji');
    let app = pokreniAplikaciju(dir, Db);
    await app.most.pokretanje(POSLIJE_45S());
    sim.kvar(FISK, 'prekid_prije');   // TFS pukne prije nego proslijedi uređaju → A NIJE odštampan
    const a = await app.naplati(posiljka('A-500', 500, gotovina(500)));
    assert.equal(a.ishod, 'nepoznato');
    const b = await app.naplati(posiljka('B-500', 500, gotovina(500)));   // 4.3.0 ne blokira drugi račun
    assert.equal(b.ishod, 'fiskalizovan');
    assert.equal(sim.traka.length, 1);

    app = pokreniAplikaciju(dir, Db);
    const rez = await app.most.pokretanje(POSLIJE_45S());
    const red = app.posKes.redRacuna('A-500');
    assert.notEqual(red.fiskalni_broj, b.fiskalni_broj, 'A ne smije dobiti broj računa B');
    assert.equal(red.stanje, 'nepoznato', 'brojači pomiješani kasnijim računom → voditelj (broj s trake)');
    assert.equal(rez.voditelj, 1);
    assert.equal(sim.traka.length, 1, 'bez nove štampe');
});

test('KAOS.3 pad usred štampe, TFS ugašen pri startu → sync NE šalje račun kao nefiskalizovan (bio bi odštampan dvaput)', T, async () => {
    const sim = await noviUredjaj();
    const dir = folder('salje');
    let app = pokreniAplikaciju(dir, Db);
    const p = posiljka('C-PAD', 750, gotovina(750));
    app.posKes.dodajURed(p.payload);
    const r = await app.naplati(p, 'poslije_stampe');   // uređaj odštampao, aplikacija umrla
    assert.ok(r.krah);
    assert.equal(sim.traka.length, 1);
    assert.equal(app.posKes.redRacuna('C-PAD').stanje, 'salje_uredjaju');
    // dok je red „salje_uredjaju" (štampa u toku / pad) — sync ga ne šalje
    assert.equal(app.posKes.nesinhronizovani().racuni.length, 0, 'račun usred štampe ne ide serveru');

    await sim.ugasi();                                   // pri pokretanju uređaj ne odgovara → oporavak ne može odlučiti
    app = pokreniAplikaciju(dir, Db);
    const rez = await app.most.pokretanje(POSLIJE_45S());
    assert.equal(rez.nedostupno, true);
    assert.equal(rez.zateceno.nepoznato, 1, 'zatečen „salje_uredjaju" → nepoznato');
    const srv = noviServer();
    await srv.rezervisiPort(); await srv.upali();
    await sinhronizuj(app.posKes, srv.baza);
    const s = srv.racuni.get('C-PAD');
    assert.equal(s.fiskalni_status, 'nepoznato', 'server zna da je račun možda odštampan — „Fiskalizuj sve" ga NE šalje uređaju');
    await srv.ugasi();
    await sim.upali();
    assert.equal(sim.traka.length, 1);
});

test('KAOS.4 pad PRIJE slanja uređaju (priprema) → pri startu „greska" (smije ponovo), sync ga šalje kao čeka fiskalizaciju', T, async () => {
    await noviUredjaj();
    const dir = folder('priprema');
    let app = pokreniAplikaciju(dir, Db);
    const r = await app.naplati(posiljka('D-PRIP', 250, gotovina(250)), 'tokom_snimka');
    assert.ok(r.krah);
    assert.equal(app.posKes.redRacuna('D-PRIP').stanje, 'priprema');
    app = pokreniAplikaciju(dir, Db);
    const rez = await app.most.pokretanje(POSLIJE_45S());
    assert.equal(rez.zateceno.greska, 1);
    const red = app.posKes.redRacuna('D-PRIP');
    assert.equal(red.stanje, 'greska');
    const zaSync = app.posKes.nesinhronizovani().racuni.find((x) => x.lokalni_uid === 'D-PRIP');
    assert.equal(zaSync.fiskalni_status, 'greska', 'server ga vodi kao „čeka fiskalizaciju" — nije odštampan');
});

test('KAOS.5 „Fiskalizuj sve" za račun već javljen serveru (greska, bez broja) + pad usred štampe → trag na disku, oporavak, bez drugog računa', T, async () => {
    const sim = await noviUredjaj();
    const dir = folder('ponovo');
    let app = pokreniAplikaciju(dir, Db);
    await app.most.pokretanje(POSLIJE_45S());
    const p = posiljka('E-FS', 500, gotovina(500));
    app.posKes.dodajURed(p.payload);
    sim.kvar(FISK, 'greska', { ime: 'PRINTER_ERR_NO_PAPER', kod: 503 });
    assert.equal((await app.naplati(p)).ishod, 'greska');
    const srv = noviServer();
    await srv.rezervisiPort(); await srv.upali();
    await sinhronizuj(app.posKes, srv.baza);
    assert.equal(srv.racuni.get('E-FS').fiskalni_status, 'greska');
    assert.equal(app.posKes.redRacuna('E-FS').poslan, 1, 'red je javljen serveru');

    // „Fiskalizuj sve" (pos.tsx): isti lokalni_uid, kanal 'fiskalizovano' — uređaj odštampa, aplikacija umre prije upisa rezultata
    const fs2 = { ...p, kanal: 'fiskalizovano', smjena_id: undefined, payload: undefined };
    const r = await app.naplati(fs2, 'poslije_stampe');
    assert.ok(r.krah);
    assert.equal(sim.traka.length, 1);
    assert.equal(app.posKes.redRacuna('E-FS').stanje, 'salje_uredjaju', 'pokušaj je ostavio trag na disku (ranije: bez traga)');

    app = pokreniAplikaciju(dir, Db);
    const rez = await app.most.pokretanje(POSLIJE_45S());
    assert.equal(rez.fiskalizovano, 1, 'oporavak po brojaču');
    const red = app.posKes.redRacuna('E-FS');
    assert.equal(red.stanje, 'fiskalizovan_lokalno');
    assert.equal(red.fiskalni_broj, String(sim.traka[0].broj));
    const opet = await app.naplati(fs2);
    assert.equal(opet.vec, true, 'ponovni „Fiskalizuj sve" ne ide uređaju');
    assert.equal(sim.traka.length, 1, 'tačno jedan račun na traci');
    await srv.ugasi();
});

test('KAOS.6 odgovor bez tijela (prazan) i prekinut u pola poslije štampe → nepoznato (ne „greska"), nema visenja ni druge štampe', T, async () => {
    const sim = await noviUredjaj();
    const dir = folder('prazan');
    let app = pokreniAplikaciju(dir, Db);
    await app.most.pokretanje(POSLIJE_45S());
    sim.kvar(FISK, 'prazan', { status: 500 });
    const a = await app.naplati(posiljka('F-PRAZ', 500, gotovina(500)));
    assert.equal(a.ishod, 'nepoznato', 'prazan odgovor NE dokazuje da uređaj nije štampao');
    const ponovo = await app.naplati(posiljka('F-PRAZ', 500, gotovina(500)));
    assert.equal(ponovo.ishod, 'blokirano', 'isti račun se ne šalje ponovo dok nije razriješen');
    assert.equal(sim.traka.length, 1);

    app = pokreniAplikaciju(dir, Db);
    await app.most.pokretanje(POSLIJE_45S());
    assert.equal(app.posKes.redRacuna('F-PRAZ').stanje, 'fiskalizovan_lokalno');

    sim.kvar(FISK, 'prekinut');
    const t0 = Date.now();
    const b = await app.naplati(posiljka('F-PREK', 250, gotovina(250)));
    assert.ok(Date.now() - t0 < 3000, 'prekinut odgovor ne visi (ranije: naplata čeka zauvijek)');
    assert.equal(b.ishod, 'nepoznato');
    assert.equal(sim.traka.length, 2);
});

test('KAOS.7 spor odgovor preko praga čekanja (35 s → skraćeno) → nepoznato; oporavak prije 45 s čeka, poslije daje broj', T, async () => {
    const sim = await noviUredjaj();
    const dir = folder('spor');
    let app = pokreniAplikaciju(dir, Db);
    await app.most.pokretanje(POSLIJE_45S());
    sim.kvar(FISK, 'spor', { ms: SPOR_MS });
    const r = await app.naplati(posiljka('G-SPOR', 750, karticaWeb(750)));
    assert.equal(r.ishod, 'nepoznato');
    app = pokreniAplikaciju(dir, Db);
    const rano = await app.most.pokretanje(Date.now());   // pokrenuta odmah — uređaj možda još štampa
    assert.equal(rano.cekaju, 1, 'prije 45 s se brojač ne čita');
    assert.equal(app.posKes.redRacuna('G-SPOR').stanje, 'nepoznato');
    const kasnije = await app.most.oporaviRedove(POSLIJE_45S());
    assert.equal(kasnije.fiskalizovano, 1);
    assert.equal(app.posKes.redRacuna('G-SPOR').fiskalni_broj, String(sim.traka[0].broj));
    assert.equal(sim.traka.length, 1);
});

test('KAOS.8 10 naplata bez interneta → red na disku → server dođe → svaki račun stigne TAČNO jednom; ponovni sync ne duplira', T, async () => {
    const sim = await noviUredjaj();
    const dir = folder('offline');
    const app = pokreniAplikaciju(dir, Db);
    await app.most.pokretanje(POSLIJE_45S());
    const srv = noviServer();
    await srv.rezervisiPort();   // server ne radi (nema interneta)
    const uidovi = [];
    for (let i = 0; i < 10; i++) {
        const uid = `OFF-${i}`;
        uidovi.push(uid);
        const p = posiljka(uid, 100 + i, i % 3 === 0 ? karticaWeb(100 + i) : gotovina(100 + i));
        app.posKes.dodajURed(p.payload);
        const r = await app.naplati(p);
        assert.equal(r.ishod, 'fiskalizovan');
        const s = await sinhronizuj(app.posKes, srv.baza, { cekanjeMs: 500 });   // kasa pokušava — bez veze
        assert.equal(s.prekid, true);
    }
    assert.equal(app.posKes.nesinhronizovaniBroj(), 10, '10 računa čeka u redu na disku');
    await srv.upali();
    srv.izgubiSljedeciOdgovor(1);                          // server upiše, ali odgovor ne stigne do kase
    const prvi = await sinhronizuj(app.posKes, srv.baza);
    assert.equal(prvi.prekid, true);
    assert.equal(app.posKes.nesinhronizovaniBroj(), 10, 'bez odgovora red ostaje');
    const drugi = await sinhronizuj(app.posKes, srv.baza);
    assert.equal(drugi.ok, 10);
    assert.equal(app.posKes.nesinhronizovaniBroj(), 0);
    const treci = await sinhronizuj(app.posKes, srv.baza);
    assert.equal(treci.poslano, 0, 'ponovni sync nema šta slati');
    assert.equal(srv.racuni.size, 10, 'server ima tačno 10 računa');
    for (const uid of uidovi) {
        const r = srv.racuni.get(uid);
        assert.equal(r.fiskalni_status, 'fiskalizovan');
        assert.equal(r.fiskalni_broj, String(sim.racuniZa(uid)[0].broj));
    }
    assert.equal(new Set([...srv.racuni.values()].map((r) => r.id)).size, 10);
    assert.equal(sim.traka.length, 10);
    await srv.ugasi();
});

test('KAOS.9 web narudžba plaćena karticom („Kartično WEB" → oznaka „Kartica") → na traci „Kartica", stanje kartice raste, gotovina ne', T, async () => {
    const sim = await noviUredjaj();
    const app = pokreniAplikaciju(folder('kartica'), Db);
    await app.most.pokretanje(POSLIJE_45S());
    const cash0 = sim.brojaci.cash;
    const card0 = sim.brojaci.card;
    const r = await app.naplati(posiljka('WEB-1', 4990, karticaWeb(4990)));
    assert.equal(r.ishod, 'fiskalizovan');
    const na = sim.racuniZa('WEB-1')[0];
    assert.deepEqual(na.placanja, [{ oznaka: 'Kartica', iznos_fening: 4990 }], 'traka: Kartica 49,90');
    assert.equal(sim.brojaci.card - card0, 4990);
    assert.equal(sim.brojaci.cash - cash0, 0);
    // opisni naziv BEZ oznake iz šifrarnika → greška prije uređaja, nikad tiho „Gotovina"
    const los = await app.naplati(posiljka('WEB-2', 1000, [{ vrsta: 'Kartično WEB', iznos_fening: 1000 }]));
    assert.equal(los.ishod, 'greska');
    assert.equal(sim.racuniZa('WEB-2').length, 0);
    // miješano plaćanje: dvije oznake na traci
    const mix = await app.naplati(posiljka('MIX-1', 1000, [{ vrsta: 'Gotovina', iznos_fening: 400 }, { vrsta: 'Kartično WEB', oznaka_uredjaja: 'Kartica', iznos_fening: 600 }]));
    assert.equal(mix.ishod, 'fiskalizovan');
    assert.deepEqual(sim.racuniZa('MIX-1')[0].placanja.map((x) => x.oznaka), ['Gotovina', 'Kartica']);
});

test('KAOS.10 drugi uređaj (drugi IBFM) ili Z izvještaj između slanja i oporavka → voditelj, bez štampe', T, async () => {
    const sim = await noviUredjaj();
    const dir = folder('ibfm');
    let app = pokreniAplikaciju(dir, Db);
    await app.most.pokretanje(POSLIJE_45S());
    sim.kvar(FISK, 'prekid_poslije');
    assert.equal((await app.naplati(posiljka('H-IBFM', 500, gotovina(500)))).ishod, 'nepoznato');
    sim.promijeniIbfm('ZZ999999');   // kasa je u međuvremenu spojena na drugi uređaj
    app = pokreniAplikaciju(dir, Db);
    let rez = await app.most.pokretanje(POSLIJE_45S());
    assert.equal(rez.voditelj, 1);
    assert.equal(app.posKes.redRacuna('H-IBFM').stanje, 'nepoznato');

    sim.promijeniIbfm('AL901930');
    app.posKes.razrijesiRed('H-IBFM', { stanje: 'fiskalizovan_lokalno', fiskalni_broj: String(sim.traka[0].broj), fiskalni_potvrda: 'voditelj' });
    sim.kvar(FISK, 'prekid_poslije');
    assert.equal((await app.naplati(posiljka('H-Z', 500, gotovina(500)))).ishod, 'nepoznato');
    await app.drajver.dnevniIzvjestaj();   // Z između (novi dan) — stanja po vrstama plaćanja od nule
    app = pokreniAplikaciju(dir, Db);
    rez = await app.most.pokretanje(POSLIJE_45S());
    assert.equal(rez.voditelj, 1, 'Z između → voditelj');
    assert.equal(sim.traka.length, 2);
});

function pokreniSkriptu(env) {
    return new Promise((ok) => {
        const p = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'test-emulator.js')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let izlaz = '';
        p.stdout.on('data', (d) => { izlaz += d; });
        p.stderr.on('data', (d) => { izlaz += d; });
        p.on('close', (kod) => ok({ kod, izlaz }));
    });
}

test('KAOS.11 uređaj VAN liste emulatora → test:emulator staje PRIJE prve komande (0 štampi); na listi → puni ciklus', T, async () => {
    const sim = await noviUredjaj({ ibfm: 'PRAVI0001' });
    const env = { TRING_HOST: '127.0.0.1', TRING_PORT: String(sim.port), TRING_TIMEOUT_MS: '2000' };
    const van = await pokreniSkriptu({ ...env, FISKALNI_EMULATOR_IBFM: 'AL901930' });
    assert.equal(van.kod, 2, van.izlaz);
    assert.match(van.izlaz, /NIJE na listi emulatora/);
    assert.equal(sim.zahtjevi.filter((z) => z.path !== OSN).length, 0, 'nijedna komanda osim čitanja IBFM-a');
    const bez = await pokreniSkriptu({ ...env, FISKALNI_EMULATOR_IBFM: '' });
    assert.equal(bez.kod, 2, 'bez liste — odmah stop');
    assert.equal(sim.brojStampi(), 0);

    const na = await pokreniSkriptu({ ...env, FISKALNI_EMULATOR_IBFM: ' al901930 ; pravi0001 ' });   // normalizacija: razmaci, mala slova
    assert.equal(na.kod, 0, na.izlaz);
    assert.equal(sim.traka.length, 2, 'fiskalni + reklamirani');
    assert.equal(sim.traka[1].tip, 'reklamirani');
    assert.equal(sim.traka[1].original_broj, String(sim.traka[0].broj), 'povrat nosi broj originala');
    assert.equal(sim.brojaci.z_number, 2, 'Z izvještaj pomjerio brojač');
});
