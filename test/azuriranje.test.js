// PLT-39 (N-3 ocjene SIS-4) i PLT-22 (beta kanal): ažuriranje samo uz potvrdu korisnika, bez tihe instalacije; aplikacija bez
// administratorskih prava; provjera potpisa ažuriranja pripremljena, ali isključena do certifikata.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { napraviAzuriranje, kanalIz, normalizujKanal, TEKST, KANALI } = require('../lib/azuriranje');
const potpis = require('../scripts/potpis-koda');
const { dodatakKonfiguraciji, argumenti } = require('../scripts/izgradi');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const bezKomentara = (s) => s.split(/\r?\n/).filter((r) => !r.trim().startsWith('//')).join('\n');

// Lažni electron-updater: `channel` setter tiho uključuje allowDowngrade, kao pravi (AppUpdater.set channel).
function lazniUpdater() {
    const u = new EventEmitter();
    u.pozivi = [];
    u._channel = null;
    Object.defineProperty(u, 'channel', { get() { return this._channel; }, set(v) { this._channel = v; this.allowDowngrade = true; } });
    u.checkForUpdates = () => { u.pozivi.push('check'); return Promise.resolve(null); };
    u.downloadUpdate = () => { u.pozivi.push('download'); return Promise.resolve([]); };
    u.quitAndInstall = () => { u.pozivi.push('quitAndInstall'); };
    return u;
}
function lazniDijalog(odgovori = []) {
    const d = { prikazano: [] };
    d.showMessageBox = (_prozor, o) => { d.prikazano.push(o); return Promise.resolve({ response: odgovori.length ? odgovori.shift() : o.cancelId ?? 0 }); };
    return d;
}
const tik = () => new Promise((r) => setImmediate(r));
function napravi({ odgovori, kanal } = {}) {
    const autoUpdater = lazniUpdater();
    const dialog = lazniDijalog(odgovori);
    const poslano = [];
    const a = napraviAzuriranje({ autoUpdater, dialog, prozor: () => null, verzijaAplikacije: () => '4.7.0', kanal,
        posalji: (k, p) => poslano.push(k) });
    return { a, autoUpdater, dialog, poslano };
}

test('AZU.1 zadano: ništa se ne preuzima ni instalira samo; stabilni kanal bez pre-release i bez vraćanja na stariju', () => {
    const { autoUpdater } = napravi();
    assert.equal(autoUpdater.autoDownload, false);
    assert.equal(autoUpdater.autoInstallOnAppQuit, false);
    assert.equal(autoUpdater.channel, 'latest');
    assert.equal(autoUpdater.allowPrerelease, false);
    assert.equal(autoUpdater.allowDowngrade, false);
});

test('AZU.2 nova verzija → pitanje „preuzmi i instaliraj?" (zadano „Ne sada"); „Ne sada" ne preuzima i ne pita ponovo do ručne provjere', async () => {
    const { a, autoUpdater, dialog, poslano } = napravi({ odgovori: [1] });
    autoUpdater.emit('update-available', { version: '4.8.0' });
    await tik();
    assert.equal(dialog.prikazano.length, 1);
    const p = dialog.prikazano[0];
    assert.equal(p.message, 'Nova verzija je dostupna — preuzmi i instaliraj?');
    assert.equal(p.buttons[p.defaultId], TEKST.neSada, 'zadano dugme ne preuzima');
    assert.equal(p.cancelId, p.defaultId);
    assert.match(p.detail, /4\.7\.0/);
    assert.match(p.detail, /4\.8\.0/);
    assert.deepEqual(autoUpdater.pozivi, [], 'bez pristanka nema preuzimanja');
    assert.deepEqual(poslano, ['update-available']);

    autoUpdater.emit('update-available', { version: '4.8.0' });   // automatska provjera iste verzije
    await tik();
    assert.equal(dialog.prikazano.length, 1, 'odbijena verzija ne pita ponovo sama');

    await a.rucnaProvjera();
    autoUpdater.emit('update-available', { version: '4.8.0' });
    await tik();
    assert.equal(dialog.prikazano.length, 2, 'ručna provjera pita ponovo');
});

