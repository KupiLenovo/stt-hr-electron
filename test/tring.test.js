// MAL-03 — testovi za lib/fiskalni/tring.js (bajt-po-bajt kopija serverskog kanonskog fajla).
// Čiste funkcije, bez I/O. Padne na starom desktop kodu (normPlacanje je vraćao 'Gotovina', bez PROTOKOL_VERZIJA,
// bez Upozorenje-uspjeha, bez grešaka po imenu).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/fiskalni/tring');

test('TRING.1 fening↔decimal i mili konverzije (oba smjera)', () => {
    assert.equal(T.feningUDecimal(1033), '10.33');
    assert.equal(T.decimalUFening('10.33'), 1033);
    assert.equal(T.decimalUFening('645,50'), 64550);   // zarez decimala
    assert.equal(T.miliUDecimal(1500), '1.5');
    assert.equal(T.miliUDecimal(1), '0.001');
    assert.equal(T.decimalUMili('2.5'), 2500);
});

test('TRING.2 normDatum — svi formati firmvera → YYYY-MM-DD, nepoznato sirovo', () => {
    assert.equal(T.normDatum('15. 6. 2026.'), '2026-06-15');
    assert.equal(T.normDatum('12.09.2021.'), '2021-09-12');
    assert.equal(T.normDatum('27.09.2023'), '2023-09-27');
    assert.equal(T.normDatum('9.1.11'), '2011-01-09');
    assert.equal(T.normDatum('nevažeće'), 'nevažeće');
    assert.equal(T.normDatum(''), '');
});

test('TRING.3 mapStopa (E/K)', () => {
    assert.equal(T.mapStopa(1700), 'E');
    assert.equal(T.mapStopa(0), 'K');
});

test('TRING.4 normPlacanje prima tačne oznake (case-insensitive) → kanonski izlaz', () => {
    assert.equal(T.normPlacanje('gotovina'), 'Gotovina');
    assert.equal(T.normPlacanje('KARTICA'), 'Kartica');
    assert.equal(T.normPlacanje('Virman'), 'Virman');
    assert.equal(T.normPlacanje('cek'), 'Cek');
});

test('TRING.5 normPlacanje BACA za opisne/nepoznate (na starom kodu bi vratio „Gotovina")', () => {
    for (const v of ['Kartično WEB', 'Gotovina pouzeće', 'Bitcoin', 'nešto', '', null, undefined]) {
        assert.throws(() => T.normPlacanje(v), /nepoznata_vrsta_placanja/, `normPlacanje(${JSON.stringify(v)}) mora baciti`);
    }
});

test('TRING.6 PROTOKOL_VERZIJA = 4.3.0 (semver)', () => {
    assert.equal(T.PROTOKOL_VERZIJA, '4.3.0');
    assert.match(T.PROTOKOL_VERZIJA, /^\d+\.\d+\.\d+$/);
});

test('TRING.7 buildRacunXml fiskalni: cijena/količina/stopa/plaćanje', () => {
    const xml = T.buildRacunXml({ broj_zahtjeva: 1, tip: 'fiskalni', stavke: [{ naziv: 'Kafa', jm: 'kom', cijena_fening: 250, stopa_oznaka: 'E', kolicina_mili: 2000 }], placanja: [{ vrsta: 'Gotovina', iznos_fening: 500 }] });
    assert.match(xml, /<VrstaZahtjeva>0<\/VrstaZahtjeva>/);
    assert.match(xml, /<Cijena>2\.50<\/Cijena>/);
    assert.match(xml, /<Kolicina>2<\/Kolicina>/);
    assert.match(xml, /<Stopa>E<\/Stopa>/);
    assert.match(xml, /<Oznaka>Gotovina<\/Oznaka>/);
});

test('TRING.8 buildRacunXml reklamirani → VrstaZahtjeva 2 + BrojRacuna original', () => {
    const xml = T.buildRacunXml({ broj_zahtjeva: 2, tip: 'reklamirani', original_broj: 35, stavke: [{ naziv: 'X', cijena_fening: 100, stopa_oznaka: 'E', kolicina_mili: 1000 }], placanja: [{ vrsta: 'Gotovina', iznos_fening: 100 }] });
    assert.match(xml, /<VrstaZahtjeva>2<\/VrstaZahtjeva>/);
    assert.match(xml, /<BrojRacuna>35<\/BrojRacuna>/);
});

