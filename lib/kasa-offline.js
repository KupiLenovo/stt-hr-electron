// MAL-20 / MAL-21 — KASA BEZ INTERNETA: keš radnje po računaru, prijava PIN-om bez servera i smjena na disku kase.
// Radi nad istom pos-kes.db kao red računa (lib/pos-kes.js daje bazu kroz baza()); Electron main ga zove preko IPC-a (main.js, kasa:*).
//
// Keš po računaru (osvježava se pri svakoj online prijavi i otvaranju kase — GET /api/v1/maloprodaja/kasa-paket):
//   kes_racunar   — ključ/vrijednost: sol računara, zadnja_veza_at (zadnji uspješan paket sa servera), lokacija_id radnje, rok_sati;
//   kes_kasa      — kase radnje;
//   kes_radnik    — radnici radnje; pin_zapis = scrypt(serverski zapis za kasu, sol računara) — glavni PIN zapis servera ovdje nikad ne dolazi,
//                   a zapis sa servera se ne čuva takav kakav je stigao (kopija baze s jednog računara ne vrijedi na drugom);
//   kes_postavke  — granice popusta, vrste plaćanja, granica gotovine (JSON);
//   kes_brava     — pogrešni PIN-ovi po radniku: 5 pogrešnih → brava 15 min (zapisana ovdje, preživi restart).
// Offline prijava (odluka plana MAL-20): samo radnici radnje kase, najviše 72 h od zadnje veze računara, samo prodaja i smjena — bez storna,
// povrata, bona i nivelacije (dozvoljeno()). Keš radnika se briše na odjavu uređaja (server: 403 obrisi_kes) i promjenu radnje.
//
// Smjena bez interneta (MAL-21) — smjena_lokalna: otvaranje i zatvaranje lokalno s lokalni_uid; računi iz reda nose smjena_lokalni_uid;
// zatvaranje čuva prebrojano i snimak X/Z uređaja kad ga ima; primopredaja = zatvaranje + nova smjena preuzimaoca (isti tok, MAL-32).
// Server je prima kroz POST /api/v1/maloprodaja/smjena/sync (idempotentno po lokalni_uid); nalog smjene pravi server tek poslije synca.
'use strict';
const crypto = require('crypto');

const ROK_SATI = 72;
const BRAVA_POKUSAJA = 5;
const BRAVA_MIN = 15;
const DOZVOLE_OFFLINE = ['prodaja', 'smjena'];
// Isti parametri kao server (stt-hr-server lib/kasa-pin.js KASA_SCRYPT) — serverski zapis 'kasa1$<sol>$<scrypt(PIN, sol)>'.
const KASA_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUZINA = 32;

let db = null;
const sadaMs = (o) => (o && typeof o.sada === 'function' ? o.sada() : Date.now());
const iso = (ms) => new Date(ms).toISOString();
const promjena = (x) => (x && (x.changes ?? x.rowsAffected)) || 0;

function init(baza) {
    db = baza || null;
    if (!db) return false;
    db.exec(`
        CREATE TABLE IF NOT EXISTS kes_racunar (kljuc TEXT PRIMARY KEY, vrijednost TEXT);
        CREATE TABLE IF NOT EXISTS kes_kasa (skladiste_id INTEGER PRIMARY KEY, lokacija_id INTEGER, sifra TEXT, naziv TEXT);
        CREATE TABLE IF NOT EXISTS kes_radnik (
            radnik_id INTEGER PRIMARY KEY, lokacija_id INTEGER, ime TEXT, prezime TEXT, uloga TEXT,
            server_sol TEXT,              -- sol serverskog zapisa za kasu (javna; bez nje se PIN ne može provjeriti)
            pin_zapis TEXT,               -- scrypt(serverski hash, sol računara), base64url
            osvjezen_at TEXT
        );
        CREATE TABLE IF NOT EXISTS kes_postavke (kljuc TEXT PRIMARY KEY, vrijednost TEXT);
        CREATE TABLE IF NOT EXISTS kes_brava (radnik_id INTEGER PRIMARY KEY, pogresnih INTEGER NOT NULL DEFAULT 0, zakljucan_do TEXT);
        CREATE TABLE IF NOT EXISTS smjena_lokalna (
            lokalni_uid TEXT PRIMARY KEY,
            skladiste_id INTEGER NOT NULL,
            server_id INTEGER,            -- id smjene na serveru (smjena otvorena online pa zatvorena bez interneta, ili poslije synca)
            status TEXT NOT NULL DEFAULT 'otvorena',   -- otvorena | zatvorena
            otvorio_radnik_id INTEGER, otvoreno_at TEXT NOT NULL, pocetni_fond_fening INTEGER NOT NULL DEFAULT 0, napomena TEXT,
            zatvorio_radnik_id INTEGER, zatvoreno_at TEXT, prebrojano_fening INTEGER, napomena_zatvaranja TEXT,
            uredjaj TEXT,                 -- JSON snimak X/Z (MAL-30) kad je uređaj bio dostupan
            prethodna_uid TEXT,           -- primopredaja: smjena koju je ova preuzela
            sinhronizovana INTEGER NOT NULL DEFAULT 0,  -- 1 = server ima i zatvaranje (ili otvorenu smjenu, dok je otvorena)
            sukob INTEGER NOT NULL DEFAULT 0,
            sync_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_smjena_lokalna_otvorena ON smjena_lokalna(skladiste_id) WHERE status='otvorena';
    `);
    return true;
}

