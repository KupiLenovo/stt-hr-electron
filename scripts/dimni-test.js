#!/usr/bin/env node
// Dimni test (PLT-22): pokreni aplikaciju s `--smoke` i provjeri da izađe s 0 i ispiše „DIMNI TEST OK" (lib/dimni-test.js).
//
//   node scripts/dimni-test.js                          :: iz koda (node_modules/electron)
//   node scripts/dimni-test.js dist/win-unpacked/aiERP.exe   :: spakovana aplikacija (build.yml, poslije pakovanja)
//
// Linux bez ekrana: sam se umota u xvfb-run (ako postoji). Kao root Chromium traži --no-sandbox (samo za probu u kontejneru).
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ROK_MS = 120000;

function komanda(argv) {
    const exe = argv[0];
    const dodatno = ['--smoke'];
    if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) dodatno.push('--no-sandbox');
    let cmd; let args;
    if (exe) {
        if (!fs.existsSync(exe)) throw new Error(`Nema spakovane aplikacije: ${exe}`);
        cmd = path.resolve(exe); args = dodatno;
    } else {
        cmd = require('electron'); args = [ROOT, ...dodatno];   // u Node-u require('electron') vraća putanju do binarnog fajla
    }
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        return { cmd: 'xvfb-run', args: ['-a', cmd, ...args] };
    }
    return { cmd, args };
}

function main() {
    const { cmd, args } = komanda(process.argv.slice(2));
    const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-aierp-dimni-'));
    const env = { ...process.env, AIERP_DIMNI_PROFIL: profil };   // privremeni profil — pravi profil kase se ne dira
    delete env.ELECTRON_RUN_AS_NODE;   // inače se binarni fajl ponaša kao Node, a ne kao aplikacija
    const pocisti = () => { try { fs.rmSync(profil, { recursive: true, force: true }); } catch { /* temp — nije kritično */ } };
    const dijete = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let ispis = '';
    dijete.stdout.on('data', (d) => { ispis += d; process.stdout.write(d); });
    dijete.stderr.on('data', (d) => { if (process.env.DIMNI_DETALJI) process.stderr.write(d); });
    const rok = setTimeout(() => { console.error(`Dimni test: rok ${ROK_MS / 1000} s istekao — gasim aplikaciju.`); dijete.kill('SIGKILL'); }, ROK_MS);
    dijete.on('error', (e) => { clearTimeout(rok); pocisti(); console.error(`Dimni test: ne mogu pokrenuti ${cmd}: ${e.message}`); process.exit(1); });
    dijete.on('exit', (kod, signal) => {
        clearTimeout(rok);
        let izFajla = '';
        try { izFajla = fs.readFileSync(path.join(profil, 'dimni-rezultat.txt'), 'utf8'); } catch { /* aplikacija nije stigla upisati */ }
        if (izFajla && !ispis.includes('DIMNI TEST')) process.stdout.write(izFajla);
        pocisti();
        const ok = kod === 0 && /DIMNI TEST OK/.test(ispis + izFajla);
        console.log(ok ? 'Dimni test prošao (izlaz 0).' : `Dimni test PAO (izlaz ${kod}${signal ? `, signal ${signal}` : ''}).`);
        process.exit(ok ? 0 : 1);
    });
}

if (require.main === module) {
    try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { komanda };
