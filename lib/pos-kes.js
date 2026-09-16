// C-POS skelet Faza 2 — LOKALNI KEŠ + OFFLINE QUEUE (Electron main, better-sqlite3).
// Cilj: POS radi bez interneta — keš artikala/cijena (čita offline) + red računa (sync kad se vrati net).
// better-sqlite3 v11 = N-API (ABI-stabilan) → prebuilt binar radi na Electronu BEZ VS build tools.
//   Instalacija: npm i better-sqlite3 --ignore-scripts && npx electron-builder install-app-deps
// Renderer (pos.tsx) vozi sync (ima JWT token + api()); main samo drži lokalnu bazu preko IPC-a.
const path = require('path');

let Database = null;
try { Database = require('better-sqlite3'); } catch { Database = null; }
let db = null;

// MAL-03: DatabaseCtor je opcioni (test ubrizga node:sqlite adapter kad better-sqlite3 nema prebuild — npr. lokalni Node 24).
// Produkcija (main.js) zove init(userData) → koristi better-sqlite3 kao i do sada.
function init(userDataPath, DatabaseCtor) {
    const Ctor = DatabaseCtor || Database;
    if (!Ctor || db) return !!db;
    db = new Ctor(path.join(userDataPath, 'pos-kes.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS kes_artikal (
            skladiste_id  INTEGER NOT NULL,
            artikal_id    INTEGER NOT NULL,
            sifra TEXT, naziv TEXT, jm TEXT,
            stopa INTEGER, cijena_fening INTEGER,
            barkodovi TEXT,                          -- JSON niz
            PRIMARY KEY (skladiste_id, artikal_id)
        );
        CREATE TABLE IF NOT EXISTS kes_meta (
            skladiste_id INTEGER PRIMARY KEY,
            synced_at TEXT
        );
        CREATE TABLE IF NOT EXISTS queue_racun (
            lokalni_uid TEXT PRIMARY KEY,            -- idempotentni ključ (isti kao server lokalni_uid)
            skladiste_id INTEGER, smjena_id INTEGER,
            payload TEXT NOT NULL,                   -- JSON cijelog body-ja za POST /racuni(/sync)
            poslan INTEGER NOT NULL DEFAULT 0,
            server_id INTEGER,
            pokusaja INTEGER NOT NULL DEFAULT 0,
            kreiran_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
    `);
    return true;
}
const spreman = () => !!db;

// ---- KEŠ KATALOGA ----
function spremiKatalog(skladisteId, artikli) {
    if (!db) throw new Error('kes nije inicijalizovan');
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM kes_artikal WHERE skladiste_id=?').run(skladisteId);
        const ins = db.prepare('INSERT OR REPLACE INTO kes_artikal (skladiste_id, artikal_id, sifra, naziv, jm, stopa, cijena_fening, barkodovi) VALUES (?,?,?,?,?,?,?,?)');
        for (const a of artikli || []) ins.run(skladisteId, a.id, a.sifra ?? null, a.naziv ?? '', a.jm ?? null, Number(a.stopa) || 0, a.cijena_fening == null ? null : Number(a.cijena_fening), JSON.stringify(a.barkodovi || []));
        db.prepare("INSERT OR REPLACE INTO kes_meta (skladiste_id, synced_at) VALUES (?, datetime('now','localtime'))").run(skladisteId);
    });
    tx();
    return { spremljeno: (artikli || []).length };
}
function citajKatalog(skladisteId) {
    if (!db) return { skladiste_id: skladisteId, artikli: [], synced_at: null };
    const meta = db.prepare('SELECT synced_at FROM kes_meta WHERE skladiste_id=?').get(skladisteId);
    const artikli = db.prepare('SELECT artikal_id AS id, sifra, naziv, jm, stopa, cijena_fening, barkodovi FROM kes_artikal WHERE skladiste_id=? ORDER BY naziv COLLATE NOCASE').all(skladisteId);
    for (const a of artikli) a.barkodovi = JSON.parse(a.barkodovi || '[]');
    return { skladiste_id: skladisteId, artikli, synced_at: meta ? meta.synced_at : null };
}

// ---- OFFLINE QUEUE RAČUNA ----
function nesinhronizovaniBroj() { return db ? db.prepare('SELECT COUNT(*) c FROM queue_racun WHERE poslan=0').get().c : 0; }
function dodajURed(racun) {
    if (!db) throw new Error('kes nije inicijalizovan');
    db.prepare('INSERT OR IGNORE INTO queue_racun (lokalni_uid, skladiste_id, smjena_id, payload) VALUES (?,?,?,?)')
        .run(racun.lokalni_uid, racun.skladiste_id || null, racun.smjena_id || null, JSON.stringify(racun));
    return { pending: nesinhronizovaniBroj() };
}
function nesinhronizovani() {
    if (!db) return { racuni: [] };
    return { racuni: db.prepare('SELECT payload FROM queue_racun WHERE poslan=0 ORDER BY kreiran_at').all().map((r) => JSON.parse(r.payload)) };
}
function oznaciPoslan(lokalniUid, serverId) {
    if (!db) return { pending: 0 };
    db.prepare('UPDATE queue_racun SET poslan=1, server_id=? WHERE lokalni_uid=?').run(serverId || null, lokalniUid);
    return { pending: nesinhronizovaniBroj() };
}

module.exports = { init, spreman, spremiKatalog, citajKatalog, dodajURed, nesinhronizovani, nesinhronizovaniBroj, oznaciPoslan };