// ---- pomoćno ----
function meta(kljuc) { const r = db.prepare('SELECT vrijednost FROM kes_racunar WHERE kljuc=?').get(kljuc); return r ? r.vrijednost : null; }
function postaviMeta(kljuc, v) { db.prepare('INSERT OR REPLACE INTO kes_racunar (kljuc, vrijednost) VALUES (?,?)').run(kljuc, v == null ? null : String(v)); }
function solRacunara() {
    let s = meta('sol');
    if (!s) { s = crypto.randomBytes(16).toString('base64url'); postaviMeta('sol', s); }
    return Buffer.from(s, 'base64url');
}
const scrypt = (lozinka, sol) => crypto.scryptSync(lozinka, sol, DUZINA, KASA_SCRYPT);
/** Serverski zapis 'kasa1$sol$hash' → { sol, hash } ili null. */
function razloziServerski(z) {
    const d = String(z || '').split('$');
    if (d.length !== 3 || d[0] !== 'kasa1') return null;
    const sol = Buffer.from(d[1], 'base64url'); const hash = Buffer.from(d[2], 'base64url');
    return sol.length === 16 && hash.length === DUZINA ? { sol: d[1], hash } : null;
}
const omotaj = (hash) => scrypt(hash, solRacunara()).toString('base64url');

// ---- PAKET KASE (keš po računaru) ----
/**
 * Snimi paket sa servera (GET /kasa-paket). Druga radnja nego do sada → stari radnici i brave se brišu (PLT-13: promjena radnje).
 * Radnik bez zapisa za kasu ne ide u keš; radnik koji više nije u paketu se briše. zadnja_veza_at = sada.
 */
