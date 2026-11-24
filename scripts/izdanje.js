#!/usr/bin/env node
// Provjera taga izdanja (PLT-22) — build.yml, prije pakovanja.
//   - tag mora biti tačno v<verzija iz package.json> (electron-builder nacrt pravi po verziji iz package.json: drugačiji tag bi
//     napravio nacrt pod drugim imenom, a objava ne bi našla ništa);
//   - verzija s nastavkom „-beta.N" je probno izdanje: objavljuje se kao pre-release i vide ga samo računari na beta kanalu.
//     Dozvoljen je samo nastavak beta (alpha i ostali kanali se ne koriste).
//
//   node scripts/izdanje.js v4.8.0-beta.1   :: ispiše verzija=… i beta=true|false (za $GITHUB_OUTPUT), izlaz 1 kad ne valja
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function provjeriTag(tag, verzija) {
    const t = String(tag || '').trim();
    if (!t.startsWith('v')) return { ok: false, poruka: `Tag „${t}" mora počinjati s „v" (npr. v${verzija}).` };
    if (t !== `v${verzija}`) return { ok: false, poruka: `Tag „${t}" nije isti kao verzija u package.json (${verzija}) — tag mora biti v${verzija}.` };
    const m = SEMVER.exec(verzija);
    if (!m) return { ok: false, poruka: `Verzija „${verzija}" nije oblika X.Y.Z ili X.Y.Z-beta.N.` };
    if (m[4] && !/^beta(\.\d+)?$/.test(m[4])) return { ok: false, poruka: `Probna verzija mora biti X.Y.Z-beta.N (sad: ${verzija}).` };
    return { ok: true, verzija, beta: !!m[4] };
}

if (require.main === module) {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const r = provjeriTag(process.argv[2] || process.env.GITHUB_REF_NAME, pkg.version);
    if (!r.ok) { console.error(r.poruka); process.exit(1); }
    console.log(`verzija=${r.verzija}`);
    console.log(`beta=${r.beta}`);
}

module.exports = { provjeriTag };
