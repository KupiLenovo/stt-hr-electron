// Generiše sve ikone aplikacije iz build/icon.svg (Vault aiERP, znak „Dvije trake" — R73, 06.11.2026):
//   build/icon_{16,32,48,64,128,256,512,1024}.png, build/icon.png (1024) i build/icon.ico (PNG zapisi 16–256).
// Pokreće se ručno kad se znak promijeni, a PNG/ICO se commitaju — build ih samo koristi.
// Treba Playwright (Chromium) — NIJE zavisnost projekta; koristi se globalna instalacija:
//   NODE_PATH="$(npm root -g)" node scripts/ikone.js
'use strict';
const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'build');
const VELICINE = [16, 32, 48, 64, 128, 256, 512, 1024];
const ICO_VELICINE = [16, 32, 48, 64, 128, 256];

// ICO s PNG zapisima (Windows Vista+): zaglavlje 6 B, po 16 B za svaki zapis, pa PNG podaci redom.
function slozIco(slike) {
    const zaglavlje = Buffer.alloc(6);
    zaglavlje.writeUInt16LE(0, 0);   // rezervisano
    zaglavlje.writeUInt16LE(1, 2);   // tip: ikona
    zaglavlje.writeUInt16LE(slike.length, 4);
    const zapisi = [];
    let pomak = 6 + 16 * slike.length;
    for (const { velicina, png } of slike) {
        const z = Buffer.alloc(16);
        z.writeUInt8(velicina >= 256 ? 0 : velicina, 0);   // 0 znači 256
        z.writeUInt8(velicina >= 256 ? 0 : velicina, 1);
        z.writeUInt8(0, 2);    // paleta
        z.writeUInt8(0, 3);    // rezervisano
        z.writeUInt16LE(1, 4); // ravni
        z.writeUInt16LE(32, 6); // bita po pikselu
        z.writeUInt32LE(png.length, 8);
        z.writeUInt32LE(pomak, 12);
        pomak += png.length;
        zapisi.push(z);
    }
    return Buffer.concat([zaglavlje, ...zapisi, ...slike.map(s => s.png)]);
}

async function main() {
    const { chromium } = require('playwright');
    const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8')
        .replace(/\swidth="\d+"\s+height="\d+"/, '');   // veličinu daje stranica
    const preglednik = await chromium.launch();
    const pngovi = {};
    try {
        for (const v of VELICINE) {
            const stranica = await preglednik.newPage({ viewport: { width: v, height: v }, deviceScaleFactor: 1 });
            await stranica.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}
                svg{display:block;width:${v}px;height:${v}px}</style></head><body>${svg}</body></html>`);
            pngovi[v] = await stranica.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: v, height: v } });
            await stranica.close();
            fs.writeFileSync(path.join(BUILD, `icon_${v}.png`), pngovi[v]);
            console.log(`  icon_${v}.png`);
        }
    } finally {
        await preglednik.close();
    }
    fs.writeFileSync(path.join(BUILD, 'icon.png'), pngovi[1024]);
    console.log('  icon.png (1024)');
    fs.writeFileSync(path.join(BUILD, 'icon.ico'), slozIco(ICO_VELICINE.map(v => ({ velicina: v, png: pngovi[v] }))));
    console.log(`  icon.ico (${ICO_VELICINE.join(', ')})`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { slozIco, VELICINE, ICO_VELICINE };
