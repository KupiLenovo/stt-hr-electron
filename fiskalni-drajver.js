// C-Fiskalni — TringDrajver (Electron main). TANAK omotač: build XML (lib) → HTTP POST localhost:8085 → parse (lib).
// Sva logika je u lib/fiskalni/tring.js (kanonski izvor + CI na serveru). Ovdje samo I/O glue.
// ⚠️ NEVERIFIKOVANO iz CI-a — testira se protiv Tring Emulatora (Eldin). EsetDrajver = budući CPF (stub).
const http = require('http');
const tring = require('./lib/fiskalni/tring');

const TFS_HOST = process.env.TRING_HOST || 'localhost';
const TFS_PORT = Number(process.env.TRING_PORT) || 8085;

// Jedini "neverifikovani" dio: HTTP POST XML na TFS. Vraća {status, raw} ili baca (veza pukla).
function postXml(putanja, xml, timeoutMs = 12000) {
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
    async statusUredjaja() { return this._posalji(tring.KOMANDE.status, tring.buildZahtjev(++brojZahtjeva, 0)); }
    async inicijalizacija(op = 0, loz = 0) { return this._posalji(tring.KOMANDE.inicijalizacija, tring.buildInicijalizacijaXml(op, loz)); }
    async fiskalizuj(racun) { return this._posalji(tring.KOMANDE.fiskalni, tring.buildRacunXml({ ...racun, broj_zahtjeva: ++brojZahtjeva, tip: 'fiskalni' })); }
    async reklamiraj(racun, originalBroj) { return this._posalji(tring.KOMANDE.reklamirani, tring.buildRacunXml({ ...racun, broj_zahtjeva: ++brojZahtjeva, tip: 'reklamirani', original_broj: originalBroj })); }
    async unosNovca(vrsta, iznosFening) { return this._posalji(tring.KOMANDE.unosNovca, tring.buildNovacXml(vrsta, iznosFening)); }
    async povratNovca(vrsta, iznosFening) { return this._posalji(tring.KOMANDE.povratNovca, tring.buildNovacXml(vrsta, iznosFening)); }
    async presjekStanja() { return this._posalji(tring.KOMANDE.presjek, tring.buildZahtjev(++brojZahtjeva, 3)); }
    async dnevniIzvjestaj() { return this._posalji(tring.KOMANDE.dnevni, tring.buildZahtjev(++brojZahtjeva, 4)); }
    async osnovneInformacije() { return this._posalji(tring.KOMANDE.osnovne, tring.buildZahtjev(++brojZahtjeva, 0)); }
}

// EsetDrajver — BUDUĆA implementacija (CPF API kad izađe 2027). Isti interface; dokaz da apstrakcija drži.
class EsetDrajver {
    get tip() { return 'eset'; }
    async fiskalizuj() { throw new Error('EsetDrajver još nije implementiran (CPF API, ~2027).'); }
}

function napraviDrajver(tip) { return tip === 'eset' ? new EsetDrajver() : new TringDrajver(); }

module.exports = { TringDrajver, EsetDrajver, napraviDrajver };
