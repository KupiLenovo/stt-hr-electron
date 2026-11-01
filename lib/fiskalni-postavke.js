// R62 — postavke fiskalnog uređaja NA OVOM RAČUNARU (ugovor mosta FIS ↔ DSK): adresa i port Tring Fiscal Servera (TFS).
//
// Pamti se u userData/fiskalni-uredjaj.json (ne na serveru — svaki računar kase ima svoj uređaj). Provjera je OVDJE, u
// glavnom procesu: renderer (aiERP sa servera) šalje samo { proizvodjac, host, port } i dobija rezultat, nikad pristup fajlu.
// Dozvoljena adresa: loopback, privatna LAN mreža (10.x, 172.16–31.x, 192.168.x, IPv6 fc00::/7) ili ime računara u mreži
// (jedna riječ, npr. KASA-1, ili ime u lokalnoj zoni .local/.lan/…). NIKAD javna adresa: računi i PIN-ovi uređaja ne smiju
// izaći na internet. Drajver (fiskalni-drajver.js) istu provjeru ponavlja pri svakom zahtjevu i provjerava i adresu u koju
// se ime razriješi (dnsProvjera), pa ni ručno izmijenjen fajl ni env ne mogu poslati račun na javnu adresu.
// Čist Node (bez Electrona) — test/fiskalni-postavke.test.js.
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');

const IME_FAJLA = 'fiskalni-uredjaj.json';
const ZADANO = Object.freeze({ proizvodjac: 'tring', host: '127.0.0.1', port: 8085 });   // IPv4 eksplicitno (TFS ne sluša ::1)
const LOKALNE_ZONE = ['local', 'lan', 'home', 'internal', 'intranet', 'localdomain', 'home.arpa'];

const greska = (kod, poruka) => ({ ok: false, greska: kod, poruka });
const HOST_PORUKA = 'Adresa mora biti ovaj računar (127.0.0.1), adresa u lokalnoj mreži (npr. 192.168.1.20) ili ime računara u mreži — nikad javna adresa.';

// IP (v4/v6) u lokalnoj mreži ili loopback. Sve ostalo (javne, 0.0.0.0, 169.254.x, broadcast) → false.
function privatnaIp(ip) {
    const s = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIPv4(s)) {
        const [a, b] = s.split('.').map(Number);
        return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    if (net.isIPv6(s)) {
        if (s === '::1') return true;
        const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);   // IPv4 mapirana u IPv6
        if (m) return privatnaIp(m[1]);
        return /^f[cd][0-9a-f]{0,2}:/.test(s);               // fc00::/7 (jedinstvena lokalna)
    }
    return false;
}

// host → { ok:true, host } (normalizovan) ili { ok:false, greska:'host_neispravan', poruka }
function provjeriHost(ulaz) {
    if (typeof ulaz !== 'string') return greska('host_neispravan', HOST_PORUKA);
    const h = ulaz.trim().toLowerCase();
    if (!h || h.length > 253) return greska('host_neispravan', HOST_PORUKA);
    const bezZagrada = h.replace(/^\[(.*)\]$/, '$1');
    if (net.isIP(bezZagrada)) return privatnaIp(bezZagrada) ? { ok: true, host: bezZagrada } : greska('host_neispravan', HOST_PORUKA);
    if (h === 'localhost') return { ok: true, host: h };
    const oznake = h.split('.');
    const ispravna = (o) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(o);
    if (!oznake.every(ispravna)) return greska('host_neispravan', HOST_PORUKA);
    // Brojevi i heks oznake razrješivač čita kao IP (npr. „134744072" = 8.8.8.8, „0x7f.1") → nisu ime računara.
    if (oznake.some((o) => /^\d+$/.test(o) || /^0x[0-9a-f]*$/.test(o))) return greska('host_neispravan', HOST_PORUKA);
    if (oznake.length === 1) return { ok: true, host: h };                       // ime računara u mreži (KASA-1)
    const zona = oznake.slice(1).join('.');
    if (LOKALNE_ZONE.some((z) => zona === z || zona.endsWith('.' + z))) return { ok: true, host: h };
    return greska('host_neispravan', HOST_PORUKA);                                // javno DNS ime (npr. nešto.ba) — ne
}

