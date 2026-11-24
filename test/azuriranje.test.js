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
    assert.deepEqual(potpis.opcijePotpisa(), {});
    assert.deepEqual(dodatakKonfiguraciji(), {});
});

test('AZU.9 uključen potpis: obavezno ime izdavača, provjera potpisa ažuriranja i pad builda bez potpisa', () => {
    assert.throws(() => potpis.opcijePotpisa({ ukljucen: true, publisherName: [] }), /PUBLISHER_NAME/);
    assert.throws(() => potpis.opcijePotpisa({ ukljucen: true, publisherName: '  ' }), /PUBLISHER_NAME/);
    const o = potpis.opcijePotpisa({ ukljucen: true, publisherName: 'Primjer d.o.o.' });
    assert.deepEqual(o, { forceCodeSigning: true, win: { publisherName: ['Primjer d.o.o.'], verifyUpdateCodeSignature: true } });
    // izmjene iz komandne linije se spajaju preko potpisa, ne brišu ga
    const a = argumenti(['--win', '--dir', '-c.directories.output=dist-test', '-c.npmRebuild=false', '-c.win.target=dir']);
    assert.deepEqual(dodatakKonfiguraciji(a.izmjene, o), {
        forceCodeSigning: true, npmRebuild: false, directories: { output: 'dist-test' },
        win: { publisherName: ['Primjer d.o.o.'], verifyUpdateCodeSignature: true, target: 'dir' },
    });
    assert.throws(() => argumenti(['--publish', 'always']), /platformu/);
    assert.throws(() => argumenti(['--win', '--sta']), /Nepoznat argument/);
});
