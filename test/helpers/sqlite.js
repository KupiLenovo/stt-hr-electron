// MAL-03 test helper: daje better-sqlite3-kompatibilan Database konstruktor.
//   • CI (Node 20): better-sqlite3 (prod dep, prebuild) — testira PRAVI drajver koji ide u aplikaciju.
//   • lokalno (Node 22+ bez prebuilda, npr. Node 24): tanak adapter nad ugrađenim node:sqlite.
// Adapter pokriva SAMO API koji lib/pos-kes.js koristi: pragma(), exec(), prepare()->{run,get,all}, transaction().
'use strict';

function napraviDriver() {
    try {
        return require('better-sqlite3');   // CI + produkcija (Electron)
    } catch { /* nema prebuilda za ovaj Node → node:sqlite (Node 22+) */ }

    const { DatabaseSync } = require('node:sqlite');   // baca na Node < 22 → CI onda MORA imati better-sqlite3
    class Stmt {
        constructor(s) { this._s = s; }
        run(...a) { return this._s.run(...a); }
        get(...a) { return this._s.get(...a); }
        all(...a) { return this._s.all(...a); }
    }
    return class Adapter {
        constructor(filename) { this._db = new DatabaseSync(String(filename)); }
        pragma(p) { this._db.exec('PRAGMA ' + p + ';'); }
        exec(sql) { this._db.exec(sql); }
        prepare(sql) { return new Stmt(this._db.prepare(sql)); }
        transaction(fn) {
            const db = this._db;
            return (...args) => {
                db.exec('BEGIN');
                try { const r = fn(...args); db.exec('COMMIT'); return r; }
                catch (e) { db.exec('ROLLBACK'); throw e; }
            };
        }
        close() { try { this._db.close(); } catch { /* ignore */ } }
    };
}

module.exports = { napraviDriver };