function spremiPaket(paket, opcije) {
    if (!db) throw new Error('kes nije inicijalizovan');
    if (!paket || !Array.isArray(paket.radnici) || !Array.isArray(paket.kase)) throw new Error('paket kase nije ispravan');
    const sada = sadaMs(opcije);
    const lok = paket.lokacija_id == null ? null : Number(paket.lokacija_id);
    const tx = db.transaction(() => {
        const bila = meta('lokacija_id');
        if (bila != null && bila !== '' && lok != null && Number(bila) !== lok) obrisiRadnikeTx();
        db.prepare('DELETE FROM kes_kasa').run();
        const insK = db.prepare('INSERT OR REPLACE INTO kes_kasa (skladiste_id, lokacija_id, sifra, naziv) VALUES (?,?,?,?)');
        for (const k of paket.kase) insK.run(Number(k.id), lok, k.sifra ?? null, k.naziv ?? '');
        const ids = [];
        const insR = db.prepare(`INSERT OR REPLACE INTO kes_radnik (radnik_id, lokacija_id, ime, prezime, uloga, server_sol, pin_zapis, osvjezen_at) VALUES (?,?,?,?,?,?,?,?)`);
        for (const r of paket.radnici) {
            const z = razloziServerski(r.offline_pin_hash);
            if (!z || !Number(r.id)) continue;
            insR.run(Number(r.id), lok, r.ime ?? '', r.prezime ?? null, r.uloga ?? 'radnik', z.sol, omotaj(z.hash), iso(sada));
            ids.push(Number(r.id));
        }
        if (ids.length) db.prepare(`DELETE FROM kes_radnik WHERE radnik_id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
        else db.prepare('DELETE FROM kes_radnik').run();
        const postavke = { granice_popusta: paket.granice_popusta ?? null, vrste_placanja: paket.vrste_placanja ?? null,
            granica_gotovine_firma_fening: paket.granica_gotovine_firma_fening ?? null, dozvole_offline: paket.dozvole_offline ?? DOZVOLE_OFFLINE };
        const insP = db.prepare('INSERT OR REPLACE INTO kes_postavke (kljuc, vrijednost) VALUES (?,?)');
        for (const [k, v] of Object.entries(postavke)) insP.run(k, JSON.stringify(v));
        postaviMeta('lokacija_id', lok == null ? '' : lok);
        postaviMeta('rok_sati', Number(paket.rok_offline_sati) > 0 ? Math.min(ROK_SATI, Number(paket.rok_offline_sati)) : ROK_SATI);
        postaviMeta('zadnja_veza_at', iso(sada));
    });
    tx();
    return { radnika: db.prepare('SELECT COUNT(*) c FROM kes_radnik').get().c, kasa: paket.kase.length, zadnja_veza_at: iso(sada) };
}
/** Svaki uspješan razgovor sa serverom pomjera „zadnju vezu" (rok 72 h teče od nje). */
function zabiljeziVezu(opcije) { if (db) postaviMeta('zadnja_veza_at', iso(sadaMs(opcije))); }
function obrisiRadnikeTx() { db.prepare('DELETE FROM kes_radnik').run(); db.prepare('DELETE FROM kes_brava').run(); }
/** Odjava uređaja (server 403 obrisi_kes) ili promjena radnje: radnici i brave nestaju, kasa bez interneta se ne može otvoriti. */
function obrisiRadnike() { if (!db) return { obrisano: 0 }; const n = db.prepare('SELECT COUNT(*) c FROM kes_radnik').get().c; db.transaction(obrisiRadnikeTx)(); return { obrisano: n }; }

function rokSati() { const v = Number(meta('rok_sati')); return v > 0 ? Math.min(ROK_SATI, v) : ROK_SATI; }
/** Stanje keša za ekran (traka „Bez interneta od …", prijava). */
function stanje(opcije) {
    if (!db) return { spreman: false };
    const zadnja = meta('zadnja_veza_at');
    const sada = sadaMs(opcije);
    const rokDo = zadnja ? Date.parse(zadnja) + rokSati() * 3600 * 1000 : null;
    return { spreman: true, zadnja_veza_at: zadnja, rok_do: rokDo ? iso(rokDo) : null, istekao: !rokDo || sada > rokDo,
        lokacija_id: meta('lokacija_id') ? Number(meta('lokacija_id')) : null,
        radnika: db.prepare('SELECT COUNT(*) c FROM kes_radnik').get().c, kasa: db.prepare('SELECT COUNT(*) c FROM kes_kasa').get().c };
}
function kase() { return db ? db.prepare('SELECT skladiste_id AS id, sifra, naziv, lokacija_id FROM kes_kasa ORDER BY naziv').all() : []; }
/** Radnici koji se mogu prijaviti na ovoj kasi bez interneta (samo radnja te kase; bez ikakvih zapisa PIN-a). */
function radnici(skladisteId) {
    if (!db) return [];
    const k = db.prepare('SELECT lokacija_id FROM kes_kasa WHERE skladiste_id=?').get(Number(skladisteId));
    if (!k) return [];
    return db.prepare('SELECT radnik_id AS id, ime, prezime, uloga FROM kes_radnik WHERE lokacija_id IS ? ORDER BY prezime, ime').all(k.lokacija_id);
}
function postavke() {
    if (!db) return {};
    const out = {};
    for (const r of db.prepare('SELECT kljuc, vrijednost FROM kes_postavke').all()) { try { out[r.kljuc] = JSON.parse(r.vrijednost); } catch { out[r.kljuc] = null; } }
    return out;
}

// ---- OFFLINE PRIJAVA ----
/**
 * Prijava PIN-om bez servera. { ok:true, radnik, dozvole, vazi_do } ili { ok:false, error, poruka }:
 *   kasa_nije_u_kesu · radnik_druge_radnje · offline_istekao (više od 72 h od zadnje veze) · zakljucan (5 pogrešnih → 15 min) · pogresan_pin.
 * Brava se upisuje u pos-kes.db (preživi restart aplikacije).
 */
function prijava({ skladiste_id, radnik_id, pin } = {}, opcije) {
    if (!db) return { ok: false, error: 'kes_nije_spreman', poruka: 'Kasa nema lokalni keš — prvi put se prijavi s internetom.' };
    const sada = sadaMs(opcije);
    const kasa = db.prepare('SELECT skladiste_id, lokacija_id FROM kes_kasa WHERE skladiste_id=?').get(Number(skladiste_id));
    if (!kasa) return { ok: false, error: 'kasa_nije_u_kesu', poruka: 'Ova kasa nije u lokalnom kešu računara — prijava bez interneta nije moguća.' };
    const r = db.prepare('SELECT * FROM kes_radnik WHERE radnik_id=?').get(Number(radnik_id));
    if (!r || r.lokacija_id !== kasa.lokacija_id) return { ok: false, error: 'radnik_druge_radnje', poruka: 'Bez interneta se na kasu prijavljuju samo radnici ove radnje.' };
    const zadnja = meta('zadnja_veza_at');
    const rokDo = zadnja ? Date.parse(zadnja) + rokSati() * 3600 * 1000 : 0;
    if (!zadnja || sada > rokDo) {
        return { ok: false, error: 'offline_istekao', poruka: `Računar nije bio na internetu više od ${rokSati()} h — prijava bez interneta je isključena. Spoji računar na internet i prijavi se.` };
    }
    const b = db.prepare('SELECT pogresnih, zakljucan_do FROM kes_brava WHERE radnik_id=?').get(r.radnik_id);
    if (b && b.zakljucan_do && Date.parse(b.zakljucan_do) > sada) {
        return { ok: false, error: 'zakljucan', zakljucan_do: b.zakljucan_do, poruka: `Previše pogrešnih PIN-ova — prijava je zaključana do ${new Date(Date.parse(b.zakljucan_do)).toLocaleTimeString('bs-BA', { hour: '2-digit', minute: '2-digit' })}.` };
    }
    const p = String(pin ?? '');
    let tacan = false;
    if (/^\d{4}$/.test(p) && r.pin_zapis && r.server_sol) {
        const h = scrypt(scrypt(p, Buffer.from(r.server_sol, 'base64url')), solRacunara());
        const z = Buffer.from(r.pin_zapis, 'base64url');
        tacan = z.length === h.length && crypto.timingSafeEqual(h, z);
    }
    if (!tacan) {
        const pogresnih = ((b && b.pogresnih) || 0) + 1;   // poslije brave brojač kreće od nule
        const zakljucaj = pogresnih >= BRAVA_POKUSAJA;
        db.prepare('INSERT OR REPLACE INTO kes_brava (radnik_id, pogresnih, zakljucan_do) VALUES (?,?,?)')
            .run(r.radnik_id, zakljucaj ? 0 : pogresnih, zakljucaj ? iso(sada + BRAVA_MIN * 60 * 1000) : (b ? b.zakljucan_do : null));
        if (zakljucaj) return { ok: false, error: 'zakljucan', zakljucan_do: iso(sada + BRAVA_MIN * 60 * 1000), poruka: `${BRAVA_POKUSAJA} pogrešnih PIN-ova — prijava je zaključana ${BRAVA_MIN} minuta.` };
        return { ok: false, error: 'pogresan_pin', preostalo: BRAVA_POKUSAJA - pogresnih, poruka: 'Pogrešan PIN.' };
    }
    db.prepare('DELETE FROM kes_brava WHERE radnik_id=?').run(r.radnik_id);
    return { ok: true, offline: true, radnik: { id: r.radnik_id, ime: r.ime, prezime: r.prezime, uloga: r.uloga, lokacija_id: r.lokacija_id },
        skladiste_id: kasa.skladiste_id, dozvole: [...DOZVOLE_OFFLINE], vazi_do: iso(rokDo) };
}
/** Šta offline sesija smije: samo prodaja i smjena (bez storna, povrata, bona i nivelacije). */
function dozvoljeno(sesija, akcija) {
    if (!sesija) return true;   // online — pravila servera
    return DOZVOLE_OFFLINE.includes(akcija);
}

// ---- OFFLINE SESIJA I TIHA OBNOVA PRIJAVE ----
// Offline sesija živi SAMO u memoriji main procesa (PIN nikad na disk): kad se veza vrati, main jednom pošalje PIN na /api/auth/pin u ime
// radnika (kolačić prijave servera se postavi u sesiju prozora), pa kasa šalje smjenu i red bez nove prijave. Ako server odbije (drugi faktor,
// uređaj nije povezan, PIN promijenjen u međuvremenu) — radnik se prijavi ručno; red i smjena čekaju na disku.
function napraviSesiju(prijavaOk, pin, opcije) {
    return { radnik_id: prijavaOk.radnik.id, skladiste_id: prijavaOk.skladiste_id, od: iso(sadaMs(opcije)), vazi_do: prijavaOk.vazi_do, pin: Buffer.from(String(pin), 'utf8') };
}
function ocistiSesiju(sesija) { if (sesija && Buffer.isBuffer(sesija.pin)) sesija.pin.fill(0); return null; }
/** POST /api/auth/pin u ime radnika offline sesije. dohvati(url, init) → { ok, status, json }. */
async function obnoviPrijavu({ server, sesija, dohvati }) {
    if (!sesija || !server || typeof dohvati !== 'function') return { ok: false, error: 'nema_sesije' };
    let r;
    try {
        r = await dohvati(`${server}/api/auth/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ radnik_id: sesija.radnik_id, pin: sesija.pin.toString('utf8') }) });
    } catch { return { ok: false, error: 'bez_veze' }; }
    if (!r) return { ok: false, error: 'bez_veze' };
    const j = r.json || {};
    if (r.ok && j.ok && !j.privremeni) return { ok: true, radnik: j.radnik || null };
    return { ok: false, error: j.error || `http_${r.status}`, poruka: j.poruka || 'Server nije prihvatio prijavu — prijavi se ponovo PIN-om.', status: r.status };
}

