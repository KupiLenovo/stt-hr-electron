// Kaos test helper — SIMULATOR Tring fiskalnog uređaja SA STANJEM (TFS na 127.0.0.1, bez hardvera i bez Tring Emulatora).
//
// Za razliku od test/helpers/tfs.js (snimljeni odgovori), simulator se ponaša kao uređaj:
//   • drži brojače kao OsnovneInformacije (§7.9.1): ibfm, last_BF, last_RF, cash/card/check/transfer_order, z_number;
//   • „štampa" račun: parsira RacunZahtjev (§7) koji šalje lib/fiskalni/tring.js, upiše ga na TRAKU (stavke, oznake plaćanja,
//     iznos, broj), pomjeri brojače i odgovori KasaOdgovor (§4) u obliku koji parseKasaOdgovor čita;
//   • kvarovi po komandi (jednokratni, redom): prekid veze prije štampe, prekid poslije štampe prije odgovora, spor odgovor
//     preko praga čekanja drajvera, prazan ili prekinut odgovor, Greska (papir), Upozorenje bez broja;
//   • gašenje TFS-a (ugasi/upali na ISTOM portu → drajver dobija ECONNREFUSED kao kad servis ne radi).
// Traka je istina: test po njoj provjerava da nijedna prodaja nije odštampana dvaput i da je broj u redu kase tačan.
'use strict';
const http = require('node:http');
const { osnovneXml, odgovorXml, greskaXml } = require('./tfs');

const PLACANJE_POLJE = { Gotovina: 'cash', Kartica: 'card', Cek: 'check', Virman: 'transfer_order' };
const STAMPA = new Set(['/stampatifiskalniracun', '/stampatireklamiraniracun']);

const tag = (xml, ime) => { const m = new RegExp(`<${ime}>([\\s\\S]*?)</${ime}>`, 'i').exec(xml); return m ? m[1].trim() : null; };
const svi = (xml, ime) => { const out = []; const re = new RegExp(`<${ime}>([\\s\\S]*?)</${ime}>`, 'gi'); let m; while ((m = re.exec(xml))) out.push(m[1]); return out; };
const fen = (s) => Math.round(parseFloat(String(s).replace(',', '.')) * 100);
const dec = (f) => (f / 100).toFixed(2);

// RacunZahtjev (onako kako ga gradi tring.buildRacunXml) → { stavke, placanja, iznos_fening, original_broj }
function parsirajRacun(xml) {
    const stavke = svi(xml, 'RacunStavka').map((s) => {
        const cijena = fen(tag(s, 'Cijena'));
        const kolicina = parseFloat(tag(s, 'Kolicina'));
        const rabat = parseFloat(tag(s, 'Rabat') || '0');
        return { naziv: tag(s, 'Naziv'), cijena_fening: cijena, kolicina, stopa: tag(s, 'Stopa'), iznos_fening: Math.round(cijena * kolicina * (1 - rabat / 100)) };
    });
    const placanja = svi(xml, 'VrstaPlacanja').map((p) => ({ oznaka: tag(p, 'Oznaka'), iznos_fening: fen(tag(p, 'Iznos')) }));
    return { stavke, placanja, iznos_fening: stavke.reduce((a, s) => a + s.iznos_fening, 0), original_broj: tag(xml, 'BrojRacuna') };
}

