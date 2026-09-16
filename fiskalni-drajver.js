// C-Fiskalni — TringDrajver (Electron main). TANAK omotač: build XML (lib) → HTTP POST localhost:8085 → parse (lib).
// Sva logika je u lib/fiskalni/tring.js (kanonski izvor + CI na serveru). Ovdje samo I/O glue.
// ⚠️ NEVERIFIKOVANO iz CI-a — testira se protiv Tring Emulatora (Eldin). EsetDrajver = budući CPF (stub).
const http = require('http');
const tring = require('./lib/fiskalni/tring');

const TFS_HOST = process.env.TRING_HOST || '127.0.0.1'; // IPv4 eksplicitno — 'localhost' razrijesi na IPv6 ::1 (Node 17+), a TFS slusa IPv4 -> ECONNREFUSED ::1:8085
const TFS_PORT = Number(process.env.TRING_PORT) || 8085;
// MAL-04: rok čekanja usklađen s TFS KomandTimeOut = 30 s → 35 s (bilo 12 s). Kraći rok je pukao dok uređaj još štampa i
// slao račun drugi put; sad istek/prekid uvijek znači 'nepoznato' (nikad automatska ponovna štampa). Test podešava kraće preko env.
const TFS_TIMEOUT_MS = Number(process.env.TRING_TIMEOUT_MS) || 35000;

// Jedini "neverifikovani" dio: HTTP POST XML na TFS. Vraća {status, raw} ili baca (veza pukla).
function postXml(putanja, xml, timeoutMs = TFS_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(xml, 'utf8');
        const req = http.request({ host: TFS_HOST, port: TFS_PORT, path: putanja, method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': body.length } }, (res) => {
            let data = ''; res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, raw: data }));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('TFS timeout (uređaj/server nedostupan)')));
        req.write(body); req.end();
    });
}
function getRaw(putanja, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: TFS_HOST, port: TFS_PORT, path: putanja, method: 'GET' }, (res) => {
            let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, raw: data }));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('TFS timeout')));
        req.end();
    });
}

let brojZahtjeva = Math.floor((process.hrtime.bigint ? Number(process.hrtime.bigint() % 100000n) : 1));

// MAL-04 — komande koje NISU u kanonskom tring.KOMANDE (tring.js je SHA-ogledalo prema serveru, ne dira se).
// ⚠ Tačan endpoint/oblik XML-a za duplikat potvrđuje se na Tring emulatoru (Eldinov korak) — CI ide na snimljenim odgovorima.
const KOMANDE_MAL04 = { duplikat: '/stampatiduplikatracuna' };
const HEADER = tring.buildPrazno();   // '<?xml version="1.0" encoding="utf-8"?>' (bez kopije logike iz tring.js)
const sanBroj = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '') || '0';
const sanDatum = (v) => String(v == null ? '' : v).replace(/[^0-9.\-]/g, '').slice(0, 10);   // dd.mm.yyyy ili yyyy-mm-dd

// Duplikat (kopija) fiskalnog/reklamiranog računa po BrojRacuna — reprint, ne kreira novi fiskalni zapis.
function buildDuplikatXml(broj, tip) {
    const vrsta = tip === 'reklamirani' ? 2 : 0;   // isti razdvoj kao original (VrstaZahtjeva)
    return `${HEADER}\n<Zahtjev><BrojZahtjeva>${++brojZahtjeva}</BrojZahtjeva><VrstaZahtjeva>${vrsta}</VrstaZahtjeva><Kopija>1</Kopija><BrojRacuna>${sanBroj(broj)}</BrojRacuna></Zahtjev>`;
}
// Periodični izvještaj od–do (postojeći endpoint tring.KOMANDE.periodicni + raspon datuma).
function buildPeriodicniXml(od, doDatum) {
    return `${HEADER}\n<Zahtjev><BrojZahtjeva>${++brojZahtjeva}</BrojZahtjeva><VrstaZahtjeva>5</VrstaZahtjeva><DatumOd>${sanDatum(od)}</DatumOd><DatumDo>${sanDatum(doDatum)}</DatumDo></Zahtjev>`;
}

