// PLT-45 (R68 ULZ): adresa instance iz šifre firme — `npm test` (čist Node, bez Electrona).
// Pada na starom kodu: lib/ulaz-firme.js nije postojao, a jedna riječ je postajala <kod>.aierp.ba upisano u kod (bez pitanja ulaza).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const uf = require('../lib/ulaz-firme');
const { normalizujAdresu } = require('../lib/server-adresa');

const PORTAL = { url: 'https://portal.primjer.test', domena: 'portal.primjer.test' };

test('portal: zadano https://aierp.ba; okruženje i konfiguracija ga mijenjaju; nesigurno → zadano', () => {
    assert.deepEqual(uf.portalAdresa({ env: {} }), { url: 'https://aierp.ba', domena: 'aierp.ba' });
    assert.deepEqual(uf.portalAdresa({ env: { AIERP_PORTAL_URL: 'https://www.primjer.test/' } }), { url: 'https://www.primjer.test', domena: 'primjer.test' });
    assert.deepEqual(uf.portalAdresa({ env: {}, konfig: { portal: 'https://ulaz.primjer.test' } }).domena, 'ulaz.primjer.test');
    assert.equal(uf.portalAdresa({ env: { AIERP_PORTAL_URL: 'https://a.test' }, konfig: { portal: 'https://b.test' } }).url, 'https://a.test', 'okruženje ima prednost');
    for (const x of ['http://primjer.test', 'ftp://primjer.test', 'https://k:l@primjer.test', 'nije adresa', 'https://jednarijec']) {
        assert.equal(uf.portalAdresa({ env: { AIERP_PORTAL_URL: x } }).url, 'https://aierp.ba', x);
    }
    assert.equal(uf.portalAdresa({ env: { AIERP_PORTAL_URL: 'http://127.0.0.1:4000' } }).url, 'http://127.0.0.1:4000', 'http samo lokalno (razvoj)');
});

test('šifra vs adresa: jedna riječ je šifra firme, sve s tačkom/shemom je adresa servera', () => {
    for (const x of ['mojafirma', ' AbC ', 'firma-2']) assert.equal(uf.jeSifra(x), true, x);
    for (const x of ['firma.primjer.ba', 'https://x', 'localhost', 'host:8443', '', '  ']) assert.equal(uf.jeSifra(x), false, x);
    assert.equal(uf.normalizujSifru(' AbC '), 'abc');
    for (const x of ['ab', '-abc', 'abc-', 'a_b', 'x'.repeat(33)]) assert.equal(uf.normalizujSifru(x), null, x);
});

test('adresa iz ulaza se prihvata samo kao https://<subdomena>.<domen portala>', () => {
    const d = 'aierp.ba';
    assert.equal(uf.adresaInstance({ url: 'https://abc.aierp.ba/', subdomena: 'abc' }, d), 'https://abc.aierp.ba');
    assert.equal(uf.adresaInstance({ url: 'https://ABC.aierp.ba' }, d), 'https://abc.aierp.ba');
    for (const url of [
        'http://abc.aierp.ba/',            // nešifrovano
        'https://zlo.test/',               // proizvoljan host
        'https://abc.aierp.ba.zlo.test/',  // domen portala kao prefiks
        'https://zloaierp.ba/',            // bez tačke ispred domene
        'https://aierp.ba/',               // sam portal nije instanca
        'https://a.b.aierp.ba/',           // dva nivoa
        'https://abc.aierp.ba:8443/',      // port
        'https://abc.aierp.ba/prijava',    // putanja
        'https://abc.aierp.ba/?token=x',   // upit
        'https://k:l@abc.aierp.ba/',       // korisnik
        'javascript:alert(1)', '', null,
    ]) assert.equal(uf.adresaInstance({ url }, d), null, String(url));
    assert.equal(uf.adresaInstance({ url: 'https://abc.aierp.ba/', subdomena: 'xyz' }, d), null, 'subdomena se mora slagati');
});

test('poveziSifrom: poznata firma → adresa i naziv; ulaz dobija samo šifru, bez kolačića', async () => {
    const pozivi = [];
    const r = await uf.poveziSifrom({ unos: ' MojaFirma ', portal: PORTAL, dohvati: async (url, init) => {
        pozivi.push({ url, init });
        return { ok: true, status: 200, json: { url: 'https://mojafirma.portal.primjer.test/', subdomena: 'mojafirma', naziv: 'Moja firma d.o.o.' } };
    } });
    assert.deepEqual(r, { ok: true, url: 'https://mojafirma.portal.primjer.test', naziv: 'Moja firma d.o.o.', sifra: 'mojafirma', pauzirana: false });
    assert.equal(pozivi[0].url, 'https://portal.primjer.test/api/ulaz');
    assert.equal(pozivi[0].init.method, 'POST');
    assert.equal(pozivi[0].init.credentials, 'omit');
    assert.deepEqual(JSON.parse(pozivi[0].init.body), { sifra: 'mojafirma' });
});

