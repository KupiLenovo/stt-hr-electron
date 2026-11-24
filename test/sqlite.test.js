// 4.8.0-beta.2 — lib/sqlite.js: omotač nad node:sqlite mora se ponašati kao better-sqlite3 (koji je do beta.1 bio baza kase) u svemu
// što lib/pos-kes.js, lib/kasa-offline.js i lib/dimni-test.js koriste. Očekivanja ispod su vrijednosti koje je davao better-sqlite3 11.10.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BazaSqlite } = require('../lib/sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-omotac-'));
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });
let n = 0;
const nova = () => new BazaSqlite(path.join(dir, `b${++n}.db`));

test('SQL.1 run() → { changes, lastInsertRowid }; get() bez reda → undefined; redovi su obični objekti', () => {
    const db = nova();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT)');
    assert.deepEqual(db.prepare('INSERT INTO t (a) VALUES (?)').run('x'), { changes: 1, lastInsertRowid: 1 });
    assert.deepEqual(db.prepare('INSERT INTO t (a) VALUES (?)').run('y'), { changes: 1, lastInsertRowid: 2 });
    assert.equal(db.prepare('UPDATE t SET a=? WHERE id>0').run('z').changes, 2);
    assert.equal(db.prepare('DELETE FROM t WHERE id=99').run().changes, 0);
    assert.equal(db.prepare('SELECT * FROM t WHERE id=99').get(), undefined);
    const red = db.prepare('SELECT * FROM t WHERE id=1').get();
    assert.equal(Object.getPrototypeOf(red), Object.prototype, 'kao better-sqlite3 (node:sqlite sam daje objekat bez prototipa)');
    assert.deepEqual(red, { id: 1, a: 'z' });
    assert.ok(db.prepare('SELECT * FROM t').all().every((r) => Object.getPrototypeOf(r) === Object.prototype));
    db.close();
});

test('SQL.2 vezanje parametara isto kao better-sqlite3: broj → REAL, BigInt → INTEGER, null; čitanje cijelih brojeva kao Number', () => {
    const db = nova();
    assert.deepEqual(db.prepare("SELECT typeof(?) t, '-' || ? || ' days' s").get(5, 90), { t: 'real', s: '-90.0 days' });
    assert.equal(db.prepare('SELECT typeof(?) t').get(5n).t, 'integer');
    db.exec('CREATE TABLE b (i INTEGER, x TEXT, n)');
    db.prepare('INSERT INTO b VALUES (?,?,?)').run(1795000300000, 5, null);
    assert.deepEqual(db.prepare('SELECT i, typeof(i) ti, x, n FROM b').get(), { i: 1795000300000, ti: 'integer', x: '5.0', n: null });
    db.close();
});

test('SQL.3 pragma: journal_mode WAL (fajl), rezultat kao better-sqlite3, { simple: true }', () => {
    const db = nova();
    assert.deepEqual(db.pragma('journal_mode = WAL'), [{ journal_mode: 'wal' }]);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.deepEqual(db.pragma('user_version = 3'), []);
    assert.equal(db.pragma('user_version', { simple: true }), 3);
    db.close();
});

test('SQL.4 transaction: commit, rollback na grešku (greška se ponovo baci), argumenti i povratna vrijednost', () => {
    const db = nova();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT NOT NULL)');
    const ubaci = db.transaction((...redovi) => { for (const r of redovi) db.prepare('INSERT INTO t (a) VALUES (?)').run(r); return redovi.length; });
    assert.equal(ubaci('a', 'b'), 2);
    assert.equal(db.inTransaction, false);
    assert.throws(() => ubaci('c', null), /NOT NULL/);
    assert.equal(db.inTransaction, false);
    assert.deepEqual(db.prepare('SELECT a FROM t ORDER BY id').all().map((r) => r.a), ['a', 'b'], 'c je vraćen zajedno s greškom');
    db.close();
});

test('SQL.5 ugniježđena transakcija ide kroz SAVEPOINT: unutrašnja greška vrati samo unutrašnji dio (kao better-sqlite3)', () => {
    const db = nova();
    db.exec('CREATE TABLE t (a TEXT NOT NULL)');
    const unutra = db.transaction((v) => { db.prepare('INSERT INTO t VALUES (?)').run('u'); if (v == null) throw new Error('unutra'); });
    const vani = db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (?)').run('v1');
        unutra(1);
        try { unutra(null); } catch { /* uhvaćeno vani */ }
        db.prepare('INSERT INTO t VALUES (?)').run('v2');
    });
    vani();
    assert.deepEqual(db.prepare('SELECT a FROM t ORDER BY rowid').all().map((r) => r.a), ['v1', 'u', 'v2']);
    assert.equal(db.inTransaction, false);
    db.close();
});

test('SQL.6 isti fajl iz druge konekcije (kao nova instanca aplikacije); close je ponovljiv', () => {
    const f = path.join(dir, 'dijeljena.db');
    const a = new BazaSqlite(f);
    a.pragma('journal_mode = WAL');
    a.exec('CREATE TABLE t (a TEXT)');
    a.prepare('INSERT INTO t VALUES (?)').run('a');
    const b = new BazaSqlite(f);
    assert.equal(b.prepare('SELECT a FROM t').get().a, 'a');
    b.close();
    a.close();
    a.close();
    assert.equal(a.open, false);
});

test('SQL.7 baza kase bez nativnog modula: nema better-sqlite3 u zavisnostima ni asarUnpack; Electron podržan (≥ 43), CI na Node 22', () => {
    const ROOT = path.join(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    assert.equal((pkg.dependencies || {})['better-sqlite3'], undefined);
    assert.equal((pkg.devDependencies || {})['better-sqlite3'], undefined);
    assert.ok(!Object.keys(lock.packages || {}).some((k) => k.endsWith('node_modules/better-sqlite3')), 'better-sqlite3 nije u package-lock.json');
    assert.doesNotMatch(JSON.stringify(pkg.build.asarUnpack || []), /better-sqlite3/);
    const major = Number(String(pkg.devDependencies.electron).replace(/^[^\d]*/, '').split('.')[0]);
    assert.ok(major >= 43, `Electron ${pkg.devDependencies.electron}: node:sqlite traži Electron ≥ 43 (Node ≥ 22.12)`);
    for (const f of ['test.yml', 'build.yml']) {
        const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8');
        const verzije = [...yml.matchAll(/node-version:\s*'(\d+)'/g)].map((m) => Number(m[1]));
        assert.ok(verzije.length && verzije.every((v) => v >= 22), `${f}: Node ${verzije.join(', ')} (treba 22+ za node:sqlite)`);
    }
    const kod = ['main.js', 'lib/pos-kes.js', 'lib/kasa-offline.js', 'lib/dimni-test.js']
        .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).filter((r) => !r.trim().startsWith('//')).join('\n')).join('\n');
    assert.doesNotMatch(kod, /require\(\s*['"]better-sqlite3['"]\s*\)/);
});