// ---- SMJENA BEZ INTERNETA (MAL-21) ----
const noviUid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
function aktivnaSmjena(skladisteId) {
    if (!db) return null;
    return db.prepare("SELECT * FROM smjena_lokalna WHERE skladiste_id=? AND status='otvorena'").get(Number(skladisteId)) || null;
}
/** Otvori smjenu lokalno. Jedna otvorena po kasi na ovom računaru. */
function otvoriSmjenu({ skladiste_id, radnik_id, pocetni_fond_fening = 0, napomena = null, lokalni_uid = null, prethodna_uid = null } = {}, opcije) {
    if (!db) throw new Error('kes nije inicijalizovan');
    if (!Number(skladiste_id)) return { ok: false, error: 'kasa_obavezna' };
    if (aktivnaSmjena(skladiste_id)) return { ok: false, error: 'smjena_vec_otvorena', poruka: 'Na ovoj kasi je već otvorena smjena.' };
    const fond = Math.round(Number(pocetni_fond_fening));
    if (!Number.isFinite(fond) || fond < 0) return { ok: false, error: 'polog_neispravan', poruka: 'Polog ne može biti negativan.' };
    const uid = lokalni_uid || noviUid();
    db.prepare(`INSERT INTO smjena_lokalna (lokalni_uid, skladiste_id, status, otvorio_radnik_id, otvoreno_at, pocetni_fond_fening, napomena, prethodna_uid)
                VALUES (?,?, 'otvorena', ?,?,?,?,?)`).run(uid, Number(skladiste_id), Number(radnik_id) || null, lokalnoVrijeme(sadaMs(opcije)), fond, napomena, prethodna_uid);
    return { ok: true, smjena: db.prepare('SELECT * FROM smjena_lokalna WHERE lokalni_uid=?').get(uid) };
}
/**
 * Zatvori smjenu lokalno (prebrojano, napomena, snimak uređaja ako ga ima). Smjena otvorena ONLINE (nema je lokalno) zatvara se uz server_id —
 * tada se pravi lokalni zapis s tim id-em, pa je sync zatvara na serveru (POST /smjena/sync sa smjena_id).
 */