function provjeriPort(ulaz) {
    const s = typeof ulaz === 'number' ? String(ulaz) : (typeof ulaz === 'string' ? ulaz.trim() : '');
    if (!/^\d{1,5}$/.test(s)) return greska('port_neispravan', 'Port mora biti cijeli broj od 1 do 65535 (Tring Fiscal Server: 8085).');
    const n = Number(s);
    if (n < 1 || n > 65535) return greska('port_neispravan', 'Port mora biti cijeli broj od 1 do 65535 (Tring Fiscal Server: 8085).');
    return { ok: true, port: n };
}

function provjeriProizvodjaca(ulaz) {
    const p = ulaz == null || ulaz === '' ? 'tring' : String(ulaz).trim().toLowerCase();
    if (p === 'tring') return { ok: true, proizvodjac: p };
    if (p === 'eset') return greska('proizvodjac_nepodrzan', 'Podrška za ESET uređaje dolazi uskoro. Za sada je podržan Tring.');
    return greska('proizvodjac_nepodrzan', 'Ovaj proizvođač fiskalnog uređaja nije podržan. Za sada je podržan Tring.');
}

// { proizvodjac, host, port } → { ok:true, postavke:{proizvodjac,host,port} } ili greška ugovora
function provjeri(ulaz) {
    const u = ulaz && typeof ulaz === 'object' ? ulaz : {};
    const p = provjeriProizvodjaca(u.proizvodjac); if (!p.ok) return p;
    const h = provjeriHost(u.host); if (!h.ok) return h;
    const n = provjeriPort(u.port); if (!n.ok) return n;
    return { ok: true, postavke: { proizvodjac: p.proizvodjac, host: h.host, port: n.port } };
}

// Važeće postavke: env (razvoj) → sačuvano na računaru → zadano. Pokvaren ili nedozvoljen zapis se ne koristi.
function ucitaj({ dir, env = process.env } = {}) {
    if (env && (env.TRING_HOST || env.TRING_PORT)) {
        return { proizvodjac: 'tring', host: env.TRING_HOST || ZADANO.host, port: Number(env.TRING_PORT) || ZADANO.port, izvor: 'env' };
    }
    if (dir) {
        try {
            const r = provjeri(JSON.parse(fs.readFileSync(path.join(dir, IME_FAJLA), 'utf8')));
            if (r.ok) return { ...r.postavke, izvor: 'sacuvano' };
        } catch { /* nema fajla ili pokvaren → zadano */ }
    }
    return { ...ZADANO, izvor: 'zadano' };
}

// Provjeri i upiši (atomski: privremeni fajl + preimenovanje). Vraća { ok:true, postavke } (važeće poslije upisa) ili grešku.
function sacuvaj(dir, ulaz, { env = process.env } = {}) {
    const r = provjeri(ulaz);
    if (!r.ok) return r;
    fs.mkdirSync(dir, { recursive: true });
    const cilj = path.join(dir, IME_FAJLA);
    const tmp = cilj + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...r.postavke, sacuvano_at: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, cilj);
    return { ok: true, postavke: ucitaj({ dir, env }) };
}

// `lookup` za http.request: ime računara se razriješi, ali veza ide samo na privatnu adresu (ime u mreži koje DNS
// pokaže na javnu adresu → greška, ništa ne ide van).
function dnsProvjera(hostname, opcije, cb) {
    dns.lookup(hostname, opcije, (err, adresa, porodica) => {
        if (err) return cb(err);
        const lista = Array.isArray(adresa) ? adresa : [{ address: adresa, family: porodica }];
        if (!lista.length || lista.some((a) => !privatnaIp(a.address))) {
            return cb(new Error(`Ime ${hostname} pokazuje na adresu van lokalne mreže — veza nije dozvoljena.`));
        }
        return cb(null, adresa, porodica);
    });
}

module.exports = { IME_FAJLA, ZADANO, privatnaIp, provjeriHost, provjeriPort, provjeri, ucitaj, sacuvaj, dnsProvjera };
