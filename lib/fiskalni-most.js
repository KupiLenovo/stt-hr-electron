// C-Fiskalni (MAL-04) — FISKALNI MOST u glavnom procesu. Veže drajver (TFS) + pos-kes.db (red na disku) + pravilo oporavka.
// Ključno pravilo protiv duplog računa: PIŠI na disk PRIJE slanja uređaju; istek/prekid → 'nepoznato' (NIKAD automatska
// ponovna štampa); oporavak čita samo brojač. Sva logika je ovdje (bez Electrona) da je node --test može voziti s lažnim TFS-om.
'use strict';
const tring = require('./fiskalni/tring');
const oporavak = require('./fiskalni/oporavak');

function safeParse(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s || null); } catch { return null; } }

// napraviMost({ drajver, posKes }) → { naplati, oporaviRedove, duplikat, periodicni, provjeriRezim }.
// drajver = fiskalni-drajver.js instanca; posKes = lib/pos-kes.js (inicijalizovan).
function napraviMost({ drajver, posKes }) {
    if (!drajver || !posKes) throw new Error('fiskalni-most: trebaju drajver i posKes');

    // Oznaka koja stvarno ide uređaju (šifrarnik: 'Kartično WEB' → 'Kartica'); mora ∈ PLACANJA ili normPlacanje baca.
    function provjeriPlacanja(placanja) {
        for (const p of placanja || []) tring.normPlacanje(p && (p.oznaka_uredjaja || p.vrsta));
    }

    function rezZaServer(prije, ishod, rez, pokusajAt) {
        const ok = ishod === 'fiskalizovan';
        return {
            uspjeh: ok, ishod, status: ishod,
            fiskalni_broj: ok && rez && rez.fiskalni_broj != null ? String(rez.fiskalni_broj) : null,
            fiskalni_datum: ok ? (rez && rez.fiskalni_datum) || null : null,
            fiskalni_vrijeme: ok ? (rez && rez.fiskalni_vrijeme) || null : null,
            qr_kod: (rez && rez.qr_kod) || null,
            raw: (rez && rez.raw) || null,
            greska: (rez && rez.greska) || null,
            fiskalni_potvrda: ishod === 'nepoznato' ? null : 'uredjaj',
            uredjaj_prije: prije, uredjaj_poslije: null,
            pokusaj_at: pokusajAt,
        };
    }

    // Jedini put računa do uređaja (protokol ≥ 4.3.0). Vraća objekat rendereru — koji tek ONDA javi serveru.
    async function naplati(p) {
        const lokalni_uid = p && p.lokalni_uid;
        if (!lokalni_uid) return { uspjeh: false, ishod: 'greska', status: 'greska', greska: { poruka: 'Nedostaje lokalni_uid.' } };
        const tip = p.tip === 'reklamirani' ? 'reklamirani' : 'fiskalni';
        const placanja = p.placanja || [];

        // 0. Oznaka plaćanja mora ∈ PLACANJA iz šifrarnika — GREŠKA PRIJE slanja uređaju (i prije upisa na disk). NIKAD tiho 'Gotovina'.
        try { provjeriPlacanja(placanja); }
        catch (e) { return { uspjeh: false, ishod: 'greska', status: 'greska', lokalni_uid, greska: { kod: e.kod || 'nepoznata_vrsta_placanja', poruka: e.message } }; }

        // Idempotencija / dedup: račun koji je već fiskalizovan (lokalno ili poslan serveru) se NE šalje ponovo; poslan-bez-odgovora prvo ide na oporavak.
        const post = posKes.redRacuna(lokalni_uid);
        if (post && (post.stanje === 'fiskalizovan_lokalno' || post.stanje === 'poslan') && post.fiskalni_broj) {
            const rz = safeParse(post.rezultat) || {};
            return { uspjeh: true, ishod: 'fiskalizovan', status: 'fiskalizovan', vec: true, lokalni_uid,
                fiskalni_broj: post.fiskalni_broj || null, fiskalni_datum: post.fiskalni_datum || null, fiskalni_vrijeme: post.fiskalni_vrijeme || null,
                qr_kod: post.qr_kod || null, raw: rz.raw || null, greska: null, fiskalni_potvrda: post.fiskalni_potvrda || 'uredjaj',
                uredjaj_prije: safeParse(post.uredjaj_prije), uredjaj_poslije: safeParse(post.uredjaj_poslije), pokusaj_at: post.pokusaj_at || null };
        }
        if (post && (post.stanje === 'salje_uredjaju' || post.stanje === 'nepoznato')) {
            return { uspjeh: false, ishod: 'blokirano', status: 'blokirano', vlastiti: true, lokalni_uid,
                poruka: 'Ovaj račun je već poslan uređaju bez odgovora — prvo ga razriješi na uređaju, ne šalji ponovo.' };
        }

        // 1. RAČUN NA DISK (priprema) — prije ijednog poziva uređaju. kanal: 'mp' (prodaja → /racuni/sync) ili 'fiskalizovano' (VP/storno/„Fiskalizuj sve" → /racuni/:id/fiskalizovano).
        posKes.pripremiNaplatu({
            lokalni_uid, skladiste_id: p.skladiste_id, smjena_id: p.smjena_id, kanal: p.kanal || 'mp',
            tip, iznos_fening: p.iznos_fening, placanja, original_broj: p.original_broj,
            payload: p.payload || p,
        });

        // 2. Snimak brojača (OsnovneInformacije) PRIJE slanja. Uređaj bez veze → račun se NE šalje (ništa nije odštampano).
        let info = null;
        try { info = await drajver.osnovneInformacije(); } catch { info = null; }
        const prije = (info && !info.veza_pukla && info.uspjeh) ? oporavak.snimakIzOdgovora(info.odgovori, oporavak.lokalnoVrijeme()) : null;
        if (!prije) {
            posKes.upisiRezultat(lokalni_uid, { stanje: 'greska', fiskalni_greska: 'Fiskalni uređaj ne odgovara — račun nije poslan.' });
            return { uspjeh: false, ishod: 'nedostupan', status: 'nedostupan', lokalni_uid,
                poruka: (info && info.greska && info.greska.poruka) ? `Fiskalni uređaj ne odgovara (${info.greska.poruka}).` : 'Fiskalni uređaj ne odgovara — račun nije poslan.' };
        }
        const sad = Date.now();
        const pokusaj_at = oporavak.lokalnoVrijeme(sad);
        posKes.oznaciSaljeUredjaju(lokalni_uid, prije, pokusaj_at, sad);

        // 3. Slanje uređaju. kupac (JIB) i napomena idu samo kad ih pošiljalac ima (VP faktura); POS prodaja ih nema.
        let rez = null;
        try {
            const racun = { stavke: p.stavke, placanja };
            if (p.kupac) racun.kupac = p.kupac;
            if (p.napomena != null) racun.napomena = p.napomena;
            rez = tip === 'reklamirani' ? await drajver.reklamiraj(racun, p.original_broj || '') : await drajver.fiskalizuj(racun);
        } catch (e) { rez = { uspjeh: false, veza_pukla: true, raw: '', greska: { poruka: (e && e.message) || 'Poziv uređaju je pukao.' } }; }

        // 4. Rezultat ODMAH na disk. Istek/prekid/nepoznat odgovor → 'nepoznato' (nikad automatska ponovna štampa).
        const ishod = oporavak.ishodSlanja(rez);
        const stanje = ishod === 'fiskalizovan' ? 'fiskalizovan_lokalno' : ishod;
        const out = rezZaServer(prije, ishod, rez, pokusaj_at);
        posKes.upisiRezultat(lokalni_uid, {
            stanje, fiskalni_broj: out.fiskalni_broj, fiskalni_datum: out.fiskalni_datum, fiskalni_vrijeme: out.fiskalni_vrijeme,
            qr_kod: out.qr_kod, fiskalni_potvrda: ishod === 'nepoznato' ? null : 'uredjaj',
            fiskalni_greska: ishod === 'greska' ? (rez && rez.greska && rez.greska.poruka) || 'Uređaj je odbio račun.' : (ishod === 'nepoznato' ? 'Uređaj nije odgovorio na vrijeme — provjeri na uređaju.' : null),
            rezultat: JSON.stringify({ raw: (rez && rez.raw) || '' }),
        });
        posKes.zurnalDodaj({ lokalni_uid, komanda: tip === 'reklamirani' ? tring.KOMANDE.reklamirani : tring.KOMANDE.fiskalni, fiskalni_broj: out.fiskalni_broj, raw: (rez && rez.raw) || '' });
        out.lokalni_uid = lokalni_uid;
        return out;
    }

    // Pri pokretanju: razriješi redove poslane uređaju bez potvrde — čitaj SAMO brojač (BEZ nove štampe).
    async function oporaviRedove(sadMs = Date.now()) {
        const rez = { provjereno: 0, fiskalizovano: 0, greska: 0, voditelj: 0, cekaju: 0, nedostupno: false };
        const svi = posKes.redoviZaOporavak();
        if (!svi.length) return rez;
        const spremni = svi.filter((r) => oporavak.preostaloDoProvjere(r.pokusaj_ms, sadMs) === 0);
        rez.cekaju = svi.length - spremni.length;
        if (!spremni.length) return rez;
        let info = null;
        try { info = await drajver.osnovneInformacije(); } catch { info = null; }
        const poslije = (info && !info.veza_pukla && info.uspjeh) ? oporavak.snimakIzOdgovora(info.odgovori, oporavak.lokalnoVrijeme(sadMs)) : null;
        if (!poslije) { rez.nedostupno = true; return rez; }   // uređaj bez veze → sljedeći start
        for (const r of spremni) {
            const prije = safeParse(r.uredjaj_prije);
            const placanja = safeParse(r.placanja) || [];
            // poslije ovog pokušaja išao je još neki račun → brojači pomiješani → voditelj (broj s trake, nikad automatska štampa)
            const kasniji = svi.some((x) => x.lokalni_uid !== r.lokalni_uid && Number(x.pokusaj_ms) > Number(r.pokusaj_ms));
            const odluka = kasniji ? 'voditelj' : oporavak.odlukaOporavka(prije, poslije, r.iznos_fening, placanja, r.tip);
            rez.provjereno++;
            if (odluka === 'fiskalizovan') {
                const broj = String(r.tip === 'reklamirani' ? poslije.last_RF : poslije.last_BF);
                posKes.razrijesiRed(r.lokalni_uid, {
                    stanje: 'fiskalizovan_lokalno', fiskalni_broj: broj, uredjaj_poslije: poslije, fiskalni_potvrda: 'brojac',
                    fiskalni_datum: (r.pokusaj_at || '').slice(0, 10) || null, fiskalni_vrijeme: (r.pokusaj_at || '').slice(11, 19) || null,
                    rezultat: JSON.stringify({ raw: (info && info.raw) || '', oporavak: true }),
                });
                posKes.zurnalDodaj({ lokalni_uid: r.lokalni_uid, komanda: 'oporavak', fiskalni_broj: broj, raw: (info && info.raw) || '' });
                rez.fiskalizovano++;
            } else if (odluka === 'stampaj') {
                posKes.razrijesiRed(r.lokalni_uid, { stanje: 'greska', uredjaj_poslije: poslije, fiskalni_greska: 'Uređaj nije odštampao račun (brojači isti) — čeka ponovnu naplatu.' });
                rez.greska++;
            } else {
                posKes.razrijesiRed(r.lokalni_uid, { stanje: 'nepoznato', uredjaj_poslije: poslije, fiskalni_potvrda: null });
                rez.voditelj++;
            }
        }
        return rez;
    }

    // Duplikat (kopija) fiskalnog/reklamiranog računa po BrojRacuna — čist reprint, NE mijenja red (ne dira queue_racun).
    async function duplikat(a) {
        const rez = await drajver.duplikatRacuna(a && a.broj, a && a.tip);
        posKes.zurnalDodaj({ komanda: 'duplikat', fiskalni_broj: a && a.broj != null ? String(a.broj) : null, raw: (rez && rez.raw) || '' });
        return rez;
    }
    // Periodični izvještaj od–do (raw u žurnal). Ne dira red.
    async function periodicni(a) {
        const rez = await drajver.periodicniIzvjestaj(a && a.od, a && a.do);
        posKes.zurnalDodaj({ komanda: 'periodicni', fiskalni_broj: null, raw: (rez && rez.raw) || '' });
        return rez;
    }
    // Provjera režima rada uređaja (Maloprodaja) pri otvaranju kase.
    async function provjeriRezim() { return drajver.provjeriRezim(); }

    return { naplati, oporaviRedove, duplikat, periodicni, provjeriRezim };
}

module.exports = { napraviMost };
