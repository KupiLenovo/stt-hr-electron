// R62 — ugovor mosta fiskalnog uređaja (desktop strana): postavke() / sacuvajPostavke() / testVeze().uredjaj / verzija.
// Adresa Tring Fiscal Servera se pamti NA OVOM RAČUNARU (userData/fiskalni-uredjaj.json), provjera host/port je u GLAVNOM
// procesu (lib/fiskalni-postavke.js) — nikad javna adresa. Renderer dobija samo rezultat, ne pristup fajlovima.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pokreniPreload } = require('./helpers/preload');

const ROOT = path.join(__dirname, '..');
const fp = require('../lib/fiskalni-postavke');
const folderi = [];
function folder() { const f = fs.mkdtempSync(path.join(os.tmpdir(), 'fpost-')); folderi.push(f); return f; }
after(() => { for (const f of folderi) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* ignore */ } } });

test('FPOST.1 dozvoljene adrese: loopback, privatna LAN mreža, ime računara u mreži', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '10.0.0.5', '172.16.0.1', '172.31.255.254',
        '192.168.1.20', 'KASA-1', 'kasa-pc', 'kasa1.local', 'server.lan', 'fd12:3456::1']) {
        assert.equal(fp.provjeriHost(h).ok, true, `trebalo bi dozvoliti: ${h}`);
    }
});

test('FPOST.2 javna ili sumnjiva adresa → host_neispravan (nikad javna adresa)', () => {
    for (const h of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '192.169.0.1', '0.0.0.0', '169.254.1.1', '255.255.255.255',
        'example.com', 'tfs.aierp.ba', 'evil.com.', '134744072', '0x7f000001', '0x7f.1', '10.1', '2001:4860:4860::8888',
        '', '   ', 'a b', 'http://127.0.0.1', '127.0.0.1:8085', '-kasa', 'x'.repeat(64), null, 42]) {
        const r = fp.provjeriHost(h);
        assert.equal(r.ok, false, `ne smije dozvoliti: ${JSON.stringify(h)}`);
        assert.equal(r.greska, 'host_neispravan');
    }
});

test('FPOST.3 sacuvajPostavke: port 1–65535, proizvođač samo tring (eset → uskoro)', () => {
    const dir = folder();
    for (const port of [0, 65536, -1, 1.5, 'abc', '', null]) {
        const r = fp.sacuvaj(dir, { proizvodjac: 'tring', host: '127.0.0.1', port });
        assert.deepEqual([r.ok, r.greska], [false, 'port_neispravan'], `port ${JSON.stringify(port)}`);
        assert.equal(typeof r.poruka, 'string');
    }
    const e = fp.sacuvaj(dir, { proizvodjac: 'eset', host: '127.0.0.1', port: 8085 });
    assert.deepEqual([e.ok, e.greska], [false, 'proizvodjac_nepodrzan']);
    assert.match(e.poruka, /uskoro/i);
    const j = fp.sacuvaj(dir, { proizvodjac: 'tring', host: '8.8.8.8', port: 8085 });
    assert.deepEqual([j.ok, j.greska], [false, 'host_neispravan']);
    assert.equal(fs.existsSync(path.join(dir, fp.IME_FAJLA)), false, 'neispravne postavke se ne upisuju');
});

test('FPOST.4 postavke(): zadano 127.0.0.1:8085 → sačuvano (po računaru, JSON u userData) → env ima prednost (razvoj)', () => {
    const dir = folder();
    assert.deepEqual(fp.ucitaj({ dir, env: {} }), { proizvodjac: 'tring', host: '127.0.0.1', port: 8085, izvor: 'zadano' });
    const r = fp.sacuvaj(dir, { proizvodjac: 'tring', host: ' 192.168.1.50 ', port: '9000' }, { env: {} });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.postavke, { proizvodjac: 'tring', host: '192.168.1.50', port: 9000, izvor: 'sacuvano' });
    const zapis = JSON.parse(fs.readFileSync(path.join(dir, fp.IME_FAJLA), 'utf8'));
    assert.equal(zapis.host, '192.168.1.50');
    assert.equal(zapis.port, 9000);
    assert.deepEqual(fp.ucitaj({ dir, env: {} }), { proizvodjac: 'tring', host: '192.168.1.50', port: 9000, izvor: 'sacuvano' });
    assert.deepEqual(fp.ucitaj({ dir, env: { TRING_HOST: '127.0.0.1', TRING_PORT: '18085' } }),
        { proizvodjac: 'tring', host: '127.0.0.1', port: 18085, izvor: 'env' });
});

test('FPOST.5 ručno izmijenjen fajl s javnom adresom ili pokvaren JSON → ne koristi se (zadano)', () => {
    const dir = folder();
    fs.writeFileSync(path.join(dir, fp.IME_FAJLA), JSON.stringify({ proizvodjac: 'tring', host: '8.8.8.8', port: 8085 }));
    assert.equal(fp.ucitaj({ dir, env: {} }).izvor, 'zadano');
    fs.writeFileSync(path.join(dir, fp.IME_FAJLA), '{ pokvaren');
    assert.equal(fp.ucitaj({ dir, env: {} }).izvor, 'zadano');
});

