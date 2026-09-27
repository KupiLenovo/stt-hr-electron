// Kaos test helper — „aplikacija" bez Electrona: PRAVI fiskalni-drajver.js + lib/pos-kes.js + lib/fiskalni-most.js nad pos-kes.db
// na disku, s tačkama pada (gašenje aplikacije usred naplate), sync kase (ogledalo pos.tsx sinhronizuj) i lažni server firme
// (ugovor POST /api/v1/maloprodaja/racuni/sync iz stt-hr-server routes/maloprodaja.js: idempotentno po lokalni_uid).
'use strict';
const http = require('node:http');
const path = require('node:path');

const KOREN = path.join(__dirname, '..', '..');
const MODULI = ['fiskalni-drajver.js', 'lib/pos-kes.js', 'lib/fiskalni-most.js'].map((f) => path.join(KOREN, f));

class Krah extends Error { constructor(tacka) { super(`KRAH aplikacije: ${tacka}`); this.krah = true; this.tacka = tacka; } }
const nikad = () => new Promise(() => {});   // proces je mrtav: ništa poslije ove tačke se ne izvrši

// Tačke pada aplikacije u toku naplate (redom kako ih naplati() prolazi):
//   poslije_pripreme   — račun je na disku ('priprema'), uređaj još ništa nije dobio
//   tokom_snimka       — pad dok se čitaju brojači (OsnovneInformacije)
//   poslije_oznake     — red je 'salje_uredjaju', zahtjev štampe još nije otišao
//   tokom_slanja       — pad dok zahtjev štampe putuje (uređaj NIJE dobio račun)
//   poslije_stampe     — uređaj JE odštampao i odgovorio, aplikacija pala prije upisa rezultata
//   prije_rezultata    — isto kao gore, ali pad tačno u upisu rezultata na disk
//   poslije_naplate    — rezultat je na disku, pad prije javljanja serveru (to radi sync kad aplikacija opet radi)
const TACKE_PADA = ['poslije_pripreme', 'tokom_snimka', 'poslije_oznake', 'tokom_slanja', 'poslije_stampe', 'prije_rezultata', 'poslije_naplate'];

// Nova instanca aplikacije nad ISTIM folderom (userData) — kao ponovno pokretanje exe-a poslije pada.
function pokreniAplikaciju(userData, DatabaseCtor) {
    for (const m of MODULI) delete require.cache[require.resolve(m)];
    const posKes = require(MODULI[1]);
    const drajver = require(MODULI[0]).napraviDrajver('tring');
    if (!posKes.init(userData, DatabaseCtor)) throw new Error('pos-kes init nije uspio');

    let tacka = null;       // tačka pada za SLJEDEĆU naplatu
    let javiKrah = null;    // razriješi se kad aplikacija „umre" (zamrznut poziv)
    const umri = (t) => { const j = javiKrah; javiKrah = null; tacka = null; if (j) j(t); return nikad(); };

    const d = {
        osnovneInformacije: async () => (tacka === 'tokom_snimka' ? umri(tacka) : drajver.osnovneInformacije()),
        fiskalizuj: async (r) => stampa(() => drajver.fiskalizuj(r)),
        reklamiraj: async (r, o) => stampa(() => drajver.reklamiraj(r, o)),
        duplikatRacuna: (...a) => drajver.duplikatRacuna(...a),
        periodicniIzvjestaj: (...a) => drajver.periodicniIzvjestaj(...a),
        provjeriRezim: () => drajver.provjeriRezim(),
    };
    async function stampa(fn) {
        if (tacka === 'tokom_slanja') return umri(tacka);
        const rez = await fn();
        if (tacka === 'poslije_stampe') return umri(tacka);
        return rez;
    }
    // pos-kes s tačkama pada: upis se izvrši (ili ne), pa „proces umre" (izuzetak prekida naplati — ništa poslije se ne upiše)
    const p = Object.create(posKes);
    p.pripremiNaplatu = (...a) => { const r = posKes.pripremiNaplatu(...a); if (tacka === 'poslije_pripreme') { const t = tacka; tacka = null; throw new Krah(t); } return r; };
    p.oznaciSaljeUredjaju = (...a) => { posKes.oznaciSaljeUredjaju(...a); if (tacka === 'poslije_oznake') { const t = tacka; tacka = null; throw new Krah(t); } };
    p.upisiRezultat = (...a) => { if (tacka === 'prije_rezultata') { const t = tacka; tacka = null; throw new Krah(t); } return posKes.upisiRezultat(...a); };
    const most = require(MODULI[2]).napraviMost({ drajver: d, posKes: p });

    return {
        posKes, drajver, most,
        /** Naplata; ako je zadana tačka pada, vraća { krah: tacka } (aplikacija je mrtva — treba nova instanca). */
        async naplati(posiljka, tackaPada = null) {
            tacka = tackaPada;
            const krah = new Promise((ok) => { javiKrah = ok; });
            try {
                const r = await Promise.race([most.naplati(posiljka), krah.then((t) => ({ krah: t }))]);
                if (r && r.krah) return r;
                if (tackaPada === 'poslije_naplate') return { krah: tackaPada, rez: r };
                return r;
            } catch (e) {
                if (e && e.krah) return { krah: e.tacka };
                throw e;
            } finally { tacka = null; javiKrah = null; }
        },
    };
}

