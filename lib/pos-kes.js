// C-POS — LOKALNI KEŠ + RED RAČUNA na disku kase (Electron main, better-sqlite3; test: node:sqlite adapter).
// Cilj (MAL-04): prodaja se upiše na disk PRIJE nego uređaj išta odštampa, pa je ne izbriše ni pad aplikacije ni nestanak struje.
// Renderer (pos.tsx) vozi sync (ima JWT + api()); main drži lokalnu bazu preko IPC-a i vodi fiskalni tok kroz fiskalni-most.js.
//
// queue_racun je jedan red po računu (idempotentno po lokalni_uid) i nosi:
//   - offline red (MAL-01/faza 2): payload servera + poslan/server_id (sync kad se vrati net);
//   - fiskalni tok (MAL-04): stanje `priprema → salje_uredjaju → fiskalizovan_lokalno | nepoznato | greska → poslan`,
//     fiskalni broj, snimke brojača uređaja (prije/poslije) i broj pokušaja.
// zurnal_fiskalni: raw odgovori uređaja zadnjih 90 dana (poređenje s uređajem / periodičnim izvještajem).
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
            kreiran_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            -- MAL-04: fiskalni tok
            stanje TEXT,                             -- priprema|salje_uredjaju|fiskalizovan_lokalno|nepoznato|greska|poslan (null = stari offline red)
            kanal TEXT,                              -- 'mp' = prodaja (rezultat ide kroz POST /racuni/sync); 'fiskalizovano' = rezultat ide kroz /racuni/:id/fiskalizovano (VP, storno, „Fiskalizuj sve") → van POS sync-a
            tip TEXT,                                -- fiskalni|reklamirani
            iznos_fening INTEGER,
            placanja TEXT,                           -- JSON [{vrsta, iznos_fening, oznaka_uredjaja?}]
            original_broj TEXT,                      -- reklamirani: broj originalnog fiskalnog računa
            fiskalni_broj TEXT,
            fiskalni_datum TEXT, fiskalni_vrijeme TEXT, qr_kod TEXT,
            fiskalni_greska TEXT, fiskalni_potvrda TEXT,   -- uredjaj|brojac (potvrda broja)
            uredjaj_prije TEXT, uredjaj_poslije TEXT,       -- JSON snimci brojača (OsnovneInformacije)
            rezultat TEXT,                           -- JSON sirovog odgovora drajvera (raw_odgovor)
            pokusaj_at TEXT, pokusaj_ms INTEGER,     -- vrijeme slanja uređaju (za pravilo oporavka)
            azuriran_at TEXT
        );
        CREATE TABLE IF NOT EXISTS zurnal_fiskalni (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lokalni_uid TEXT,
            komanda TEXT,                            -- endpoint (npr. /stampatifiskalniracun) ili 'duplikat'/'periodicni'
            fiskalni_broj TEXT,
            raw TEXT,                                -- sirovi odgovor uređaja
            kreiran_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
    `);
    // Stara pos-kes.db (4.3.0 MAL-03) ima queue_racun bez MAL-04 kolona → dodaj ih (bez migracionog motora; lokalni fajl kase).
    uskladiKolone('queue_racun', {
        stanje: 'TEXT', kanal: 'TEXT', tip: 'TEXT', iznos_fening: 'INTEGER', placanja: 'TEXT', original_broj: 'TEXT',
        fiskalni_broj: 'TEXT', fiskalni_datum: 'TEXT', fiskalni_vrijeme: 'TEXT', qr_kod: 'TEXT',
        fiskalni_greska: 'TEXT', fiskalni_potvrda: 'TEXT', uredjaj_prije: 'TEXT', uredjaj_poslije: 'TEXT',
        rezultat: 'TEXT', pokusaj_at: 'TEXT', pokusaj_ms: 'INTEGER', azuriran_at: 'TEXT',
    });
    return true;
}
const spreman = () => !!db;

// Dodaj kolone koje nedostaju (idempotentno). pragma_table_info radi i u better-sqlite3 i u node:sqlite.
function uskladiKolone(tabela, kolone) {
    let postoje;
    try { postoje = new Set(db.prepare(`SELECT name FROM pragma_table_info('${tabela}')`).all().map((r) => r.name)); }
    catch { return; }
    for (const [ime, tip] of Object.entries(kolone)) {
        if (!postoje.has(ime)) { try { db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${ime} ${tip}`); } catch { /* trka pri paralelnom initu */ } }
    }
}

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

