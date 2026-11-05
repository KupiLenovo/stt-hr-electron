'use strict';
// Adresa aiERP servera u desktop appu (v4.2.0). Cista logika bez Electrona — test: `npm test`.
//
// Do v4.1.3 adresa je bila ZAKUCANA na stari server bez TLS-a (STARI_SERVER, nesifrovano: PIN i token
// isli internetom kao cist tekst). Takav exe je mogao koristiti samo jedna firma. Od 4.2.0:
//   - nova instalacija pri prvom pokretanju pita ŠIFRU firme (lib/ulaz-firme.js → ulaz portala daje adresu instance) ili,
//     za firmu na vlastitom serveru, punu adresu (npr. erp.firma.ba) — ova normalizacija je za taj drugi slučaj;
//   - 4.6.0 (odluka Eldina 05.11.2026 (10)): nema rezervne adrese nijedne firme u kodu — i stara (4.1.x) instalacija
//     dobija ekran „Šifra firme" (main.js); STARI_SERVER ostaje samo kao trag prelaza u zapisu (prelaz_sa), nikad za vezu.
// Eldin 10.09.2026: exe ostaje proizvod — prodaje se i iznajmljuje.

const STARI_SERVER = 'http://46.101.96.28:3737';   // v4.0.0–v4.1.3 (bez TLS-a) — samo oznaka, odbija je normalizujAdresu

const PORUKE = {
    prazno: 'Upiši adresu servera svoje firme.',
    neispravno: 'Adresa nije ispravna. Upiši šifru firme ili punu adresu servera (npr. erp.mojafirma.ba).',
    http: 'Nešifrovana veza (http://) nije dozvoljena — adresa mora biti https.',
};

const LOKALNI = new Set(['localhost', '127.0.0.1', '[::1]']);

// Unos korisnika → { url } (samo origin: https://host[:port], bez putanje i kose crte na kraju)
// ili { greska, poruka }. Bez sheme se podrazumijeva https. R68 (PLT-45): jedna rijec bez tacke vise NIJE <kod>.aierp.ba upisano u
// kod — to je sifra firme i ide kroz ulaz portala (lib/ulaz-firme.js); ovdje je neispravna adresa.
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
    if (!lokalno && !u.hostname.includes('.')) return { greska: 'neispravno', poruka: PORUKE.neispravno };
    if (u.protocol === 'http:' && !lokalno) return { greska: 'http', poruka: PORUKE.http };
    return { url: u.origin };
}

module.exports = { normalizujAdresu, STARI_SERVER, PORUKE };
