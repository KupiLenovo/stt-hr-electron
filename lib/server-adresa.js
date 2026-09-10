'use strict';
// Adresa aiERP servera u desktop appu (v4.2.0). Cista logika bez Electrona — test: `npm test`.
//
// Do v4.1.3 adresa je bila ZAKUCANA na http://46.101.96.28:3737: STT-ov server, nesifrovano
// (PIN i token isli internetom kao cist tekst). Takav exe moze koristiti samo STT. Od 4.2.0:
//   - nova instalacija pri prvom pokretanju pita adresu firme (npr. firma.aierp.ba);
//   - stare STT instalacije tiho prelaze na https://app.aierp.ba (main.js → prelazSaStareVerzije).
// Eldin 10.09.2026: exe ostaje proizvod — prodaje se i iznajmljuje, STT je firma 0.

const STARI_SERVER = 'http://46.101.96.28:3737';   // v4.0.0–v4.1.3, samo STT
const STT_SERVER = 'https://app.aierp.ba';          // STT d.o.o. = firma 0
const DOMENA = 'aierp.ba';                          // „firma" → firma.aierp.ba

const PORUKE = {
    prazno: 'Upiši adresu servera svoje firme.',
    neispravno: 'Adresa nije ispravna. Primjer: firma.aierp.ba',
    http: 'Nešifrovana veza (http://) nije dozvoljena — adresa mora biti https.',
};

const LOKALNI = new Set(['localhost', '127.0.0.1', '[::1]']);

// Unos korisnika → { url } (samo origin: https://host[:port], bez putanje i kose crte na kraju)
// ili { greska, poruka }. Bez sheme se podrazumijeva https; jedna rijec bez tacke je kod firme.
function normalizujAdresu(unos) {
    let s = String(unos == null ? '' : unos).trim();
    if (!s) return { greska: 'prazno', poruka: PORUKE.prazno };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch { return { greska: 'neispravno', poruka: PORUKE.neispravno }; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || !u.hostname) {
        return { greska: 'neispravno', poruka: PORUKE.neispravno };
    }
    const lokalno = LOKALNI.has(u.hostname);
    if (!lokalno && !u.hostname.includes('.')) u.hostname = `${u.hostname}.${DOMENA}`;
    if (u.protocol === 'http:' && !lokalno) return { greska: 'http', poruka: PORUKE.http };
    return { url: u.origin };
}

module.exports = { normalizujAdresu, STARI_SERVER, STT_SERVER, PORUKE };