test('TRING.9 buildRacunXml šalje oznaka_uredjaja (šifrarnik) kad postoji, fallback vrsta', () => {
    const xml = T.buildRacunXml({ broj_zahtjeva: 1, tip: 'fiskalni', stavke: [{ naziv: 'X', cijena_fening: 100, stopa_oznaka: 'E', kolicina_mili: 1000 }], placanja: [{ vrsta: 'Kartično WEB', oznaka_uredjaja: 'Kartica', iznos_fening: 100 }] });
    assert.match(xml, /<Oznaka>Kartica<\/Oznaka>/, 'oznaka_uredjaja iz šifrarnika ide uređaju');
    // bez oznaka_uredjaja: fallback na vrstu koja je tačna Tring oznaka
    const xml2 = T.buildRacunXml({ broj_zahtjeva: 1, tip: 'fiskalni', stavke: [{ naziv: 'X', cijena_fening: 100, stopa_oznaka: 'E', kolicina_mili: 1000 }], placanja: [{ vrsta: 'Gotovina', iznos_fening: 100 }] });
    assert.match(xml2, /<Oznaka>Gotovina<\/Oznaka>/);
});

test('TRING.10 buildNovacXml (unos/povrat) + buildZahtjev + buildInicijalizacijaXml + buildPrazno', () => {
    assert.match(T.buildNovacXml('Gotovina', 5000), /<Oznaka>Gotovina<\/Oznaka><Iznos>50\.00<\/Iznos>/);
    assert.match(T.buildZahtjev(7, 4), /<BrojZahtjeva>7<\/BrojZahtjeva><VrstaZahtjeva>4<\/VrstaZahtjeva>/);
    assert.match(T.buildInicijalizacijaXml(0, 0), /<BrojOperatora>0<\/BrojOperatora>/);
    assert.equal(T.buildPrazno(), '<?xml version="1.0" encoding="utf-8"?>');
});

test('TRING.11 parseKasaOdgovor OK → uspjeh + broj + datum normalizovan', () => {
    const rez = T.parseKasaOdgovor('<KasaOdgovor><Odgovori><Odgovor><Naziv>BrojFiskalnogRacuna</Naziv><Vrijednost xsi:type="xsd:long">35</Vrijednost></Odgovor><Odgovor><Naziv>DatumFiskalnogRacuna</Naziv><Vrijednost>9.1.11</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>');
    assert.equal(rez.uspjeh, true);
    assert.equal(rez.fiskalni_broj, '35');
    assert.equal(rez.fiskalni_datum, '2011-01-09');
    assert.equal(T.statusIzRezultata(rez, false), 'fiskalizovan');
});

test('TRING.12 parseKasaOdgovor — EN fallback polja (FiscalDate/ReceiptTotal/FiscalReceiptNumber)', () => {
    const rez = T.parseKasaOdgovor('<KasaOdgovor><Odgovori><Odgovor><Naziv>FiscalReceiptNumber</Naziv><Vrijednost>2</Vrijednost></Odgovor><Odgovor><Naziv>FiscalDate</Naziv><Vrijednost>27.09.2023</Vrijednost></Odgovor><Odgovor><Naziv>ReceiptTotal</Naziv><Vrijednost>10.33</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>');
    assert.equal(rez.fiskalni_broj, '2');
    assert.equal(rez.fiskalni_datum, '2023-09-27');
    assert.equal(rez.iznos_fening, 1033);
});

test('TRING.13 parseKasaOdgovor Greška (503) → greska + user poruka', () => {
    const rez = T.parseKasaOdgovor('<KasaOdgovor><Odgovori><Odgovor><Naziv>Nema_Papira</Naziv><Vrijednost>503</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>Greska</VrstaOdgovora></KasaOdgovor>');
    assert.equal(rez.uspjeh, false);
    assert.equal(rez.greska.kod, 503);
    assert.match(rez.greska.poruka, /papir/i);
    assert.equal(T.statusIzRezultata(rez, false), 'greska');
});