// ---- SYNC KASE: ogledalo pos.tsx → sinhronizuj() za put 4.3.0 (red iz pos-kes.db, dijelovi po 20, oznaciPoslan po id-u) ----
const SYNC_DIO = 20;
async function sinhronizuj(posKes, baza, { token = 'test', cekanjeMs = 8000 } = {}) {
    const racuni = (posKes.nesinhronizovani().racuni || []);
    const out = { poslano: 0, ok: 0, pali: [], prekid: false };
    for (let i = 0; i < racuni.length; i += SYNC_DIO) {
        const dio = racuni.slice(i, i + SYNC_DIO);
        let odg = null;
        try {
            const r = await fetch(`${baza}/api/v1/maloprodaja/racuni/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ racuni: dio }),
                signal: AbortSignal.timeout(cekanjeMs),
            });
            if (r.ok) odg = await r.json();
        } catch { odg = null; }
        if (!odg) { out.prekid = true; break; }   // bez veze / istek → ostatak ostaje u redu za sljedeći sync
        out.poslano += dio.length;
        for (const rez of odg.rezultati || []) {
            if (rez.id) { posKes.oznaciPoslan(rez.lokalni_uid || '', rez.id); out.ok++; }
            else out.pali.push(rez.poruka || rez.greska || 'nepoznata greška');
        }
    }
    return out;
}

// ---- LAŽNI SERVER FIRME: samo POST /api/v1/maloprodaja/racuni/sync, pravila iz routes/maloprodaja.js ----
//  • idempotentno po lokalni_uid (isti račun = isti id, postojeci: true);
//  • fiskalizovan račun se ne prepisuje; bez statusa se ne dira 'nepoznato';
//  • iz 'nepoznato' u drugo stanje samo uz fiskalni_potvrda, a u 'fiskalizovan' i uz broj (provjeriPrelaz).
function napraviServer() {
    const racuni = new Map();   // lokalni_uid → { id, fiskalni_status, fiskalni_broj, fiskalni_potvrda, puta }
    const zahtjevi = [];
    let sljedeciId = 1;
    let izgubiOdgovor = 0;      // koliko sljedećih odgovora „izgubiti" (server upiše, veza pukne prije odgovora)
    let server = null;
    let port = 0;

    function obradiRacun(rc) {
        if (!rc || !rc.lokalni_uid) return { greska: 'lokalni_uid_obavezan' };
        let r = racuni.get(rc.lokalni_uid);
        const postojeci = !!r;
        if (!r) { r = { id: sljedeciId++, lokalni_uid: rc.lokalni_uid, fiskalni_status: 'na_cekanju', fiskalni_broj: null, fiskalni_potvrda: null, iznos: rc.placanja ? rc.placanja.reduce((a, p) => a + p.iznos_fening, 0) : null, puta: 0 }; racuni.set(rc.lokalni_uid, r); }
        r.puta++;
        const smije = r.fiskalni_status !== 'fiskalizovan' && !(r.fiskalni_status === 'nepoznato' && !rc.fiskalni_status);
        let odbijen = null;
        if (smije && rc.fiskalni_status && r.fiskalni_status === 'nepoznato' && rc.fiskalni_status !== 'nepoznato') {
            if (!rc.fiskalni_potvrda) odbijen = 'fiskalni_potvrda_obavezna';
            else if (rc.fiskalni_status === 'fiskalizovan' && !String(rc.fiskalni_broj || '').trim()) odbijen = 'fiskalni_broj_obavezan';
        }
        if (smije && !odbijen && (rc.fiskalni_status || rc.fiskalni_broj)) {
            if (rc.fiskalni_status) r.fiskalni_status = rc.fiskalni_status;
            if (rc.fiskalni_broj) r.fiskalni_broj = String(rc.fiskalni_broj);
            if (rc.fiskalni_potvrda) r.fiskalni_potvrda = rc.fiskalni_potvrda;
        }
        return { lokalni_uid: rc.lokalni_uid, id: r.id, postojeci, ...(odbijen ? { fiskalni_odbijen: odbijen } : {}) };
    }

    function onRequest(req, res) {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (req.method !== 'POST' || req.url !== '/api/v1/maloprodaja/racuni/sync') { res.writeHead(404); res.end('{}'); return; }
            let ulaz = [];
            try { ulaz = JSON.parse(body).racuni || []; } catch { ulaz = []; }
            zahtjevi.push(ulaz.map((x) => x.lokalni_uid));
            const rezultati = ulaz.map(obradiRacun);
            if (izgubiOdgovor > 0) { izgubiOdgovor--; req.socket.destroy(); return; }   // upisano, ali kasa ne dobije odgovor
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ obradjeno: rezultati.length, rezultati }));
        });
    }

    return {
        racuni, zahtjevi,
        get baza() { return `http://127.0.0.1:${port}`; },
        /** Rezerviše port (server „ne postoji" dok se ne upali — ECONNREFUSED kao bez interneta). */
        async rezervisiPort() { const s = http.createServer(); await new Promise((ok) => s.listen(0, '127.0.0.1', ok)); port = s.address().port; await new Promise((ok) => s.close(ok)); return port; },
        async upali() { server = http.createServer(onRequest); await new Promise((ok) => server.listen(port, '127.0.0.1', ok)); port = server.address().port; return port; },
        async ugasi() { if (!server) return; const s = server; server = null; await new Promise((ok) => { s.close(() => ok()); if (s.closeAllConnections) s.closeAllConnections(); }); },
        izgubiSljedeciOdgovor(n = 1) { izgubiOdgovor = n; },
    };
}

// Deterministički generator (mulberry32) — isto sjeme = isti kaos, pa se pad može ponoviti.
function sjeme(s) {
    let a = s >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

module.exports = { pokreniAplikaciju, sinhronizuj, napraviServer, sjeme, Krah, TACKE_PADA, SYNC_DIO };
