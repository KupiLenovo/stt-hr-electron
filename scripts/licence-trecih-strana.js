#!/usr/bin/env node
// Fajl licenci trećih strana u instalaciji (PLT-22): LICENCE-TRECIH-STRANA.txt ide pored exe-a (package.json build.extraFiles).
// Sadrži svaki PRODUKCIJSKI npm paket koji ulazi u aplikaciju (package-lock.json bez dev paketa) s verzijom, licencom i tekstom
// licence iz node_modules. Electron i Chromium donose svoje: electron-builder stavlja LICENSE.electron.txt i LICENSES.chromium.html
// u isti folder.
//
//   node scripts/licence-trecih-strana.js            :: napiši fajl (poslije `npm ci`, kad se promijene zavisnosti)
//   node scripts/licence-trecih-strana.js --provjeri :: build.yml: fajl mora biti isti kao iz trenutnog package-lock.json
//
// Fajl je u repou (commitan), da build ne zavisi od mreže; test/licence.test.js drži da spisak odgovara package-lock.json.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FAJL = path.join(ROOT, 'LICENCE-TRECIH-STRANA.txt');
const POCETAK_SPISKA = 'SPISAK PAKETA';
const POCETAK_TEKSTOVA = 'TEKSTOVI LICENCI';

/** Produkcijski paketi iz package-lock.json (v2/v3): [{ ime, verzija, licenca, putanja }], sortirano, bez ponavljanja. */
function paketiIzLocka(lock) {
    const vidjeno = new Map();
    for (const [kljuc, p] of Object.entries((lock && lock.packages) || {})) {
        if (!kljuc || p.dev || p.link) continue;
        const ime = p.name || kljuc.slice(kljuc.lastIndexOf('node_modules/') + 'node_modules/'.length);
        const id = `${ime}@${p.version}`;
        if (!vidjeno.has(id)) vidjeno.set(id, { ime, verzija: p.version, licenca: p.license || 'nepoznata', putanja: kljuc, opcioni: !!p.optional });
    }
    return [...vidjeno.values()].sort((a, b) => (a.ime === b.ime ? a.verzija.localeCompare(b.verzija, 'en') : a.ime.localeCompare(b.ime, 'en')));
}

const red = (p) => `  ${p.ime} ${p.verzija} — ${p.licenca}`;

/** Tekst licence iz instaliranog paketa (null = paket nije instaliran, '' = paket nema fajl licence). */
function tekstLicence(putanja, root = ROOT) {
    const dir = path.join(root, putanja);
    let fajlovi;
    try { fajlovi = fs.readdirSync(dir); } catch { return null; }
    const lic = fajlovi.filter((f) => /^(licen[cs]e|copying)(\b|[.-])/i.test(f)).sort();
    return lic.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n?/g, '\n').trim()).join('\n\n');
}

function sastavi(paketi, citaj = tekstLicence) {
    const linija = '='.repeat(78);
    const dijelovi = [
        'Vault aiERP — licence komponenti trećih strana',
        linija,
        'Aplikacija sadrži komponente otvorenog koda navedene ispod, svaku pod njenom licencom.',
        'Electron i Chromium: LICENSE.electron.txt i LICENSES.chromium.html u istom folderu.',
        'Fajl pravi scripts/licence-trecih-strana.js iz package-lock.json i node_modules — ne mijenjati ručno.',
        '',
        `${POCETAK_SPISKA} (${paketi.length})`,
        ...paketi.map(red),
        '',
        POCETAK_TEKSTOVA,
    ];
    const nema = [];
    for (const p of paketi) {
        const t = citaj(p.putanja);
        if (t == null && !p.opcioni) nema.push(`${p.ime}@${p.verzija}`);
        dijelovi.push('', linija, `${p.ime} ${p.verzija} (${p.licenca})`, linija,
            t ? t : t === '' ? `Paket nema fajl licence; licenca prema package.json: ${p.licenca}.` : `Paket nije instaliran na ovoj platformi; licenca: ${p.licenca}.`);
    }
    return { tekst: dijelovi.join('\n') + '\n', nema };
}

/** Spisak paketa iz postojećeg fajla (između naslova spiska i tekstova) — za test bez node_modules. */
function spisakIzFajla(tekst) {
    const i = tekst.indexOf(POCETAK_SPISKA);
    const j = tekst.indexOf(POCETAK_TEKSTOVA);
    if (i < 0 || j < 0) return [];
    return tekst.slice(i, j).split('\n').slice(1).filter((r) => r.startsWith('  '));
}

function main() {
    const provjeri = process.argv.includes('--provjeri');
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const { tekst, nema } = sastavi(paketiIzLocka(lock));
    if (nema.length) {
        console.error(`Nisu instalirani (pokreni npm ci): ${nema.join(', ')}`);
        process.exit(1);
    }
    if (provjeri) {
        const sada = fs.existsSync(FAJL) ? fs.readFileSync(FAJL, 'utf8').replace(/\r\n?/g, '\n') : '';
        if (sada !== tekst) {
            console.error('LICENCE-TRECIH-STRANA.txt nije usklađen s package-lock.json — pokreni `npm run licence` i commituj fajl.');
            process.exit(1);
        }
        console.log('LICENCE-TRECIH-STRANA.txt je usklađen.');
        return;
    }
    fs.writeFileSync(FAJL, tekst);
    console.log(`Napisan ${path.relative(ROOT, FAJL)} (${paketiIzLocka(lock).length} paketa).`);
}

if (require.main === module) main();

module.exports = { paketiIzLocka, sastavi, spisakIzFajla, tekstLicence, red, FAJL };
