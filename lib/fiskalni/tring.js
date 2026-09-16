// C-Fiskalni — TESTABILNA SRŽ Tring drajvera (čiste funkcije, bez I/O).
// Granica fening konvencije: SVE konverzije fening↔decimal su OVDJE, nigdje drugo.
// Electron omotač je tanak: uzmi XML iz build*(), POST na localhost:8085/{komanda}, daj odgovor parseKasaOdgovor().
// Protokol: Tring TFS uputstvo v3.0.1 (RacunZahtjev §7, KasaOdgovor §4, OsnovneInformacije §7.9.1, error kodovi §11). CI testira ovaj fajl.
// MAL-03: KANONSKI IZVOR protokola. Desktop (stt-hr-electron) drži BAJT-PO-BAJT kopiju uz lib/fiskalni/tring.sha256; serverski
// CI job `fiskalni-ogledalo` preuzme desktop main i padne ako se razlikuje. Izmjena protokola: PRVO desktop grana, pa server.

// ---------- KONVERZIJE (fening/mili ↔ decimal string za Tring) ----------
function feningUDecimal(f) { return (Number(f || 0) / 100).toFixed(2); }                 // 1033 → "10.33"
function decimalUFening(s) { return Math.round(parseFloat(String(s).replace(',', '.')) * 100) || 0; } // "10.33" → 1033
function miliUDecimal(m) { return String(parseFloat((Number(m || 0) / 1000).toFixed(3))); } // 1500 → "1.5", 1000 → "1"
function decimalUMili(s) { return Math.round(parseFloat(String(s).replace(',', '.')) * 1000) || 0; }

// Tring vraća datum u VIŠE formata zavisno od firmvera: "15. 6. 2026." (razmaci+tačka),
// "27. 9. 2023.", "12.09.2021." (trailing tačka), "27.09.2023", "9.1.11" (2-cifrena godina).
// Normalizuj u našu konvenciju 'YYYY-MM-DD'. Nepoznat format → vrati sirovo (ne ruši, ne gubi podatak).
function normDatum(s) {
    if (s == null || s === '') return s;
    const d = String(s).replace(/\s+/g, '').replace(/\.+$/, '').split('.').filter((x) => x !== '');
    if (d.length !== 3) return String(s);
    let [dan, mj, god] = d;
    if (god.length === 2) god = '20' + god;
    if (!/^\d{1,2}$/.test(dan) || !/^\d{1,2}$/.test(mj) || !/^\d{4}$/.test(god)) return String(s);
    return `${god}-${mj.padStart(2, '0')}-${dan.padStart(2, '0')}`;
}

// Verzija protokola Tring integracije (semver). Desktop je izlaže kroz preload (fiskalniDrajver.protokol);
// kasa (pos.tsx) traži da instalirani desktop bude >= ove verzije, inače pokaže traku „ažuriraj aplikaciju".
const PROTOKOL_VERZIJA = '4.3.0';

// ---------- MAPIRANJA ----------
// tarife.stopa (bp) → Tring oznaka. STT = PDV obveznik: 1700→E (17%), 0→K (oslobođeno). A = van PDV (ne koristimo).
function mapStopa(bp) { return Number(bp) > 0 ? 'E' : 'K'; }
// Plaćanje → Tring Oznaka (case-insensitive ulaz, kanonski izlaz). SAMO tačne oznake (Gotovina|Kartica|Virman|Cek);
// nepoznato BACA grešku — NIKAD tiho 'Gotovina' (pogrešna vrsta na fiskalnom računu je porezna greška). Opisne nazive
// ('Kartično WEB', 'Gotovina pouzeće') prevodi šifrarnik pos_vrsta_placanja (lib/pos-placanje.oznakaUredjaja) PRIJE
// ovog poziva → oznaka_uredjaja ∈ PLACANJA. buildRacunXml zato šalje normPlacanje(oznaka_uredjaja || vrsta).
const PLACANJA = ['Gotovina', 'Kartica', 'Virman', 'Cek'];
function normPlacanje(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    const tacno = PLACANJA.find((p) => p.toLowerCase() === s);
    if (tacno) return tacno;
    const e = new Error(`nepoznata_vrsta_placanja: '${v}' (dozvoljeno: ${PLACANJA.join('|')})`);
    e.kod = 'nepoznata_vrsta_placanja';
    throw e;
}

// ---------- KOMANDE (endpoint mapa) ----------
const KOMANDE = {
    test: '/test', status: '/osnovneinformacije', inicijalizacija: '/inicijalizacija',
    fiskalni: '/stampatifiskalniracun', reklamirani: '/stampatireklamiraniracun',
    unosNovca: '/unosnovca', povratNovca: '/povratnovca',
    presjek: '/stampatipresjekstanja', dnevni: '/stampatidnevniizvjestaj', periodicni: '/stampatiperiodicniizvjestaj',
    osnovne: '/osnovneinformacije', prekini: '/prekiniracun',
};