// ---------- drajver koristi sačuvanu adresu; testVeze vraća podatke uređaja ----------
let server, port, osnovneOdg = null;
before(async () => {
    server = http.createServer((req, res) => {
        if (req.method === 'GET') { res.writeHead(200); res.end('TFS'); return; }
        let d = ''; req.on('data', (c) => { d += c; });
        req.on('end', () => {
            if (osnovneOdg === 'drop') { req.socket.destroy(); return; }
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(osnovneOdg || '<KasaOdgovor><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
});
after(() => { try { server.close(); } catch { /* ignore */ } });

function drajverSaAdresom(host, p) {
    const { napraviDrajver } = require('../fiskalni-drajver');
    return napraviDrajver('tring', { adresa: () => ({ host, port: p }) });
}
const xml = (parovi) => `<KasaOdgovor><Odgovori>${Object.entries(parovi).map(([n, v]) => `<Odgovor><Naziv>${n}</Naziv><Vrijednost>${v}</Vrijednost></Odgovor>`).join('')}</Odgovori><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>`;

test('FPOST.6 drajver šalje na adresu iz postavki (ne samo env/zadano 8085)', async () => {
    osnovneOdg = null;
    const r = await drajverSaAdresom('127.0.0.1', port).testVeze();
    assert.equal(r.ok, true, JSON.stringify(r));
    const mrtav = await drajverSaAdresom('127.0.0.1', 1).testVeze();
    assert.equal(mrtav.ok, false);
});

test('FPOST.7 drajver odbija javnu adresu i kad je dođe mimo postavki (odbrana u glavnom procesu)', async () => {
    const r = await drajverSaAdresom('8.8.8.8', 8085).testVeze();
    assert.equal(r.ok, false);
    assert.match(r.poruka, /lokaln/i);
});

test('FPOST.8 testVeze vraća uredjaj { serijski_broj, ibfm, sat_uredjaja, model } iz OsnovneInformacije', async () => {
    osnovneOdg = xml({ ibfm: 'AL901930', SerijskiBroj: 'TR123456', Datum: '01.11.2026', Vrijeme: '10:15:00', Model: 'Tring FP-01', last_BF: 41 });
    const r = await drajverSaAdresom('127.0.0.1', port).testVeze();
    assert.equal(r.ok, true);
    assert.deepEqual(r.uredjaj, { serijski_broj: 'TR123456', ibfm: 'AL901930', sat_uredjaja: '01.11.2026 10:15:00', model: 'Tring FP-01' });
});

test('FPOST.9 testVeze: nepoznata polja se izostave; uređaj bez OsnovneInformacije → ok bez uredjaj', async () => {
    osnovneOdg = xml({ ibfm: 'AL901930', last_BF: 41 });
    const r = await drajverSaAdresom('127.0.0.1', port).testVeze();
    assert.deepEqual(r.uredjaj, { ibfm: 'AL901930' });
    osnovneOdg = 'drop';
    const bez = await drajverSaAdresom('127.0.0.1', port).testVeze();
    assert.equal(bez.ok, true, 'TFS je odgovorio na GET — veza postoji');
    assert.equal(bez.uredjaj, undefined);
});

// ---------- most u preloadu + main ----------
test('FPOST.10 preload: fiskalniDrajver.postavke / sacuvajPostavke / verzija (verzija aplikacije), samo IPC — bez fajlova', async () => {
    const { mostovi, pozivi } = pokreniPreload();
    const fd = mostovi.fiskalniDrajver;
    assert.equal(typeof fd.postavke, 'function');
    assert.equal(typeof fd.sacuvajPostavke, 'function');
    assert.equal(fd.verzija, require('../package.json').version);
    await fd.postavke();
    await fd.sacuvajPostavke({ proizvodjac: 'tring', host: '192.168.1.5', port: 8085, visak: () => 1 });
    const inv = pozivi.filter((p) => p.vrsta === 'invoke');
    assert.equal(inv[0].kanal, 'fiskalni:postavke');
    assert.equal(inv[1].kanal, 'fiskalni:sacuvaj-postavke');
    assert.deepEqual(JSON.parse(JSON.stringify(inv[1].arg[0])), { proizvodjac: 'tring', host: '192.168.1.5', port: 8085 }, 'preload prosljeđuje samo tri polja');
});

test('FPOST.11 main: kanali postavki u glavnom procesu, drajver dobija adresu iz postavki', () => {
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(main, /require\('\.\/lib\/fiskalni-postavke'\)/);
    assert.match(main, /ipcMain\.handle\('fiskalni:postavke'/);
    assert.match(main, /ipcMain\.handle\('fiskalni:sacuvaj-postavke'/);
    assert.match(main, /napraviDrajver\([^)]*adresa:/);
});
