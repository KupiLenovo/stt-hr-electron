// Automatsko ažuriranje (electron-updater) — PLT-39 (N-3 ocjene SIS-4) i PLT-22 (beta kanal).
//
// Do 4.7.0: autoDownload = true i autoInstallOnAppQuit = true → nova verzija se tiho preuzimala i instalirala pri zatvaranju
// aplikacije, bez pitanja i bez potpisa. Sad ništa ne ide bez korisnika:
//   1. provjera nađe novu verziju → pitanje „Nova verzija je dostupna — preuzmi i instaliraj?" (zadano „Ne sada");
//   2. tek na „Preuzmi i instaliraj" počinje preuzimanje (autoDownload = false);
//   3. kad je preuzeto → „Instaliraj sada" ili „Pri zatvaranju aplikacije" (zadano; korisnik je već pristao, a kasa ne smije stati
//      usred naplate). autoInstallOnAppQuit se uključuje SAMO na taj izbor.
// „Ne sada" za neku verziju ne pita ponovo do sljedećeg pokretanja ili ručne provjere (meni „Provjeri ažuriranja").
// Zahtjev iz web aplikacije (install-update) ide kroz ISTA pitanja — stranica sa servera ne može sama pokrenuti instalaciju.
//
// Kanal (PLT-22): „stabilni" (zadano) vidi samo objavljena izdanja; „beta" vidi i probna izdanja (tag vX.Y.Z-beta.N, na GitHubu
// označena kao pre-release). Kanal je postavka računara (aierp-server.json → kanal_azuriranja), ne firme.
//
// Potpis koda: provjera potpisa preuzetog instalatera (verifyUpdateCodeSignature + publisherName) se uključuje u BUILDU, ne ovdje —
// electron-builder upisuje publisherName u app-update.yml, a electron-updater tada odbija nepotpisan ili tuđe potpisan instalater.
// Do certifikata je isključeno (scripts/potpis-koda.js, zastavica POTPIS_UKLJUCEN).
//
// Bez Electrona (autoUpdater i dialog se ubacuju) — test/azuriranje.test.js.
'use strict';

const KANALI = Object.freeze({ STABILNI: 'stabilni', BETA: 'beta' });

function normalizujKanal(k) {
    return String(k || '').trim().toLowerCase() === KANALI.BETA ? KANALI.BETA : KANALI.STABILNI;
}

// Kanal iz okoline (razvoj/proba) ima prednost nad postavkom računara.
function kanalIz({ env = {}, konfig = {} } = {}) {
    return normalizujKanal(env.AIERP_KANAL_AZURIRANJA || (konfig && konfig.kanal_azuriranja));
}

/** Podesi electron-updater za kanal. Postavljanje `channel` u electron-updateru tiho uključuje allowDowngrade — ovdje se vraća na false. */
function podesiKanal(autoUpdater, kanal) {
    const beta = normalizujKanal(kanal) === KANALI.BETA;
    autoUpdater.channel = beta ? 'beta' : 'latest';
    autoUpdater.allowPrerelease = beta;
    autoUpdater.allowDowngrade = false;
    return beta ? KANALI.BETA : KANALI.STABILNI;
}

const TEKST = Object.freeze({
    naslov: 'Ažuriranje aplikacije',
    dostupna: 'Nova verzija je dostupna — preuzmi i instaliraj?',
    preuzmi: 'Preuzmi i instaliraj',
    neSada: 'Ne sada',
    preuzeta: 'Nova verzija je preuzeta. Instalirati je sada?',
    instalirajSada: 'Instaliraj sada',
    priZatvaranju: 'Pri zatvaranju aplikacije',
    najnovija: 'Koristite najnoviju verziju.',
    greska: 'Nije moguće provjeriti ili preuzeti ažuriranje.',
});

/**
 * @param {object} o
 * @param {object} o.autoUpdater electron-updater autoUpdater (EventEmitter + checkForUpdates/downloadUpdate/quitAndInstall)
 * @param {object} o.dialog Electron dialog (showMessageBox)
 * @param {() => any} o.prozor glavni prozor ili null
 * @param {() => string} o.verzijaAplikacije
 * @param {string} [o.nazivProizvoda]
 * @param {string} [o.kanal] 'stabilni' | 'beta'
 * @param {(kanal: string, podaci: any) => void} [o.posalji] obavijest rendereru (update-available/progress/downloaded)
 * @param {boolean} [o.dev] ispis grešaka u konzolu
 */
