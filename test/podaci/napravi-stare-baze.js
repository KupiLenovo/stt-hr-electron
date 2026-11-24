#!/usr/bin/env node
// Pravi test/podaci/pos-kes-*.db — baze kase kakve su na računarima prije 4.8.0-beta.2 (prelaz better-sqlite3 → node:sqlite).
// NE ide u `npm test` i ne treba se ponovo pokretati: fajlovi su commitani i to su DOKAZI, ne izlaz testa. Ostavljeno radi traga.
//
// Fajlove piše STARI kod iz gita (tag) STARIM drajverom (better-sqlite3 11.10, kao u aplikaciji do beta.1):
//   - pos-kes-4.2.0.db: šema MAL-03 (queue_racun bez MAL-04 kolona), offline red računa, uredno zatvorena aplikacija;
//   - pos-kes-4.8.0-beta.1.db + .db-wal: pun šema beta.1 (pos-kes + kasa-offline), WAL, aplikacija PALA usred rada —
//     dio reda je samo u -wal fajlu (nije prenesen u glavni fajl), kao na kasi kojoj je nestalo struje.
//
//   node test/podaci/napravi-stare-baze.js <folder node_modules s better-sqlite3@11>
//   (npr. glavni checkout prije 4.8.0-beta.2 poslije `npm ci`; Node s prebuildom za better-sqlite3 11 — Node 20/22)
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CILJ = __dirname;

function stariKod(tag, nodeModules) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stari-${tag}-`));
    fs.mkdirSync(path.join(dir, 'lib'));
    for (const f of ['lib/pos-kes.js', 'lib/kasa-offline.js']) {
        let s;
        try { s = execFileSync('git', ['show', `${tag}:${f}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { continue; }
        fs.writeFileSync(path.join(dir, f), s);
    }
    fs.symlinkSync(path.resolve(nodeModules), path.join(dir, 'node_modules'), 'dir');
    return dir;
}