test('AZU.3 pristanak → preuzimanje; preuzeto → „Instaliraj sada" instalira, „Pri zatvaranju" tek tada uključi instalaciju pri izlazu', async () => {
    for (const [odgovor, ocekivano] of [[0, 'sada'], [1, 'pri_zatvaranju']]) {
        const { autoUpdater, dialog } = napravi({ odgovori: [0, odgovor] });
        autoUpdater.emit('update-available', { version: '4.8.0' });
        await tik(); await tik();
        assert.deepEqual(autoUpdater.pozivi, ['download']);
        assert.equal(autoUpdater.autoInstallOnAppQuit, false, 'prije preuzimanja nema instalacije pri izlazu');
        autoUpdater.emit('update-downloaded', { version: '4.8.0' });
        await tik(); await tik();
        const p = dialog.prikazano[1];
        assert.equal(p.message, TEKST.preuzeta);
        assert.equal(p.buttons[p.defaultId], TEKST.priZatvaranju, 'zadano ne prekida kasu usred naplate');
        if (ocekivano === 'sada') {
            assert.deepEqual(autoUpdater.pozivi, ['download', 'quitAndInstall']);
        } else {
            assert.deepEqual(autoUpdater.pozivi, ['download'], 'nema instalacije odmah');
            assert.equal(autoUpdater.autoInstallOnAppQuit, true);
        }
    }
});

test('AZU.4 zahtjev web aplikacije (install-update) ide kroz ista pitanja — nikad direktno quitAndInstall', async () => {
    const prazno = napravi();
    assert.equal(await prazno.a.zahtjevInstalacije(), false);
    assert.equal(prazno.dialog.prikazano.length, 0);

    const { a, autoUpdater, dialog } = napravi({ odgovori: [1, 1] });
    autoUpdater.emit('update-available', { version: '4.8.0' });
    await tik();
    assert.equal(await a.zahtjevInstalacije(), false, 'odbijeno u dijalogu');
    assert.equal(dialog.prikazano.length, 2);
    assert.equal(dialog.prikazano[1].message, TEKST.dostupna);
    assert.ok(!autoUpdater.pozivi.includes('quitAndInstall'));
});

test('AZU.5 greška: vidljiva samo kad je korisnik pokrenuo provjeru ili preuzimanje', async () => {
    const tiho = napravi();
    tiho.autoUpdater.emit('error', new Error('nema mreže'));
    await tik();
    assert.equal(tiho.dialog.prikazano.length, 0);

    const { autoUpdater, dialog } = napravi({ odgovori: [0] });
    autoUpdater.emit('update-available', { version: '4.8.0' });
    await tik(); await tik();
    autoUpdater.emit('error', new Error('prekinuto preuzimanje'));
    await tik();
    assert.equal(dialog.prikazano.at(-1).type, 'error');
});

test('AZU.6 beta kanal (PLT-22): pre-release dozvoljen, vraćanje na stariju verziju nije; postavka računara ili okoline', () => {
    const { a, autoUpdater, dialog } = napravi({ kanal: 'beta' });
    assert.equal(autoUpdater.channel, 'beta');
    assert.equal(autoUpdater.allowPrerelease, true);
    assert.equal(autoUpdater.allowDowngrade, false, 'channel setter ga uključi — mora se vratiti na false');
    assert.equal(a.kanal(), KANALI.BETA);
    assert.equal(a.promijeniKanal('stabilni'), KANALI.STABILNI);
    assert.equal(autoUpdater.channel, 'latest');
    assert.equal(autoUpdater.allowPrerelease, false);
    assert.equal(autoUpdater.allowDowngrade, false);
    assert.equal(dialog.prikazano.length, 0);

    assert.equal(kanalIz({ konfig: { kanal_azuriranja: 'beta' } }), 'beta');
    assert.equal(kanalIz({ env: { AIERP_KANAL_AZURIRANJA: 'stabilni' }, konfig: { kanal_azuriranja: 'beta' } }), 'stabilni');
    assert.equal(kanalIz({}), 'stabilni');
    for (const x of ['alpha', '', null, 'latest', 'BETA ']) assert.equal(normalizujKanal(x), x === 'BETA ' ? 'beta' : 'stabilni', String(x));
});

test('AZU.7 main.js: nema tihog ažuriranja ni direktne instalacije; kanal računara preživi promjenu firme', () => {
    const kod = bezKomentara(MAIN);
    assert.doesNotMatch(kod, /autoDownload\s*=\s*true/);
    assert.doesNotMatch(kod, /autoInstallOnAppQuit\s*=\s*true/);
    assert.doesNotMatch(kod, /quitAndInstall/, 'instalacija samo kroz lib/azuriranje.js (uz potvrdu)');
    assert.match(kod, /ipcMain\.on\('install-update', \(\) => \{ if \(azuriranje\) azuriranje\.zahtjevInstalacije\(\); \}\)/);
    assert.match(kod, /const \{ portal, kanal_azuriranja \} = konfiguracija\(\);/);
});