function napraviAzuriranje({ autoUpdater, dialog, prozor, verzijaAplikacije, nazivProizvoda = 'Vault aiERP', kanal = KANALI.STABILNI,
    posalji = () => {}, dev = false }) {
    let rucna = false;            // korisnik je kliknuo „Provjeri ažuriranja" → vidljiv rezultat i kad nema novog
    let dostupna = null;          // info zadnje nađene verzije (još nije preuzeta)
    let preuzeto = null;          // info preuzete verzije
    let preuzimanje = false;      // korisnik je pristao, preuzimanje u toku
    let pitanje = null;           // dijalog je već otvoren → ne otvaraj drugi
    const odbijene = new Set();   // „Ne sada" u ovom pokretanju

    autoUpdater.autoDownload = false;            // PLT-39: ništa se ne preuzima bez pristanka
    autoUpdater.autoInstallOnAppQuit = false;    // PLT-39: ništa se ne instalira tiho pri zatvaranju
    autoUpdater.logger = null;
    let trenutniKanal = podesiKanal(autoUpdater, kanal);

    const poruka = (o) => Promise.resolve(dialog.showMessageBox(prozor(), o));
    const verzija = (info) => (info && info.version) || '?';
    const opisKanala = () => (trenutniKanal === KANALI.BETA ? ' (beta kanal)' : '');

    function jednoPitanje(fn) {
        if (pitanje) return pitanje;
        pitanje = Promise.resolve().then(fn).catch(() => false).finally(() => { pitanje = null; });
        return pitanje;
    }

    function ponudiPreuzimanje(info) {
        return jednoPitanje(async () => {
            const r = await poruka({
                type: 'question',
                title: TEKST.naslov,
                message: TEKST.dostupna,
                detail: `Sada instalirano: ${verzijaAplikacije()}\nNova verzija: ${verzija(info)}${opisKanala()}\n\n` +
                    'Preuzimanje ide u pozadini i kasa radi normalno. Kad bude preuzeto, aplikacija pita kada da instalira.',
                buttons: [TEKST.preuzmi, TEKST.neSada],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            });
            if (!r || r.response !== 0) { odbijene.add(verzija(info)); return false; }
            preuzimanje = true;
            rucna = true;   // korisnik je pokrenuo preuzimanje → greška mora biti vidljiva
            Promise.resolve(autoUpdater.downloadUpdate()).catch(() => { preuzimanje = false; });
            return true;
        });
    }

    function ponudiInstalaciju(info) {
        return jednoPitanje(async () => {
            const r = await poruka({
                type: 'question',
                title: TEKST.naslov,
                message: TEKST.preuzeta,
                detail: `Sada instalirano: ${verzijaAplikacije()}\nNova verzija: ${verzija(info)}${opisKanala()}\n\n` +
                    'Instalacija zatvara aplikaciju i otvara je ponovo (oko minut). Usred naplate izaberi „Pri zatvaranju aplikacije".',
                buttons: [TEKST.instalirajSada, TEKST.priZatvaranju],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            });
            if (r && r.response === 0) { autoUpdater.quitAndInstall(); return 'sada'; }
            autoUpdater.autoInstallOnAppQuit = true;   // korisnik je pristao na instalaciju — pri zatvaranju aplikacije
            return 'pri_zatvaranju';
        });
    }

    autoUpdater.on('update-available', (info) => {
        dostupna = info || {};
        posalji('update-available', info);
        const ruc = rucna;
        rucna = false;
        if (preuzimanje || preuzeto) return;
        if (!ruc && odbijene.has(verzija(info))) return;
        ponudiPreuzimanje(info);
    });
    autoUpdater.on('download-progress', (p) => posalji('update-progress', p));
    autoUpdater.on('update-not-available', () => {
        if (!rucna) return;
        rucna = false;
        poruka({ type: 'info', title: TEKST.naslov, message: TEKST.najnovija,
            detail: `${nazivProizvoda} ${verzijaAplikacije()}${opisKanala()}` }).catch(() => {});
    });
    autoUpdater.on('update-downloaded', (info) => {
        rucna = false;
        preuzimanje = false;
        preuzeto = info || {};
        posalji('update-downloaded', info);
        ponudiInstalaciju(preuzeto);
    });
    autoUpdater.on('error', (err) => {
        if (dev) console.error('Greška ažuriranja:', err);
        preuzimanje = false;
        if (!rucna) return;
        rucna = false;
        poruka({ type: 'error', title: TEKST.naslov, message: TEKST.greska,
            detail: 'Provjeri internet vezu pa pokušaj ponovo (meni Aplikacija → Provjeri ažuriranja).' }).catch(() => {});
    });

    return {
        provjeri() { return Promise.resolve(autoUpdater.checkForUpdates()).catch(() => null); },
        rucnaProvjera() { rucna = true; return Promise.resolve(autoUpdater.checkForUpdates()).catch(() => null); },
        // install-update iz renderera: ista pitanja kao i iz glavnog procesa
        zahtjevInstalacije() {
            if (preuzeto) return ponudiInstalaciju(preuzeto);
            if (dostupna && !preuzimanje) return ponudiPreuzimanje(dostupna);
            return Promise.resolve(false);
        },
        promijeniKanal(novi) { trenutniKanal = podesiKanal(autoUpdater, novi); odbijene.clear(); return trenutniKanal; },
        kanal: () => trenutniKanal,
    };
}

module.exports = { napraviAzuriranje, podesiKanal, kanalIz, normalizujKanal, KANALI, TEKST };