// ---------- ERROR KODOVI (§11) → user-friendly ----------
const ERROR_KODOVI = {
    400: 'Veza s fiskalnim uređajem u prekidu — provjeri kabl/mrežu.',
    401: 'Operater nije logiran.', 655: 'Operater nije logiran.',
    412: 'Obavezan dnevni izvještaj (Z) prije nastavka.',
    503: 'Nema papira u štampaču.', 616: 'Nema papira u štampaču.',
    504: 'Štampač pregrijan — pričekaj hlađenje.', 617: 'Štampač pregrijan — pričekaj hlađenje.',
    505: 'Dostignut maksimum dnevnih izvještaja — servis.',
    508: 'Neispravna komanda.',
    510: 'Nedefiniran artikal na uređaju.', 605: 'Nedefiniran artikal na uređaju.',
    511: 'Maksimum artikala dostignut — servis.',
    512: 'Nevažeća količina/cijena/plaćanje (0).',
    523: 'Plaćanje karticom/čekom veće od iznosa računa.',
    524: 'Suma plaćanja veća od sume računa.',
    528: 'Elektronski žurnal bez konekcije — servis.', 529: 'Elektronski žurnal pun — servis.',
};
// Greške po IMENU iz Tring uputstva v3.0.1 (uz numeričke §11). Firmver zna vratiti simboličko ime
// (ERROR_FISCAL_*, PRINTER_ERR_*) umjesto/uz broj iz grupe 1700. Ime ima prednost nad brojem.
const ERROR_IMENA = {
    ERROR_FISCAL_INSUFFICIENT_MONEY: 'Nedovoljno gotovine u kasi za povrat.',
    ERROR_FISCAL_DAILY_REQUIRED: 'Obavezan dnevni izvještaj (Z) prije nastavka.',
    ERROR_FISCAL_OPERATOR_NOT_LOGGED: 'Operater nije logiran.',
    ERROR_FISCAL_INVALID_PAYMENT: 'Nevažeća vrsta plaćanja.',
    ERROR_FISCAL_DEVICE_BUSY: 'Uređaj je zauzet — pokušaj ponovo za koji sekund.',
    PRINTER_ERR_NO_PAPER: 'Nema papira u štampaču.',
    PRINTER_ERR_OVERHEAT: 'Štampač pregrijan — pričekaj hlađenje.',
    PRINTER_ERR_COVER_OPEN: 'Poklopac štampača je otvoren.',
};
function porukaZaKod(kod) {
    const n = Number(kod);
    if (ERROR_KODOVI[n]) return ERROR_KODOVI[n];
    if (n >= 1700 && n <= 1799) return `Fiskalna greška (kod ${n}) — vidi Tring uputstvo v3.0.1.`;   // grupa 1700
    return `Greška uređaja (kod ${kod}).`;
}
// Poruka za grešku po imenu (v3.0.1) uz fallback na numerički kod pa na sirovi naziv.
function porukaZaGresku(ime, kod, sirovi) {
    return ERROR_IMENA[ime] || (kod != null ? porukaZaKod(kod) : null) || sirovi || 'Nepoznata greška uređaja';
}
// 401/655 (ili ERROR_FISCAL_OPERATOR_NOT_LOGGED) = nije logiran → omotač treba auto-inicijalizaciju + retry.
function trebaReLogin(kod, ime) { return Number(kod) === 401 || Number(kod) === 655 || ime === 'ERROR_FISCAL_OPERATOR_NOT_LOGGED'; }

// ---------- XML BUILD ----------
function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
const HEADER = '<?xml version="1.0" encoding="utf-8"?>';

// Inicijalizacija (login). BrojOperatora=0 (admin), Lozinka=0.
function buildInicijalizacijaXml(brojOperatora = 0, lozinka = 0) {
    return `${HEADER}\n<Operator><BrojOperatora>${Number(brojOperatora) || 0}</BrojOperatora><Lozinka>${xmlEsc(lozinka)}</Lozinka></Operator>`;
}

