// MAL-03 — RUČNI test na Tring EMULATORU (razvojni računar, Eldin). NE pokreće se u CI-ju.
// Prolazi puni ciklus: fiskalni račun → reklamirani (povrat) → X (presjek) → Z (dnevni) → unos → povrat novca,
// SVE na 127.0.0.1:8085. 🚨 SIGURNOSNA BRANA: prvo pročita IBFM uređaja i STAJE PRIJE prve komande ako IBFM
// nije na listi emulatora (FISKALNI_EMULATOR_IBFM). Time se garantuje da se stvarni fiskalni uređaj NIKAD ne dira.
//
//   Pokretanje (samo na računaru gdje radi Tring Emulator):
//     FISKALNI_EMULATOR_IBFM="AL901930" npm run test:emulator
//   (Više IBFM-a razdvoji zarezom/razmakom. Bez liste — skripta odmah staje, ništa ne štampa.)
'use strict';
const { napraviDrajver } = require('../fiskalni-drajver');

// Ista pravila kao ibfmNaListi u client-v2/src/lib/fiskalni-oporavak.js (G155): normalizuj (bez razmaka, velika slova).
const normIbfm = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
function ibfmNaListi(ibfm, lista) {
    const x = normIbfm(ibfm);
    if (!x) return false;
    const l = Array.isArray(lista) ? lista : String(lista || '').split(/[,;\s]+/);
    return l.map(normIbfm).filter(Boolean).includes(x);
}

function stani(poruka, kod = 2) { console.error('⛔ ' + poruka); process.exit(kod); }

async function korak(naziv, fn) {
    process.stdout.write(`→ ${naziv} … `);
    const r = await fn();
    if (r && r.veza_pukla) stani(`veza s TFS-om pukla (${r.greska && r.greska.poruka}). Prekid — provjeri emulator.`, 3);
    if (!r || !r.uspjeh) { console.log('GREŠKA'); console.log('   ', JSON.stringify(r && r.greska)); }
    else console.log('OK', r.fiskalni_broj != null ? `(broj ${r.fiskalni_broj})` : '');
    return r;
}

async function main() {
    const lista = process.env.FISKALNI_EMULATOR_IBFM || '';
    const drajver = napraviDrajver('tring');

    // 1) BRANA: pročitaj IBFM PRIJE ijedne komande štampe.
    const info = await drajver.osnovneInformacije();
    if (!info || info.veza_pukla || !info.uspjeh) {
        stani(`Ne mogu pročitati OsnovneInformacije s 127.0.0.1:8085 (${info && info.greska && info.greska.poruka || 'nema odgovora'}). ` +
              'Pokreni Tring Emulator pa probaj ponovo. Nijedna komanda nije poslana.', 3);
    }
    const ibfm = info.odgovori && info.odgovori.ibfm;
    if (!ibfmNaListi(ibfm, lista)) {
        stani(`IBFM uređaja „${ibfm || '?'}" NIJE na listi emulatora (FISKALNI_EMULATOR_IBFM="${lista}"). ` +
              'STOP prije prve komande — ovo možda nije emulator nego pravi fiskalni uređaj.', 2);
    }
    console.log(`✔ IBFM ${ibfm} je na listi emulatora — nastavljam ciklus.\n`);

    // 2) Puni ciklus na emulatoru.
    const racun = { stavke: [{ naziv: 'TEST kafa', cijena_fening: 250, stopa_oznaka: 'E', kolicina_mili: 1000 }], placanja: [{ vrsta: 'Gotovina', iznos_fening: 250 }] };
    const fisk = await korak('fiskalni račun', () => drajver.fiskalizuj(racun));
    const original = fisk && fisk.fiskalni_broj;
    if (original != null) await korak('reklamirani (povrat)', () => drajver.reklamiraj(racun, original));
    await korak('presjek stanja (X)', () => drajver.presjekStanja());
    await korak('dnevni izvještaj (Z)', () => drajver.dnevniIzvjestaj());
    await korak('unos novca', () => drajver.unosNovca('Gotovina', 10000));
    await korak('povrat novca', () => drajver.povratNovca('Gotovina', 5000));
    console.log('\n✔ Ciklus na emulatoru gotov.');
}

if (require.main === module) {
    main().catch((e) => stani('Neočekivana greška: ' + (e && e.message), 1));
}

module.exports = { ibfmNaListi };