test('AZU.8 bez administratorskih prava; productName/appId/name ostaju (userData kase); potpis isključen do certifikata', () => {
    assert.equal(PKG.build.win.requestedExecutionLevel, 'asInvoker');
    assert.doesNotMatch(JSON.stringify(PKG), /requireAdministrator/);
    assert.equal(PKG.name, 'stt-hr');
    assert.equal(PKG.build.appId, 'ba.stt.business');
    assert.equal(PKG.build.productName, 'aiERP');
    assert.doesNotMatch(PKG.description, /STT/);

    assert.equal(potpis.POTPIS_UKLJUCEN, false, 'uključuje se tek kad stigne certifikat (scripts/potpis-koda.js)');
    assert.equal(PKG.build.win.verifyUpdateCodeSignature, false);
    assert.equal(PKG.build.win.publisherName, undefined, 'publisherName ide samo kroz scripts/potpis-koda.js');
    assert.equal(PKG.build.win.signtoolOptions, undefined, 'publisherName ide samo kroz scripts/potpis-koda.js');
    assert.deepEqual(potpis.opcijePotpisa(), {});
    assert.deepEqual(dodatakKonfiguraciji(), {});
});

test('AZU.9 uključen potpis: obavezno ime izdavača, provjera potpisa ažuriranja i pad builda bez potpisa', () => {
    assert.throws(() => potpis.opcijePotpisa({ ukljucen: true, publisherName: [] }), /PUBLISHER_NAME/);
    assert.throws(() => potpis.opcijePotpisa({ ukljucen: true, publisherName: '  ' }), /PUBLISHER_NAME/);
    const o = potpis.opcijePotpisa({ ukljucen: true, publisherName: 'Primjer d.o.o.' });
    // electron-builder 26: publisherName je u win.signtoolOptions (win.publisherName ne prolazi provjeru konfiguracije)
    assert.deepEqual(o, { forceCodeSigning: true, win: { signtoolOptions: { publisherName: ['Primjer d.o.o.'] }, verifyUpdateCodeSignature: true } });
    // izmjene iz komandne linije se spajaju preko potpisa, ne brišu ga
    const a = argumenti(['--win', '--dir', '-c.directories.output=dist-test', '-c.npmRebuild=false', '-c.win.target=dir']);
    assert.deepEqual(dodatakKonfiguraciji(a.izmjene, o), {
        forceCodeSigning: true, npmRebuild: false, directories: { output: 'dist-test' },
        win: { signtoolOptions: { publisherName: ['Primjer d.o.o.'] }, verifyUpdateCodeSignature: true, target: 'dir' },
    });
    assert.throws(() => argumenti(['--publish', 'always']), /platformu/);
    assert.throws(() => argumenti(['--win', '--sta']), /Nepoznat argument/);
});

// ── Beta kanal kroz PRAVI electron-updater (GitHubProvider) nad lažnim GitHubom ─────────────────────────────────────────────
// v4.8.0-beta.2: electron-builder za GitHub pravi samo latest*.yml. Beta kasa (channel 'beta' + allowPrerelease) prvo traži
// beta.yml / beta-mac.yml, pa tek na grešku latest*.yml; objavljeno beta.2 izdanje nije imalo ni latest-mac.yml (Mac fajlovi su ostali
// u drugom nacrtu). Od beta.3 posao `nacrt` (scripts/izdanje.js pripremi) stavlja beta*.yml u SVAKO izdanje.
const { createRequire } = require('node:module');
const os = require('node:os');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const izUpdatera = createRequire(require.resolve('electron-updater/out/AppUpdater.js'));
const semver = izUpdatera('semver');
const { HttpError } = izUpdatera('builder-util-runtime');
const { pripremi, obavezniFajlovi } = require('../scripts/izdanje');

