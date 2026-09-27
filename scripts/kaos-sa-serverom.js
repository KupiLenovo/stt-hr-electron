// JEDNOKRATNA lokalna provjera (NE ide u CI ni u npm test): 10 offline računa iz desktop kase stiže na PRAVI aiERP server tačno jednom.
//
// Pokreće pravi stt-hr-server (node server.js) na PRIVREMENOJ bazi i slobodnom portu (NODE_ENV=test → demo radnici s PIN-om 0000),
// kroz API napravi kasu (maloprodajno skladište), artikal, novog radnika (privremeni PIN → svoj PIN) i otvori smjenu. Zatim desktop
// (pravi fiskalni-drajver.js + lib/fiskalni-most.js + lib/pos-kes.js, uređaj = test/helpers/tring-simulator.js) naplati 10 računa
// BEZ interneta (server nedostupan → red u pos-kes.db), pa kad server „dođe" red ide kroz sync kase (ogledalo pos.tsx) na
// POST /api/v1/maloprodaja/racuni/sync. Tvrdi: server ima tačno 10 računa, svi fiskalizovani s brojem s trake uređaja; ponovni sync
// i ponovno slanje istih računa (izgubljen odgovor) ne dupliraju ništa.
//
//   node scripts/kaos-sa-serverom.js                 (server repo u ../stt-hr-server)
//   STT_HR_SERVER=/put/do/stt-hr-server node scripts/kaos-sa-serverom.js
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { napraviSimulator } = require('../test/helpers/tring-simulator');
const { napraviDriver } = require('../test/helpers/sqlite');

const SERVER_REPO = path.resolve(process.env.STT_HR_SERVER || path.join(__dirname, '..', '..', 'stt-hr-server'));
const BROJ = 10;

const slobodanPort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const cekaj = (ms) => new Promise((r) => setTimeout(r, ms));
function provjeri(uslov, poruka) { if (!uslov) throw new Error(poruka); console.log('  ✔ ' + poruka); }

