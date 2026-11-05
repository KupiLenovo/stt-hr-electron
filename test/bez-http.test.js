// Nijedan fajl koji se PAKUJE ne smije graditi nešifrovanu (http://) adresu servera.
//
// Zašto: do v4.1.3 je adresa bila zakucana na `http://46.101.96.28:3737` — PIN i token su išli internetom
// kao čist tekst. Od v4.2.0 svaka adresa prolazi kroz `lib/server-adresa.js`, koji http odbija (osim
// localhosta). Ali u repou je do ovog testa stajao i `app/index.html` — stari, ugrađeni klijent koji je
// sam sastavljao `http://${ip}:3737`. Nije se pakovao (nije u `build.files`), pa nije bio opasan danas,
// ali jeste bio zamka: dovoljno je da ga neko jednom vrati u `files` ili prekopira komad koda.
// Fajl je obrisan, a ovaj test drži da se takav put ne vrati.
//
// Test čita `build.files` iz package.json — dakle tačno ono što ide u instalaciju, ne cijeli repo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KORIJEN = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(KORIJEN, 'package.json'), 'utf8'));

// Lokalne adrese su dozvoljene (fiskalni drajver je na localhost:8085, razvoj na localhost:3737).
const LOKALNO = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;
// Jedini dozvoljen izuzetak: stara adresa (4.0–4.1.3) kao KONSTANTA u lib/server-adresa.js. Ne koristi se za
// vezu — od 4.6.0 samo kao trag prelaza u zapisu (prelaz_sa); normalizujAdresu je ionako odbija (http).
const IZUZETAK = { fajl: 'lib/server-adresa.js', url: 'http://46.101.96.28:3737' };

/** Fajlovi iz `build.files` (podržani su i `lib/**\/*` obrasci). Vraća pune putanje. */
function fajloviIzBuilda() {
    const out = [];
    for (const uzorak of pkg.build.files) {
        const bezZvjezdica = uzorak.replace(/\/\*\*\/\*$/, '');
        const p = path.join(KORIJEN, bezZvjezdica);
        if (!fs.existsSync(p)) continue;
        if (fs.statSync(p).isDirectory()) {
            (function obidji(dir) {
                for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                    const puna = path.join(dir, f.name);
                    if (f.isDirectory()) obidji(puna);
                    else if (/\.(js|html|json)$/i.test(f.name)) out.push(puna);
                }
            })(p);
        } else out.push(p);
    }
    return out;
}

/** Redovi bez komentara — komentar smije spominjati staru adresu (to je historija, ne kod). */
function kodneLinije(tekst) {
    return tekst.split(/\r?\n/).map((red, i) => ({ red, broj: i + 1 }))
        .filter(({ red }) => {
            const t = red.trim();
            return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('<!--');
        });
}

test('u instalaciji nema nešifrovane (http://) adrese servera', () => {
    const fajlovi = fajloviIzBuilda();
    assert.ok(fajlovi.length >= 5, `očekivano je bar 5 fajlova u build.files, nađeno ${fajlovi.length}`);
    const nalazi = [];
    for (const f of fajlovi) {
        for (const { red, broj } of kodneLinije(fs.readFileSync(f, 'utf8'))) {
            for (const m of red.matchAll(/https?:\/\/[^\s'"`)<>]*/gi)) {
                const url = m[0];
                const rel = path.relative(KORIJEN, f).replace(/\\/g, '/');
                if (!/^http:/i.test(url) || LOKALNO.test(url)) continue;
                if (!/^http:\/\/[^/]/i.test(url)) continue;                       // „http://" u tekstu poruke, bez hosta
                if (rel === IZUZETAK.fajl && url === IZUZETAK.url) continue;      // dokumentovan izuzetak (vidi gore)
                nalazi.push(`${rel}:${broj} → ${url}`);
            }
        }
    }
    assert.deepEqual(nalazi, [], 'nešifrovana adresa u kodu koji se pakuje — PIN i token bi išli kao čist tekst');
});

test('stari ugrađeni klijent (app/index.html) je obrisan i ne pakuje se', () => {
    assert.equal(fs.existsSync(path.join(KORIJEN, 'app', 'index.html')), false,
        'app/index.html je sam sastavljao http://IP:3737 mimo lib/server-adresa.js');
    assert.equal(pkg.build.files.some((f) => f.startsWith('app')), false, 'app/ ne smije ući u build.files');
});

test('stara (http) adresa je samo trag prelaza u zapisu, nikad veza (4.6.0)', () => {
    // 4.6.0 (odluka Eldina 05.11.2026 (10)): prelaz 4.1.x više ne čita localStorage starog origina i ne ide ni na jedan server —
    // STARI_SERVER smije stajati samo u zapisu o prelazu (prelaz_sa) i u require-u; nikad u loadURL, net.fetch ni naOriginu.
    const main = fs.readFileSync(path.join(KORIJEN, 'main.js'), 'utf8');
    const upotrebe = kodneLinije(main).filter(({ red }) => /\bSTARI_SERVER\b/.test(red));
    assert.ok(upotrebe.length > 0, 'trag prelaza sa 4.1.x postoji');
    for (const { red, broj } of upotrebe) {
        assert.ok(/prelaz_sa: STARI_SERVER|require\(/.test(red), `main.js:${broj}: stara adresa smije ići samo u zapis o prelazu — ${red.trim()}`);
    }
    assert.doesNotMatch(main, /naOriginu|prelazSaStareVerzije/, 'prenos localStorage na server jedne firme je uklonjen');
});

test('4.6.0: u instalaciji nema adrese ni rezervne putanje jedne firme (app.aierp.ba, STT_SERVER)', () => {
    // Proizvod se prodaje firmama — isti exe ne smije tiho voditi na server STT-a (ni u komentaru, da se ne vrati „kao primjer").
    // STT_SERVER_URL (okruženje, samo za razvoj) ostaje.
    const nalazi = [];
    for (const f of fajloviIzBuilda()) {
        const rel = path.relative(KORIJEN, f).replace(/\\/g, '/');
        fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((red, i) => {
            if (/app\.aierp\.ba/i.test(red) || /\bSTT_SERVER\b(?!_URL)/.test(red)) nalazi.push(`${rel}:${i + 1} → ${red.trim()}`);
        });
    }
    assert.deepEqual(nalazi, []);
});

test('adresa servera se dobija samo kroz lib/server-adresa.js', () => {
    // Druga brana istom nalazu: čak i da neko doda novi ekran, adresa mora proći kroz normalizaciju
    // (koja odbija http za sve osim localhosta) — ne smije se sklapati iz IP-a i porta.
    const main = fs.readFileSync(path.join(KORIJEN, 'main.js'), 'utf8');
    assert.match(main, /require\(['"]\.\/lib\/server-adresa['"]\)/, 'main.js mora koristiti lib/server-adresa');
    const sklapanje = kodneLinije(main).filter(({ red }) => /`https?:\/\/\$\{/.test(red));
    assert.deepEqual(sklapanje.map((x) => x.broj), [], 'adresa se ne sklapa u stringu — ide kroz normalizujAdresu');
});
