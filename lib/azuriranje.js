// Automatsko ažuriranje (electron-updater) — PLT-39 N-3 (R62): ažuriranje se NIKAD ne instalira samo.
//
// Do 4.4.0: autoInstallOnAppQuit = true → preuzeto ažuriranje se tiho instaliralo pri zatvaranju aplikacije (i usred radnog
// dana kase), a install-update iz web aplikacije je odmah zvao quitAndInstall. Sad: preuzimanje ide u pozadini, a instalacija
// tek kad korisnik potvrdi u dijalogu koji pokazuje trenutnu i novu verziju. „Kasnije" ne instalira ništa — pitanje dolazi
// opet pri sljedećoj provjeri (preuzeto ažuriranje ostaje u kešu updatera). Zahtjev iz renderera ide kroz ISTI dijalog.
// Bez Electrona (autoUpdater i dialog se ubacuju) — test/izdanje.test.js.
'use strict';

/**
 * @param {object} o
 * @param {object} o.autoUpdater electron-updater autoUpdater (EventEmitter + checkForUpdates/quitAndInstall)
 * @param {object} o.dialog Electron dialog (showMessageBox)
 * @param {() => any} o.prozor glavni prozor ili null
 * @param {() => string} o.verzijaAplikacije
 * @param {(kanal: string, podaci: any) => void} [o.posalji] obavijest rendereru (update-available/progress/downloaded)
 * @param {boolean} [o.dev] ispis grešaka u konzolu
 */
function napraviAzuriranje({ autoUpdater, dialog, prozor, verzijaAplikacije, posalji = () => {}, dev = false }) {
    let rucna = false;          // korisnik je kliknuo „Provjeri ažuriranja" → vidljiv rezultat i kad nema novog
    let preuzeto = null;        // info zadnjeg preuzetog ažuriranja
    let pitanje = null;         // dijalog je već otvoren → ne otvaraj drugi

    autoUpdater.autoDownload = true;            // preuzimanje u pozadini je bezopasno
    autoUpdater.autoInstallOnAppQuit = false;   // N-3: nikad tiha instalacija pri zatvaranju
    autoUpdater.logger = null;

    const poruka = (o) => dialog.showMessageBox(prozor(), o);

    function ponudiInstalaciju(info) {
        if (pitanje) return pitanje;
        const nova = (info && info.version) || '?';
        pitanje = Promise.resolve(poruka({
            type: 'question',
            title: 'Ažuriranje aplikacije',
            message: `Nova verzija aplikacije (${nova}) je preuzeta. Instalirati je sada?`,
            detail: `Sada instalirano: ${verzijaAplikacije()}\nNova verzija: ${nova}\n\n` +
                'Instalacija zatvara aplikaciju i otvara je ponovo (oko minut). Ne instaliraj usred naplate — ' +
                'izaberi „Kasnije" i aplikacija će pitati ponovo.',
            buttons: ['Instaliraj sada', 'Kasnije'],
            defaultId: 1,
            cancelId: 1,
        })).then((r) => {
            if (r && r.response === 0) { autoUpdater.quitAndInstall(); return true; }
            return false;
        }).catch(() => false).finally(() => { pitanje = null; });
        return pitanje;
    }

    autoUpdater.on('update-available', (info) => {
        posalji('update-available', info);
        if (rucna) {
            poruka({ type: 'info', title: 'Ažuriranje', message: `Dostupna je nova verzija (${info && info.version}).`,
                detail: 'Preuzimam u pozadini — pitaću prije instalacije.' }).catch(() => {});
        }
    });
    autoUpdater.on('download-progress', (p) => posalji('update-progress', p));
    autoUpdater.on('update-not-available', () => {
        if (!rucna) return;
        rucna = false;
        poruka({ type: 'info', title: 'Ažuriranje', message: 'Koristite najnoviju verziju.', detail: `aiERP kasa ${verzijaAplikacije()}` }).catch(() => {});
    });
    autoUpdater.on('update-downloaded', (info) => {
        rucna = false;
        preuzeto = info || {};
        posalji('update-downloaded', info);
        ponudiInstalaciju(preuzeto);
    });
    autoUpdater.on('error', (err) => {
        if (dev) console.error('Greška ažuriranja:', err);
        if (!rucna) return;
        rucna = false;
        poruka({ type: 'error', title: 'Ažuriranje', message: 'Nije moguće provjeriti ažuriranja.',
            detail: 'Provjeri internet vezu pa pokušaj ponovo.' }).catch(() => {});
    });

    return {
        provjeri() { autoUpdater.checkForUpdates().catch(() => {}); },
        rucnaProvjera() { rucna = true; autoUpdater.checkForUpdates().catch(() => {}); },
        // install-update iz renderera: isti dijalog (web aplikacija ne može sama pokrenuti instalaciju)
        zahtjevInstalacije() { return preuzeto ? ponudiInstalaciju(preuzeto) : Promise.resolve(false); },
    };
}

module.exports = { napraviAzuriranje };
