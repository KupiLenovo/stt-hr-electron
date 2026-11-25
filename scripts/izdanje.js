#!/usr/bin/env node
// Izdanje desktop aplikacije (PLT-22) — sve što build.yml radi s GitHub izdanjem, kao čist, testiran Node (test/izdanje.test.js).
//
//   1. provjera taga: tag mora biti tačno v<verzija iz package.json>; verzija s nastavkom „-beta.N" je probno izdanje (objavljuje se
//      kao pre-release i vide ga samo računari na beta kanalu). Dozvoljen je samo nastavak beta.
//   2. pripremi (posao `nacrt`, poslije obje gradnje): fajlovi iz Windows i Mac gradnje u jednom folderu → doda fajlove beta kanala
//      (beta.yml, beta-mac.yml) i provjeri da je TAČNO spisak obaveznih fajlova, da yml nose ovu verziju i pokazuju na fajlove iz foldera.
//   3. napraviNacrt (posao `nacrt`): JEDAN nacrt izdanja za tag — napravi ga ili preuzme jedini postojeći nacrt tog taga — i otpremi fajlove.
//   4. objaviNacrt (posao `objavi`, okruženje `izdanje` = Eldinovo odobrenje): prije objave provjeri da je za tag tačno to jedno izdanje i
//      da ima SVE obavezne fajlove; inače pada i ništa ne objavljuje.
//
// Zašto ovako (v4.8.0-beta.2, 25.11.2026): gradnje su same otpremale na GitHub (`--publish always`) i electron-builder je za isti tag
// napravio DVA nacrta (458504890 i 458504892 — uzastopni id-ovi, napravljeni istovremeno: svaki electron-builderov „publisher" sam traži
// nacrt, ne nađe ga i napravi svoj; `created_at` izdanja je datum commita, ne trenutak pravljenja). Objava je uzela prvi nacrt s tim
// tagom (Setup .exe + latest.yml, bez .blockmap) — Mac fajlovi su ostali u drugom nacrtu, pa Mac kasa ne nalazi ni latest-mac.yml.
// Sad gradnje NE pišu na GitHub (`--publish never`); nacrt pravi i puni samo posao `nacrt`.
//
// Beta kanal: electron-updater na beta kanalu (channel 'beta' + allowPrerelease) za SVAKO izdanje (i stabilno) prvo traži beta.yml
// (Windows) / beta-mac.yml (Mac), a latest*.yml tek kao rezervu kad toga nema. electron-builder za GitHub pravi SAMO latest.yml /
// latest-mac.yml (`generateUpdatesFilesForAllChannels` za GitHub ne važi — app-builder-lib computeChannelNames), pa se beta*.yml ovdje
// prave kao kopije latest*.yml: beta kasa nalazi opis verzije u fajlu svog kanala. Stabilni kanal čita samo zadnje NE-pre-release
// izdanje (GitHub /releases/latest) i njegov latest*.yml — beta izdanje (pre-release) ne vidi.
//
//   node scripts/izdanje.js v4.8.0-beta.3        :: ispiše verzija=… i beta=true|false (za $GITHUB_OUTPUT), izlaz 1 kad ne valja
//   node scripts/izdanje.js --pripremi izdanje   :: folder s fajlovima obje gradnje; izlaz 1 s porukom kad nešto fali ili je višak
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
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

// Fajlovi beta kanala = kopije opisa stabilnog kanala iste platforme (isti sadržaj: verzija, fajlovi, sha512).
const KANALSKI = Object.freeze({ 'beta.yml': 'latest.yml', 'beta-mac.yml': 'latest-mac.yml' });

const razvij = (sablon, v) => String(sablon).replace(/\$\{(\w+)\}/g, (_, k) => (k in v ? v[k] : `\${${k}}`));

/** Arhitekture Mac DMG-a iz package.json (build.mac.target). */
function macArhitekture(pkg = PKG) {
    const t = (pkg.build.mac.target || []).find((x) => (x.target || x) === 'dmg');
    return (t && t.arch) || ['x64'];
}

/**
 * Spisak fajlova koje izdanje MORA imeti: obje platforme (instalacija + .blockmap) i opisi verzije za stabilni i beta kanal.
 * Imena iz package.json (nsis.artifactName, dmg.artifactName) — preimenovanje instalacije mijenja i spisak.
 */
function obavezniFajlovi(verzija, pkg = PKG) {
    const exe = razvij(pkg.build.nsis.artifactName, { version: verzija, ext: 'exe' });
    const dmg = macArhitekture(pkg).map((arch) => razvij(pkg.build.dmg.artifactName, { version: verzija, arch, ext: 'dmg' }));
    return [exe, `${exe}.blockmap`, ...dmg.flatMap((d) => [d, `${d}.blockmap`]), 'latest.yml', 'latest-mac.yml', ...Object.keys(KANALSKI)].sort();
}