// Svaka verzija u svom procesu (stari moduli drže bazu u modulu; „pad" = izlaz bez close()).
const DIJETE = {
    'v4.2.0': (dir, izlaz) => {
        const posKes = require(path.join(dir, 'lib/pos-kes.js'));
        const Database = require(path.join(dir, 'node_modules/better-sqlite3'));
        if (!posKes.init(izlaz)) throw new Error('stari pos-kes se nije otvorio');
        posKes.spremiKatalog(7, [{ id: 1, sifra: 'A1', naziv: 'Kafa', jm: 'kom', stopa: 17, cijena_fening: 250, barkodovi: ['3870001'] }]);
        posKes.dodajURed({ lokalni_uid: 'stari-420-1', skladiste_id: 7, smjena_id: 31, ukupno_fening: 250, stavke: [{ artikal_id: 1, kolicina: 1 }] });
        posKes.dodajURed({ lokalni_uid: 'stari-420-2', skladiste_id: 7, smjena_id: 31, ukupno_fening: 500, stavke: [{ artikal_id: 1, kolicina: 2 }] });
        posKes.dodajURed({ lokalni_uid: 'stari-420-poslan', skladiste_id: 7, smjena_id: 31, ukupno_fening: 250, stavke: [] });
        posKes.oznaciPoslan('stari-420-poslan', 900);
        // uredno zatvorena aplikacija: sve u glavnom fajlu (WAL prenesen i prazan)
        const d = new Database(path.join(izlaz, 'pos-kes.db'));
        d.pragma('wal_checkpoint(TRUNCATE)');
        d.close();
        fs.copyFileSync(path.join(izlaz, 'pos-kes.db'), path.join(CILJ, 'pos-kes-4.2.0.db'));
    },
    'v4.8.0-beta.1': (dir, izlaz) => {
        const posKes = require(path.join(dir, 'lib/pos-kes.js'));
        const kasaOffline = require(path.join(dir, 'lib/kasa-offline.js'));
        if (!posKes.init(izlaz)) throw new Error('stari pos-kes se nije otvorio');
        const db = posKes.baza();
        kasaOffline.init(db);
        posKes.spremiKatalog(7, [{ id: 1, sifra: 'A1', naziv: 'Kafa', jm: 'kom', stopa: 17, cijena_fening: 250, barkodovi: ['3870001'] }]);
        kasaOffline.otvoriSmjenu({ skladiste_id: 7, radnik_id: 4, pocetni_fond_fening: 10000, lokalni_uid: 'smjena-beta1' });
        // stari put (kanal NULL, stanje NULL)
        posKes.dodajURed({ lokalni_uid: 'beta1-offline', skladiste_id: 7, smjena_id: 31, ukupno_fening: 250, stavke: [{ artikal_id: 1, kolicina: 1 }] });
        // MAL-04: odštampan na uređaju, server ga još nema
        posKes.pripremiNaplatu({ lokalni_uid: 'beta1-fiskalizovan', skladiste_id: 7, smjena_id: 31, tip: 'fiskalni', iznos_fening: 500,
            placanja: [{ vrsta: 'Gotovina', iznos_fening: 500 }], payload: { lokalni_uid: 'beta1-fiskalizovan', stavke: [{ artikal_id: 1, kolicina: 2 }] } });
        posKes.oznaciSaljeUredjaju('beta1-fiskalizovan', { last_BF: 41 }, '2026-11-24 10:00:00', 1795000000000);
        posKes.upisiRezultat('beta1-fiskalizovan', { stanje: 'fiskalizovan_lokalno', fiskalni_broj: '42', fiskalni_datum: '24.11.2026',
            fiskalni_vrijeme: '10:00:05', fiskalni_potvrda: 'uredjaj', uredjaj_poslije: { last_BF: 42 }, rezultat: { raw: '<odgovor broj="42"/>' } });
        posKes.zurnalDodaj({ lokalni_uid: 'beta1-fiskalizovan', komanda: '/stampatifiskalniracun', fiskalni_broj: '42', raw: '<odgovor broj="42"/>' });
        posKes.dodajURed({ lokalni_uid: 'beta1-poslan', skladiste_id: 7, smjena_id: 31, ukupno_fening: 100, stavke: [] });
        posKes.oznaciPoslan('beta1-poslan', 901);
        // dovde je sve preneseno u glavni fajl; dalje samo u -wal (automatski prenos isključen) — pa „nestane struje"
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.pragma('wal_autocheckpoint = 0');
        posKes.dodajURed({ lokalni_uid: 'beta1-samo-wal', skladiste_id: 7, smjena_id: 31, ukupno_fening: 750, stavke: [{ artikal_id: 1, kolicina: 3 }] });
        posKes.pripremiNaplatu({ lokalni_uid: 'beta1-usred-stampe', skladiste_id: 7, smjena_id: 31, tip: 'fiskalni', iznos_fening: 300,
            placanja: [{ vrsta: 'Kartica', iznos_fening: 300 }], payload: { lokalni_uid: 'beta1-usred-stampe', stavke: [] } });
        posKes.oznaciSaljeUredjaju('beta1-usred-stampe', { last_BF: 42 }, '2026-11-24 10:05:00', 1795000300000);
        const wal = fs.readFileSync(path.join(izlaz, 'pos-kes.db-wal'));
        if (!wal.length) throw new Error('-wal je prazan — fixture ne bi dokazivao ništa');
        fs.copyFileSync(path.join(izlaz, 'pos-kes.db'), path.join(CILJ, 'pos-kes-4.8.0-beta.1.db'));
        fs.writeFileSync(path.join(CILJ, 'pos-kes-4.8.0-beta.1.db-wal'), wal);
        process.exit(0);   // pad: bez close(), bez prenosa WAL-a
    },
};

if (process.argv[2] === '--dijete') {
    DIJETE[process.argv[3]](process.argv[4], process.argv[5]);
} else {
    const nodeModules = process.argv[2];
    if (!nodeModules || !fs.existsSync(path.join(nodeModules, 'better-sqlite3'))) {
        console.error('Navedi folder node_modules s better-sqlite3@11 (npr. ../stt-hr-electron/node_modules).');
        process.exit(1);
    }
    for (const tag of Object.keys(DIJETE)) {
        const dir = stariKod(tag, nodeModules);
        const izlaz = fs.mkdtempSync(path.join(os.tmpdir(), `baza-${tag}-`));
        const r = spawnSync(process.execPath, [__filename, '--dijete', tag, dir, izlaz], { stdio: 'inherit' });
        if (r.status !== 0) { console.error(`${tag}: nije uspjelo`); process.exit(1); }
        console.log(`${tag}: napravljeno (better-sqlite3 ${require(path.resolve(nodeModules, 'better-sqlite3/package.json')).version})`);
    }
}