class TringDrajver {
    get tip() { return 'tring'; }
    // izvrši komandu: pošalji XML, parsiraj odgovor; veza pukla → offline signal
    async _posalji(putanja, xml) {
        try { const { raw } = await postXml(putanja, xml); return this._rez(tring.parseKasaOdgovor(raw), false); }
        catch (e) { return { uspjeh: false, status: 'offline_queue', greska: { poruka: e.message }, raw: '', veza_pukla: true }; }
    }
    _rez(p, vezaPukla) {
        return { uspjeh: !!(p && p.uspjeh), status: tring.statusIzRezultata(p, vezaPukla), fiskalni_broj: p && p.fiskalni_broj, fiskalni_datum: p && p.fiskalni_datum, fiskalni_vrijeme: p && p.fiskalni_vrijeme, qr_kod: (p && p.qr_kod) || null, iznos_fening: p && p.iznos_fening, greska: p && p.greska, odgovori: p && p.odgovori, raw: (p && p.raw) || '' };
    }
    async testVeze() {
        try { const { status } = await getRaw('/'); return { ok: status >= 200 && status < 500, poruka: `TFS odgovorio (HTTP ${status})` }; }
        catch (e) { return { ok: false, poruka: 'TFS nedostupan: ' + e.message }; }
    }
    async statusUredjaja() { return this._posalji(tring.KOMANDE.status, tring.buildPrazno()); }
    async inicijalizacija(op = 0, loz = 0) { return this._posalji(tring.KOMANDE.inicijalizacija, tring.buildInicijalizacijaXml(op, loz)); }
    async fiskalizuj(racun) { return this._posalji(tring.KOMANDE.fiskalni, tring.buildRacunXml({ ...racun, broj_zahtjeva: ++brojZahtjeva, tip: 'fiskalni' })); }
    async reklamiraj(racun, originalBroj) { return this._posalji(tring.KOMANDE.reklamirani, tring.buildRacunXml({ ...racun, broj_zahtjeva: ++brojZahtjeva, tip: 'reklamirani', original_broj: originalBroj })); }
    async unosNovca(vrsta, iznosFening) { return this._posalji(tring.KOMANDE.unosNovca, tring.buildNovacXml(vrsta, iznosFening)); }
    async povratNovca(vrsta, iznosFening) { return this._posalji(tring.KOMANDE.povratNovca, tring.buildNovacXml(vrsta, iznosFening)); }
    async presjekStanja() { return this._posalji(tring.KOMANDE.presjek, tring.buildZahtjev(++brojZahtjeva, 3)); }
    async dnevniIzvjestaj() { return this._posalji(tring.KOMANDE.dnevni, tring.buildZahtjev(++brojZahtjeva, 4)); }
    async osnovneInformacije() { return this._posalji(tring.KOMANDE.osnovne, tring.buildPrazno()); }
    // MAL-04: duplikat po BrojRacuna (fiskalni/reklamirani), periodični od–do, provjera režima rada.
    async duplikatRacuna(broj, tip = 'fiskalni') { return this._posalji(KOMANDE_MAL04.duplikat, buildDuplikatXml(broj, tip)); }
    async periodicniIzvjestaj(od, doDatum) { return this._posalji(tring.KOMANDE.periodicni, buildPeriodicniXml(od, doDatum)); }
    // Režim rada uređaja mora biti Maloprodaja pri otvaranju kase. Uređaj koji ne vraća polje → maloprodaja=null (ne blokiraj).
    async provjeriRezim() {
        const r = await this._posalji(tring.KOMANDE.osnovne, tring.buildPrazno());
        const o = (r && r.odgovori) || {};
        const sirovi = o.RezimRada ?? o.Rezim ?? o.NacinRada ?? o.mode ?? o.Mode ?? null;
        const s = String(sirovi == null ? '' : sirovi).trim().toLowerCase();
        const maloprodaja = /maloprod|retail/.test(s) ? true : (/veleprod|obuk|trening|servis|training/.test(s) ? false : null);
        return { ...r, rezim: sirovi == null ? null : String(sirovi), maloprodaja };
    }
}

// EsetDrajver — BUDUĆA implementacija (CPF API kad izađe 2027). Isti interface; dokaz da apstrakcija drži.
class EsetDrajver {
    get tip() { return 'eset'; }
    async fiskalizuj() { throw new Error('EsetDrajver još nije implementiran (CPF API, ~2027).'); }
}

function napraviDrajver(tip) { return tip === 'eset' ? new EsetDrajver() : new TringDrajver(); }

module.exports = { TringDrajver, EsetDrajver, napraviDrajver };
