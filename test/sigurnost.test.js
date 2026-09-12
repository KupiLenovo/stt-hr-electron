// Sigurnosne brane nad main.js (e2, nezavisna revizija III). Čist Node, čita izvor — kao test/bez-http.test.js.
//
// Nalazi:
//  1. `webSecurity: false` je stajao od prvog commita (2.0.0), kad se UI učitavao s file:// i pozivao cloud server
//     cross-origin. Od 4.2.0 UI dolazi sa servera (same-origin), /api/ping ide kroz main (net.fetch), fiskalni
//     drajver kroz IPC — pa isključena same-origin politika nije služila ničemu, a tuđem sadržaju (iframe, blob:
//     prozor s naslijeđenim preloadom) otvarala je put do fiskalnog printera i lokalne baze kase.
//  2. `executeJavaScript` je ime stranice iz IPC-a umetao golim tekstom u kod.
//  3. Skriveni prozor za štampu zatvarao se samo iz callbacka print() — bez `did-finish-load` ostajao je zauvijek.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
/** Redovi koda bez komentara (komentar smije spominjati staru vrijednost). */
const kod = main.split(/\r?\n/).filter((r) => { const t = r.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');

test('same-origin politika je uključena u glavnom prozoru', () => {
    assert.doesNotMatch(kod, /webSecurity\s*:\s*false/, 'webSecurity: false otvara fiskalni printer i bazu kase tuđem sadržaju');
    assert.match(kod, /webSecurity\s*:\s*true/, 'piše se izričito, da se ne vrati slučajno');
    // nijedan drugi prozor ne smije ni tražiti iznimku
    assert.doesNotMatch(kod, /allowRunningInsecureContent\s*:\s*true/);
    assert.doesNotMatch(kod, /nodeIntegration\s*:\s*true/, 'renderer nikad ne dobija Node');
    assert.doesNotMatch(kod, /contextIsolation\s*:\s*false/);
});

test('ime stranice iz IPC-a ide u JS kao JSON literal, ne golim umetanjem', () => {
    const blok = kod.slice(kod.indexOf('function showSystemNotif'), kod.indexOf("ipcMain.on('save-html'"));
    assert.ok(blok.length > 50, 'showSystemNotif mora postojati');
    assert.match(blok, /JSON\.stringify\(String\(stranica\)\)/, 'apostrof u imenu stranice bi inače postao ubrizgan kod');
    assert.doesNotMatch(blok, /'\$\{stranica\}'/, 'golo umetanje u string literal');
});

test('prozor za štampu se zatvara i kad učitavanje ne uspije', () => {
    const blok = kod.slice(kod.indexOf("ipcMain.on('save-html'"), kod.indexOf("ipcMain.on('system-notif'"));
    assert.match(blok, /did-fail-load/, 'greška učitavanja mora zatvoriti prozor');
    assert.match(blok, /setTimeout\(/, 'i rok, ako ne stigne ni uspjeh ni greška');
    assert.match(blok, /isDestroyed\(\)/, 'zatvaranje ne smije puknuti na već zatvorenom prozoru');
});
