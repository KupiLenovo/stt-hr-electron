// MAL-03 — TringDrajver (fiskalni-drajver.js) protiv LAŽNOG TFS-a: snimljeni odgovori emulatora, BEZ Electrona i BEZ uređaja.
// Pokriva: OK račun, Greška (503), Upozorenje s brojem, greška po imenu (nedovoljno gotovine), prazan Z,
// „odgovor za 35 s" (timeout → veza_pukla) i prekid veze (→ veza_pukla). Timeout je skraćen preko TRING_TIMEOUT_MS.
'use strict';
const http = require('node:http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Snimljeni odgovori (oblik iz Tring uputstva v3.0.1, KasaOdgovor §4).
const ODG = {
    ok: '<KasaOdgovor><Odgovori><Odgovor><Naziv>BrojFiskalnogRacuna</Naziv><Vrijednost xsi:type="xsd:long">42</Vrijednost></Odgovor><Odgovor><Naziv>DatumFiskalnogRacuna</Naziv><Vrijednost>27.09.2023</Vrijednost></Odgovor><Odgovor><Naziv>IznosFiskalnogRacuna</Naziv><Vrijednost xsi:type="xsd:double">5.00</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>',
    greska503: '<KasaOdgovor><Odgovori><Odgovor><Naziv>Nema_Papira</Naziv><Vrijednost xsi:type="xsd:int">503</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>Greska</VrstaOdgovora></KasaOdgovor>',
    upozorenje: '<KasaOdgovor><Odgovori><Odgovor><Naziv>BrojFiskalnogRacuna</Naziv><Vrijednost>629301</Vrijednost></Odgovor><Odgovor><Naziv>Upozorenje</Naziv><Vrijednost>Papira ponestaje</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>Upozorenje</VrstaOdgovora></KasaOdgovor>',
    nedovoljnoNovca: '<KasaOdgovor><Odgovori><Odgovor><Naziv>ERROR_FISCAL_INSUFFICIENT_MONEY</Naziv><Vrijednost>1723</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>Greska</VrstaOdgovora></KasaOdgovor>',
    praznZ: '<KasaOdgovor><Odgovori></Odgovori><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>',
    osnovne: '<KasaOdgovor><Odgovori><Odgovor><Naziv>ibfm</Naziv><Vrijednost>AL901930</Vrijednost></Odgovor><Odgovor><Naziv>last_BF</Naziv><Vrijednost>41</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>',
};

const RACUN = { stavke: [{ naziv: 'Kafa', cijena_fening: 250, stopa_oznaka: 'E', kolicina_mili: 2000 }], placanja: [{ vrsta: 'Gotovina', iznos_fening: 500 }] };

let server, drajver;
let next = null;   // { body?, status?, delayMs?, drop? } — postavlja se prije svakog poziva drajvera

before(async () => {
    server = http.createServer((req, res) => {
        if (req.method === 'GET') { res.writeHead(200); res.end('TFS'); return; }   // testVeze
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
            const n = next || {}; next = null;
            if (n.drop) { req.socket.destroy(); return; }                            // prekid veze
            const posalji = () => { try { if (!res.writableEnded) { res.writeHead(n.status || 200, { 'Content-Type': 'text/xml' }); res.end(n.body != null ? n.body : ODG.ok); } } catch { /* socket zatvoren (timeout) */ } };
            if (n.delayMs) { const t = setTimeout(posalji, n.delayMs); if (t.unref) t.unref(); } else { posalji(); }
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.TRING_HOST = '127.0.0.1';
    process.env.TRING_PORT = String(server.address().port);
    process.env.TRING_TIMEOUT_MS = '300';   // „odgovor za 35 s" → timeout za 0,3 s (test ne čeka stvarnih 35 s)
    drajver = require('../fiskalni-drajver').napraviDrajver('tring');   // require TEK kad je env postavljen
});
after(() => { try { server.close(); } catch { /* ignore */ } });

test('DRAJVER.1 fiskalizuj OK → uspjeh, status fiskalizovan, broj i datum normalizovan', async () => {
    next = { body: ODG.ok };
    const r = await drajver.fiskalizuj(RACUN);
    assert.equal(r.uspjeh, true);
    assert.equal(r.status, 'fiskalizovan');
    assert.equal(r.fiskalni_broj, '42');
    assert.equal(r.fiskalni_datum, '2023-09-27');
});

test('DRAJVER.2 fiskalizuj Greška (503) → uspjeh false, status greska, poruka o papiru', async () => {
    next = { body: ODG.greska503 };
    const r = await drajver.fiskalizuj(RACUN);
    assert.equal(r.uspjeh, false);
    assert.equal(r.status, 'greska');
    assert.equal(r.greska.kod, 503);
    assert.match(r.greska.poruka, /papir/i);
});

test('DRAJVER.3 fiskalizuj Upozorenje S brojem → uspjeh (fiskalizovan), broj popunjen', async () => {
    next = { body: ODG.upozorenje };
    const r = await drajver.fiskalizuj(RACUN);
    assert.equal(r.uspjeh, true);
    assert.equal(r.status, 'fiskalizovan');
    assert.equal(r.fiskalni_broj, '629301');
});

test('DRAJVER.4 povratNovca — greška po imenu ERROR_FISCAL_INSUFFICIENT_MONEY → poruka o nedovoljno gotovine', async () => {
    next = { body: ODG.nedovoljnoNovca };
    const r = await drajver.povratNovca('Gotovina', 5000);
    assert.equal(r.uspjeh, false);
    assert.match(r.greska.poruka, /nedovoljno gotovine/i);
});

test('DRAJVER.5 dnevniIzvjestaj — prazan Z (OK bez računa) → uspjeh, bez broja', async () => {
    next = { body: ODG.praznZ };
    const r = await drajver.dnevniIzvjestaj();
    assert.equal(r.uspjeh, true);
    assert.equal(r.fiskalni_broj, undefined);
});

test('DRAJVER.6 „odgovor za 35 s" (spor) → istek čekanja: veza_pukla, status offline_queue', async () => {
    next = { delayMs: 1500, body: ODG.ok };   // >300 ms TRING_TIMEOUT_MS
    const r = await drajver.fiskalizuj(RACUN);
    assert.equal(r.veza_pukla, true);
    assert.equal(r.status, 'offline_queue');
    assert.equal(r.uspjeh, false);
});

test('DRAJVER.7 prekid veze (TFS zatvori socket) → veza_pukla, status offline_queue', async () => {
    next = { drop: true };
    const r = await drajver.fiskalizuj(RACUN);
    assert.equal(r.veza_pukla, true);
    assert.equal(r.status, 'offline_queue');
});

test('DRAJVER.8 unosNovca OK → uspjeh true', async () => {
    next = { body: ODG.ok };
    const r = await drajver.unosNovca('Gotovina', 10000);
    assert.equal(r.uspjeh, true);
});

test('DRAJVER.9 reklamiraj OK → uspjeh true (VrstaZahtjeva reklamirani obradio uređaj)', async () => {
    next = { body: ODG.ok };
    const r = await drajver.reklamiraj(RACUN, 42);
    assert.equal(r.uspjeh, true);
});

test('DRAJVER.10 osnovneInformacije → parsirani odgovori (ibfm, last_BF) za oporavak', async () => {
    next = { body: ODG.osnovne };
    const r = await drajver.osnovneInformacije();
    assert.equal(r.uspjeh, true);
    assert.equal(r.odgovori.ibfm, 'AL901930');
    assert.equal(r.odgovori.last_BF, '41');
});

test('DRAJVER.11 testVeze — GET / → ok true', async () => {
    const r = await drajver.testVeze();
    assert.equal(r.ok, true);
});
