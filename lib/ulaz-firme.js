'use strict';
// PLT-45 (R68 ULZ): adresa instance firme iz ŠIFRE FIRME pri prvom pokretanju. Čista logika bez Electrona — test: test/ulaz-firme.test.js.
//
// Svaka firma ima svoju instancu na subdomeni portala (abc.aierp.ba). Korisnik ne mora znati adresu: upiše šifru firme, aplikacija pita
// ulaz portala (POST <portal>/api/ulaz { sifra }) i zapamti adresu instance i naziv firme. Ulaz za nepoznatu i zatvorenu firmu daje
// ISTU poruku (ne otkriva koje firme postoje) — aplikacija je samo prenese.
//
// Sigurnost:
//   - adresa iz odgovora ulaza se prihvata SAMO kao https://<subdomena>.<domen portala> (bez porta, putanje i korisnika) — ulaz (ili neko
//     ko se predstavi kao ulaz) ne može poslati aplikaciju na proizvoljan host;
//   - zahtjev ide bez kolačića (credentials: 'omit') i aplikacija s ulaza ne čuva ništa osim adrese i naziva — ulaz ne izdaje token.
// Portal: zadano https://aierp.ba; AIERP_PORTAL_URL (okruženje) ili `portal` u userData/aierp-server.json ga mijenja (druga domena, proba).

const PORTAL_ZADANO = 'https://aierp.ba';
const LOKALNI = new Set(['localhost', '127.0.0.1', '[::1]']);

const PORUKE = {
    sifra: 'Šifra firme ima 3–32 znaka: mala slova, cifre i crtica (npr. mojafirma).',
    nepoznata: 'Firma s tom šifrom nije pronađena ili trenutno nije dostupna. Provjeri šifru ili pitaj administratora svoje firme.',
    previse: 'Previše pokušaja s ovog računara. Sačekaj minutu pa pokušaj ponovo.',
    veza: 'Ulaz se ne javlja. Provjeri internet pa pokušaj ponovo.',
    odgovor: 'Ulaz je vratio neispravnu adresu firme. Pokušaj ponovo ili pitaj administratora svoje firme.',
};

/** Šifra firme kao na ulazu (registar firmi): mala slova, cifre i crtica, 3–32 znaka, bez crtice na krajevima. Vraća šifru ili null. */
function normalizujSifru(unos) {
    const x = String(unos == null ? '' : unos).trim().toLowerCase();
    return /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(x) ? x : null;
}

/** Unos izgleda kao šifra (jedna riječ bez tačke, sheme i porta), a ne kao adresa servera. */
function jeSifra(unos) {
    const x = String(unos == null ? '' : unos).trim();
    return !!x && !/[.:/\\@\s]/.test(x) && !LOKALNI.has(x.toLowerCase());
}

/**
 * Adresa portala (ulaza): AIERP_PORTAL_URL iz okruženja, pa `portal` iz konfiguracije, pa zadano https://aierp.ba.
 * Samo https (http samo localhost, za razvoj i testove); neispravna vrijednost → zadano. Vraća { url (origin), domena }.
 * domena = host portala bez „www." — instanca firme mora biti tačno jedan nivo ispod nje.
 */
function portalAdresa({ env = process.env, konfig = null } = {}) {
    for (const kandidat of [env && env.AIERP_PORTAL_URL, konfig && konfig.portal]) {
        const p = provjeriPortal(kandidat);
        if (p) return p;
    }
    return provjeriPortal(PORTAL_ZADANO);
}
function provjeriPortal(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return null;
    let u;
    try { u = new URL(t); } catch { return null; }
    if (u.username || u.password || !u.hostname) return null;
    const lokalno = LOKALNI.has(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && lokalno)) return null;
    if (!lokalno && !u.hostname.includes('.')) return null;
    return { url: u.origin, domena: u.hostname.replace(/^www\./, '') };
}

/**
 * Adresa instance iz odgovora ulaza — prihvata se samo https://<subdomena>.<domena>[/] (subdomena = jedna oznaka kao šifra,
 * bez porta, putanje, upita i korisnika). Ako odgovor nosi i `subdomena`, mora se slagati. Vraća origin ili null.
 */
function adresaInstance(odgovor, domena) {
    if (!odgovor || typeof odgovor.url !== 'string' || !domena) return null;
    let u;
    try { u = new URL(odgovor.url); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
    const host = u.hostname.toLowerCase();
    const rep = '.' + String(domena).toLowerCase();
    if (!host.endsWith(rep)) return null;
    const sub = host.slice(0, -rep.length);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(sub)) return null;   // tačno jedna DNS oznaka (bez tačke)
    if (odgovor.subdomena != null && String(odgovor.subdomena).toLowerCase() !== sub) return null;
    return `https://${host}`;
}

/** Naziv firme za prikaz: običan tekst, najviše 120 znakova (prikazuje se samo kao tekst). */
function nazivFirme(n) {
    const s = String(n == null ? '' : n).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return s ? s.slice(0, 120) : null;
}

/**
 * Šifra → instanca kroz ulaz portala. dohvati(url, init) → { ok, status, json } (main daje net.fetch; test lažni ulaz).
 * Vraća { ok: true, url, naziv, sifra, pauzirana } ili { ok: false, greska, poruka } — poruku ulaza (nepoznata/zatvorena) prenosi.
 */
async function poveziSifrom({ unos, portal, dohvati }) {
    const sifra = normalizujSifru(unos);
    if (!sifra) return { ok: false, greska: 'sifra', poruka: PORUKE.sifra };
    let r;
    try {
        r = await dohvati(portal.url + '/api/ulaz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ sifra }),
            credentials: 'omit',     // ulaz ne dijeli kolačiće s instancama; ništa s ulaza se ne čuva
            cache: 'no-store',
            redirect: 'error',       // ulaz /api/ulaz ne preusmjerava — preusmjerenje znači da to nije ulaz
        });
    } catch {
        return { ok: false, greska: 'veza', poruka: PORUKE.veza };
    }
    const j = (r && r.json) || {};
    if (r && r.status === 429) return { ok: false, greska: 'previse', poruka: PORUKE.previse };
    if (!r || !r.ok) {
        const p = typeof j.poruka === 'string' && j.poruka.trim() ? j.poruka.trim().slice(0, 300) : PORUKE.nepoznata;
        return { ok: false, greska: r && r.status === 404 ? 'nepoznata' : 'ulaz', poruka: p };
    }
    const url = adresaInstance(j, portal.domena);
    if (!url) return { ok: false, greska: 'odgovor', poruka: PORUKE.odgovor };
    return { ok: true, url, naziv: nazivFirme(j.naziv), sifra, pauzirana: j.pauzirana === true };
}

module.exports = { PORTAL_ZADANO, PORUKE, normalizujSifru, jeSifra, portalAdresa, adresaInstance, nazivFirme, poveziSifrom };
