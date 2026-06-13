// ⚠️ MIRROR — KANONSKI IZVOR: stt-hr-server/lib/fiskalni/tring.js (CI-testiran, g11).
// Vendorana kopija jer je Electron zaseban repo. Držati 1:1 sa serverom pri svakoj izmjeni protokola.
// C-Fiskalni — TESTABILNA SRŽ Tring drajvera (čiste funkcije, bez I/O). Konverzije fening↔decimal SAMO ovdje.

// ---------- KONVERZIJE ----------
function feningUDecimal(f) { return (Number(f || 0) / 100).toFixed(2); }
function decimalUFening(s) { return Math.round(parseFloat(String(s).replace(',', '.')) * 100) || 0; }
function miliUDecimal(m) { return String(parseFloat((Number(m || 0) / 1000).toFixed(3))); }
function decimalUMili(s) { return Math.round(parseFloat(String(s).replace(',', '.')) * 1000) || 0; }

// ---------- MAPIRANJA ----------
function mapStopa(bp) { return Number(bp) > 0 ? 'E' : 'K'; }
const PLACANJA = ['Gotovina', 'Kartica', 'Virman', 'Cek'];
function normPlacanje(v) {
    const s = String(v || '').trim().toLowerCase();
    return PLACANJA.find((p) => p.toLowerCase() === s) || 'Gotovina';
}

// ---------- KOMANDE ----------
const KOMANDE = {
    test: '/test', status: '/provjeristatusuredjaja', inicijalizacija: '/inicijalizacija',
    fiskalni: '/stampatifiskalniracun', reklamirani: '/stampatireklamiraniracun',
    unosNovca: '/unosnovca', povratNovca: '/povratnovca',
    presjek: '/stampatipresjekstanja', dnevni: '/stampatidnevniizvjestaj', periodicni: '/stampatiperiodicniizvjestaj',
    osnovne: '/osnovneinformacije', prekini: '/prekiniracun',
};

// ---------- ERROR KODOVI ----------
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
function porukaZaKod(kod) { return ERROR_KODOVI[Number(kod)] || `Greška uređaja (kod ${kod}).`; }
function trebaReLogin(kod) { return Number(kod) === 401 || Number(kod) === 655; }

// ---------- XML BUILD ----------
function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
const HEADER = '<?xml version="1.0" encoding="utf-8"?>';

function buildInicijalizacijaXml(brojOperatora = 0, lozinka = 0) {
    return `${HEADER}\n<Operator><BrojOperatora>${Number(brojOperatora) || 0}</BrojOperatora><Lozinka>${xmlEsc(lozinka)}</Lozinka></Operator>`;
}

