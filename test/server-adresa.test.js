// Adresa servera firme (v4.2.0) — `npm test` (cist Node, bez Electrona).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const adresa = require('../lib/server-adresa');
const { normalizujAdresu, STARI_SERVER } = adresa;

test('bez sheme → https, samo origin (bez putanje i kose crte)', () => {
    assert.deepEqual(normalizujAdresu('erp.mojafirma.ba'), { url: 'https://erp.mojafirma.ba' });
    assert.deepEqual(normalizujAdresu('  https://erp.mojafirma.ba/  '), { url: 'https://erp.mojafirma.ba' });
    assert.deepEqual(normalizujAdresu('https://firma.aierp.ba/pos?x=1#y'), { url: 'https://firma.aierp.ba' });
    assert.deepEqual(normalizujAdresu('HTTPS://Erp.MojaFirma.ba'), { url: 'https://erp.mojafirma.ba' });
    assert.deepEqual(normalizujAdresu('erp.firma.com:8443'), { url: 'https://erp.firma.com:8443' });
});

test('jedna rijec nije adresa (R68: to je sifra firme → ulaz portala, lib/ulaz-firme.js)', () => {
    assert.equal(normalizujAdresu('firma').greska, 'neispravno');
    assert.equal(normalizujAdresu('app').greska, 'neispravno');
    assert.deepEqual(normalizujAdresu('https://firma.aierp.ba'), { url: 'https://firma.aierp.ba' }, 'puna adresa i dalje radi');
});

test('nesifrovani http je odbijen — osim lokalnog razvoja', () => {
    assert.equal(normalizujAdresu('http://erp.mojafirma.ba').greska, 'http');
    assert.equal(normalizujAdresu(STARI_SERVER).greska, 'http', 'stari IP bez TLS-a se vise ne prihvata');
    assert.deepEqual(normalizujAdresu('http://localhost:3737'), { url: 'http://localhost:3737' });
    assert.deepEqual(normalizujAdresu('http://127.0.0.1:3737/'), { url: 'http://127.0.0.1:3737' });
});

test('smece i opasni oblici su odbijeni s porukom', () => {
    for (const x of ['', '   ', null, undefined]) assert.equal(normalizujAdresu(x).greska, 'prazno');
    for (const x of ['ftp://firma.aierp.ba', 'file:///C:/x', 'https://korisnik:lozinka@firma.aierp.ba', 'https://', 'ht tp://x', 'javascript:alert(1)']) {
        const r = normalizujAdresu(x);
        assert.ok(r.greska, `${x} → ${JSON.stringify(r)}`);
        assert.ok(r.poruka, 'uvijek ljudska poruka');
    }
});

test('4.6.0 (odluka 10): nema rezervne adrese jedne firme — samo stara oznaka bez TLS-a', () => {
    assert.equal('STT_SERVER' in adresa, false, 'STT_SERVER je uklonjen: proizvod ne pretpostavlja nijednu firmu');
    for (const [ime, v] of Object.entries(adresa)) {
        if (typeof v !== 'string') continue;
        assert.ok(normalizujAdresu(v).greska, `${ime} (${v}) ne smije biti upotrebljiva adresa servera`);
    }
});