async function api(baza, putanja, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(baza + putanja, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    if (!r.ok) throw new Error(`${method} ${putanja} → HTTP ${r.status}: ${typeof j === 'string' ? j.slice(0, 300) : JSON.stringify(j)}`);
    return j;
}
// Prijava PIN-om kroz pravi tok: privremeni PIN → postavi svoj → Bearer (bez_kolacica, kao POS-tokovi).
async function prijava(baza, radnikId, privremeni, novi) {
    await api(baza, '/api/auth/pin', { method: 'POST', body: { radnik_id: radnikId, pin: privremeni, bez_kolacica: true } });
    const r = await api(baza, '/api/auth/pin/postavi', { method: 'POST', body: { radnik_id: radnikId, stari_pin: privremeni, novi_pin: novi, bez_kolacica: true } });
    if (!r || !r.token) throw new Error(`prijava radnika ${radnikId} nije dala token`);
    return r.token;
}

async function main() {
    if (!fs.existsSync(path.join(SERVER_REPO, 'server.js'))) throw new Error(`Nema stt-hr-server u ${SERVER_REPO} (postavi STT_HR_SERVER).`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaos-sa-serverom-'));
    const port = await slobodanPort();
    const baza = `http://127.0.0.1:${port}`;
    console.log(`→ pokrećem stt-hr-server (${SERVER_REPO}) na ${baza}, baza ${tmp}/server.db`);
    const log = fs.openSync(path.join(tmp, 'server.log'), 'w');
    const srv = spawn(process.execPath, ['server.js'], {
        cwd: SERVER_REPO,
        env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DB_PATH: path.join(tmp, 'server.db'), UPLOADS_DIR: path.join(tmp, 'uploads'),
            JWT_SECRET: 'kaos-sa-serverom-jwt-tajna-1234567890', TOTP_KLJUC: 'kaos-sa-serverom-totp-kljuc-1234567890' },
        stdio: ['ignore', log, log],
    });
    let sim = null;
    let greska = null;
    try {
        for (let i = 0; ; i++) {
            try { const p = await api(baza, '/api/ping'); if (p && p.ok) break; } catch { /* još se diže */ }
            if (srv.exitCode != null) throw new Error(`server je izašao (kod ${srv.exitCode}) — vidi ${tmp}/server.log`);
            if (i > 300) throw new Error('server se nije digao za 60 s');
            await cekaj(200);
        }
        console.log('✔ server radi');

        // ---- postavka kroz API ----
        const admin = await prijava(baza, 1, '0000', '4826');   // demo admin (NODE_ENV=test), početni PIN
        const pozicije = await api(baza, '/api/pozicije', { token: admin });
        const pozicijaId = (Array.isArray(pozicije) ? pozicije : pozicije.items || [])[0].id;
        const noviRadnik = await api(baza, '/api/radnici', { method: 'POST', token: admin, body: { ime: 'Kaos', prezime: 'Kasir', pozicija_id: pozicijaId, lokacija_id: 1, datum_zaposlenja: '2026-09-01', uloga: 'radnik' } });
        const kasir = await prijava(baza, noviRadnik.id, noviRadnik.privremeni_pin, '5937');
        const kasa = await api(baza, '/api/v1/skladista', { method: 'POST', token: admin, body: { sifra: 'KAOS-KASA', naziv: 'Kaos kasa', tip: 'maloprodaja', lokacija_id: 1 } });
        const tarife = await api(baza, '/api/v1/tarife', { token: admin });
        let tarifa = (Array.isArray(tarife) ? tarife : tarife.items || []).find((t) => Number(t.stopa) === 1700);
        if (!tarifa) tarifa = await api(baza, '/api/v1/tarife', { method: 'POST', token: admin, body: { sifra: 'KAOS17', naziv: 'PDV 17%', stopa: 1700 } });
        const artikal = await api(baza, '/api/v1/artikli', { method: 'POST', token: admin, body: { sifra: 'KAOS-ART', naziv: 'Kaos artikal', tarifa_id: tarifa.id, jm: 'kom' } });
        const smjena = await api(baza, '/api/v1/maloprodaja/smjena/otvori', { method: 'POST', token: kasir, body: { skladiste_id: kasa.id, pocetni_fond_fening: 0 } });
        console.log(`✔ kasa #${kasa.id}, artikal #${artikal.id}, radnik #${noviRadnik.id} (svoj PIN), smjena #${smjena.id}`);

        // ---- desktop: uređaj (simulator) + pos-kes.db + fiskalni most ----
        sim = napraviSimulator();
        process.env.TRING_HOST = '127.0.0.1';
        process.env.TRING_PORT = String(await sim.start());
        process.env.TRING_TIMEOUT_MS = '2000';
        const { pokreniAplikaciju, sinhronizuj } = require('../test/helpers/kasa');
        const userData = path.join(tmp, 'userData');   // %APPDATA%\stt-hr — Electron ga napravi sam
        fs.mkdirSync(userData, { recursive: true });
        const app = pokreniAplikaciju(userData, napraviDriver());
        await app.most.pokretanje(Date.now() + 46000);
        const mrtav = `http://127.0.0.1:${await slobodanPort()}`;   // „nema interneta": na ovom portu niko ne sluša

        const uidovi = [];
        for (let i = 0; i < BROJ; i++) {
            const uid = `kaos-srv-${Date.now()}-${i}`;
            const cijena = 150 + i * 10;
            const placanja = i % 3 === 0 ? [{ vrsta: 'Kartica', iznos_fening: cijena }] : [{ vrsta: 'Gotovina', iznos_fening: cijena }];
            // tijelo računa kao pos.tsx (racunBody) — ide u lokalni red PRIJE naplate jer server nije dostupan
            const racunBody = { lokalni_uid: uid, skladiste_id: kasa.id, smjena_id: smjena.id, stavke: [{ artikal_id: artikal.id, naziv: 'Kaos artikal', jm: 'kom', cijena_fening: cijena, rabat_bp: 0, stopa_oznaka: 'E', kolicina_mili: 1000 }], placanja };
            app.posKes.dodajURed(racunBody);
            const r = await app.naplati({ lokalni_uid: uid, racun_id: null, skladiste_id: kasa.id, smjena_id: smjena.id, tip: 'fiskalni', kanal: 'mp',
                stavke: [{ naziv: uid, jm: 'kom', cijena_fening: cijena, stopa_oznaka: 'E', kolicina_mili: 1000 }], placanja, iznos_fening: cijena, payload: racunBody });
            if (r.ishod !== 'fiskalizovan') throw new Error(`naplata ${uid}: ${r.ishod}`);
            const bez = await sinhronizuj(app.posKes, mrtav, { token: kasir, cekanjeMs: 1000 });
            if (!bez.prekid) throw new Error('sync bez interneta nije smio proći');
            uidovi.push(uid);
        }
        provjeri(app.posKes.nesinhronizovaniBroj() === BROJ, `${BROJ} fiskalizovanih računa čeka u redu na disku kase (server nedostupan)`);

        // ---- internet se vratio ----
        const s1 = await sinhronizuj(app.posKes, baza, { token: kasir });
        provjeri(s1.ok === BROJ && !s1.pali.length, `sync: server prihvatio ${s1.ok}/${BROJ}${s1.pali.length ? ' — pali: ' + s1.pali.join('; ') : ''}`);
        provjeri(app.posKes.nesinhronizovaniBroj() === 0, 'red na disku je prazan');
        const s2 = await sinhronizuj(app.posKes, baza, { token: kasir });
        provjeri(s2.poslano === 0, 'ponovni sync nema šta slati');
        // izgubljen odgovor servera: kasa isti red pošalje još jednom → server prepozna po lokalni_uid
        const ponovo = uidovi.map((uid) => ({ ...JSON.parse(app.posKes.redRacuna(uid).payload), lokalni_uid: uid, fiskalni_status: 'fiskalizovan', fiskalni_broj: app.posKes.redRacuna(uid).fiskalni_broj, fiskalni_drajver: 'tring', fiskalni_potvrda: 'uredjaj' }));
        const dup = await api(baza, '/api/v1/maloprodaja/racuni/sync', { method: 'POST', token: kasir, body: { racuni: ponovo } });
        provjeri(dup.rezultati.every((x) => x.postojeci === true), 'ponovljeno slanje istih 10 računa: server ih prepoznaje (postojeci), ne pravi nove');

        const lista = await api(baza, `/api/v1/maloprodaja/racuni?skladiste_id=${kasa.id}&limit=200`, { token: admin });
        provjeri(lista.total === BROJ, `server ima TAČNO ${BROJ} računa za kasu (ima ${lista.total})`);
        const poUid = new Map(lista.items.map((x) => [x.lokalni_uid, x]));
        provjeri(uidovi.every((u) => poUid.has(u)), 'svaki lokalni_uid je na serveru');
        provjeri(new Set(lista.items.map((x) => x.lokalni_uid)).size === BROJ, 'nijedan lokalni_uid nije dupliran');
        provjeri(lista.items.every((x) => x.fiskalni_status === 'fiskalizovan'), 'svi su fiskalizovani');
        const naTraci = (uid) => sim.racuniZa(uid)[0];
        provjeri(uidovi.every((u) => naTraci(u) && String(naTraci(u).broj) === String(poUid.get(u).fiskalni_broj)), 'fiskalni broj na serveru = broj na traci uređaja');
        provjeri(sim.traka.length === BROJ, `uređaj je odštampao tačno ${BROJ} računa`);
        console.log(`\n✔ ${BROJ} offline računa stiglo na pravi server tačno jednom.`);

        // ---- dodatno: pad aplikacije usred štampe, uređaj ne odgovara pri startu → server račun vodi kao „nepoznato", ne „čeka" ----
        const uidPad = `kaos-srv-pad-${Date.now()}`;
        const tijelo = { lokalni_uid: uidPad, skladiste_id: kasa.id, smjena_id: smjena.id, stavke: [{ artikal_id: artikal.id, naziv: 'Kaos artikal', jm: 'kom', cijena_fening: 990, rabat_bp: 0, stopa_oznaka: 'E', kolicina_mili: 1000 }], placanja: [{ vrsta: 'Gotovina', iznos_fening: 990 }] };
        app.posKes.dodajURed(tijelo);
        const pad = await app.naplati({ lokalni_uid: uidPad, skladiste_id: kasa.id, smjena_id: smjena.id, tip: 'fiskalni', kanal: 'mp',
            stavke: [{ naziv: uidPad, jm: 'kom', cijena_fening: 990, stopa_oznaka: 'E', kolicina_mili: 1000 }], placanja: tijelo.placanja, iznos_fening: 990, payload: tijelo }, 'poslije_stampe');
        provjeri(!!pad.krah && sim.racuniZa(uidPad).length === 1, 'uređaj odštampao, aplikacija pala prije upisa rezultata');
        await sim.ugasi();
        const app2 = pokreniAplikaciju(userData, napraviDriver());
        const start = await app2.most.pokretanje(Date.now() + 46000);
        provjeri(start.zateceno.nepoznato === 1 && start.nedostupno, 'pri startu: zatečen red → nepoznato, uređaj ne odgovara');
        await sinhronizuj(app2.posKes, baza, { token: kasir });
        const ceka = await api(baza, `/api/v1/maloprodaja/racuni?skladiste_id=${kasa.id}&fiskalni_status=ceka`, { token: admin });
        const nep = await api(baza, `/api/v1/maloprodaja/racuni?skladiste_id=${kasa.id}&fiskalni_status=nepoznato`, { token: admin });
        provjeri(!ceka.items.some((x) => x.lokalni_uid === uidPad), 'server ga NE nudi za „Fiskalizuj sve" (nema drugog računa na uređaju)');
        provjeri(nep.items.some((x) => x.lokalni_uid === uidPad && x.fiskalni_pokusaj_at), 'server ga vodi kao „nepoznato" s vremenom pokušaja (za „Provjeri na uređaju")');
        console.log('\n✔ GOTOVO.');
    } catch (e) {
        greska = e;
    } finally {
        if (sim) await sim.stop();
        srv.kill();
        await cekaj(300);
        if (!greska) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows */ } }
    }
    if (greska) { console.error(`\n⛔ ${greska.message}\n   (server log: ${tmp}/server.log)`); process.exit(1); }
    process.exit(0);
}

main().catch((e) => { console.error('⛔', e); process.exit(1); });
