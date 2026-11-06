// R73 (odluka Eldina 06.11.2026): proizvod je „Vault aiERP", znak je „Dvije trake". „Staro ne smije ostati nigdje":
// test drži da se stari znak (kocka od obojenih pločica + orbita) ne vrati ni u jedan fajl repoa, da su ikone nove
// i tačnih dimenzija, i da identifikatori od kojih zavise putanje (userData, instalacioni folder) ostanu isti.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const PRESKOCI = new Set(['node_modules', '.git', 'dist', 'dist-test']);

// Tragovi starog znaka — sastavljeni iz dijelova da ovaj fajl sam sebe ne nađe.
const STARO = [
    'ai' + 'orbit', 'ai' + 'front',
    '28,8 36.5' + ',12.9',              // gornja pločica kocke
    '36.5,32.5 45' + ',27.6',           // donja desna pločica kocke
    'rx="28" ry' + '="11"',             // orbita
];

const NOVI_ZNAK = [
    '<polygon points="5,8 15.5,8 29,40 19,40" fill="#2563EB"/>',
    '<polygon points="43,8 32.5,8 19,40 29,40" fill="#7C3AED"/>',
    '<polygon points="24,28.2 29,40 19,40" fill="#3730A3"/>',
];

function tekstualniFajlovi(dir = ROOT, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (PRESKOCI.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) tekstualniFajlovi(p, out);
        else if (!/\.(png|ico|icns|db|exe|dmg)$/i.test(e.name)) out.push(p);
    }
    return out;
}

function dimenzijePng(buf) {
    assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', 'nije PNG');
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('BRD.1 nijedan fajl repoa nema stari znak (kocka + orbita)', () => {
    const nadjeno = [];
    for (const f of tekstualniFajlovi()) {
        const s = fs.readFileSync(f, 'utf8');
        for (const t of STARO) if (s.includes(t)) nadjeno.push(`${path.relative(ROOT, f)}: ${t}`);
    }
    assert.deepEqual(nadjeno, []);
});

test('BRD.2 ikona i ekran povezivanja nose novi znak „Dvije trake"', () => {
    for (const f of ['build/icon.svg', 'povezivanje.html']) {
        const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
        for (const p of NOVI_ZNAK) assert.ok(s.includes(p), `${f} nema ${p}`);
    }
});

test('BRD.3 ikone imaju tačne dimenzije, a icon.ico PNG zapise 16–256', () => {
    for (const v of [16, 32, 48, 64, 128, 256, 512, 1024]) {
        assert.deepEqual(dimenzijePng(fs.readFileSync(path.join(BUILD, `icon_${v}.png`))), [v, v], `icon_${v}.png`);
    }
    assert.deepEqual(dimenzijePng(fs.readFileSync(path.join(BUILD, 'icon.png'))), [1024, 1024], 'icon.png');

    const ico = fs.readFileSync(path.join(BUILD, 'icon.ico'));
    assert.equal(ico.readUInt16LE(2), 1, 'ICO tip');
    const broj = ico.readUInt16LE(4);
    const velicine = [];
    for (let i = 0; i < broj; i++) {
        const z = 6 + 16 * i;
        const v = ico.readUInt8(z) || 256;
        const duzina = ico.readUInt32LE(z + 8);
        const pomak = ico.readUInt32LE(z + 12);
        assert.deepEqual(dimenzijePng(ico.subarray(pomak, pomak + duzina)), [v, v], `ICO zapis ${v}`);
        velicine.push(v);
    }
    assert.deepEqual(velicine, [16, 32, 48, 64, 128, 256]);
});

test('BRD.4 nijedna ikona nije bajt-ista staroj (origin/main prije R73)', () => {
    // SHA-256 starih fajlova (kocka + orbita), izračunato iz `git show 80402b8:build/<fajl>`.
    const stari = {
        'icon.png': 'a4c93f7cd36aa8d46ed7d9fd80a6c5388d48bbb690704ea76d8b57ded52de8bf',
        'icon_16.png': 'e7488aefde8ec6ac3128a851e986155e9429e7a0454f6c1f858faa806bfa44f8',
        'icon_32.png': 'a7980c7fad2ac17f34da4397297245c9a0b7c37f3a915f9e21ffb057cadf0e81',
        'icon_48.png': '84c21c1f110de74c92b648e8cfaff5ebcc9db8d00d7492d95e8fd5da16244d2c',
        'icon_64.png': '0aee0fed90c01cec520123020ffd70fbeb9e5cf1d97ed88397b94b146379175e',
        'icon_128.png': 'afeb1948dd6e4e2b6e4d5cd4c3824522e4954c58aef05bf903fab4605820d5c5',
        'icon_256.png': '571563f80ecf50c3ad5e7aa73438fa452c4dee70cf0eb9f495b72463ef3eb9a8',
        'icon_512.png': 'a76b0b4171467b07c4a7fe09fd37ace51109735ad020808620d6c4e66374ef3d',
        'icon_1024.png': 'a4c93f7cd36aa8d46ed7d9fd80a6c5388d48bbb690704ea76d8b57ded52de8bf',
        'icon.ico': '71f688ada0754cf7d1133d58d3ded8299c87d713b13ef4b90533e280f95f6f49',
    };
    const sviStari = new Set(Object.values(stari));
    for (const f of fs.readdirSync(BUILD).filter((f) => /\.(png|ico)$/.test(f))) {
        assert.ok(!sviStari.has(sha(fs.readFileSync(path.join(BUILD, f)))), `${f} je stara ikona`);
    }
});

test('BRD.5 prikazani naziv je „Vault aiERP"; identifikatori putanja ostaju', () => {
    for (const f of ['povezivanje.html', 'offline.html']) {
        const naslov = fs.readFileSync(path.join(ROOT, f), 'utf8').match(/<title>([^<]*)<\/title>/)[1];
        assert.match(naslov, /^Vault aiERP — /, f);
    }
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(main, /const NAZIV_PROIZVODA = 'Vault aiERP';/);
    // Stringovi u main.js (bez komentara) ne smiju imati goli „aiERP" kao naziv
    const kod = main.split(/\r?\n/).filter((r) => !r.trim().startsWith('//')).join('\n');
    const goli = [...kod.matchAll(/(['"`])(?:(?!\1).)*?\1/g)].map((m) => m[0])
        .filter((s) => /\baiERP\b/.test(s.replace(/Vault aiERP/g, '')));
    assert.deepEqual(goli, []);

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'stt-hr', 'name daje userData (%APPDATA%\\stt-hr)');
    assert.equal(pkg.build.appId, 'ba.stt.business', 'appId je ključ instalacije i ažuriranja');
    assert.equal(pkg.build.productName, 'aiERP', 'productName daje instalacioni folder i ime exe-a');
    assert.equal(pkg.build.nsis.shortcutName, 'Vault aiERP');
    assert.equal(pkg.build.copyright, '(c) 2026 STT d.o.o.');
    assert.match(pkg.description, /^Vault aiERP — /);
});