function napraviSimulator({ ibfm = 'AL901930', last_BF = 100, last_RF = 10, z_number = 1, datum = '27. 9. 2026.' } = {}) {
    const brojaci = { ibfm, last_BF, last_RF, cash: 0, card: 0, check: 0, transfer_order: 0, z_number };
    const traka = [];          // odštampani računi (istina uređaja)
    const zahtjevi = [];       // svaki primljeni zahtjev { path, body, kvar }
    const kvarovi = {};        // path → [kvar] (jednokratni, redom)
    let port = 0;
    let server = null;
    let ukljucen = false;
    let sekunda = 0;

    function stampaj(path, body) {
        const r = parsirajRacun(body);
        const reklamirani = path === '/stampatireklamiraniracun';
        const zbir = r.placanja.reduce((a, p) => a + p.iznos_fening, 0);
        const losa = r.placanja.find((p) => !PLACANJE_POLJE[p.oznaka]);
        if (losa) return { xml: greskaXml('ERROR_FISCAL_INVALID_PAYMENT', 1712) };
        if (!r.stavke.length || r.iznos_fening <= 0) return { xml: greskaXml('Neispravna_komanda', 512) };
        if (zbir !== r.iznos_fening) return { xml: greskaXml('Suma_placanja', 524) };
        const broj = reklamirani ? ++brojaci.last_RF : ++brojaci.last_BF;
        const znak = reklamirani ? -1 : 1;
        for (const p of r.placanja) brojaci[PLACANJE_POLJE[p.oznaka]] += znak * p.iznos_fening;
        sekunda++;
        const vrijeme = `10:${String(Math.floor(sekunda / 60) % 60).padStart(2, '0')}:${String(sekunda % 60).padStart(2, '0')}`;
        const zapis = { broj, tip: reklamirani ? 'reklamirani' : 'fiskalni', ...r, vrijeme };
        traka.push(zapis);
        return { xml: odgovorXml({ BrojFiskalnogRacuna: broj, DatumFiskalnogRacuna: datum, VrijemeFiskalnogRacuna: vrijeme, IznosFiskalnogRacuna: dec(r.iznos_fening) }), zapis };
    }

    function obradi(path, body) {
        if (path === '/osnovneinformacije') return { xml: osnovneXml({ bf: brojaci.last_BF, rf: brojaci.last_RF, cash: brojaci.cash, card: brojaci.card, check: brojaci.check, transfer: brojaci.transfer_order, z: brojaci.z_number, ibfm: brojaci.ibfm }) };
        if (STAMPA.has(path)) return stampaj(path, body);
        if (path === '/stampatidnevniizvjestaj') {   // Z: novi dan — stanja po vrsti plaćanja od nule
            brojaci.z_number++;
            for (const k of Object.values(PLACANJE_POLJE)) brojaci[k] = 0;
            return { xml: odgovorXml({}) };
        }
        return { xml: odgovorXml({}) };   // presjek, duplikat, periodični, unos/povrat novca — bez promjene brojača računa
    }

    function onRequest(req, res) {
        if (req.method === 'GET') { res.writeHead(200); res.end('TFS'); return; }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const q = kvarovi[req.url];
            const kvar = q && q.length ? q.shift() : null;
            const vrsta = kvar && kvar.vrsta;
            zahtjevi.push({ path: req.url, body, kvar: vrsta || null });
            if (vrsta === 'prekid_prije') { req.socket.destroy(); return; }                  // TFS pukne prije nego proslijedi uređaju
            if (vrsta === 'greska') { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(greskaXml(kvar.ime || 'PRINTER_ERR_NO_PAPER', kvar.kod || 503)); return; }
            const { xml } = obradi(req.url, body);                                             // uređaj ŠTAMPA (ili pročita brojače)
            if (vrsta === 'prekid_poslije') { req.socket.destroy(); return; }                // odštampano, veza pukla prije odgovora
            if (vrsta === 'prazan') { res.writeHead(kvar.status || 200); res.end(); return; } // odštampano, odgovor bez tijela
            if (vrsta === 'prekinut') {                                                      // odštampano, odgovor prekinut u pola
                res.writeHead(200, { 'Content-Type': 'text/xml', 'Content-Length': String(Buffer.byteLength(xml) + 50) });
                res.write(xml.slice(0, 20));
                setTimeout(() => req.socket.destroy(), 5).unref();
                return;
            }
            if (vrsta === 'upozorenje_bez_broja') { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(odgovorXml({ Upozorenje: 'Papira ponestaje' }, 'Upozorenje')); return; }
            const posalji = () => { try { if (!res.writableEnded && !res.destroyed) { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(xml); } } catch { /* drajver je već odustao */ } };
            if (vrsta === 'spor') { setTimeout(posalji, kvar.ms || 1000).unref(); return; }  // odštampano, odgovor stiže poslije praga čekanja
            posalji();
        });
    }

    const api = {
        brojaci, traka, zahtjevi,
        get port() { return port; },
        get ukljucen() { return ukljucen; },
        async start(p = 0) {
            server = http.createServer(onRequest);
            await new Promise((ok, ne) => { server.once('error', ne); server.listen(p || port || 0, '127.0.0.1', () => ok()); });
            port = server.address().port;
            ukljucen = true;
            return port;
        },
        /** TFS ugašen: port zatvoren → drajver dobija ECONNREFUSED. */
        async ugasi() {
            if (!server) return;
            const s = server; server = null; ukljucen = false;
            await new Promise((ok) => { s.close(() => ok()); if (s.closeAllConnections) s.closeAllConnections(); });
        },
        /** TFS ponovo radi na istom portu (brojači i traka ostaju — to je uređaj, ne servis). */
        async upali() { if (!server) await api.start(port); },
        stop() { return api.ugasi(); },
        /** Kvar za sljedeći zahtjev na putanju (jednokratan; više poziva = red). vrsta: prekid_prije | prekid_poslije | spor | prazan | prekinut | greska | upozorenje_bez_broja */
        kvar(path, vrsta, opcije = {}) { (kvarovi[path] = kvarovi[path] || []).push({ vrsta, ...opcije }); return api; },
        ocistiKvarove() { for (const k of Object.keys(kvarovi)) delete kvarovi[k]; return api; },
        brojStampi() { return traka.length; },
        broj(path) { return zahtjevi.filter((z) => z.path === path).length; },
        /** Računi na traci čija stavka nosi dati naziv (test stavlja lokalni_uid u naziv stavke). */
        racuniZa(naziv) { return traka.filter((r) => r.stavke.some((s) => s.naziv === naziv)); },
        promijeniIbfm(novi) { brojaci.ibfm = novi; return api; },
    };
    return api;
}

module.exports = { napraviSimulator, parsirajRacun, PLACANJE_POLJE };
