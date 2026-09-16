// MAL-04 test helper — LAŽNI TFS (Tring fiskalni servis) na 127.0.0.1: snimljeni odgovori po endpointu, brojanje zahtjeva,
// simulacija spore veze (delayMs) i prekida (drop). BEZ Electrona i BEZ uređaja — isti obrazac kao test/fiskalni-drajver.test.js.
'use strict';
const http = require('node:http');

// OsnovneInformacije (§7.9.1) snimak brojača — sve u obliku koji snimakIzOdgovora očekuje (cash u decimalama, brojevi cijeli).
function osnovneXml({ bf = 0, rf = 0, cash = 0, card = 0, check = 0, transfer = 0, z = 1, ibfm = 'AL901930' } = {}) {
    const dec = (f) => (Number(f) / 100).toFixed(2);
    return `<KasaOdgovor><Odgovori>` +
        `<Odgovor><Naziv>ibfm</Naziv><Vrijednost>${ibfm}</Vrijednost></Odgovor>` +
        `<Odgovor><Naziv>last_BF</Naziv><Vrijednost>${bf}</Vrijednost></Odgovor>` +
        `<Odgovor><Naziv>last_RF</Naziv><Vrijednost>${rf}</Vrijednost></Odgovor>` +
        `<Odgovor><Naziv>cash</Naziv><Vrijednost>${dec(cash)}</Vrijednost></Odgovor>` +
        `<Odgovor><Naziv>card</Naziv><Vrijednost>${dec(card)}</Vrijednost></Odgovor>` +
        `<Odgovor><Naziv>check</Naziv><Vrijednost>${dec(check)}</Vrijednost></Odgovor>` +
        `<Odgovor><Naziv>transfer_order</Naziv><Vrijednost>${dec(transfer)}</Vrijednost></Odgovor>` +
        `<Odgovor><Naziv>z_number</Naziv><Vrijednost>${z}</Vrijednost></Odgovor>` +
        `</Odgovori><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>`;
}
// Uspješan fiskalni/reklamirani odgovor s brojem.
function racunOkXml(broj, iznosF = 500, datum = '27.09.2023') {
    return `<KasaOdgovor><Odgovori>` +
        `<Odgovor><Naziv>BrojFiskalnogRacuna</Naziv><Vrijednost>${broj}</Vrijednost></Odgovor>` +
        `<Odgovor><Naziv>DatumFiskalnogRacuna</Naziv><Vrijednost>${datum}</Vrijednost></Odgovor>` +
        `<Odgovor><Naziv>IznosFiskalnogRacuna</Naziv><Vrijednost>${(iznosF / 100).toFixed(2)}</Vrijednost></Odgovor>` +
        `</Odgovori><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>`;
}

function napraviTFS() {
    const zahtjevi = [];        // { path, body } — svaki primljeni POST
    const plan = {};            // path → [ {body?,status?,delayMs?,drop?} ] (potroši se redom)
    let fallback = { body: '<KasaOdgovor><VrstaOdgovora>OK</VrstaOdgovora></KasaOdgovor>' };

    const server = http.createServer((req, res) => {
        if (req.method === 'GET') { res.writeHead(200); res.end('TFS'); return; }   // testVeze
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
            zahtjevi.push({ path: req.url, body: data });
            const q = plan[req.url];
            const n = (q && q.length ? q.shift() : null) || fallback || {};
            if (n.drop) { req.socket.destroy(); return; }
            const posalji = () => { try { if (!res.writableEnded) { res.writeHead(n.status || 200, { 'Content-Type': 'text/xml' }); res.end(n.body != null ? n.body : fallback.body); } } catch { /* socket zatvoren (timeout) */ } };
            if (n.delayMs) { const t = setTimeout(posalji, n.delayMs); if (t.unref) t.unref(); } else posalji();
        });
    });

    const api = {
        async start() { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return server.address().port; },
        stop() { try { server.close(); } catch { /* ignore */ } },
        /** Zakaži odgovore za endpoint (potroše se redom). */
        odgovori(path, ...res) { (plan[path] = plan[path] || []).push(...res); return api; },
        setFallback(r) { fallback = r; return api; },
        zahtjevi,
        broj(path) { return zahtjevi.filter((z) => z.path === path).length; },
        zadnji(path) { return [...zahtjevi].reverse().find((z) => z.path === path) || null; },
        reset() { zahtjevi.length = 0; for (const k of Object.keys(plan)) delete plan[k]; return api; },
    };
    return api;
}

module.exports = { napraviTFS, osnovneXml, racunOkXml };
