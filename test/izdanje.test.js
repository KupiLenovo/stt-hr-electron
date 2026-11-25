// PLT-22: build.yml gradi samo NACRT izdanja; objava ide jedino kroz posao u GitHub okruženju `izdanje` (ručno odobrenje).
// Do 4.7.0 je posao publish-release objavljivao odmah poslije builda — instalirane kase su vidjele izdanje bez ikakve provjere.
// v4.8.0-beta.3: JEDAN nacrt po tagu sa svim fajlovima obje platforme + beta*.yml; objava prije svega provjeri spisak fajlova
// (v4.8.0-beta.2: dva nacrta za isti tag, objavljen onaj bez Mac fajlova i bez .exe.blockmap — scripts/izdanje.js).
// Test čita workflow kao tekst (bez YAML zavisnosti): fajl je pisan u jednostavnom obliku (posao = 2 razmaka, ključ: vrijednost).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const iz = require('../scripts/izdanje');
const { provjeriTag, obavezniFajlovi, pripremi, izaberiNacrt, provjeriZaObjavu, napraviNacrt, objaviNacrt, procitajOpis } = iz;

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
const potrebni = (t) => ((/^ {4}needs: \[([^\]]*)\]$/m.exec(t) || [])[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
// Šta god u poslu objavljuje ili mijenja izdanje (nacrt → objavljeno), na bilo koji od poznatih načina
const OBJAVA = [/updateRelease/, /objaviNacrt/, /draft:\s*false/, /gh\s+release\s+(edit|create)/, /--draft=false/, /createRelease/,
    /releaseType[=:]\s*['"]?(release|prerelease)/, /EP_PRE_?RELEASE/, /EP_DRAFT:\s*['"]?false/];
const objavljuje = (tijelo) => OBJAVA.some((r) => r.test(tijelo));
// Šta god piše na GitHub izdanje (pravi nacrt ili otprema fajlove)
const PISE_IZDANJE = [/--publish (always|onTag)/, /GH_TOKEN/, /napraviNacrt/, /uploadReleaseAsset/, /gh\s+release\s+upload/, ...OBJAVA];
const piseIzdanje = (tijelo) => PISE_IZDANJE.some((r) => r.test(tijelo));

const BETA1 = ['latest-mac.yml', 'latest.yml', 'Vault-aiERP-4.8.0-beta.1-arm64.dmg', 'Vault-aiERP-4.8.0-beta.1-arm64.dmg.blockmap',
    'Vault-aiERP-4.8.0-beta.1-x64.dmg', 'Vault-aiERP-4.8.0-beta.1-x64.dmg.blockmap', 'Vault-aiERP-Setup-4.8.0-beta.1.exe',
    'Vault-aiERP-Setup-4.8.0-beta.1.exe.blockmap'];
// v4.8.0-beta.2 na GitHubu (25.11.2026): dva nacrta istog taga, fajlovi razbacani po oba
const BETA2_OBJAVLJEN = { id: 458504890, tag_name: 'v4.8.0-beta.2', draft: true,
    assets: ['latest.yml', 'Vault-aiERP-Setup-4.8.0-beta.2.exe'] };
const BETA2_NACRT = { id: 458504892, tag_name: 'v4.8.0-beta.2', draft: true,
    assets: ['latest-mac.yml', 'Vault-aiERP-4.8.0-beta.2-arm64.dmg', 'Vault-aiERP-4.8.0-beta.2-arm64.dmg.blockmap', 'Vault-aiERP-4.8.0-beta.2-x64.dmg',
        'Vault-aiERP-4.8.0-beta.2-x64.dmg.blockmap', 'Vault-aiERP-Setup-4.8.0-beta.2.exe.blockmap'] };
const saFajlovima = (r) => ({ ...r, assets: r.assets.map((name, i) => ({ id: r.id * 100 + i, name, size: 10, state: 'uploaded' })) });

/** Lažni Octokit (github-script `github`) nad listom izdanja u memoriji; bilježi svaki poziv koji mijenja izdanja. */
function lazniGithub(izdanja = []) {
    const g = { izdanja: izdanja.map(saFajlovima), pozivi: [] };
    let sljedeci = 900000000;
    const r = {
        listReleases: async () => { throw new Error('ide kroz paginate'); },
        listReleaseAssets: async () => { throw new Error('ide kroz paginate'); },
        createRelease: async (o) => {
            g.pozivi.push(['createRelease', o]);
            const novo = { id: sljedeci++, tag_name: o.tag_name, draft: o.draft, prerelease: o.prerelease, assets: [] };
            g.izdanja.push(novo);
            return { data: novo };
        },
        deleteReleaseAsset: async (o) => {
            g.pozivi.push(['deleteReleaseAsset', o.asset_id]);
            for (const x of g.izdanja) x.assets = x.assets.filter((a) => a.id !== o.asset_id);
        },
        uploadReleaseAsset: async (o) => {
            g.pozivi.push(['uploadReleaseAsset', o.release_id, o.name]);
            assert.ok(Buffer.isBuffer(o.data) && o.data.length > 0, `${o.name}: sadržaj`);
            g.izdanja.find((x) => x.id === o.release_id).assets.push({ id: sljedeci++, name: o.name, size: o.data.length, state: 'uploaded' });
        },
        updateRelease: async (o) => {
            g.pozivi.push(['updateRelease', o]);
            Object.assign(g.izdanja.find((x) => x.id === o.release_id), { draft: o.draft, prerelease: o.prerelease });
        },
    };
    g.rest = { repos: r };
    g.paginate = async (fn, o) => {
        if (fn === r.listReleases) return structuredClone(g.izdanja);
        if (fn === r.listReleaseAssets) return structuredClone(g.izdanja.find((x) => x.id === o.release_id).assets);
        throw new Error('nepoznat paginate');
    };
    return g;
}
const REPO = { owner: 'KupiLenovo', repo: 'stt-hr-electron' };

/** Folder kakav posao `nacrt` dobije od obje gradnje (yml u obliku koji piše electron-builder 26). */
function folderGradnji(verzija, { bez = [], dodaj = {}, ymlVerzija = verzija } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'izdanje-'));
    const exe = `Vault-aiERP-Setup-${verzija}.exe`;
    const dmg = (a) => `Vault-aiERP-${verzija}-${a}.dmg`;
    const fajlovi = {
        [exe]: 'MZ…', [`${exe}.blockmap`]: 'bm', [dmg('x64')]: 'dmg', [`${dmg('x64')}.blockmap`]: 'bm', [dmg('arm64')]: 'dmg', [`${dmg('arm64')}.blockmap`]: 'bm',
        'latest.yml': `version: ${ymlVerzija}\nfiles:\n  - url: ${exe}\n    sha512: abc==\n    size: 3\npath: ${exe}\nsha512: abc==\nreleaseDate: '2026-11-25T18:42:00.000Z'\n`,
        'latest-mac.yml': `version: ${ymlVerzija}\nfiles:\n  - url: ${dmg('x64')}\n    sha512: a==\n    size: 3\n  - url: ${dmg('arm64')}\n    sha512: b==\n    size: 3\n` +
            `path: ${dmg('x64')}\nsha512: a==\nreleaseDate: '2026-11-25T18:51:00.000Z'\n`,
        ...dodaj,
    };
    for (const [f, s] of Object.entries(fajlovi)) if (!bez.includes(f)) fs.writeFileSync(path.join(dir, f), s);
    return dir;
}

test('IZD.1 izdanje se pravi samo na tag v* (ne na grani ni PR-u) i zadano nema pravo pisanja', () => {
    const vrh = najviseNivo(BUILD);
    assert.match(BUILD, /\non:\n {2}push:\n {4}tags:\n {6}- 'v\*'\n/);
    const okidaci = (/\non:\n((?: .*\n)+)/.exec(bezKomentara(BUILD)) || [])[1] || '';
    assert.equal(okidaci, "  push:\n    tags:\n      - 'v*'\n", 'jedini okidač je push taga v*');
    assert.match(vrh, /^permissions:\n {2}contents: read$/m, 'zadano samo čitanje; pisanje dobija posao po posao');
});

test('IZD.2 gradnje NE pišu na GitHub (--publish never, bez prava pisanja); fajlove predaju poslu `nacrt` kroz Actions', () => {
    assert.equal(PKG.build.publish.releaseType, 'draft', 'i ručni --publish always pravi samo nacrt');
    assert.equal(PKG.build.publish.provider, 'github', 'app-update.yml: kasa traži ažuriranja na GitHub izdanjima');
    const p = poslovi(BUILD);
    const graditelji = Object.entries(p).filter(([, t]) => /npm run build:/.test(t));
    assert.deepEqual(graditelji.map(([ime]) => ime).sort(), ['build-mac', 'build-windows']);
    for (const [ime, t] of graditelji) {
        assert.match(t, new RegExp(`npm run build:${ime === 'build-mac' ? 'mac' : 'win'} -- --publish never`), `${ime}: --publish never`);
        assert.ok(!piseIzdanje(t), `${ime} ne smije pisati na GitHub izdanje (dva nacrta za isti tag — v4.8.0-beta.2)`);
        assert.doesNotMatch(t, /contents: write/, `${ime}: bez prava pisanja`);
        assert.doesNotMatch(t, /environment:/, `${ime}: gradnja ne treba odobrenje`);
        assert.match(t, /uses: actions\/upload-artifact@v4/, `${ime}: fajlovi idu poslu nacrt`);
        assert.match(t, /name: izdanje-(windows|mac)\n/, ime);
        assert.match(t, /if-no-files-found: error/, `${ime}: fali fajl → gradnja pada`);
    }
    assert.match(p['build-windows'], /dist\/Vault-aiERP-Setup-\*\.exe\n[\s\S]*dist\/Vault-aiERP-Setup-\*\.exe\.blockmap\n[\s\S]*dist\/latest\.yml\n/);
    assert.match(p['build-mac'], /dist\/Vault-aiERP-\*\.dmg\n[\s\S]*dist\/Vault-aiERP-\*\.dmg\.blockmap\n[\s\S]*dist\/latest-mac\.yml\n/);
});

test('IZD.3 jedini posao koji objavljuje je u okruženju `izdanje`, čeka sve i objavljuje kroz objaviNacrt (provjera spiska fajlova)', () => {
    const p = poslovi(BUILD);
    const objavljivaci = Object.entries(p).filter(([, t]) => objavljuje(t));
    assert.equal(objavljivaci.length, 1, `objavljuju: ${objavljivaci.map(([i]) => i).join(', ')}`);
    const [ime, t] = objavljivaci[0];
    assert.equal(ime, 'objavi');
    assert.match(t, new RegExp(`^ {4}environment: ${OKRUZENJE}$`, 'm'), `${ime} mora biti u okruženju ${OKRUZENJE}`);
    for (const b of ['provjera', 'build-windows', 'build-mac', 'nacrt']) assert.ok(potrebni(t).includes(b), `${ime} ne čeka ${b}`);
    assert.match(t, /require\('\.\/scripts\/izdanje\.js'\)/);
    assert.match(t, /await objaviNacrt\(/);
    assert.match(t, /NACRT: \$\{\{ needs\.nacrt\.outputs\.id \}\}/, 'objavljuje TAČNO nacrt koji je napravio posao nacrt (ne „prvi nacrt s tagom")');
    assert.match(t, /BETA: \$\{\{ needs\.provjera\.outputs\.beta \}\}/);
    assert.doesNotMatch(t, /r\.tag_name === tag && r\.draft/, 'stari izbor „prvi nacrt s tim tagom" je uzeo nepotpun nacrt (beta.2)');
    // pravo pisanja: samo nacrt (pravi nacrt) i objavi
    const pisu = Object.entries(p).filter(([, x]) => /contents: write/.test(x)).map(([i]) => i).sort();
    assert.deepEqual(pisu, ['nacrt', 'objavi']);
});

test('IZD.4 prije pakovanja: tag = verzija, testovi; poslije pakovanja: dimni test pa predaja fajlova; licence usklađene', () => {
    const p = poslovi(BUILD);
    assert.match(p.provjera, /node scripts\/izdanje\.js "\$GITHUB_REF_NAME"/);
    assert.match(p.provjera, /npm test/);
    for (const [ime, exe] of [['build-windows', 'dist/win-unpacked/aiERP.exe'], ['build-mac', 'dist/mac-arm64/aiERP.app/Contents/MacOS/aiERP']]) {
        const t = p[ime];
        assert.match(t, /^ {4}needs: provjera$/m, `${ime} čeka provjeru`);
        const i = t.indexOf('--publish never');
        const j = t.indexOf(`node scripts/dimni-test.js ${exe}`);
        const k = t.indexOf('actions/upload-artifact');
        assert.ok(i >= 0 && j > i && k > j, `${ime}: pakovanje → dimni test ${exe} → predaja fajlova (pao dimni test = nema izdanja)`);
        assert.match(t, /node scripts\/licence-trecih-strana\.js --provjeri/);
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
        assert.doesNotMatch(t, /--publish|contents: write|electron-builder|napraviNacrt/, f);
    }
});

test('IZD.6 sam test hvata stari način (objava bez odobrenja; gradnja koja sama otprema)', () => {
    const staro = `on:\n  push:\n    tags:\n      - 'v*'\npermissions:\n  contents: write\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: npm run build:win -- --publish always\n` +
        `  publish-release:\n    needs: [build]\n    steps:\n      - uses: actions/github-script@v7\n        with:\n          script: |\n            await github.rest.repos.updateRelease({ draft: false });\n`;
    const p = poslovi(staro);
    const objavljivaci = Object.entries(p).filter(([, t]) => objavljuje(t));
    assert.deepEqual(objavljivaci.map(([i]) => i), ['publish-release']);
    assert.doesNotMatch(objavljivaci[0][1], new RegExp(`environment: ${OKRUZENJE}`), 'stari posao nije imao odobrenje → IZD.3 pada');
    assert.doesNotMatch(najviseNivo(staro), /^permissions:\n {2}contents: read$/m, 'stari fajl → IZD.1 pada');
    assert.ok(piseIzdanje(p.build), 'gradnja s --publish always → IZD.2 pada');
    // gradnja iz v4.8.0-beta.2 (EP_DRAFT + --publish always) piše na GitHub → IZD.2 pada
    assert.ok(piseIzdanje("      - run: npm run build:mac -- --publish always\n        env:\n          GH_TOKEN: x\n          EP_DRAFT: 'true'\n"));
});

test('IZD.7 tag mora biti v<verzija>; beta samo kao X.Y.Z-beta.N', () => {
    assert.deepEqual(provjeriTag('v4.8.0', '4.8.0'), { ok: true, verzija: '4.8.0', beta: false });
    assert.deepEqual(provjeriTag('v4.8.0-beta.1', '4.8.0-beta.1'), { ok: true, verzija: '4.8.0-beta.1', beta: true });
    assert.equal(provjeriTag('v4.8.1', '4.8.0').ok, false);
    assert.equal(provjeriTag('4.8.0', '4.8.0').ok, false);
    assert.equal(provjeriTag('v4.8.0-alpha.1', '4.8.0-alpha.1').ok, false);
    assert.equal(provjeriTag('v4.8', '4.8').ok, false);
    assert.equal(provjeriTag(`v${PKG.version}`, PKG.version).ok, true, 'trenutna verzija iz package.json je ispravna');
    assert.equal(PKG.version, '4.8.0-beta.3');
});

test('IZD.8 beta kanal: beta.yml / beta-mac.yml prave se iz latest*.yml (electron-builder ih za GitHub ne pravi)', () => {
    // app-builder-lib computeChannelNames: za provider github vrati samo [channel || 'latest'] — generateUpdatesFilesForAllChannels se
    // tu ne gleda (zato ni beta.1 ni beta.2 nisu imali beta*.yml). Opcija je zbunjivala, pa je izbačena.
    assert.equal(PKG.build.generateUpdatesFilesForAllChannels, undefined);
    assert.deepEqual({ ...iz.KANALSKI }, { 'beta.yml': 'latest.yml', 'beta-mac.yml': 'latest-mac.yml' });
});

test('IZD.9 spisak obaveznih fajlova: obje platforme (instalacija + .blockmap), latest*.yml i beta*.yml', () => {
    const v = '4.8.0-beta.3';
    assert.deepEqual(obavezniFajlovi(v), [
        'Vault-aiERP-4.8.0-beta.3-arm64.dmg', 'Vault-aiERP-4.8.0-beta.3-arm64.dmg.blockmap',
        'Vault-aiERP-4.8.0-beta.3-x64.dmg', 'Vault-aiERP-4.8.0-beta.3-x64.dmg.blockmap',
        'Vault-aiERP-Setup-4.8.0-beta.3.exe', 'Vault-aiERP-Setup-4.8.0-beta.3.exe.blockmap',
        'beta-mac.yml', 'beta.yml', 'latest-mac.yml', 'latest.yml',
    ]);
    // potpuno izdanje beta.1 (sve u jednom) = spisak bez beta*.yml — imena se slažu s onim što electron-builder pravi
    assert.deepEqual(obavezniFajlovi('4.8.0-beta.1').filter((f) => !f.startsWith('beta')), [...BETA1].sort());
    assert.ok(obavezniFajlovi('4.8.0').includes('beta.yml'), 'i stabilno izdanje nosi beta*.yml (beta kasa prvo traži beta.yml)');
});

test('IZD.10 objava odbija nepotpun nacrt — oba nacrta v4.8.0-beta.2 bi pala (ništa se ne objavljuje)', () => {
    for (const r of [BETA2_OBJAVLJEN, BETA2_NACRT]) {
        const p = provjeriZaObjavu([saFajlovima(r)], 'v4.8.0-beta.2', r.id, '4.8.0-beta.2');
        assert.equal(p.ok, false, String(r.id));
        assert.match(p.poruka, /NIJE potpun — ništa nije objavljeno/);
    }
    const p = provjeriZaObjavu([saFajlovima(BETA2_OBJAVLJEN)], 'v4.8.0-beta.2', BETA2_OBJAVLJEN.id, '4.8.0-beta.2');
    for (const f of ['Vault-aiERP-Setup-4.8.0-beta.2.exe.blockmap', 'Vault-aiERP-4.8.0-beta.2-x64.dmg', 'Vault-aiERP-4.8.0-beta.2-arm64.dmg.blockmap',
        'latest-mac.yml', 'beta.yml', 'beta-mac.yml']) assert.ok(p.poruka.includes(f), `poruka navodi ${f}`);
    // dva nacrta za isti tag — i da je jedan potpun, objava stane
    const pun = { id: 7, tag_name: 'v4.8.0-beta.2', draft: true, assets: obavezniFajlovi('4.8.0-beta.2') };
    assert.match(provjeriZaObjavu([pun, BETA2_NACRT].map(saFajlovima), 'v4.8.0-beta.2', 7, '4.8.0-beta.2').poruka, /postoji 2 izdanja\/nacrta/);
    assert.equal(provjeriZaObjavu([saFajlovima(pun)], 'v4.8.0-beta.2', 7, '4.8.0-beta.2').ok, true);
    // fajl otpremljen do pola (state ≠ uploaded) ili prazan
    const pola = saFajlovima(pun);
    pola.assets[0].state = 'starter';
    assert.match(provjeriZaObjavu([pola], 'v4.8.0-beta.2', 7, '4.8.0-beta.2').poruka, /nisu do kraja otpremljeni/);
    // već objavljeno → ne „objavljuje" ponovo
    assert.match(provjeriZaObjavu([{ ...saFajlovima(pun), draft: false }], 'v4.8.0-beta.2', 7, '4.8.0-beta.2').poruka, /nije nacrt/);
});

test('IZD.11 jedan nacrt po tagu: nema → napravi; jedan (i zaostao od ranije) → preuzmi; dva ili objavljeno → stani', () => {
    const ostali = [{ id: 1, tag_name: 'v4.8.0-beta.1', draft: false }, { id: 2, tag_name: 'v2.1.3', draft: true }];
    assert.deepEqual(izaberiNacrt(ostali, 'v4.8.0-beta.3'), { ok: true, akcija: 'napravi' });
    assert.deepEqual(izaberiNacrt([...ostali, { id: 3, tag_name: 'v4.8.0-beta.3', draft: true }], 'v4.8.0-beta.3'), { ok: true, akcija: 'koristi', id: 3 });
    const dva = izaberiNacrt([...ostali, BETA2_OBJAVLJEN, BETA2_NACRT], 'v4.8.0-beta.2');
    assert.equal(dva.ok, false);
    assert.match(dva.poruka, /2 nacrta \(id 458504890, 458504892\)/);
    assert.match(izaberiNacrt(ostali, 'v4.8.0-beta.1').poruka, /već postoji objavljeno izdanje/);
});

test('IZD.12 napraviNacrt: TAČNO jedan nacrt (draft), svi fajlovi otpremljeni u njega, nikad ne objavljuje', async () => {
    const v = '4.8.0-beta.3';
    const dir = folderGradnji(v);
    assert.equal(pripremi(dir, v).ok, true);
    const g = lazniGithub([{ id: 1, tag_name: 'v4.8.0-beta.1', draft: false, assets: BETA1 }]);
    const id = await napraviNacrt({ github: g, repo: REPO, tag: `v${v}`, verzija: v, sha: 'abc', dir });
    const napravljeni = g.pozivi.filter(([k]) => k === 'createRelease');
    assert.equal(napravljeni.length, 1);
    assert.deepEqual(napravljeni[0][1], { ...REPO, tag_name: `v${v}`, target_commitish: 'abc', name: v, draft: true, prerelease: false });
    assert.ok(!g.pozivi.some(([k]) => k === 'updateRelease'), 'posao nacrt ne objavljuje');
    const otpremljeno = g.pozivi.filter(([k]) => k === 'uploadReleaseAsset');
    assert.ok(otpremljeno.every(([, rid]) => rid === id), 'svi fajlovi u ISTI nacrt');
    assert.deepEqual(otpremljeno.map(([, , ime]) => ime).sort(), obavezniFajlovi(v));
    assert.equal(g.izdanja.filter((r) => r.tag_name === `v${v}`).length, 1);

    // zaostao nacrt istog taga (npr. ponovljeno pokretanje): preuzme se, stari fajlovi se brišu, novi nacrt se NE pravi
    const g2 = lazniGithub([{ id: 5, tag_name: `v${v}`, draft: true, assets: ['latest.yml', 'stari.exe'] }]);
    assert.equal(await napraviNacrt({ github: g2, repo: REPO, tag: `v${v}`, verzija: v, sha: 'abc', dir }), 5);
    assert.ok(!g2.pozivi.some(([k]) => k === 'createRelease'));
    assert.equal(g2.pozivi.filter(([k]) => k === 'deleteReleaseAsset').length, 2);
    assert.deepEqual(g2.izdanja[0].assets.map((a) => a.name).sort(), obavezniFajlovi(v));

    // dva nacrta za tag (stanje v4.8.0-beta.2) → stane prije ikakvog pisanja
    const g3 = lazniGithub([{ ...BETA2_OBJAVLJEN, tag_name: `v${v}` }, { ...BETA2_NACRT, tag_name: `v${v}` }]);
    await assert.rejects(napraviNacrt({ github: g3, repo: REPO, tag: `v${v}`, verzija: v, sha: 'abc', dir }), /JEDNO/);
    assert.deepEqual(g3.pozivi, []);
});

test('IZD.13 objaviNacrt: nepotpun nacrt → greška i BEZ updateRelease; potpun → objavi (beta = pre-release, stabilno ne)', async () => {
    const g = lazniGithub([BETA2_OBJAVLJEN]);
    await assert.rejects(objaviNacrt({ github: g, repo: REPO, tag: 'v4.8.0-beta.2', verzija: '4.8.0-beta.2', beta: true, id: String(BETA2_OBJAVLJEN.id) }),
        /NIJE potpun[\s\S]*latest-mac\.yml/);
    assert.deepEqual(g.pozivi, []);

    for (const [v, beta] of [['4.8.0-beta.3', true], ['4.8.0', false]]) {
        const g2 = lazniGithub([{ id: 42, tag_name: `v${v}`, draft: true, assets: obavezniFajlovi(v) }]);
        await objaviNacrt({ github: g2, repo: REPO, tag: `v${v}`, verzija: v, beta, id: '42' });
        assert.deepEqual(g2.pozivi, [['updateRelease', { ...REPO, release_id: 42, draft: false, prerelease: beta }]]);
    }
});

test('IZD.14 pripremi: beta*.yml = kopije latest*.yml; pada s jasnom porukom kad fajl fali, viška ima ili yml ne odgovara', () => {
    const v = '4.8.0-beta.3';
    const dir = folderGradnji(v);
    const r = pripremi(dir, v);
    assert.equal(r.ok, true, r.poruka);
    assert.deepEqual(r.fajlovi, obavezniFajlovi(v));
    assert.equal(fs.readFileSync(path.join(dir, 'beta.yml'), 'utf8'), fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(dir, 'beta-mac.yml'), 'utf8'), fs.readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8'));
    assert.deepEqual(procitajOpis(fs.readFileSync(path.join(dir, 'beta-mac.yml'), 'utf8')),
        { verzija: v, fajlovi: [`Vault-aiERP-${v}-x64.dmg`, `Vault-aiERP-${v}-arm64.dmg`] });

    const slucajevi = [
        [{ bez: ['latest-mac.yml'] }, /nedostaju: beta-mac\.yml, latest-mac\.yml/],
        [{ bez: [`Vault-aiERP-Setup-${v}.exe.blockmap`] }, /nedostaju: Vault-aiERP-Setup-4\.8\.0-beta\.3\.exe\.blockmap/],
        [{ dodaj: { 'builder-debug.yml': 'x' } }, /višak .*builder-debug\.yml/],
        [{ ymlVerzija: '4.8.0-beta.2' }, /latest\.yml nosi verziju 4\.8\.0-beta\.2, a izdanje je 4\.8\.0-beta\.3/],
        [{ bez: [`Vault-aiERP-${v}-arm64.dmg`] }, /latest-mac\.yml pokazuje na Vault-aiERP-4\.8\.0-beta\.3-arm64\.dmg, a tog fajla nema/],
    ];
    for (const [o, poruka] of slucajevi) {
        const x = pripremi(folderGradnji(v, o), v);
        assert.equal(x.ok, false, JSON.stringify(o));
        assert.match(x.poruka, /NIJE potpuno — ništa se ne otprema/);
        assert.match(x.poruka, poruka);
    }
});
