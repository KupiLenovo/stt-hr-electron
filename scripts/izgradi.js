#!/usr/bin/env node
// Pakovanje aplikacije (electron-builder) — jedini ulaz za build:win / build:mac i build.yml (PLT-22, PLT-39).
// Konfiguracija je `build` iz package.json; ovdje se preko nje spajaju samo:
//   - opcije potpisa koda (scripts/potpis-koda.js — isključeno do certifikata),
//   - izmjene iz komandne linije `-c.ključ.podključ=vrijednost` (kao kod electron-buildera, npr. -c.directories.output=dist-test).
// Izdanje se UVIJEK pravi kao nacrt (package.json build.publish.releaseType = "draft"); objava je poseban korak uz odobrenje.
//
//   node scripts/izgradi.js --win [--dir] [--publish always|never] [-c.npmRebuild=false]
//   node scripts/izgradi.js --linux --dir     :: lokalna proba pakovanja + dimni test (scripts/dimni-test.js)
'use strict';

const { opcijePotpisa } = require('./potpis-koda');

function vrijednost(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null') return null;
    return v;
}

function postavi(obj, kljuc, v) {
    const dijelovi = kljuc.split('.');
    let o = obj;
    for (const d of dijelovi.slice(0, -1)) { if (!o[d] || typeof o[d] !== 'object') o[d] = {}; o = o[d]; }
    o[dijelovi[dijelovi.length - 1]] = v;
}

function spoji(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b || {})) {
        out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? spoji(a[k], v) : v;
    }
    return out;
}

function argumenti(argv) {
    const o = { platforme: [], dir: false, publish: 'never', izmjene: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--win' || a === '--mac' || a === '--linux') o.platforme.push(a.slice(2));
        else if (a === '--dir') o.dir = true;
        else if (a === '--publish' || a === '-p') o.publish = argv[++i];
        else if (a.startsWith('--publish=')) o.publish = a.slice('--publish='.length);
        else if (a.startsWith('-c.')) { const j = a.indexOf('='); postavi(o.izmjene, a.slice(3, j), vrijednost(a.slice(j + 1))); }
        else throw new Error(`Nepoznat argument: ${a}`);
    }
    if (!['always', 'never', 'onTag', 'onTagOrDraft'].includes(o.publish)) throw new Error(`Nepoznato --publish: ${o.publish}`);
    if (!o.platforme.length) throw new Error('Navedi platformu: --win, --mac ili --linux');
    return o;
}

/** Dodatak konfiguraciji za electron-builder (spaja se preko package.json build). */
function dodatakKonfiguraciji(izmjene = {}, potpis = opcijePotpisa()) {
    return spoji(potpis, izmjene);
}

async function main() {
    const a = argumenti(process.argv.slice(2));
    const builder = require('electron-builder');
    const opcije = { publish: a.publish, dir: a.dir, config: dodatakKonfiguraciji(a.izmjene) };
    for (const p of a.platforme) opcije[p] = [];
    await builder.build(opcije);
}

if (require.main === module) {
    main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}

module.exports = { argumenti, dodatakKonfiguraciji, spoji };