test('TRING.14 parseKasaOdgovor Upozorenje S brojem = USPJEH uz upozorenje (status fiskalizovan)', () => {
    const rez = T.parseKasaOdgovor('<KasaOdgovor><Odgovori><Odgovor><Naziv>BrojFiskalnogRacuna</Naziv><Vrijednost>629301</Vrijednost></Odgovor><Odgovor><Naziv>Upozorenje</Naziv><Vrijednost>Papira ponestaje</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>Upozorenje</VrstaOdgovora></KasaOdgovor>');
    assert.equal(rez.uspjeh, true);
    assert.equal(rez.fiskalni_broj, '629301');
    assert.ok(rez.upozorenje && /papira/i.test(rez.upozorenje), 'upozorenje popunjeno');
    assert.equal(T.statusIzRezultata(rez, false), 'fiskalizovan');
});

test('TRING.15 parseKasaOdgovor Upozorenje BEZ broja = nije uspjeh (ne zna se je li odštampan)', () => {
    const rez = T.parseKasaOdgovor('<KasaOdgovor><Odgovori><Odgovor><Naziv>Upozorenje</Naziv><Vrijednost>Uređaj zauzet</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>Upozorenje</VrstaOdgovora></KasaOdgovor>');
    assert.equal(rez.uspjeh, false);
});

test('TRING.16 parseKasaOdgovor greška PO IMENU (v3.0.1) → poruka po imenu', () => {
    const rez = T.parseKasaOdgovor('<KasaOdgovor><Odgovori><Odgovor><Naziv>ERROR_FISCAL_INSUFFICIENT_MONEY</Naziv><Vrijednost>1723</Vrijednost></Odgovor></Odgovori><VrstaOdgovora>Greska</VrstaOdgovora></KasaOdgovor>');
    assert.equal(rez.uspjeh, false);
    assert.equal(rez.greska.ime, 'ERROR_FISCAL_INSUFFICIENT_MONEY');
    assert.match(rez.greska.poruka, /nedovoljno gotovine/i);
});

test('TRING.17 parseKasaOdgovor greška BEZ koda → poruka iz <Naziv> (ne „Nepoznata")', () => {
    const rez = T.parseKasaOdgovor('<KasaOdgovor><Odgovori><Odgovor><Naziv>Nema komande ili je neispravna. Provjeriti naziv XML fajla.</Naziv></Odgovor></Odgovori><VrstaOdgovora>Greska</VrstaOdgovora></KasaOdgovor>');
    assert.equal(rez.uspjeh, false);
    assert.equal(rez.greska.kod, null);
    assert.match(rez.greska.poruka, /Nema komande/);
});

test('TRING.18 statusIzRezultata: veza pukla → offline_queue', () => {
    assert.equal(T.statusIzRezultata(null, true), 'offline_queue');
    assert.equal(T.statusIzRezultata({ uspjeh: true }, false), 'fiskalizovan');
    assert.equal(T.statusIzRezultata({ uspjeh: false }, false), 'greska');
});

test('TRING.19 porukaZaKod: grupa 1700 dobija fiskalnu poruku; nepoznat kod generičku', () => {
    assert.match(T.porukaZaKod(1750), /Fiskalna greška/i);
    assert.match(T.porukaZaKod(9999), /kod 9999/);
    assert.equal(T.trebaReLogin(401), true);
    assert.equal(T.trebaReLogin(0, 'ERROR_FISCAL_OPERATOR_NOT_LOGGED'), true);
});

test('TRING.20 modul izlaže očekivani interface', () => {
    for (const k of ['PROTOKOL_VERZIJA', 'normPlacanje', 'buildRacunXml', 'buildNovacXml', 'parseKasaOdgovor', 'statusIzRezultata', 'PLACANJA', 'ERROR_IMENA']) {
        assert.ok(k in T, `nedostaje export: ${k}`);
    }
    assert.deepEqual(T.PLACANJA, ['Gotovina', 'Kartica', 'Virman', 'Cek']);
});