/** { nedostaju, visak } za spisak imena fajlova (u folderu ili u izdanju na GitHubu). */
function uporediFajlove(imena, verzija, pkg = PKG) {
    const ima = new Set(imena);
    const treba = obavezniFajlovi(verzija, pkg);
    return { nedostaju: treba.filter((f) => !ima.has(f)), visak: [...ima].filter((f) => !treba.includes(f)).sort() };
}

/** Najjednostavnije čitanje opisa verzije (latest.yml) bez YAML zavisnosti: verzija i svi fajlovi (`url:` i `path:`). */
function procitajOpis(tekst) {
    const t = String(tekst || '');
    const v = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(t);
    const urls = [...t.matchAll(/^\s*-?\s*url:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
    const put = /^path:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(t);
    return { verzija: v ? v[1] : null, fajlovi: [...new Set([...urls, ...(put ? [put[1]] : [])])] };
}

/**
 * Folder sa fajlovima obje gradnje → doda beta*.yml (kopije latest*.yml) i provjeri sve. Ne baca: vraća { ok, poruka, fajlovi }.
 * @param {string} dir
 * @param {string} verzija
 */
function pripremi(dir, verzija, { pkg = PKG } = {}) {
    const greske = [];
    const put = (f) => path.join(dir, f);
    for (const [beta, latest] of Object.entries(KANALSKI)) {
        if (fs.existsSync(put(latest))) fs.copyFileSync(put(latest), put(beta));
    }
    const imena = fs.readdirSync(dir).filter((f) => fs.statSync(put(f)).isFile()).sort();
    const { nedostaju, visak } = uporediFajlove(imena, verzija, pkg);
    if (nedostaju.length) greske.push(`nedostaju: ${nedostaju.join(', ')}`);
    if (visak.length) greske.push(`višak (nije na spisku obaveznih): ${visak.join(', ')}`);
    for (const f of imena) {
        if (fs.statSync(put(f)).size === 0) greske.push(`${f} je prazan`);
    }
    for (const yml of ['latest.yml', 'latest-mac.yml', ...Object.keys(KANALSKI)].filter((f) => imena.includes(f))) {
        const o = procitajOpis(fs.readFileSync(put(yml), 'utf8'));
        if (o.verzija !== verzija) greske.push(`${yml} nosi verziju ${o.verzija || '?'}, a izdanje je ${verzija}`);
        if (!o.fajlovi.length) greske.push(`${yml} ne navodi nijedan fajl`);
        for (const f of o.fajlovi) if (!imena.includes(f)) greske.push(`${yml} pokazuje na ${f}, a tog fajla nema`);
    }
    const ok = greske.length === 0;
    return {
        ok,
        fajlovi: imena,
        poruka: ok ? `Izdanje ${verzija}: svih ${imena.length} fajlova na mjestu (${imena.join(', ')}).`
            : `Izdanje ${verzija} NIJE potpuno — ništa se ne otprema:\n  - ${greske.join('\n  - ')}`,
    };
}

/**
 * Koji nacrt puniti za tag. Jedan nacrt po tagu: nema ga → napravi; tačno jedan nacrt (npr. od ponovljenog pokretanja ili zaostao od
 * ranije) → preuzmi ga; više nacrta ili već objavljeno izdanje s tim tagom → stani (ne pogađa se koji je pravi, ništa se ne briše samo).
 */
function izaberiNacrt(izdanja, tag) {
    const zaTag = (izdanja || []).filter((r) => r.tag_name === tag);
    const objavljena = zaTag.filter((r) => !r.draft);
    if (objavljena.length) {
        return { ok: false, poruka: `Za ${tag} već postoji objavljeno izdanje (id ${objavljena.map((r) => r.id).join(', ')}) — novi tag mora imati novu verziju.` };
    }
    if (zaTag.length > 1) {
        return { ok: false, poruka: `Za ${tag} postoji ${zaTag.length} nacrta (id ${zaTag.map((r) => r.id).join(', ')}). Izdanje mora biti JEDNO — ` +
            'obriši višak nacrta na GitHubu (Releases) pa ponovo pokreni posao `nacrt`.' };
    }
    return zaTag.length === 1 ? { ok: true, akcija: 'koristi', id: zaTag[0].id } : { ok: true, akcija: 'napravi' };
}

/** Provjera prije objave: tačno jedno izdanje za tag, nacrt, sa svim obaveznim (i samo obaveznim) do kraja otpremljenim fajlovima. */
function provjeriZaObjavu(izdanja, tag, id, verzija, pkg = PKG) {
    const zaTag = (izdanja || []).filter((r) => r.tag_name === tag);
    const r = zaTag.find((x) => x.id === id);
    if (!r) return { ok: false, poruka: `Nacrt ${id} za ${tag} ne postoji — ništa nije objavljeno.` };
    if (zaTag.length !== 1) {
        return { ok: false, poruka: `Za ${tag} postoji ${zaTag.length} izdanja/nacrta (id ${zaTag.map((x) => x.id).join(', ')}) — mora biti tačno jedno. Ništa nije objavljeno.` };
    }
    if (!r.draft) return { ok: false, poruka: `Izdanje ${id} za ${tag} nije nacrt (već objavljeno?) — ništa nije objavljeno.` };
    const gotovi = (r.assets || []).filter((a) => a.state === 'uploaded' && a.size > 0).map((a) => a.name);
    const nedovrseni = (r.assets || []).filter((a) => !gotovi.includes(a.name)).map((a) => a.name);
    const { nedostaju, visak } = uporediFajlove(gotovi, verzija, pkg);
    const greske = [];
    if (nedostaju.length) greske.push(`nedostaju: ${nedostaju.join(', ')}`);
    if (nedovrseni.length) greske.push(`nisu do kraja otpremljeni: ${nedovrseni.join(', ')}`);
    if (visak.length) greske.push(`višak: ${visak.join(', ')}`);
    if (greske.length) return { ok: false, poruka: `Nacrt ${id} za ${tag} NIJE potpun — ništa nije objavljeno:\n  - ${greske.join('\n  - ')}` };
    return { ok: true, poruka: `Nacrt ${id} za ${tag}: svih ${gotovi.length} fajlova na mjestu.` };
}

const svaIzdanja = (github, repo) => github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 });