// Fiskalni/reklamirani račun. racun = {broj_zahtjeva, tip, original_broj?, kupac?, stavke[], placanja[], napomena?}
// stavka = {sifra?, naziv, jm?, cijena_fening, stopa_oznaka, kolicina_mili, rabat_bp?, plu?}
// placanje = {vrsta, iznos_fening}
function buildRacunXml(racun) {
    const reklamirani = racun.tip === 'reklamirani';
    const vrstaZahtjeva = reklamirani ? 2 : 0;
    const k = racun.kupac;
    // Kupac samo ako ima validan JIB (13 cifara) — inače izostavi (pravilo g).
    const kupacXml = (k && /^\d{13}$/.test(String(k.idbroj || ''))) ? `
    <Kupac><IDbroj>${xmlEsc(k.idbroj)}</IDbroj><Naziv>${xmlEsc(k.naziv)}</Naziv><Adresa>${xmlEsc(k.adresa)}</Adresa><PostanskiBroj>${xmlEsc(k.posta)}</PostanskiBroj><Grad>${xmlEsc(k.grad)}</Grad></Kupac>` : '';
    const stavkeXml = (racun.stavke || []).map((s) => `
      <RacunStavka>
        <artikal><Sifra>${xmlEsc(s.sifra ?? 0)}</Sifra><Naziv>${xmlEsc(s.naziv)}</Naziv><JM>${xmlEsc(s.jm || 'kom')}</JM><Cijena>${feningUDecimal(s.cijena_fening)}</Cijena><Stopa>${xmlEsc(s.stopa_oznaka)}</Stopa><Grupa>0</Grupa><PLU>${xmlEsc(s.plu ?? 0)}</PLU></artikal>
        <Kolicina>${miliUDecimal(s.kolicina_mili)}</Kolicina><Rabat>${(Number(s.rabat_bp || 0) / 100).toFixed(2)}</Rabat>
      </RacunStavka>`).join('');
    // MAL-02 (g168): oznaka na uređaju dolazi IZ ŠIFRARNIKA (p.oznaka_uredjaja, ∈ PLACANJA → tačno poklapanje), pa
    // 'Kartično WEB' ide kao 'Kartica', 'Gotovina pouzeće' kao 'Gotovina'. Bez oznake (stari klijent) → normPlacanje(vrsta).
    const placanjaXml = (racun.placanja || []).map((p) => `
      <VrstaPlacanja><Oznaka>${normPlacanje(p.oznaka_uredjaja || p.vrsta)}</Oznaka><Iznos>${feningUDecimal(p.iznos_fening)}</Iznos></VrstaPlacanja>`).join('');
    return `${HEADER}
<RacunZahtjev>
  <BrojZahtjeva>${xmlEsc(racun.broj_zahtjeva ?? 0)}</BrojZahtjeva>
  <VrstaZahtjeva>${vrstaZahtjeva}</VrstaZahtjeva>
  <NoviObjekat>${kupacXml}
    <StavkeRacuna>${stavkeXml}
    </StavkeRacuna>
    <VrstePlacanja>${placanjaXml}
    </VrstePlacanja>
    <Napomena>${xmlEsc(racun.napomena || '')}</Napomena>
    <BrojRacuna>${reklamirani ? xmlEsc(racun.original_broj ?? 0) : 0}</BrojRacuna>
  </NoviObjekat>
</RacunZahtjev>`;
}

// Unos/povrat novca u kasu.
function buildNovacXml(vrsta, iznos_fening) {
    return `${HEADER}\n<NoviObjekat><Oznaka>${normPlacanje(vrsta)}</Oznaka><Iznos>${feningUDecimal(iznos_fening)}</Iznos></NoviObjekat>`;
}
// Prazan/jednostavan zahtjev (X/Z/periodični) — samo broj+vrsta.
function buildZahtjev(brojZahtjeva, vrstaZahtjeva) {
    return `${HEADER}\n<Zahtjev><BrojZahtjeva>${Number(brojZahtjeva) || 0}</BrojZahtjeva><VrstaZahtjeva>${Number(vrstaZahtjeva) || 0}</VrstaZahtjeva></Zahtjev>`;
}
// OsnovneInformacije / status uređaja: prazan zahtjev (samo XML deklaracija) — TFS uputstvo §7.9.1.
function buildPrazno() { return HEADER; }