/** Izdanje kakvo pravi posao `nacrt`: fajlovi obje gradnje → pripremi (beta*.yml) → { ime: sadržaj }. */
function izdanjeIzNacrta(v) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azu-izdanje-'));
    const exe = `Vault-aiERP-Setup-${v}.exe`;
    const dmg = (a) => `Vault-aiERP-${v}-${a}.dmg`;
    const fajlovi = {
        [exe]: 'x', [`${exe}.blockmap`]: 'x', [dmg('x64')]: 'x', [`${dmg('x64')}.blockmap`]: 'x', [dmg('arm64')]: 'x', [`${dmg('arm64')}.blockmap`]: 'x',
        'latest.yml': `version: ${v}\nfiles:\n  - url: ${exe}\n    sha512: YQ==\n    size: 1\npath: ${exe}\nsha512: YQ==\nreleaseDate: '2026-11-25T18:42:00.000Z'\n`,
        'latest-mac.yml': `version: ${v}\nfiles:\n  - url: ${dmg('x64')}\n    sha512: Yg==\n    size: 1\n  - url: ${dmg('arm64')}\n    sha512: Yw==\n    size: 1\n` +
            `path: ${dmg('x64')}\nsha512: Yg==\nreleaseDate: '2026-11-25T18:51:00.000Z'\n`,
    };
    for (const [f, s] of Object.entries(fajlovi)) fs.writeFileSync(path.join(dir, f), s);
    const r = pripremi(dir, v);
    assert.equal(r.ok, true, r.poruka);
    return Object.fromEntries(obavezniFajlovi(v).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
}

/** Lažni github.com: objavljena izdanja (najnovije prvo) → releases.atom, /releases/latest (bez pre-release) i preuzimanje fajla. */
function lazniGithubCom(izdanja) {
    const trazeno = [];
    const baza = '/KupiLenovo/stt-hr-electron/releases';
    const odgovor = (put) => {
        if (put === `${baza}.atom`) {
            return '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">' + izdanja.map((r) =>
                `<entry><title>${r.tag}</title><link rel="alternate" type="text/html" href="https://github.com${baza}/tag/${r.tag}"/><content>x</content></entry>`).join('') + '</feed>';
        }
        if (put === `${baza}/latest`) return JSON.stringify({ tag_name: izdanja.find((r) => !r.prerelease).tag });
        const m = new RegExp(`^${baza}/download/([^/]+)/(.+)$`).exec(put);
        const r = m && izdanja.find((x) => x.tag === m[1]);
        if (r && m[2] in r.fajlovi) return r.fajlovi[m[2]];
        throw new HttpError(404, 'Not Found');
    };
    return {
        trazeno,
        request(o) {
            const put = o.path;
            try { const t = odgovor(put); trazeno.push(`200 ${put.replace(baza, '')}`); return Promise.resolve(t); }
            catch (e) { trazeno.push(`404 ${put.replace(baza, '')}`); return Promise.reject(e); }
        },
    };
}

/** Šta kasa nađe: kanal se podesi kroz lib/azuriranje.js (kao u aplikaciji), opis verzije traži pravi GitHubProvider. */
async function provjeraKase({ kanal, platforma, trenutna, izdanja }) {
    const { autoUpdater } = napravi({ kanal });
    const executor = lazniGithubCom(izdanja);
    const p = new GitHubProvider({ provider: 'github', owner: 'KupiLenovo', repo: 'stt-hr-electron' },
        { channel: autoUpdater.channel, allowPrerelease: autoUpdater.allowPrerelease, currentVersion: semver.parse(trenutna), fullChangelog: false },
        { platform: platforma, executor, isUseMultipleRangeRequest: false });
    try {
        const info = await p.getLatestVersion();
        return { verzija: info.version, nova: semver.gt(info.version, trenutna), fajlovi: info.files.map((f) => f.url), trazeno: executor.trazeno };
    } catch (e) {
        return { greska: e.code, trazeno: executor.trazeno };
    }
}

const STABILNO_470 = { tag: 'v4.7.0', prerelease: false, fajlovi: { 'latest.yml': 'version: 4.7.0\nfiles:\n  - url: Vault-aiERP-Setup-4.7.0.exe\n    sha512: YQ==\n    size: 1\npath: Vault-aiERP-Setup-4.7.0.exe\nsha512: YQ==\n',
    'latest-mac.yml': 'version: 4.7.0\nfiles:\n  - url: Vault-aiERP-4.7.0-x64.dmg\n    sha512: YQ==\n    size: 1\npath: Vault-aiERP-4.7.0-x64.dmg\nsha512: YQ==\n' } };

