// PLT-22: build.yml gradi samo NACRT izdanja; objava ide jedino kroz posao u GitHub okruženju `izdanje` (ručno odobrenje).
// Do 4.7.0 je posao publish-release objavljivao odmah poslije builda — instalirane kase su vidjele izdanje bez ikakve provjere.
// Test čita workflow kao tekst (bez YAML zavisnosti): fajl je pisan u jednostavnom obliku (posao = 2 razmaka, ključ: vrijednost).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { provjeriTag } = require('../scripts/izdanje');

const ROOT = path.join(__dirname, '..');
const WF = path.join(ROOT, '.github', 'workflows');
const BUILD = fs.readFileSync(path.join(WF, 'build.yml'), 'utf8').replace(/\r\n?/g, '\n');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OKRUZENJE = 'izdanje';

const bezKomentara = (s) => s.split('\n').map((r) => (/^\s*#/.test(r) ? '' : r.replace(/\s+#\s.*$/, ''))).join('\n');

/** { ime: tijelo } poslova iz `jobs:` (posao je red s tačno 2 razmaka uvlake i dvotačkom na kraju). */
function poslovi(yml) {
    const redovi = bezKomentara(yml).split('\n');
    const pocetak = redovi.findIndex((r) => /^jobs:\s*$/.test(r));
    assert.ok(pocetak >= 0, 'nema jobs:');
    const out = {};
    let ime = null;
    for (const r of redovi.slice(pocetak + 1)) {
        if (/^\S/.test(r)) break;                       // novi ključ najvišeg nivoa
        const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(r);
        if (m) { ime = m[1]; out[ime] = ''; continue; }
        if (ime) out[ime] += r + '\n';
    }
    return out;
}
const najviseNivo = (yml) => bezKomentara(yml).split('\n').filter((r) => /^\S/.test(r) || /^ {2}\S/.test(r)).join('\n');
// Šta god u poslu objavljuje ili mijenja izdanje (nacrt → objavljeno), na bilo koji od poznatih načina
const OBJAVA = [/updateRelease/, /draft:\s*false/, /gh\s+release\s+(edit|create)/, /--draft=false/, /createRelease/, /releaseType[=:]\s*['"]?(release|prerelease)/,
    /EP_PRE_?RELEASE/, /EP_DRAFT:\s*['"]?false/];
const objavljuje = (tijelo) => OBJAVA.some((r) => r.test(tijelo));

test('IZD.1 izdanje se pravi samo na tag v* (ne na grani ni PR-u) i zadano nema pravo pisanja', () => {
    const vrh = najviseNivo(BUILD);
    assert.match(BUILD, /\non:\n {2}push:\n {4}tags:\n {6}- 'v\*'\n/);
    const okidaci = (/\non:\n((?: .*\n)+)/.exec(bezKomentara(BUILD)) || [])[1] || '';
    assert.equal(okidaci, "  push:\n    tags:\n      - 'v*'\n", 'jedini okidač je push taga v*');
    assert.match(vrh, /^permissions:\n {2}contents: read$/m, 'zadano samo čitanje; pisanje dobija posao po posao');
});

test('IZD.2 build poslovi pune SAMO nacrt (releaseType draft + EP_DRAFT) i ne objavljuju', () => {
    assert.equal(PKG.build.publish.releaseType, 'draft');
    assert.equal(PKG.build.publish.provider, 'github');
    const p = poslovi(BUILD);
    const graditelji = Object.entries(p).filter(([, t]) => /--publish always/.test(t));
    assert.deepEqual(graditelji.map(([ime]) => ime).sort(), ['build-mac', 'build-windows']);
    for (const [ime, t] of graditelji) {
        assert.match(t, /EP_DRAFT: 'true'/, `${ime}: EP_DRAFT`);
        assert.ok(!objavljuje(t), `${ime} ne smije objavljivati`);
        assert.doesNotMatch(t, /environment:/, `${ime}: build ne treba odobrenje (pravi samo nacrt)`);
    }
});

test('IZD.3 jedini posao koji objavljuje je u okruženju `izdanje` (ručno odobrenje) i čeka sve buildove', () => {
    const p = poslovi(BUILD);
    const objavljivaci = Object.entries(p).filter(([, t]) => objavljuje(t));
    assert.equal(objavljivaci.length, 1, `objavljuju: ${objavljivaci.map(([i]) => i).join(', ')}`);
    const [ime, t] = objavljivaci[0];
    assert.match(t, new RegExp(`^ {4}environment: ${OKRUZENJE}$`, 'm'), `${ime} mora biti u okruženju ${OKRUZENJE}`);
    const potrebni = (/^ {4}needs: \[([^\]]*)\]$/m.exec(t) || [])[1];
    assert.ok(potrebni, `${ime}: needs`);
    for (const b of ['provjera', 'build-windows', 'build-mac']) assert.ok(potrebni.split(',').map((x) => x.trim()).includes(b), `${ime} ne čeka ${b}`);
    // objavljuje samo nacrt za ovaj tag; beta tag → pre-release (vide ga samo računari na beta kanalu)
    assert.match(t, /r\.tag_name === tag && r\.draft/);
    assert.match(t, /prerelease: beta/);
    // u okruženju je jedini posao s pravom pisanja koji ne puni nacrt
    const pisu = Object.entries(p).filter(([, x]) => /contents: write/.test(x)).map(([i]) => i).sort();
    assert.deepEqual(pisu, ['build-mac', 'build-windows', ime].sort());
});

test('IZD.4 prije pakovanja: tag = verzija, testovi; poslije pakovanja: dimni test spakovane aplikacije; licence usklađene', () => {
    const p = poslovi(BUILD);
    assert.match(p.provjera, /node scripts\/izdanje\.js "\$GITHUB_REF_NAME"/);
    assert.match(p.provjera, /npm test/);
    for (const [ime, exe] of [['build-windows', 'dist/win-unpacked/aiERP.exe'], ['build-mac', 'dist/mac-arm64/aiERP.app/Contents/MacOS/aiERP']]) {
        const t = p[ime];
        assert.match(t, /^ {4}needs: provjera$/m, `${ime} čeka provjeru`);
        const i = t.indexOf('--publish always');
        const j = t.indexOf(`node scripts/dimni-test.js ${exe}`);
        assert.ok(j > i, `${ime}: dimni test ${exe} poslije pakovanja`);
        assert.match(t, /node scripts\/licence-trecih-strana\.js --provjeri/);
        assert.match(t, new RegExp(`npm run build:${ime === 'build-mac' ? 'mac' : 'win'} -- --publish always`));
    }
    // ime exe-a dolazi od productName (ostaje „aiERP" zbog userData i instalacionog foldera)
    assert.equal(PKG.build.productName, 'aiERP');
    assert.equal(PKG.scripts['build:win'], 'node scripts/izgradi.js --win');
    assert.equal(PKG.scripts['build:mac'], 'node scripts/izgradi.js --mac');
});

test('IZD.5 nijedan drugi workflow ne objavljuje i nema pravo pisanja', () => {
    for (const f of fs.readdirSync(WF).filter((x) => /\.ya?ml$/.test(x) && x !== 'build.yml')) {
        const t = bezKomentara(fs.readFileSync(path.join(WF, f), 'utf8'));
        assert.ok(!objavljuje(t), `${f} objavljuje`);
        assert.doesNotMatch(t, /--publish|contents: write|electron-builder/, f);
    }
});

test('IZD.6 sam test hvata stari način (objava bez odobrenja)', () => {
    const staro = `on:\n  push:\n    tags:\n      - 'v*'\npermissions:\n  contents: write\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: npm run build:win -- --publish always\n` +
        `  publish-release:\n    needs: [build]\n    steps:\n      - uses: actions/github-script@v7\n        with:\n          script: |\n            await github.rest.repos.updateRelease({ draft: false });\n`;
    const p = poslovi(staro);
    const objavljivaci = Object.entries(p).filter(([, t]) => objavljuje(t));
    assert.deepEqual(objavljivaci.map(([i]) => i), ['publish-release']);
    assert.doesNotMatch(objavljivaci[0][1], new RegExp(`environment: ${OKRUZENJE}`), 'stari posao nije imao odobrenje → IZD.3 pada');
    assert.doesNotMatch(najviseNivo(staro), /^permissions:\n {2}contents: read$/m, 'stari fajl → IZD.1 pada');
});

test('IZD.7 tag mora biti v<verzija>; beta samo kao X.Y.Z-beta.N', () => {
    assert.deepEqual(provjeriTag('v4.8.0', '4.8.0'), { ok: true, verzija: '4.8.0', beta: false });
    assert.deepEqual(provjeriTag('v4.8.0-beta.1', '4.8.0-beta.1'), { ok: true, verzija: '4.8.0-beta.1', beta: true });
    assert.equal(provjeriTag('v4.8.1', '4.8.0').ok, false);
    assert.equal(provjeriTag('4.8.0', '4.8.0').ok, false);
    assert.equal(provjeriTag('v4.8.0-alpha.1', '4.8.0-alpha.1').ok, false);
    assert.equal(provjeriTag('v4.8', '4.8').ok, false);
    assert.equal(provjeriTag(`v${PKG.version}`, PKG.version).ok, true, 'trenutna verzija iz package.json je ispravna');
});

test('IZD.8 beta kanal: build piše datoteke ažuriranja za sve kanale (beta računar vidi i stabilna izdanja)', () => {
    assert.equal(PKG.build.generateUpdatesFilesForAllChannels, true);
});