// ---- OFFLINE QUEUE RAČUNA (stari put + izvor za sync) ----
function nesinhronizovaniBroj() { return db ? db.prepare('SELECT COUNT(*) c FROM queue_racun WHERE poslan=0').get().c : 0; }
function dodajURed(racun) {
    if (!db) throw new Error('kes nije inicijalizovan');
    db.prepare('INSERT OR IGNORE INTO queue_racun (lokalni_uid, skladiste_id, smjena_id, payload) VALUES (?,?,?,?)')
        .run(racun.lokalni_uid, racun.skladiste_id || null, racun.smjena_id || null, JSON.stringify(racun));
    return { pending: nesinhronizovaniBroj() };
}
// Serveru ide payload računa + (MAL-04) fiskalni rezultat iz reda — odštampan račun iz reda nikad ne ode kao nefiskalizovan.
function fiskalniIzReda(r) {
    if (!r.stanje || !['fiskalizovan_lokalno', 'nepoznato', 'greska'].includes(r.stanje)) return {};
    let raw = null;
    try { const rz = r.rezultat ? JSON.parse(r.rezultat) : null; raw = rz && rz.raw ? rz.raw : null; } catch { raw = null; }
    return {
        fiskalni_status: r.stanje === 'fiskalizovan_lokalno' ? 'fiskalizovan' : r.stanje,
        fiskalni_drajver: 'tring',
        fiskalni_broj: r.fiskalni_broj || null,
        fiskalni_datum: r.fiskalni_datum || null,
        fiskalni_vrijeme: r.fiskalni_vrijeme || null,
        qr_kod: r.qr_kod || null,
        raw_odgovor: raw,
        fiskalni_greska: r.fiskalni_greska || null,
        fiskalni_potvrda: r.fiskalni_potvrda || null,
        uredjaj_prije: r.uredjaj_prije ? safeParse(r.uredjaj_prije) : null,
        fiskalni_pokusaj_at: r.pokusaj_at || null,
    };
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function nesinhronizovani() {
    if (!db) return { racuni: [] };
    // Samo redovi čiji rezultat ide kroz POST /racuni/sync: prodaja ('mp') i stari offline red (kanal NULL). Redovi 'fiskalizovano'
    // (VP, storno, „Fiskalizuj sve") server dobija kroz /racuni/:id/fiskalizovano — nikad kroz sync (inače bi napravio lažan pos_racun).
    const redovi = db.prepare("SELECT * FROM queue_racun WHERE poslan=0 AND (kanal IS NULL OR kanal='mp') ORDER BY kreiran_at, rowid").all();
    return { racuni: redovi.map((r) => ({ ...JSON.parse(r.payload), ...fiskalniIzReda(r) })) };
}
function oznaciPoslan(lokalniUid, serverId) {
    if (!db) return { pending: 0 };
    db.prepare("UPDATE queue_racun SET poslan=1, server_id=?, stanje=CASE WHEN stanje IS NULL THEN NULL ELSE 'poslan' END, azuriran_at=datetime('now','localtime') WHERE lokalni_uid=?").run(serverId || null, lokalniUid);
    return { pending: nesinhronizovaniBroj() };
}

// ---- FISKALNI TOK (MAL-04): pisanje na disk PRIJE štampe ----
function redRacuna(lokalniUid) {
    if (!db) return null;
    return db.prepare('SELECT * FROM queue_racun WHERE lokalni_uid=?').get(lokalniUid) || null;
}
// 1. priprema — račun na disku PRIJE ijednog poziva uređaju (idempotentno; ne dira već poslan red).
function pripremiNaplatu(r) {
    if (!db) throw new Error('kes nije inicijalizovan');
    const payload = JSON.stringify(r.payload || r);
    db.prepare('INSERT OR IGNORE INTO queue_racun (lokalni_uid, skladiste_id, smjena_id, payload, stanje, kanal) VALUES (?,?,?,?,\'priprema\',?)')
        .run(r.lokalni_uid, r.skladiste_id || null, r.smjena_id || null, payload, r.kanal || 'mp');
    db.prepare(`UPDATE queue_racun SET stanje='priprema', kanal=COALESCE(?, kanal), tip=?, iznos_fening=?, placanja=?, original_broj=?, payload=?,
                    skladiste_id=COALESCE(?, skladiste_id), smjena_id=COALESCE(?, smjena_id), azuriran_at=datetime('now','localtime')
                WHERE lokalni_uid=? AND poslan=0`)
        .run(r.kanal || 'mp', r.tip || 'fiskalni', r.iznos_fening == null ? null : Math.round(r.iznos_fening), JSON.stringify(r.placanja || []),
             r.original_broj == null ? null : String(r.original_broj), payload, r.skladiste_id || null, r.smjena_id || null, r.lokalni_uid);
    return { stanje: 'priprema' };
}
// 2. salje_uredjaju — snimak brojača prije slanja + vrijeme pokušaja (za pravilo oporavka), broj pokušaja +1.
function oznaciSaljeUredjaju(lokalniUid, uredjajPrije, pokusajAt, pokusajMs) {
    if (!db) return;
    db.prepare(`UPDATE queue_racun SET stanje='salje_uredjaju', uredjaj_prije=?, pokusaj_at=?, pokusaj_ms=?,
                    pokusaja=pokusaja+1, azuriran_at=datetime('now','localtime') WHERE lokalni_uid=? AND poslan=0`)
        .run(uredjajPrije ? JSON.stringify(uredjajPrije) : null, pokusajAt || null, pokusajMs == null ? null : Math.round(pokusajMs), lokalniUid);
}
// 3. rezultat — TEK poslije odgovora uređaja (ili istek/prekid → nepoznato). Idempotentno po lokalni_uid.
function upisiRezultat(lokalniUid, r) {
    if (!db) return;
    db.prepare(`UPDATE queue_racun SET stanje=?, fiskalni_broj=?, fiskalni_datum=?, fiskalni_vrijeme=?, qr_kod=?,
                    fiskalni_greska=?, fiskalni_potvrda=?, uredjaj_poslije=?, rezultat=?, azuriran_at=datetime('now','localtime')
                WHERE lokalni_uid=? AND poslan=0`)
        .run(r.stanje, r.fiskalni_broj || null, r.fiskalni_datum || null, r.fiskalni_vrijeme || null, r.qr_kod || null,
             r.fiskalni_greska || null, r.fiskalni_potvrda || null,
             r.uredjaj_poslije ? JSON.stringify(r.uredjaj_poslije) : null,
             r.rezultat != null ? (typeof r.rezultat === 'string' ? r.rezultat : JSON.stringify(r.rezultat)) : null,
             lokalniUid);
}
// Redovi koje treba razriješiti pri pokretanju: poslani uređaju bez potvrde (salje_uredjaju = pad usred štampe; nepoznato = istek/prekid).
function redoviZaOporavak() {
    if (!db) return [];
    return db.prepare("SELECT * FROM queue_racun WHERE poslan=0 AND stanje IN ('salje_uredjaju','nepoznato') ORDER BY pokusaj_ms, rowid").all();
}
// Konačna odluka oporavka upisana u red (BEZ nove štampe).
function razrijesiRed(lokalniUid, r) { upisiRezultat(lokalniUid, r); }
// Prored završenih redova (poslan / fiskalizovan_lokalno / greska) starijih od N dana — dedup ih više ne treba, a baza ne raste.
// NIKAD ne dira nerazriješene (priprema / salje_uredjaju / nepoznato).
function redProred(dana = 90) {
    if (!db) return { obrisano: 0 };
    const r = db.prepare(`DELETE FROM queue_racun WHERE (poslan=1 OR stanje IN ('fiskalizovan_lokalno','greska'))
                          AND kreiran_at < datetime('now','localtime','-' || ? || ' days')`).run(Math.round(dana));
    return { obrisano: (r && (r.changes ?? r.rowsAffected)) || 0 };
}

// ---- LOKALNI ŽURNAL (raw odgovori, 90 dana) ----
function zurnalDodaj(z) {
    if (!db) return;
    db.prepare('INSERT INTO zurnal_fiskalni (lokalni_uid, komanda, fiskalni_broj, raw) VALUES (?,?,?,?)')
        .run(z.lokalni_uid || null, z.komanda || null, z.fiskalni_broj || null, z.raw == null ? null : String(z.raw));
}
function zurnalProred(dana = 90) {
    if (!db) return { obrisano: 0 };
    const r = db.prepare(`DELETE FROM zurnal_fiskalni WHERE kreiran_at < datetime('now','localtime','-' || ? || ' days')`).run(Math.round(dana));
    return { obrisano: (r && (r.changes ?? r.rowsAffected)) || 0 };
}
function zurnalBroj() { return db ? db.prepare('SELECT COUNT(*) c FROM zurnal_fiskalni').get().c : 0; }

module.exports = {
    init, spreman,
    spremiKatalog, citajKatalog,
    dodajURed, nesinhronizovani, nesinhronizovaniBroj, oznaciPoslan,
    redRacuna, pripremiNaplatu, oznaciSaljeUredjaju, upisiRezultat, redoviZaOporavak, razrijesiRed, redProred,
    zurnalDodaj, zurnalProred, zurnalBroj,
};
