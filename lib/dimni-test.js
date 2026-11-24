// Dimni test spakovane aplikacije (PLT-22): `aiERP.exe --smoke` (ili `electron . --smoke`) se pokrene na PRAZNOM privremenom profilu,
// otvori glavni prozor (ekran povezivanja — bez mreže i bez servera firme), provjeri da su tu stvari koje padnu tek u spakovanoj
// aplikaciji, i ugasi se: izlaz 0 = sve u redu, 1 = nešto ne radi, 2 = istekao rok.
//
// Šta se provjerava (svaka stavka je jedna linija u ispisu):
//   - glavni prozor se učitao i prikazao, s lokalnog ekrana (file://) i s naslovom proizvoda;
//   - ugrađeni node:sqlite (lib/sqlite.js; do 4.8.0-beta.1 nativni better-sqlite3) radi u Electronu i lokalna baza kase radi (upis + čitanje);
//   - preload u sandboxu je kroz contextBridge izložio sve mostove (electronAPI, fiskalniDrajver, posOffline, aierpPostavke).
// Pravi profil kase se NE dira (main.js prije svega postavi userData na privremeni folder); ažuriranje se ne provjerava.
// Bez Electrona — test/dimni.test.js.
'use strict';

const ROK_MS = 60000;
const MOSTOVI = Object.freeze(['electronAPI', 'fiskalniDrajver', 'posOffline', 'aierpPostavke']);
// Izraz koji se izvrši u prozoru (renderer) — samo tipovi, bez podataka
const IZRAZ_MOSTOVA = `(${JSON.stringify(MOSTOVI)}).reduce((o, k) => (o[k] = typeof window[k], o), {})`;

/**
 * @param {object} s stanje prikupljeno u main procesu
 * @returns {{ ok: boolean, redovi: string[] }}
 */
function ocijeni(s = {}) {
    const redovi = [];
    let ok = true;
    const stavka = (uslov, opis, detalj = '') => {
        if (!uslov) ok = false;
        redovi.push(`${uslov ? 'OK ' : 'NE '} ${opis}${detalj ? ` — ${detalj}` : ''}`);
    };
    stavka(s.ucitan === true, 'glavni prozor se učitao', s.greskaUcitavanja || '');
    stavka(s.vidljiv === true, 'glavni prozor je prikazan');
    stavka(typeof s.url === 'string' && s.url.startsWith('file:'), 'lokalni ekran (bez mreže)', s.url || 'nema adrese');
    stavka(typeof s.naslov === 'string' && s.naslov.startsWith(s.nazivProizvoda || 'Vault aiERP'), 'naslov proizvoda', s.naslov || '');
    stavka(s.kesSpreman === true, 'node:sqlite: lokalna baza kase otvorena', s.greskaKesa || '');
    stavka(s.kesUpis === true, 'lokalna baza kase: upis i čitanje', s.greskaUpisa || '');
    const m = s.mostovi || {};
    for (const ime of MOSTOVI) stavka(m[ime] === 'object', `most ${ime} (contextBridge)`, m[ime] ? `typeof = ${m[ime]}` : 'nije provjereno');
    redovi.unshift(`${ok ? 'DIMNI TEST OK' : 'DIMNI TEST PAO'} — verzija ${s.verzija || '?'}, Electron ${s.electron || '?'}, ${s.spakovana ? 'spakovana aplikacija' : 'iz koda'}`);
    return { ok, redovi };
}

/** Provjera da lokalna baza kase stvarno piše (privremena tabela, ostaje samo u privremenom profilu). */
function provjeriUpis(baza) {
    if (!baza) return { ok: false, greska: 'baza nije otvorena' };
    try {
        baza.exec('CREATE TABLE IF NOT EXISTS dimni_test (id INTEGER PRIMARY KEY, t TEXT)');
        baza.prepare('INSERT INTO dimni_test (t) VALUES (?)').run('dim');
        const r = baza.prepare('SELECT t FROM dimni_test ORDER BY id DESC LIMIT 1').get();
        return r && r.t === 'dim' ? { ok: true } : { ok: false, greska: 'pročitano nije isto upisanom' };
    } catch (e) { return { ok: false, greska: e.message }; }
}

module.exports = { ocijeni, provjeriUpis, ROK_MS, MOSTOVI, IZRAZ_MOSTOVA };
