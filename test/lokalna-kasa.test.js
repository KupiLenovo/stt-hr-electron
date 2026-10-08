// MAL-20 / MAL-21 — lokalna kasa (lib/lokalna-kasa.js + grana did-fail-load u main.js) i prihvatanje na simulatoru (odluka Eldina
// 27.09.2026: provjere s uređaja zamjenjuje simulator Tring uređaja; prava provjera na dan prve instalacije u radnji).
//   LK.1  pada na starom kodu: server nedostupan → main.js je uvijek učitavao offline.html; sada računar s kešom kase otvara lokalnu kasu.
//   LK.5  „isključen kabl i restart": za manje od 60 s radnik je na kasi, otvara smjenu i štampa račun na simulatoru uređaja.
//   LK.6  „kad se veza vrati": svi računi i smjena su na serveru za manje od 2 min, bez duplih (ugovor /smjena/sync i /racuni/sync).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { napraviDriver } = require('./helpers/sqlite');
const { napraviSimulator } = require('./helpers/tring-simulator');
const { pokreniAplikaciju } = require('./helpers/kasa');
const lk = require('../lib/lokalna-kasa');
const ko = require('../lib/kasa-offline');

const Db = napraviDriver();
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const kod = main.split(/\r?\n/).filter((r) => { const t = r.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
const folderi = [];
const folder = (ime) => { const f = fs.mkdtempSync(path.join(os.tmpdir(), `lk-${ime}-`)); folderi.push(f); return f; };
let sim = null;
before(() => { process.env.TRING_HOST = '127.0.0.1'; process.env.TRING_TIMEOUT_MS = '2000'; });
after(async () => {
    if (sim) await sim.stop();
    for (const f of folderi) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* Windows */ } }
});

