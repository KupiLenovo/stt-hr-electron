'use strict';
// F8 (R63/R65) + odluka Eldina 05.11.2026 (9): PAUZIRANA FIRMA NA DESKTOPU. Čista logika bez Electrona — test: test/pauza-firme.test.js.
//
// Kako server javlja pauzu (stt-hr-server, platforma/moduli.js + platforma/ulaz.js):
//   • instanca firme: operater platforme postavi fajl PAUZA pored baze firme; dok on postoji, svaki UPIS na /api (osim prijave i izvoza)
//     vraća 423 { error: 'firma_pauzirana', razlog, od, poruka } — čitanje i izvoz rade („samo čitanje");
//   • GET /api/v1/meni (prijavljen korisnik) nosi `pauza: { razlog, od }` dok je firma pauzirana, inače polja nema;
//   • ulaz portala POST /api/ulaz { sifra } za pauziranu firmu daje istu adresu instance uz `pauzirana: true`.
//   • /api/ping (javni) pauzu danas NE javlja — ako je server doda kao `pauzirana: true|false`, desktop je čita prvu (najjeftinije).
//
// Desktop (main.js): stanje pauze se pamti u userData/aierp-server.json (`pauza`), pa ga kasa zna i bez interneta i poslije restarta.
// Dok je firma pauzirana: NOVA prodaja se ne prima (račun u offline red, naplata na uređaju bez računa sa servera, nova smjena), a pregled
// radi kao i prije. Red računa se NE dira: već odštampani računi ostaju na disku kase i šalju se serveru kad pauza prestane (server do
// tada upis odbija s 423, a kasa ih zato ne označava kao poslane). Server je jedini sudac: račun koji je server upisao (ima racun_id)
// znači da firma nije pauzirana — njegova štampa se ne blokira, a stanje se odmah provjerava ponovo.

const PORUKE = {
    naslov: 'Firma je pauzirana',
    prodaja: 'Firma je privremeno pauzirana — nova prodaja na ovoj kasi nije moguća. Pregled podataka radi, a već odštampani računi '
        + 'ostaju sačuvani na ovom računaru i šalju se serveru kad pauza prestane.',
    smjena: 'Firma je privremeno pauzirana — nova smjena se ne otvara. Zatvaranje smjene i pregled podataka rade.',
    kontakt: 'Za ponovno uključenje administrator firme se javlja podršci Vault aiERP-a.',
    nastavak: 'Firma ponovo radi — prodaja na kasi je opet moguća.',
};
const KOD = 'firma_pauzirana';

const tekst = (v, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null);

/** Nalaz jedne provjere: { pauzirana: true|false, od, razlog } ili null (izvor ništa ne zna). */
function nalaz(pauzirana, o) {
    return { pauzirana: !!pauzirana, od: pauzirana ? tekst(o && o.od, 40) : null, razlog: pauzirana ? tekst(o && o.razlog) : null };
}

/** /api/ping — samo ako server izričito javlja `pauzirana` (boolean); današnji server ga ne šalje → null. */
function izPinga(j) {
    if (!j || typeof j !== 'object' || j.ok !== true || typeof j.pauzirana !== 'boolean') return null;
    return nalaz(j.pauzirana, j.pauza);
}
/** /api/v1/meni (prijavljen korisnik): 200 s menijem → pauza postoji ili ne; sve drugo (401, mreža, nešto treće) → null. */
function izMenija(r) {
    if (!r || !r.ok || !r.json || typeof r.json !== 'object' || !Array.isArray(r.json.moduli)) return null;
    const p = r.json.pauza;
    return nalaz(!!(p && typeof p === 'object'), p);
}
/** Ulaz portala: važi samo ako ulaz za tu šifru daje ISTU instancu na kojoj je ovaj računar (inače o njoj ništa ne govori). */
function izUlaza(r, server) {
    if (!r || !r.ok || !r.json || typeof r.json.url !== 'string' || !server) return null;
    let a; let b;
    try { a = new URL(r.json.url).origin; b = new URL(server).origin; } catch { return null; }
    return a === b ? nalaz(r.json.pauzirana === true, null) : null;
}

/**
 * Provjera pauze redom: ping (javno) → meni (kolačić prijave) → ulaz portala (šifra firme). Prvi izvor koji zna — odlučuje.
 * dohvati(url, init) → { ok, status, json } (main: net.fetch). Vraća nalaz s `izvor` ili { pauzirana: null } kad niko ne zna.
 */