function zatvoriSmjenu({ lokalni_uid = null, server_id = null, skladiste_id = null, radnik_id = null, prebrojano_fening = null, napomena = null, uredjaj = null,
    otvoreno_at = null, otvorio_radnik_id = null, pocetni_fond_fening = 0 } = {}, opcije) {
    if (!db) throw new Error('kes nije inicijalizovan');
    let sm = lokalni_uid ? db.prepare('SELECT * FROM smjena_lokalna WHERE lokalni_uid=?').get(lokalni_uid)
        : server_id ? db.prepare('SELECT * FROM smjena_lokalna WHERE server_id=?').get(Number(server_id)) : null;
    if (!sm && server_id && Number(skladiste_id)) {
        const uid = noviUid();
        db.prepare(`INSERT INTO smjena_lokalna (lokalni_uid, skladiste_id, server_id, status, otvorio_radnik_id, otvoreno_at, pocetni_fond_fening, sinhronizovana)
                    VALUES (?,?,?, 'otvorena', ?,?,?, 0)`).run(uid, Number(skladiste_id), Number(server_id), Number(otvorio_radnik_id) || null,
            otvoreno_at || lokalnoVrijeme(sadaMs(opcije)), Math.max(0, Math.round(Number(pocetni_fond_fening) || 0)));
        sm = db.prepare('SELECT * FROM smjena_lokalna WHERE lokalni_uid=?').get(uid);
    }
    if (!sm) return { ok: false, error: 'smjena_ne_postoji', poruka: 'Ta smjena nije otvorena na ovoj kasi.' };
    if (sm.status !== 'otvorena') return { ok: true, smjena: sm, vec: true };
    const preb = prebrojano_fening == null || prebrojano_fening === '' ? null : Math.round(Number(prebrojano_fening));
    db.prepare(`UPDATE smjena_lokalna SET status='zatvorena', zatvorio_radnik_id=?, zatvoreno_at=?, prebrojano_fening=?, napomena_zatvaranja=?, uredjaj=?,
                    sinhronizovana=0 WHERE lokalni_uid=?`)
        .run(Number(radnik_id) || null, lokalnoVrijeme(sadaMs(opcije)), Number.isFinite(preb) ? preb : null, napomena || null,
            uredjaj ? JSON.stringify(uredjaj) : null, sm.lokalni_uid);
    return { ok: true, smjena: db.prepare('SELECT * FROM smjena_lokalna WHERE lokalni_uid=?').get(sm.lokalni_uid) };
}
/** Primopredaja bez interneta (MAL-32): zatvori smjenu predavaoca i otvori smjenu preuzimaoca — jedna radnja (transakcija). */
function primopredaja({ lokalni_uid, predaje_radnik_id, preuzima_radnik_id, prebrojano_fening, napomena = null, pocetni_fond_fening = null } = {}, opcije) {
    if (!db) throw new Error('kes nije inicijalizovan');
    const sm = db.prepare("SELECT * FROM smjena_lokalna WHERE lokalni_uid=? AND status='otvorena'").get(lokalni_uid);
    if (!sm) return { ok: false, error: 'smjena_ne_postoji', poruka: 'Smjena za primopredaju nije otvorena na ovoj kasi.' };
    if (!Number(preuzima_radnik_id) || Number(preuzima_radnik_id) === Number(predaje_radnik_id)) return { ok: false, error: 'preuzimalac_obavezan', poruka: 'Izaberi radnika koji preuzima smjenu.' };
    let out = null;
    db.transaction(() => {
        const z = zatvoriSmjenu({ lokalni_uid, radnik_id: predaje_radnik_id, prebrojano_fening, napomena: napomena || 'Primopredaja bez interneta' }, opcije);
        const fond = pocetni_fond_fening == null ? (z.smjena.prebrojano_fening ?? sm.pocetni_fond_fening) : pocetni_fond_fening;
        const o = otvoriSmjenu({ skladiste_id: sm.skladiste_id, radnik_id: preuzima_radnik_id, pocetni_fond_fening: fond, prethodna_uid: lokalni_uid,
            napomena: 'Preuzeto primopredajom bez interneta' }, opcije);
        if (!o.ok) throw Object.assign(new Error(o.poruka || o.error), { kod: o });
        out = { ok: true, zatvorena: z.smjena, nova: o.smjena };
    })();
    return out;
}
/** Smjene koje server još nema (ili nema njihovo zatvaranje), najstarije prve — sync ih šalje redom (primopredaja: prvo predata). */
function nesinhronizovaneSmjene() {
    if (!db) return [];
    return db.prepare('SELECT * FROM smjena_lokalna WHERE sinhronizovana=0 ORDER BY otvoreno_at, rowid').all()
        .map((s) => ({ ...s, uredjaj: s.uredjaj ? JSON.parse(s.uredjaj) : null }));
}
/** Tijelo za POST /api/v1/maloprodaja/smjena/sync (računi iz reda dodaje renderer — on ih šalje i označava poslanim). */
function tijeloSynca(s) {
    return {
        lokalni_uid: s.lokalni_uid, ...(s.server_id ? { smjena_id: s.server_id } : {}), skladiste_id: s.skladiste_id,
        otvoreno_at: s.otvoreno_at, otvorio_korisnik_id: s.otvorio_radnik_id, pocetni_fond_fening: s.pocetni_fond_fening, napomena: s.napomena || undefined,
        ...(s.status === 'zatvorena' ? { zatvaranje: { zatvoreno_at: s.zatvoreno_at, zatvorio_korisnik_id: s.zatvorio_radnik_id, prebrojano_fening: s.prebrojano_fening,
            napomena: s.napomena_zatvaranja || undefined, ...(s.uredjaj ? { uredjaj: typeof s.uredjaj === 'string' ? JSON.parse(s.uredjaj) : s.uredjaj } : {}) } } : {}),
    };
}
/** Odgovor servera upisan: server_id, sukob; zatvorena smjena je time gotova, otvorena ostaje otvorena (dalje je vodi server). */
function oznaciSmjenu(lokalniUid, { server_id = null, sukob = false } = {}, opcije) {
    if (!db) return { ok: false };
    const sm = db.prepare('SELECT status FROM smjena_lokalna WHERE lokalni_uid=?').get(lokalniUid);
    if (!sm) return { ok: false };
    const r = db.prepare('UPDATE smjena_lokalna SET server_id=COALESCE(?, server_id), sukob=?, sinhronizovana=?, sync_at=? WHERE lokalni_uid=?')
        .run(server_id == null ? null : Number(server_id), sukob ? 1 : 0, sm.status === 'zatvorena' ? 1 : 0, iso(sadaMs(opcije)), lokalniUid);
    return { ok: promjena(r) > 0 };
}
/** Otvorena smjena koja je stigla na server i dalje radi online — lokalni zapis se zatvara bez slanja (server je vodi). */
function predajServeru(lokalniUid) {
    if (!db) return { ok: false };
    const r = db.prepare("UPDATE smjena_lokalna SET status='zatvorena', sinhronizovana=1, napomena_zatvaranja=COALESCE(napomena_zatvaranja,'preuzeta online') WHERE lokalni_uid=? AND server_id IS NOT NULL").run(lokalniUid);
    return { ok: promjena(r) > 0 };
}
// „GGGG-MM-DD HH:MM:SS" po satu računara (server ga čita kao lokalno vrijeme firme, kao i fiskalni datum uređaja)
function lokalnoVrijeme(ms) {
    const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = {
    ROK_SATI, BRAVA_POKUSAJA, BRAVA_MIN, DOZVOLE_OFFLINE, KASA_SCRYPT,
    init, spremiPaket, zabiljeziVezu, obrisiRadnike, stanje, kase, radnici, postavke,
    prijava, dozvoljeno, napraviSesiju, ocistiSesiju, obnoviPrijavu,
    aktivnaSmjena, otvoriSmjenu, zatvoriSmjenu, primopredaja, nesinhronizovaneSmjene, tijeloSynca, oznaciSmjenu, predajServeru,
};