function buildRacunXml(racun) {
    const reklamirani = racun.tip === 'reklamirani';
    const vrstaZahtjeva = reklamirani ? 2 : 0;
    const k = racun.kupac;
    const kupacXml = (k && /^\d{13}$/.test(String(k.idbroj || ''))) ? `
    <Kupac><IDbroj>${xmlEsc(k.idbroj)}</IDbroj><Naziv>${xmlEsc(k.naziv)}</Naziv><Adresa>${xmlEsc(k.adresa)}</Adresa><PostanskiBroj>${xmlEsc(k.posta)}</PostanskiBroj><Grad>${xmlEsc(k.grad)}</Grad></Kupac>` : '';
    const stavkeXml = (racun.stavke || []).map((s) => `
      <RacunStavka>
        <artikal><Sifra>${xmlEsc(s.sifra ?? 0)}</Sifra><Naziv>${xmlEsc(s.naziv)}</Naziv><JM>${xmlEsc(s.jm || 'kom')}</JM><Cijena>${feningUDecimal(s.cijena_fening)}</Cijena><Stopa>${xmlEsc(s.stopa_oznaka)}</Stopa><Grupa>0</Grupa><PLU>${xmlEsc(s.plu ?? 0)}</PLU></artikal>
        <Kolicina>${miliUDecimal(s.kolicina_mili)}</Kolicina><Rabat>${(Number(s.rabat_bp || 0) / 100).toFixed(2)}</Rabat>
      </RacunStavka>`).join('');
    const placanjaXml = (racun.placanja || []).map((p) => `
      <VrstaPlacanja><Oznaka>${normPlacanje(p.vrsta)}</Oznaka><Iznos>${feningUDecimal(p.iznos_fening)}</Iznos></VrstaPlacanja>`).join('');
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

function buildNovacXml(vrsta, iznos_fening) {
    return `${HEADER}\n<NoviObjekat><Oznaka>${normPlacanje(vrsta)}</Oznaka><Iznos>${feningUDecimal(iznos_fening)}</Iznos></NoviObjekat>`;
}
function buildZahtjev(brojZahtjeva, vrstaZahtjeva) {
    return `${HEADER}\n<Zahtjev><BrojZahtjeva>${Number(brojZahtjeva) || 0}</BrojZahtjeva><VrstaZahtjeva>${Number(vrstaZahtjeva) || 0}</VrstaZahtjeva></Zahtjev>`;
}

// ---------- XML PARSE ----------
function parseKasaOdgovor(xml) {
    const raw = String(xml || '');
    const vrsta = (raw.match(/<VrstaOdgovora>\s*([^<]+?)\s*<\/VrstaOdgovora>/i) || [])[1] || '';
    const uspjeh = /^ok$/i.test(vrsta.trim());
    const odgovori = {};
    const blokRe = /<Odgovor>([\s\S]*?)<\/Odgovor>/gi;
    let m;
    while ((m = blokRe.exec(raw)) !== null) {
        const blok = m[1];
        const naziv = (blok.match(/<Naziv>\s*([^<]*?)\s*<\/Naziv>/i) || [])[1];
        const vrij = (blok.match(/<Vrijednost[^>]*>\s*([^<]*?)\s*<\/Vrijednost>/i) || [])[1];
        if (naziv != null) odgovori[naziv] = vrij != null ? vrij : '';
    }
    const rez = { uspjeh, odgovori, raw, qr_kod: null };
    if (uspjeh) {
        if (odgovori.BrojFiskalnogRacuna != null) rez.fiskalni_broj = odgovori.BrojFiskalnogRacuna;
        if (odgovori.DatumFiskalnogRacuna != null) rez.fiskalni_datum = odgovori.DatumFiskalnogRacuna;
        if (odgovori.VrijemeFiskalnogRacuna != null) rez.fiskalni_vrijeme = odgovori.VrijemeFiskalnogRacuna;
        if (odgovori.IznosFiskalnogRacuna != null) rez.iznos_fening = decimalUFening(odgovori.IznosFiskalnogRacuna);
        if (odgovori.QR != null || odgovori.QrKod != null) rez.qr_kod = odgovori.QR || odgovori.QrKod;
    } else {
        let kod = null, ime = null;
        for (const [naziv, vrij] of Object.entries(odgovori)) {
            if (/^\d+$/.test(String(vrij))) { kod = Number(vrij); ime = naziv; break; }
        }
        rez.greska = { kod, ime, poruka: kod != null ? porukaZaKod(kod) : (ime || 'Nepoznata greška uређаја'), treba_relogin: trebaReLogin(kod) };
    }
    return rez;
}

function statusIzRezultata(rez, vezaPukla) {
    if (vezaPukla) return 'offline_queue';
    return rez && rez.uspjeh ? 'fiskalizovan' : 'greska';
}

module.exports = {
    feningUDecimal, decimalUFening, miliUDecimal, decimalUMili,
    mapStopa, normPlacanje, PLACANJA, KOMANDE, ERROR_KODOVI, porukaZaKod, trebaReLogin,
    buildInicijalizacijaXml, buildRacunXml, buildNovacXml, buildZahtjev,
    parseKasaOdgovor, statusIzRezultata,
};
