// Baza kase (pos-kes.db) nad UGRAĐENIM `node:sqlite` (Electron 45 nosi Node 24 + SQLite 3.54; test: Node 22+) — 4.8.0-beta.2.
// Do 4.8.0-beta.1 je ovo radio better-sqlite3 (nativni modul): za Electron ≥ 43 nema prebuilda, pa je otpao zajedno s asarUnpack-om.
// Fajl je isti SQLite fajl (isti format, ista WAL) — red računa sa starije verzije ostaje čitljiv (test/pos-kes-stara-baza.test.js).
//
// Tanak omotač s API-jem better-sqlite3 koji koriste lib/pos-kes.js, lib/kasa-offline.js i lib/dimni-test.js:
//   new BazaSqlite(fajl) · pragma() · exec() · prepare() → { run, get, all } · transaction(fn) · close()
// Ponašanje je namjerno ISTO kao better-sqlite3 (provjereno uporedo nad istim upitima):
//   - run() vraća { changes, lastInsertRowid } (brojevi);
//   - get() bez reda vraća undefined; redovi su obični objekti (node:sqlite daje objekte bez prototipa → kopija);
//   - JS broj se veže kao REAL (i better-sqlite3 tako radi: '-' || 90 || ' days' = '-90.0 days'), BigInt kao INTEGER;
//   - cijeli brojevi se čitaju kao Number (readBigInts isključen, kao defaultSafeIntegers u better-sqlite3); broj veći od
//     2^53 node:sqlite odbije greškom umjesto da tiho izgubi tačnost — u bazi kase takvih nema (id, feninzi, Date.now());
//   - čekanje na zaključanu bazu 5 s (better-sqlite3 zadano `timeout: 5000`; node:sqlite zadano 0);
//   - transaction(fn): BEGIN … COMMIT, greška → ROLLBACK i ponovo baci; ugniježđen poziv ide kroz SAVEPOINT (kao better-sqlite3);
//   - pragma('x = y') vraća redove kao better-sqlite3 (npr. [{ journal_mode: 'wal' }]), { simple: true } → prva vrijednost.
// Samo main proces (preload je u sandboxu i ne smije ovo učitati).
'use strict';

const { DatabaseSync } = require('node:sqlite');

const CEKANJE_MS = 5000;

const obicanRed = (r) => (r === undefined ? undefined : Object.assign({}, r));

class Izjava {
    constructor(izjava) { this._s = izjava; }
    run(...parametri) {
        const r = this._s.run(...parametri);
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    }
    get(...parametri) { return obicanRed(this._s.get(...parametri)); }
    all(...parametri) { return this._s.all(...parametri).map(obicanRed); }
}

class BazaSqlite {
    constructor(fajl) {
        this._db = new DatabaseSync(String(fajl), { timeout: CEKANJE_MS });
        this._dubina = 0;   // ugniježđene transakcije (rezerva ako runtime nema isTransaction)
    }
    get open() { return this._db.isOpen !== false; }
    get inTransaction() { return typeof this._db.isTransaction === 'boolean' ? this._db.isTransaction : this._dubina > 0; }
    pragma(izraz, opcije) {
        const redovi = this._db.prepare('PRAGMA ' + izraz).all().map(obicanRed);
        if (opcije && opcije.simple) { const prvi = redovi[0]; return prvi ? prvi[Object.keys(prvi)[0]] : undefined; }
        return redovi;
    }
    exec(sql) { this._db.exec(sql); return this; }
    prepare(sql) { return new Izjava(this._db.prepare(sql)); }
    transaction(fn) {
        const baza = this;
        return function transakcija(...args) {
            const db = baza._db;
            const ugnijezdena = baza.inTransaction;
            const tacka = ugnijezdena ? `tx_${baza._dubina}` : null;
            db.exec(ugnijezdena ? `SAVEPOINT ${tacka}` : 'BEGIN');
            baza._dubina++;
            try {
                const r = fn.apply(this, args);
                db.exec(ugnijezdena ? `RELEASE ${tacka}` : 'COMMIT');
                return r;
            } catch (e) {
                // SQLite neke greške (npr. pun disk) sam vrati — tad ROLLBACK nema šta vratiti i ne smije sakriti pravu grešku
                if (db.isTransaction !== false) {
                    try { db.exec(ugnijezdena ? `ROLLBACK TO ${tacka}; RELEASE ${tacka}` : 'ROLLBACK'); } catch { /* već vraćeno */ }
                }
                throw e;
            } finally {
                baza._dubina--;
            }
        };
    }
    close() { if (this._db.isOpen !== false) this._db.close(); return this; }
}

module.exports = { BazaSqlite };