/**
 * Posao `nacrt`: JEDAN nacrt za tag (napravi ili preuzmi jedini postojeći), otpremi fajlove iz `dir` i provjeri rezultat.
 * Nacrt ostaje nacrt (draft: true) — ovaj posao nikad ne objavljuje.
 * @returns {Promise<number>} id nacrta
 */
async function napraviNacrt({ github, repo, tag, verzija, sha, dir, log = () => {} }) {
    const izbor = izaberiNacrt(await svaIzdanja(github, repo), tag);
    if (!izbor.ok) throw new Error(izbor.poruka);
    let id = izbor.id;
    if (izbor.akcija === 'napravi') {
        const { data } = await github.rest.repos.createRelease({ ...repo, tag_name: tag, target_commitish: sha, name: verzija, draft: true, prerelease: false });
        id = data.id;
        log(`Napravljen nacrt ${id} za ${tag}.`);
    } else {
        // preuzet nacrt (npr. ponovljeno pokretanje poslije prekida): stari fajlovi se brišu, pa nacrt nosi samo fajlove ovog builda
        const stari = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: id, per_page: 100 });
        for (const a of stari) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: a.id });
        log(`Preuzet postojeći nacrt ${id} za ${tag} (obrisano starih fajlova: ${stari.length}).`);
    }
    for (const f of obavezniFajlovi(verzija)) {
        const podaci = fs.readFileSync(path.join(dir, f));
        await github.rest.repos.uploadReleaseAsset({ ...repo, release_id: id, name: f, data: podaci,
            headers: { 'content-type': 'application/octet-stream', 'content-length': podaci.length } });
        log(`Otpremljeno: ${f} (${podaci.length} B)`);
    }
    const p = provjeriZaObjavu(await svaIzdanja(github, repo), tag, id, verzija);
    if (!p.ok) throw new Error(p.poruka);
    log(p.poruka);
    return id;
}

/**
 * Posao `objavi` (okruženje `izdanje`): provjeri nacrt pa ga objavi; beta → pre-release (stabilni kanal ga ne vidi).
 * Kad provjera ne prođe, baca grešku i NE zove updateRelease.
 */
async function objaviNacrt({ github, repo, tag, verzija, beta, id, log = () => {} }) {
    const p = provjeriZaObjavu(await svaIzdanja(github, repo), tag, Number(id), verzija);
    if (!p.ok) throw new Error(p.poruka);
    log(p.poruka);
    await github.rest.repos.updateRelease({ ...repo, release_id: Number(id), draft: false, prerelease: !!beta });
    log(`Objavljeno izdanje ${tag}${beta ? ' (beta, pre-release)' : ''}.`);
}

if (require.main === module) {
    if (process.argv[2] === '--pripremi') {
        const r = pripremi(process.argv[3] || 'izdanje', PKG.version);
        (r.ok ? console.log : console.error)(r.poruka);
        process.exit(r.ok ? 0 : 1);
    }
    const r = provjeriTag(process.argv[2] || process.env.GITHUB_REF_NAME, PKG.version);
    if (!r.ok) { console.error(r.poruka); process.exit(1); }
    console.log(`verzija=${r.verzija}`);
    console.log(`beta=${r.beta}`);
}

module.exports = { provjeriTag, obavezniFajlovi, uporediFajlove, procitajOpis, pripremi, izaberiNacrt, provjeriZaObjavu, napraviNacrt, objaviNacrt, KANALSKI };