async function provjeri({ server, sifra = null, portal = null, dohvati }) {
    if (!server || typeof dohvati !== 'function') return { pauzirana: null, izvor: null };
    const pokusaj = async (fn) => { try { return await fn(); } catch { return null; } };
    const ping = await pokusaj(async () => izPinga((await dohvati(server + '/api/ping', { cache: 'no-store' })).json));
    if (ping) return { ...ping, izvor: 'ping' };
    const meni = await pokusaj(async () => izMenija(await dohvati(server + '/api/v1/meni', { credentials: 'include', cache: 'no-store' })));
    if (meni) return { ...meni, izvor: 'meni' };
    if (sifra && portal && portal.url) {
        const ulaz = await pokusaj(async () => izUlaza(await dohvati(portal.url + '/api/ulaz', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ sifra }),
            credentials: 'omit', cache: 'no-store', redirect: 'error',
        }), server));
        if (ulaz) return { ...ulaz, izvor: 'ulaz' };
    }
    return { pauzirana: null, izvor: null };
}

const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };
/**
 * Zapamćeno stanje iz konfiguracije za server na kojem je računar: { od, razlog, provjereno, izvor, server } ili null (firma radi).
 * Pauza važi samo za instancu za koju je zapisana (druga firma / STT_SERVER_URL u razvoju je ne naslijede).
 */
function iz(konfig, server) {
    const p = konfig && konfig.pauza;
    if (!p || typeof p !== 'object' || !server) return null;
    if (p.server && p.server !== origin(server)) return null;
    return { od: tekst(p.od, 40), razlog: tekst(p.razlog), provjereno: tekst(p.provjereno, 40), izvor: tekst(p.izvor, 20), server: origin(server) };
}
/** Novo stanje poslije nalaza: true → pauza (od/razlog), false → null, nepoznato → staro ostaje (bez interneta se pauza ne gubi). */
function sljedece(staro, n, { server = null, sadaMs = Date.now() } = {}) {
    if (!n || n.pauzirana == null) return staro || null;
    if (!n.pauzirana) return null;
    return { od: n.od || (staro && staro.od) || null, razlog: n.razlog || (staro && staro.razlog) || null,
        provjereno: new Date(sadaMs).toISOString(), izvor: n.izvor || null, server: origin(server) || (staro && staro.server) || null };
}

/** Jedna rečenica za čovjeka (dijalog, offline ekran). */
function poruka(stanje, vrsta = 'prodaja') {
    if (!stanje) return null;
    const od = stanje.od ? ` (od ${stanje.od})` : '';
    const razlog = stanje.razlog ? ` Razlog: ${stanje.razlog.replace(/[.\s]+$/, '')}.` : '';
    const osnova = (PORUKE[vrsta] || PORUKE.prodaja).replace('pauzirana', `pauzirana${od}`);
    return `${osnova}${razlog} ${PORUKE.kontakt}`;
}

/**
 * Smije li NOVA naplata na uređaj (fiskalni:naplati)? null = smije; inače odgovor mosta (bez upisa na disk i bez poziva uređaju).
 * Ne blokira: firmu koja nije pauzirana; račun koji je server upisao (racun_id — server je sudac); račun koji je već fiskalizovan
 * na ovoj kasi (most ga vraća kao „vec", ništa se ne štampa).
 */
function blokadaNaplate(stanje, posiljka, redNaDisku = null) {
    if (!stanje) return null;
    if (posiljka && posiljka.racun_id != null && posiljka.racun_id !== '') return null;
    if (redNaDisku && redNaDisku.fiskalni_broj) return null;
    const p = poruka(stanje, 'prodaja');
    return { uspjeh: false, ishod: 'blokirano', status: 'blokirano', lokalni_uid: (posiljka && posiljka.lokalni_uid) || null,
        greska: { kod: KOD, poruka: p }, poruka: p };
}
/** Novi račun u offline red (dodajURed) — null = smije; račun koji je već u redu (ponovljen poziv) se ne blokira. */
function blokadaReda(stanje, vecURedu) {
    if (!stanje || vecURedu) return null;
    const p = poruka(stanje, 'prodaja');
    return { ok: false, error: KOD, greska: p, poruka: p };
}
/** Nova smjena (otvaranje, primopredaja) — null = smije. */
function blokadaSmjene(stanje) {
    if (!stanje) return null;
    const p = poruka(stanje, 'smjena');
    return { ok: false, error: KOD, greska: p, poruka: p };
}
/** Stari put drajvera (fiskalizuj/reklamiraj bez računa sa servera) — oblik odgovora drajvera. */
function blokadaDrajvera(stanje) {
    if (!stanje) return null;
    return { uspjeh: false, status: 'greska', greska: { kod: KOD, poruka: poruka(stanje, 'prodaja') } };
}

/** Prigušivanje obavijesti: najviše jedna u `razmakMs` (kasirka koja ponavlja naplatu ne dobija dijalog za dijalogom). */
function trebaObavijest(zadnjaMs, sadaMs = Date.now(), razmakMs = 60000) {
    return !zadnjaMs || sadaMs - zadnjaMs >= razmakMs;
}

module.exports = {
    PORUKE, KOD, izPinga, izMenija, izUlaza, provjeri, iz, sljedece, poruka,
    blokadaNaplate, blokadaReda, blokadaSmjene, blokadaDrajvera, trebaObavijest,
};
