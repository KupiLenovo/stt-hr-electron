// MAL-20 — LOKALNA KASA: kad se server firme ne javi (nema interneta ujutru), prozor ne ostaje na offline.html nego otvara ekran kase.
//
// Ekran kase je client-v2 build sa servera firme (PWA, service worker već precache-ira sve js/css/html — vite.config.ts globPatterns).
// Desktop uz to drži SVOJU kopiju tog builda na disku (userData/kasa-ljuska): poslije svakog uspješnog učitavanja servera pročita listu
// fajlova iz /sw.js (precache manifest) i skine ono što se promijenilo. Bez interneta main.js tu kopiju servira NA ORIGINU servera
// (protocol.handle, isti trik kao prelaz 4.1.x → 4.2.0): localStorage, kasa i dnevnik štampe ostaju isti kao online, a /api/* ide na mrežu
// (pada dok nema veze — kasa tada radi nad pos-kes.db i drajverom; čim veza dođe, isti zahtjevi prolaze bez ponovnog učitavanja).
// Čista logika (bez Electrona) — testovi: test/lokalna-kasa.test.js.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FAJLOVA = 2000;
const MAX_BAJTOVA = 60 * 1024 * 1024;
const PUTANJA_KASE = '/kasa-bez-interneta';
const TIPOVI = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/** Fajlovi iz workbox precache manifesta u sw.js: [{url:"assets/x.js",revision:…}] → ['assets/x.js', …] (samo relativne, bez „..“). */
function fajloviIzSw(swTekst) {
    const out = new Set(['index.html']);
    const re = /url\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(String(swTekst || ''))) && out.size < MAX_FAJLOVA) {
        const u = m[1].replace(/^\.?\//, '');
        if (!u || /^[a-z]+:/i.test(u) || u.includes('..') || u.startsWith('api/')) continue;
        out.add(u);
    }
    return [...out];
}
const verzijaSw = (swTekst) => crypto.createHash('sha256').update(String(swTekst || '')).digest('hex').slice(0, 16);
function procitajManifest(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'kasa-ljuska.json'), 'utf8')); } catch { return null; } }

/**
 * Osvježi kopiju ekrana kase s servera. `dohvati(url)` → { ok, status, tekst?, bajtovi? } (main.js: net.fetch; test: lažni server).
 * Ništa se ne mijenja dok se sve ne skine (privremeni folder pa zamjena) — pola kopije nikad ne postane „lokalna kasa".
 */
async function osvjeziLjusku({ server, dir, dohvati }) {
    if (!server || !dir || typeof dohvati !== 'function') return { ok: false, razlog: 'parametri' };
    const sw = await dohvati(`${server}/sw.js`);
    if (!sw || !sw.ok) return { ok: false, razlog: 'sw_nedostupan' };
    const verzija = verzijaSw(sw.tekst);
    const bio = procitajManifest(dir);
    if (bio && bio.verzija === verzija && bio.server === server) return { ok: true, vec: true, verzija };
    const fajlovi = fajloviIzSw(sw.tekst);
    const privremeni = `${dir}.novo`;
    fs.rmSync(privremeni, { recursive: true, force: true });
    fs.mkdirSync(privremeni, { recursive: true });
    let ukupno = 0;
    for (const f of fajlovi) {
        const r = await dohvati(`${server}/${f}`);
        if (!r || !r.ok) { fs.rmSync(privremeni, { recursive: true, force: true }); return { ok: false, razlog: `fajl_${f}` }; }
        const b = Buffer.isBuffer(r.bajtovi) ? r.bajtovi : Buffer.from(r.tekst ?? '', 'utf8');
        ukupno += b.length;
        if (ukupno > MAX_BAJTOVA) { fs.rmSync(privremeni, { recursive: true, force: true }); return { ok: false, razlog: 'prevelika' }; }
        const cilj = path.join(privremeni, ...f.split('/'));
        if (!cilj.startsWith(privremeni + path.sep)) continue;
        fs.mkdirSync(path.dirname(cilj), { recursive: true });
        fs.writeFileSync(cilj, b);
    }
    fs.writeFileSync(path.join(privremeni, 'kasa-ljuska.json'), JSON.stringify({ server, verzija, fajlova: fajlovi.length, bajtova: ukupno, at: new Date().toISOString() }));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(privremeni, dir);
    return { ok: true, verzija, fajlova: fajlovi.length };
}
/** Kopija postoji i pripada ovom serveru. */
function ljuskaSpremna(dir, server) {
    const m = procitajManifest(dir);
    return !!(m && m.server === server && fs.existsSync(path.join(dir, 'index.html')));
}
/**
 * Odgovor lokalne kase za zahtjev na originu servera: { tijelo, tip } ili null (ide na mrežu). /api/* uvijek na mrežu; fajl iz kopije ako
 * postoji; navigacija (putanja bez ekstenzije) → index.html (SPA, kao navigateFallback service workera).
 */
function odgovor(dir, putanja) {
    const p = decodeURIComponent(String(putanja || '/').split('?')[0]);
    if (p.startsWith('/api/') || p === '/api' || p.includes('..')) return null;
    const rel = p.replace(/^\/+/, '');
    const fajl = rel ? path.join(dir, ...rel.split('/')) : null;
    if (fajl && fajl.startsWith(dir + path.sep) && fs.existsSync(fajl) && fs.statSync(fajl).isFile()) {
        return { tijelo: fs.readFileSync(fajl), tip: TIPOVI[path.extname(fajl).toLowerCase()] || 'application/octet-stream' };
    }
    if (!path.extname(rel)) {
        const idx = path.join(dir, 'index.html');
        if (fs.existsSync(idx)) return { tijelo: fs.readFileSync(idx), tip: TIPOVI['.html'] };
    }
    return null;
}
/**
 * Šta prozor radi kad učitavanje servera ne uspije (did-fail-load): 'lokalna_kasa' kad računar ima keš kase (radnici radnje, rok 72 h
 * od zadnje veze) i kopiju ekrana kase; inače 'offline' (stari ekran offline.html s „Pokušaj ponovo").
 */
function odlukaPriGresci({ server, stanjeKesa, ljuska }) {
    if (!server || !ljuska) return 'offline';
    if (!stanjeKesa || !stanjeKesa.spreman || !stanjeKesa.radnika || !stanjeKesa.kasa || stanjeKesa.istekao) return 'offline';
    return 'lokalna_kasa';
}
const adresaKase = (server) => `${server}${PUTANJA_KASE}`;

module.exports = { PUTANJA_KASE, fajloviIzSw, osvjeziLjusku, ljuskaSpremna, odgovor, odlukaPriGresci, adresaKase };