// ---------- XML PARSE (KasaOdgovor §4) ----------
// Vraća {uspjeh, odgovori:{Naziv→Vrijednost}, fiskalni_broj, fiskalni_datum, fiskalni_vrijeme, iznos_fening, qr_kod, greska, raw}
function parseKasaOdgovor(xml) {
    const raw = String(xml || '');
    const vrstaClean = ((raw.match(/<VrstaOdgovora>\s*([^<]+?)\s*<\/VrstaOdgovora>/i) || [])[1] || '').trim();
    const jeOk = /^ok$/i.test(vrstaClean);
    const jeUpozorenje = /^upozorenje$/i.test(vrstaClean);
    // svi <Odgovor>...<Naziv>X</Naziv>...<Vrijednost...>Y</Vrijednost>...</Odgovor>
    const odgovori = {};
    const blokRe = /<Odgovor>([\s\S]*?)<\/Odgovor>/gi;
    let m;
    while ((m = blokRe.exec(raw)) !== null) {
        const blok = m[1];
        const naziv = (blok.match(/<Naziv>\s*([^<]*?)\s*<\/Naziv>/i) || [])[1];
        const vrij = (blok.match(/<Vrijednost[^>]*>\s*([^<]*?)\s*<\/Vrijednost>/i) || [])[1];
        if (naziv != null) odgovori[naziv] = vrij != null ? vrij : '';
    }
    const broj = odgovori.BrojFiskalnogRacuna ?? odgovori.FiscalReceiptNumber;
    const imaBroj = broj != null && String(broj).trim() !== '';
    // 'Upozorenje' S brojem računa = račun JE fiskalizovan, samo uz upozorenje (npr. papira ponestaje) → uspjeh.
    // 'Upozorenje' BEZ broja = ne zna se je li odštampan → nije uspjeh; klijentski oporavak (ishodSlanja) to riješi kao 'nepoznato'.
    const uspjeh = jeOk || (jeUpozorenje && imaBroj);
    const rez = { uspjeh, odgovori, raw, qr_kod: null };
    if (jeUpozorenje && uspjeh) rez.upozorenje = odgovori.Upozorenje || odgovori.Warning || odgovori.Poruka || 'Uređaj je fiskalizovao račun uz upozorenje.';
    if (uspjeh) {
        // Firmware vraća i BS i EN nazive polja — uzmi BS, fallback EN.
        if (broj != null) rez.fiskalni_broj = broj;
        const datum = odgovori.DatumFiskalnogRacuna ?? odgovori.FiscalDate;
        if (datum != null) rez.fiskalni_datum = normDatum(datum);                   // → 'YYYY-MM-DD'
        if (odgovori.VrijemeFiskalnogRacuna != null) rez.fiskalni_vrijeme = odgovori.VrijemeFiskalnogRacuna;
        const iznos = odgovori.IznosFiskalnogRacuna ?? odgovori.ReceiptTotal;
        if (iznos != null) rez.iznos_fening = decimalUFening(iznos);
        if (odgovori.QR != null || odgovori.QrKod != null) rez.qr_kod = odgovori.QR || odgovori.QrKod;  // Tring NULL; CPF popunjava
    } else {
        // greška = prvi Odgovor čija Vrijednost je broj (error kod), Naziv = ime greške
        let kod = null, ime = null;
        for (const [naziv, vrij] of Object.entries(odgovori)) {
            if (/^\d+$/.test(String(vrij))) { kod = Number(vrij); ime = naziv; break; }
        }
        // Greška BEZ numeričkog koda: TFS stavlja tekst/ime u <Naziv> ("Nema komande…" ili "ERROR_FISCAL_…"/"PRINTER_ERR_…").
        const prviNaziv = Object.keys(odgovori)[0] || null;
        const imeGreske = ime || prviNaziv;
        const poruka = porukaZaGresku(imeGreske, kod, prviNaziv);
        rez.greska = { kod, ime: imeGreske, poruka, treba_relogin: trebaReLogin(kod, imeGreske) };
    }
    return rez;
}

// status računa iz rezultata fiskalizacije (+ je li veza pukla = uređaj/TFS nedostupan)
function statusIzRezultata(rez, vezaPukla) {
    if (vezaPukla) return 'offline_queue';
    return rez && rez.uspjeh ? 'fiskalizovan' : 'greska';
}

// FiskalniDrajver interface (drajver-as-interface, ESET-ready):
//   testVeze() · statusUredjaja() · inicijalizacija(op) · fiskalizuj(racun) · reklamiraj(racun, originalBroj)
//   unosNovca(vrsta,iznos) · povratNovca(...) · presjekStanja() · dnevniIzvjestaj() · osnovneInformacije()
// TringDrajver (Electron main) implementira HTTP-XML koristeći build*/parse* odavde.
// EsetDrajver = BUDUĆA implementacija (CPF API kad izađe) — isti interface, dokaz da apstrakcija drži. NE graditi sad.

module.exports = {
    PROTOKOL_VERZIJA,
    feningUDecimal, decimalUFening, miliUDecimal, decimalUMili, normDatum,
    mapStopa, normPlacanje, PLACANJA, KOMANDE, ERROR_KODOVI, ERROR_IMENA, porukaZaKod, porukaZaGresku, trebaReLogin,
    buildInicijalizacijaXml, buildRacunXml, buildNovacXml, buildZahtjev, buildPrazno,
    parseKasaOdgovor, statusIzRezultata,
};
