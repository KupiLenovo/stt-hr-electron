// Adresa servera firme (v4.2.0) — `npm test` (cist Node, bez Electrona).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizujAdresu, STARI_SERVER, STT_SERVER } = require('../lib/server-adresa');

test('bez sheme → https, samo origin (bez putanje i kose crte)', () => {
    assert.deepEqual(normalizujAdresu('app.aierp.ba'), { url: 'https://app.aierp.ba' });
    assert.deepEqual(normalizujAdresu('  https://app.aierp.ba/  '), { url: 'https://app.aierp.ba' });
    assert.deepEqual(normalizujAdresu('https://firma.aierp.ba/pos?x=1#y'), { url: 'https://firma.aierp.ba' });
    assert.deepEqual(normalizujAdresu('HTTPS://App.AIERP.ba'), { url: 'https://app.aierp.ba' });
    assert.deepEqual(normalizujAdresu('erp.firma.com:8443'), { url: 'https://erp.firma.com:8443' });
});

test('jedna rijec je kod firme → <kod>.aierp.ba', () => {
    assert.deepEqual(normalizujAdresu('firma'), { url: 'https://firma.aierp.ba' });
    assert.deepEqual(normalizujAdresu('app'), { url: STT_SERVER });
});

test('nesifrovani http je odbijen — osim lokalnog razvoja', () => {
    assert.equal(normalizujAdresu('http://app.aierp.ba').greska, 'http');
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