test('poveziSifrom: nepoznata/zatvorena → poruka ulaza; 429; bez veze; zao odgovor; neispravna šifra bez poziva', async () => {
    const neutralna = 'Firma s tom šifrom nije pronađena ili trenutno nije dostupna.';
    const n = await uf.poveziSifrom({ unos: 'nema', portal: PORTAL, dohvati: async () => ({ ok: false, status: 404, json: { error: 'sifra_nepoznata', poruka: neutralna } }) });
    assert.deepEqual(n, { ok: false, greska: 'nepoznata', poruka: neutralna });
    const bezTijela = await uf.poveziSifrom({ unos: 'nema', portal: PORTAL, dohvati: async () => ({ ok: false, status: 404, json: null }) });
    assert.equal(bezTijela.poruka, uf.PORUKE.nepoznata, 'ista neutralna poruka i bez tijela');
    assert.equal((await uf.poveziSifrom({ unos: 'abc', portal: PORTAL, dohvati: async () => ({ ok: false, status: 429, json: {} }) })).greska, 'previse');
    assert.equal((await uf.poveziSifrom({ unos: 'abc', portal: PORTAL, dohvati: async () => { throw new Error('ENOTFOUND'); } })).greska, 'veza');
    const zao = await uf.poveziSifrom({ unos: 'abc', portal: PORTAL, dohvati: async () => ({ ok: true, status: 200, json: { url: 'https://zlo.test/', naziv: 'x' } }) });
    assert.deepEqual([zao.ok, zao.greska], [false, 'odgovor'], 'ulaz ne može poslati aplikaciju na proizvoljan host');
    let pozvan = false;
    const los = await uf.poveziSifrom({ unos: 'a', portal: PORTAL, dohvati: async () => { pozvan = true; return {}; } });
    assert.equal(los.greska, 'sifra');
    assert.equal(pozvan, false, 'neispravna šifra ne ide na ulaz');
    const pauza = await uf.poveziSifrom({ unos: 'abc', portal: PORTAL, dohvati: async () => ({ ok: true, status: 200, json: { url: 'https://abc.portal.primjer.test/', naziv: 'A', pauzirana: true } }) });
    assert.equal(pauza.pauzirana, true, 'pauzirana firma (samo čitanje) — adresa ista, oznaka ide dalje');
});

test('poveziSifrom kroz pravi HTTP (lažni ulaz na localhost) — fetch bez kolačića', async () => {
    let kolacic = null;
    const srv = http.createServer((req, res) => {
        kolacic = req.headers.cookie || null;
        let t = '';
        req.on('data', (c) => { t += c; });
        req.on('end', () => {
            const { sifra } = JSON.parse(t);
            res.setHeader('content-type', 'application/json');
            res.setHeader('set-cookie', 'zlo=1');
            if (sifra === 'abc') return res.end(JSON.stringify({ url: 'https://abc.localhost/', subdomena: 'abc', naziv: 'ABC' }));
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'sifra_nepoznata', poruka: uf.PORUKE.nepoznata }));
        });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const portal = uf.portalAdresa({ env: { AIERP_PORTAL_URL: `http://127.0.0.1:${srv.address().port}` } });
    const dohvati = async (url, init) => { const o = await fetch(url, init); return { ok: o.ok, status: o.status, json: await o.json().catch(() => null) }; };
    try {
        // domena lokalnog portala je 127.0.0.1 → https://abc.localhost nije pod njom: odbijeno (adresa se veže za domen portala)
        assert.equal((await uf.poveziSifrom({ unos: 'abc', portal, dohvati })).greska, 'odgovor');
        const ok = await uf.poveziSifrom({ unos: 'abc', portal: { ...portal, domena: 'localhost' }, dohvati });
        assert.equal(ok.url, 'https://abc.localhost');
        assert.equal(kolacic, null, 'ulaz ne dobija kolačiće');
        assert.equal((await uf.poveziSifrom({ unos: 'xyz', portal, dohvati })).greska, 'nepoznata');
    } finally { srv.close(); }
});

test('jedna riječ u adresi više ne postaje <kod>.aierp.ba upisano u kod', () => {
    const r = normalizujAdresu('firma');
    assert.ok(r.greska, 'jedna riječ ide kroz ulaz (šifra firme), ne kroz zakucanu domenu');
    const izvor = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server-adresa.js'), 'utf8');
    assert.doesNotMatch(izvor, /const DOMENA = 'aierp\.ba'/);
});

test('main.js: povezivanje šifrom ide kroz ulaz, pamti naziv, „Promijeni firmu" briše zapamćeno', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(main, /require\('\.\/lib\/ulaz-firme'\)/);
    assert.match(main, /poveziSifrom\(/);
    assert.match(main, /ipcMain\.handle\('server:zaboravi'/, 'IPC za „Promijeni firmu"');
    const blok = main.slice(main.indexOf("ipcMain.handle('server:zaboravi'"), main.indexOf("ipcMain.handle('server:zaboravi'") + 400);
    assert.match(blok, /izLokalneStranice\(e\)/, 'samo lokalni ekran smije zaboraviti firmu');
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    assert.match(preload, /zaboravi: \(\) => ipcRenderer\.invoke\('server:zaboravi'\)/);
    const html = fs.readFileSync(path.join(__dirname, '..', 'povezivanje.html'), 'utf8');
    assert.match(html, /Šifra firme/);
    assert.match(html, /id="promijeni"/);
    assert.match(html, /id="nastavi"/);
});