// lažni server firme za kopiju ekrana kase: sw.js s precache listom + fajlovi
const SW = 'importScripts("sw-push.js");self.__WB=[{url:"assets/index-abc.js",revision:null},{url:"assets/index-abc.css",revision:null},{url:"index.html",revision:"1"},{url:"../tajna",revision:"x"},{url:"https://drugi.ba/x.js",revision:null}];';
function dohvatiIz(fajlovi, { pada = null } = {}) {
    return async (url) => {
        const p = new URL(url).pathname.replace(/^\//, '');
        if (pada && p === pada) return { ok: false, status: 500 };
        if (!(p in fajlovi)) return { ok: false, status: 404 };
        return { ok: true, status: 200, tekst: fajlovi[p] };
    };
}
const FAJLOVI = { 'sw.js': SW, 'index.html': '<!doctype html><div id="root"></div>', 'assets/index-abc.js': 'console.log(1)', 'assets/index-abc.css': 'body{}' };
const SERVER = 'https://firma.aierp.ba';

test('LK.1 server nedostupan: did-fail-load otvara lokalnu kasu (keš kase + kopija ekrana), a offline.html samo kad nje nema', () => {
    const blok = kod.slice(kod.indexOf("mainWindow.webContents.on('did-fail-load'"), kod.indexOf("mainWindow.webContents.on('will-navigate'"));
    assert.ok(blok.length > 100, 'grana did-fail-load postoji');
    const iOdluka = blok.indexOf('lokalnaKasa.odlukaPriGresci(');
    const iLokalna = blok.indexOf('otvoriLokalnuKasu()');
    const iOffline = blok.indexOf("'offline.html'");
    assert.ok(iOdluka > 0, 'odluka po kešu kase i kopiji ekrana (stari kod: odmah offline.html)');
    assert.ok(iLokalna > iOdluka && iLokalna < iOffline, 'lokalna kasa prije offline.html');
    assert.match(blok, /kasaOffline\.stanje\(\)/);
    assert.match(blok, /ljuskaSpremna\(/);
    // lokalna kasa: kopija se servira NA ORIGINU servera (localStorage i dnevnik štampe ostaju), /api ide na mrežu
    const fn = kod.slice(kod.indexOf('function otvoriLokalnuKasu'), kod.indexOf('function ugasiLokalnuKasu'));
    assert.match(fn, /protocol\.handle\(sema/);
    assert.match(fn, /u\.origin === origin/);
    assert.match(fn, /lokalnaKasa\.odgovor\(dir, u\.pathname\)/);
    assert.match(fn, /net\.fetch\(req, \{ bypassCustomProtocolHandlers: true \}\)/);
    assert.match(fn, /loadURL\(lokalnaKasa\.adresaKase\(server\)\)/);
    // offline sesija ne smije povrat ni storno na uređaju (samo prodaja i smjena)
    assert.match(kod, /ipcMain\.handle\('fiskalni:naplati'[^\n]*reklamirani[^\n]*dozvoljeno\(offlineSesija, 'povrat'\)/);
    assert.match(kod, /ipcMain\.handle\('fiskalni:reklamiraj'[^\n]*dozvoljeno\(offlineSesija, 'povrat'\)/);
    // PIN offline sesije nikad na disk; prijava briše kolačić prethodnog korisnika (offline sesija ne dijeli token)
    const prijava = kod.slice(kod.indexOf("ipcMain.handle('kasa:prijava'"), kod.indexOf("ipcMain.handle('kasa:odjava'"));
    assert.match(prijava, /cookies\.remove\(server, 'stt_token'\)/);
    assert.doesNotMatch(prijava, /writeFile|snimiAdresu|posKes\./, 'PIN ne ide u fajl');
});

test('LK.2 kopija ekrana kase: lista iz sw.js (samo relativne putanje), skida se cijela ili ništa, ista verzija se ne skida ponovo', async () => {
    assert.deepEqual(lk.fajloviIzSw(SW).sort(), ['assets/index-abc.css', 'assets/index-abc.js', 'index.html']);
    const dir = path.join(folder('ljuska'), 'kasa-ljuska');
    assert.equal(lk.ljuskaSpremna(dir, SERVER), false);
    const r = await lk.osvjeziLjusku({ server: SERVER, dir, dohvati: dohvatiIz(FAJLOVI) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(lk.ljuskaSpremna(dir, SERVER), true);
    assert.equal(lk.ljuskaSpremna(dir, 'https://druga.aierp.ba'), false, 'kopija pripada serveru firme');
    assert.equal((await lk.osvjeziLjusku({ server: SERVER, dir, dohvati: dohvatiIz(FAJLOVI) })).vec, true);
    // nova verzija koja pukne na pola: stara kopija ostaje netaknuta
    const nova = { ...FAJLOVI, 'sw.js': SW.replaceAll('abc', 'xyz'), 'assets/index-xyz.js': 'x', 'assets/index-xyz.css': 'y' };
    const pao = await lk.osvjeziLjusku({ server: SERVER, dir, dohvati: dohvatiIz(nova, { pada: 'assets/index-xyz.css' }) });
    assert.equal(pao.ok, false);
    assert.ok(fs.existsSync(path.join(dir, 'assets', 'index-abc.js')), 'stara kopija i dalje radi');
});

test('LK.3 odgovor lokalne kase: fajl iz kopije, navigacija → index.html, /api i „..“ idu na mrežu (null)', async () => {
    const dir = path.join(folder('odg'), 'kasa-ljuska');
    await lk.osvjeziLjusku({ server: SERVER, dir, dohvati: dohvatiIz(FAJLOVI) });
    assert.equal(lk.odgovor(dir, '/assets/index-abc.js').tip, 'text/javascript; charset=utf-8');
    assert.match(lk.odgovor(dir, lk.PUTANJA_KASE).tijelo.toString(), /id="root"/);
    assert.match(lk.odgovor(dir, '/pos?kasa=10').tijelo.toString(), /id="root"/);
    assert.equal(lk.odgovor(dir, '/api/v1/maloprodaja/kase'), null);
    assert.equal(lk.odgovor(dir, '/assets/../../tajna'), null);
    assert.equal(lk.odgovor(dir, '/assets/nema.js'), null);
});

test('LK.4 odluka pri grešci: lokalna kasa samo uz keš radnika i kasa u roku od 72 h i kopiju ekrana', () => {
    const st = { spreman: true, radnika: 2, kasa: 1, istekao: false };
    assert.equal(lk.odlukaPriGresci({ server: SERVER, stanjeKesa: st, ljuska: true }), 'lokalna_kasa');
    assert.equal(lk.odlukaPriGresci({ server: SERVER, stanjeKesa: { ...st, istekao: true }, ljuska: true }), 'offline');
    assert.equal(lk.odlukaPriGresci({ server: SERVER, stanjeKesa: { ...st, radnika: 0 }, ljuska: true }), 'offline', 'odjavljen uređaj (keš obrisan)');
    assert.equal(lk.odlukaPriGresci({ server: SERVER, stanjeKesa: st, ljuska: false }), 'offline');
    assert.equal(lk.odlukaPriGresci({ server: null, stanjeKesa: st, ljuska: true }), 'offline');
});

// ---- prihvatanje ----
function serverskiZapis(pin) {
    const sol = crypto.randomBytes(16);
    return `kasa1$${sol.toString('base64url')}$${crypto.scryptSync(pin, sol, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;
}
const PAKET = { verzija: 1, rok_offline_sati: 72, skladiste_id: 3, lokacija_id: 1, kase: [{ id: 3, sifra: 'K3', naziv: 'Kasa 3' }],
    radnici: [{ id: 6, ime: 'Ana', prezime: 'A', uloga: 'radnik', offline_pin_hash: serverskiZapis('1234') }, { id: 4, ime: 'Bojan', prezime: 'B', uloga: 'voditelj', offline_pin_hash: serverskiZapis('5678') }],
    vrste_placanja: [{ naziv: 'Gotovina', oznaka_uredjaja: 'Gotovina' }] };
let userData = null;
let ljuska = null;
function posiljka(uid, iznos, smjenaUid) {
    const placanja = [{ vrsta: 'Gotovina', iznos_fening: iznos }];
    const payload = { lokalni_uid: uid, skladiste_id: 3, smjena_lokalni_uid: smjenaUid, stavke: [{ artikal_id: 1, kolicina_mili: 1000, cijena_fening: iznos }], placanja };
    return { lokalni_uid: uid, skladiste_id: 3, tip: 'fiskalni', kanal: 'mp', iznos_fening: iznos, placanja, payload,
        stavke: [{ naziv: 'Artikal', jm: 'kom', cijena_fening: iznos, stopa_oznaka: 'E', kolicina_mili: 1000 }] };
}

test('LK.5 prihvatanje: bez interneta i poslije restarta za manje od 60 s radnik je na kasi, otvara smjenu i štampa račun (simulator)', async () => {
    // jučer s internetom: keš kase i kopija ekrana na računaru
    userData = folder('kasa');
    ljuska = path.join(userData, 'kasa-ljuska');
    {
        const app = pokreniAplikaciju(userData, Db);
        ko.init(app.posKes.baza());
        ko.spremiPaket(PAKET, { sada: () => Date.now() - 14 * 3600 * 1000 });
        await lk.osvjeziLjusku({ server: SERVER, dir: ljuska, dohvati: dohvatiIz(FAJLOVI) });
    }
    sim = napraviSimulator();
    process.env.TRING_PORT = String(await sim.start());
    const pocetak = Date.now();
    // restart računara bez mreže: nova instanca aplikacije nad istim userData
    const app = pokreniAplikaciju(userData, Db);
    ko.init(app.posKes.baza());
    await app.most.pokretanje(Date.now());
    assert.equal(lk.odlukaPriGresci({ server: SERVER, stanjeKesa: ko.stanje(), ljuska: lk.ljuskaSpremna(ljuska, SERVER) }), 'lokalna_kasa', 'umjesto offline.html');
    assert.ok(lk.odgovor(ljuska, lk.PUTANJA_KASE), 'ekran kase iz kopije');
    const p = ko.prijava({ skladiste_id: 3, radnik_id: 6, pin: '1234' });
    assert.equal(p.ok, true, JSON.stringify(p));
    const sm = ko.otvoriSmjenu({ skladiste_id: 3, radnik_id: 6, pocetni_fond_fening: 5000 });
    assert.equal(sm.ok, true);
    const r = await app.most.naplati(posiljka('lk5-r1', 1250, sm.smjena.lokalni_uid));
    assert.equal(r.ishod, 'fiskalizovan', JSON.stringify(r));
    assert.equal(sim.brojStampi(), 1, 'račun odštampan na simulatoru');
    const trajanje = Date.now() - pocetak;
    assert.ok(trajanje < 60000, `na kasi za ${trajanje} ms (granica 60 s)`);
    const red = app.posKes.nesinhronizovani().racuni.find((x) => x.lokalni_uid === 'lk5-r1');
    assert.equal(red.smjena_lokalni_uid, sm.smjena.lokalni_uid, 'račun iz reda nosi smjenu s diska');
    assert.equal(red.fiskalni_status, 'fiskalizovan');
});

// Lažni server firme: ugovor POST /smjena/sync i /racuni/sync iz stt-hr-server routes/maloprodaja.js (idempotentno po lokalni_uid smjene i
// računa; računi smjene idu u svoju smjenu). Pravi server i pravi klijentski sync (client-v2 lib/kasa-offline.ts) testira g1712.
function lazniServer() {
    const smjene = new Map(); const racuni = new Map(); let id = 1;
    const upisi = (rc, smjenaId) => {
        let r = racuni.get(rc.lokalni_uid); const postojeci = !!r;
        if (!r) { r = { id: id++, smjena_id: smjenaId, puta: 0, fiskalni_status: rc.fiskalni_status || null }; racuni.set(rc.lokalni_uid, r); }
        r.puta++;
        return { lokalni_uid: rc.lokalni_uid, id: r.id, postojeci };
    };
    const srv = http.createServer((req, res) => {
        let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
            const tijelo = JSON.parse(b || '{}');
            if (req.url === '/api/v1/maloprodaja/smjena/sync') {
                let s = smjene.get(tijelo.lokalni_uid);
                if (!s) { s = { id: id++, status: 'otvorena', puta: 0 }; smjene.set(tijelo.lokalni_uid, s); }
                s.puta++;
                const rezultati = (tijelo.racuni || []).map((rc) => upisi(rc, s.id));
                if (tijelo.zatvaranje) { s.status = 'zatvorena'; s.prebrojano = tijelo.zatvaranje.prebrojano_fening; }
                res.end(JSON.stringify({ smjena: { id: s.id, status: s.status }, sukob: false, rezultati }));
            } else if (req.url === '/api/v1/maloprodaja/racuni/sync') {
                res.end(JSON.stringify({ rezultati: (tijelo.racuni || []).map((rc) => upisi(rc, null)) }));
            } else { res.statusCode = 404; res.end('{}'); }
        });
    });
    return { srv, smjene, racuni };
}
// Ogledalo klijenta (client-v2 lib/kasa-offline.ts sinhronizujSmjene + pos.tsx sinhronizuj): prvo smjene s njihovim računima, pa ostatak reda.
async function syncKase(posKes, baza) {
    const post = async (put, body) => { const r = await fetch(baza + put, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); };
    const red = posKes.nesinhronizovani().racuni;
    for (const s of ko.nesinhronizovaneSmjene()) {
        const odg = await post('/api/v1/maloprodaja/smjena/sync', { ...ko.tijeloSynca(s), racuni: red.filter((rc) => rc.smjena_lokalni_uid === s.lokalni_uid) });
        for (const rz of odg.rezultati) posKes.oznaciPoslan(rz.lokalni_uid, rz.id);
        ko.oznaciSmjenu(s.lokalni_uid, { server_id: odg.smjena.id, sukob: odg.sukob });
    }
    const ostatak = posKes.nesinhronizovani().racuni.filter((rc) => !rc.smjena_lokalni_uid || !ko.nesinhronizovaneSmjene().some((s) => s.lokalni_uid === rc.smjena_lokalni_uid));
    if (ostatak.length) { const odg = await post('/api/v1/maloprodaja/racuni/sync', { racuni: ostatak }); for (const rz of odg.rezultati) posKes.oznaciPoslan(rz.lokalni_uid, rz.id); }
}

test('LK.6 prihvatanje: kad se veza vrati, svi računi i smjena su na serveru za manje od 2 min, bez duplih', async () => {
    const app = pokreniAplikaciju(userData, Db);
    ko.init(app.posKes.baza());
    const sm = ko.aktivnaSmjena(3);
    for (let i = 2; i <= 12; i++) assert.equal((await app.most.naplati(posiljka(`lk5-r${i}`, 100 * i, sm.lokalni_uid))).ishod, 'fiskalizovan');
    ko.zatvoriSmjenu({ lokalni_uid: sm.lokalni_uid, radnik_id: 6, prebrojano_fening: 5000 + 1250 + 7700 });
    const { srv, smjene, racuni } = lazniServer();
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const baza = `http://127.0.0.1:${srv.address().port}`;
    try {
        const pocetak = Date.now();
        await syncKase(app.posKes, baza);
        const trajanje = Date.now() - pocetak;
        assert.ok(trajanje < 120000, `sync za ${trajanje} ms (granica 2 min)`);
        assert.equal(app.posKes.nesinhronizovaniBroj(), 0, 'red je prazan');
        assert.equal(ko.nesinhronizovaneSmjene().length, 0, 'smjena je na serveru');
        assert.equal(racuni.size, 12, '12 računa');
        const s = smjene.get(sm.lokalni_uid);
        assert.equal(s.status, 'zatvorena');
        assert.ok([...racuni.values()].every((r) => r.smjena_id === s.id), 'svi u svojoj smjeni');
        // veza pukne usred odgovora i kasa pošalje ponovo: server ne pravi duple (idempotentno), red ostaje prazan
        await syncKase(app.posKes, baza);
        assert.equal(racuni.size, 12);
        assert.equal(smjene.size, 1);
        assert.equal(sim.brojStampi(), 12, 'nijedan račun nije odštampan dvaput');
    } finally { await new Promise((ok) => srv.close(ok)); }
});