test('AZU.10 beta kanal: kasa (Windows i Mac) nađe novu beta verziju u beta.yml / beta-mac.yml izdanja iz posla `nacrt` — bez rezervnog puta', async () => {
    const izdanja = [{ tag: 'v4.8.0-beta.3', prerelease: true, fajlovi: izdanjeIzNacrta('4.8.0-beta.3') }, STABILNO_470];
    for (const [platforma, yml, fajl] of [['win32', 'beta.yml', 'Vault-aiERP-Setup-4.8.0-beta.3.exe'], ['darwin', 'beta-mac.yml', 'Vault-aiERP-4.8.0-beta.3-x64.dmg']]) {
        const r = await provjeraKase({ kanal: 'beta', platforma, trenutna: '4.8.0-beta.2', izdanja });
        assert.equal(r.greska, undefined, `${platforma}: ${r.trazeno.join(' | ')}`);
        assert.equal(r.verzija, '4.8.0-beta.3');
        assert.equal(r.nova, true);
        assert.ok(r.fajlovi.includes(fajl), `${platforma}: ${r.fajlovi}`);
        assert.deepEqual(r.trazeno, ['200 .atom', `200 /download/v4.8.0-beta.3/${yml}`], `${platforma}: opis verzije iz fajla beta kanala, bez 404`);
    }
    // stabilno izdanje poslije bete: beta kasa ga nađe preko beta.yml (posao nacrt ga stavlja i u stabilna izdanja)
    const r = await provjeraKase({ kanal: 'beta', platforma: 'win32', trenutna: '4.8.0-beta.3',
        izdanja: [{ tag: 'v4.8.0', prerelease: false, fajlovi: izdanjeIzNacrta('4.8.0') }, ...izdanja] });
    assert.equal(r.verzija, '4.8.0');
    assert.deepEqual(r.trazeno, ['200 .atom', '200 /download/v4.8.0/beta.yml']);
});

test('AZU.11 stabilni kanal ne vidi beta izdanja (pre-release): čita samo zadnje stabilno izdanje i latest*.yml', async () => {
    const izdanja = [{ tag: 'v4.8.0-beta.3', prerelease: true, fajlovi: izdanjeIzNacrta('4.8.0-beta.3') }, STABILNO_470];
    for (const platforma of ['win32', 'darwin']) {
        const r = await provjeraKase({ kanal: 'stabilni', platforma, trenutna: '4.7.0', izdanja });
        assert.equal(r.verzija, '4.7.0', platforma);
        assert.equal(r.nova, false);
        assert.ok(r.trazeno.every((x) => !/beta/.test(x)), `${platforma}: ${r.trazeno.join(' | ')}`);
        assert.ok(r.trazeno.includes(`200 /download/v4.7.0/${platforma === 'darwin' ? 'latest-mac.yml' : 'latest.yml'}`));
    }
});

test('AZU.12 dokaz za v4.8.0-beta.2: objavljeno izdanje (samo latest.yml + .exe) — Mac beta kasa ne nađe ništa, Windows tek preko rezerve', async () => {
    const beta2 = { tag: 'v4.8.0-beta.2', prerelease: true, fajlovi: {
        'latest.yml': 'version: 4.8.0-beta.2\nfiles:\n  - url: Vault-aiERP-Setup-4.8.0-beta.2.exe\n    sha512: YQ==\n    size: 1\npath: Vault-aiERP-Setup-4.8.0-beta.2.exe\nsha512: YQ==\n',
        'Vault-aiERP-Setup-4.8.0-beta.2.exe': 'x' } };
    const mac = await provjeraKase({ kanal: 'beta', platforma: 'darwin', trenutna: '4.8.0-beta.1', izdanja: [beta2, STABILNO_470] });
    assert.equal(mac.greska, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
    assert.deepEqual(mac.trazeno, ['200 .atom', '404 /download/v4.8.0-beta.2/beta-mac.yml', '404 /download/v4.8.0-beta.2/latest-mac.yml']);
    const win = await provjeraKase({ kanal: 'beta', platforma: 'win32', trenutna: '4.8.0-beta.1', izdanja: [beta2, STABILNO_470] });
    assert.equal(win.verzija, '4.8.0-beta.2');
    assert.deepEqual(win.trazeno, ['200 .atom', '404 /download/v4.8.0-beta.2/beta.yml', '200 /download/v4.8.0-beta.2/latest.yml']);
});
