// R62 — PLT-39 N-3 i S-4: aplikacija radi s pravima običnog korisnika (asInvoker), ažuriranje se ne instalira samo
// (korisnik potvrđuje u dijalogu s verzijom), opis aplikacije bez imena firme kupca, verzija podignuta (minor).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('IZD.1 asInvoker — fiskalni drajver je HTTP na lokalnoj mreži, ne traži administratora', () => {
    assert.equal(pkg.build.win.requestedExecutionLevel, 'asInvoker');
    const drajver = fs.readFileSync(path.join(ROOT, 'fiskalni-drajver.js'), 'utf8');
    assert.match(drajver, /require\('http'\)/);
    assert.doesNotMatch(drajver, /child_process|regedit|HKLM/);
});

test('IZD.2 opis i autor bez imena firme kupca (neutralno: „aiERP kasa")', () => {
    assert.equal(pkg.description, 'aiERP kasa');
    for (const v of [pkg.description, pkg.author, pkg.build.copyright, pkg.build.productName, pkg.build.nsis.shortcutName]) {
        assert.doesNotMatch(String(v), /STT|Sarajevo/i, `ime firme kupca u: ${v}`);
    }
    assert.equal(pkg.name, 'stt-hr', 'name se NE mijenja — po njemu je folder userData (profil, keš kase)');
});

test('IZD.3 verzija podignuta (minor) iznad 4.4.0; package-lock i CLAUDE.md usklađeni', () => {
    const [maj, min] = pkg.version.split('.').map(Number);
    assert.ok(maj === 4 && min >= 5, `verzija ${pkg.version}`);
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.match(fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8'), new RegExp(`\\*\\*Verzija:\\*\\* ${pkg.version.replace(/\./g, '\\.')}`));
});

function lazniUpdater() {
    const u = new EventEmitter();
    u.instalirano = 0;
    u.provjera = 0;
    u.quitAndInstall = () => { u.instalirano++; };
    u.checkForUpdates = () => { u.provjera++; return Promise.resolve(); };
    u.setFeedURL = () => {};
    return u;
}
function lazniDijalog(odgovor) {
    const d = { pitanja: [] };
    d.showMessageBox = async (_w, o) => { d.pitanja.push(o); return { response: typeof odgovor === 'function' ? odgovor(o) : odgovor }; };
    return d;
}
const tick = () => new Promise((r) => setImmediate(r));

test('IZD.4 ažuriranje se ne instalira samo: bez tihe instalacije na izlazu, dijalog s verzijom; „Kasnije" ne instalira', async () => {
    const { napraviAzuriranje } = require('../lib/azuriranje');
    const au = lazniUpdater();
    const dlg = lazniDijalog(1);   // Kasnije
    const poslano = [];
    napraviAzuriranje({ autoUpdater: au, dialog: dlg, prozor: () => null, verzijaAplikacije: () => '4.5.0', posalji: (k, v) => poslano.push(k) });
    assert.equal(au.autoInstallOnAppQuit, false, 'nikad tiha instalacija pri zatvaranju');
    au.emit('update-downloaded', { version: '4.6.0' });
    await tick();
    assert.equal(dlg.pitanja.length, 1, 'i bez ručne provjere korisnik dobija pitanje');
    assert.match(dlg.pitanja[0].message + dlg.pitanja[0].detail, /4\.6\.0/);
    assert.match(dlg.pitanja[0].detail, /4\.5\.0/);
    assert.equal(dlg.pitanja[0].buttons.length, 2);
    assert.equal(dlg.pitanja[0].cancelId, 1);
    assert.equal(au.instalirano, 0);
    assert.ok(poslano.includes('update-downloaded'));
});

test('IZD.5 „Instaliraj sada" → quitAndInstall; zahtjev iz web aplikacije (install-update) i dalje traži potvrdu', async () => {
    const { napraviAzuriranje } = require('../lib/azuriranje');
    const au = lazniUpdater();
    const dlg = lazniDijalog(0);
    const az = napraviAzuriranje({ autoUpdater: au, dialog: dlg, prozor: () => null, verzijaAplikacije: () => '4.5.0', posalji: () => {} });
    assert.equal(await az.zahtjevInstalacije(), false, 'ništa preuzeto → ništa za instalirati, bez dijaloga');
    assert.equal(dlg.pitanja.length, 0);
    au.emit('update-downloaded', { version: '4.6.0' });
    await tick();
    assert.equal(au.instalirano, 1);
    const au2 = lazniUpdater();
    let pitaj = 1;
    const dlg2 = lazniDijalog(() => pitaj);
    const az2 = napraviAzuriranje({ autoUpdater: au2, dialog: dlg2, prozor: () => null, verzijaAplikacije: () => '4.5.0', posalji: () => {} });
    au2.emit('update-downloaded', { version: '4.6.0' });   // Kasnije
    await tick();
    pitaj = 0;
    assert.equal(await az2.zahtjevInstalacije(), true);
    assert.equal(dlg2.pitanja.length, 2, 'install-update iz renderera ide kroz isti dijalog');
    assert.equal(au2.instalirano, 1);
});

test('IZD.6 main.js: ažuriranje iz lib/azuriranje.js, install-update ne zove quitAndInstall direktno', () => {
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.match(main, /require\('\.\/lib\/azuriranje'\)/);
    assert.doesNotMatch(main, /autoInstallOnAppQuit\s*=\s*true/);
    assert.doesNotMatch(main, /ipcMain\.on\('install-update',[^;]*quitAndInstall/);
});
