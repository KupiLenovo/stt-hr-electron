// C-Fiskalni (MAL-04) — čista logika oporavka fiskalnog računa u GLAVNOM procesu (Electron main), bez I/O i bez importa.
// Isti nepromijenjeni skup pravila kao serverski client-v2/src/lib/fiskalni-oporavak.js (g155/MAL-01): brojači uređaja
// (OsnovneInformacije) → snimak; poređenje snimka prije/poslije → odluka je li račun stварno odštampan. Server tu logiku
// vozi u rendereru (kasa), a MAL-04 je vozi i ovdje: pri pokretanju aplikacija razrješava redove u pos-kes.db (queue_racun)
// BEZ nove štampe — čita samo brojač. Držati SINHRONO sa serverskim fajlom (isti fening, isti pragovi, iste odluke).
//
// ⚠ Ovo NIJE lib/fiskalni/tring.js (SHA-ogledalo prema serveru) — ovo je zaseban desktop modul; server nema ogledalo za njega.
'use strict';

// Tring TFS drži komandu do 30 s (KomandTimeOut). Brojači se čitaju tek kad uređaj sigurno više ne štampa — inače bi račun
// koji se još štampa izgledao kao „ništa se nije promijenilo" i otišao bi na uređaj drugi put.
const CEKANJE_OPORAVKA_MS = 45000;

// Stanja po vrsti plaćanja u OsnovneInformacije (Tring uputstvo v3.0.1, §7.9.1)
const STANJA_PLACANJA = ['cash', 'card', 'check', 'transfer_order'];

// Vrsta plaćanja → polje stanja na uređaju. Ista pravila kao normPlacanje u lib/fiskalni/tring.js.
function kljucPlacanja(vrsta) {
  const s = String(vrsta || '').trim().toLowerCase();
  if (s.includes('karti') || s.includes('card')) return 'card';
  if (s.includes('virman') || s.includes('transakci')) return 'transfer_order';
  if (s.includes('cek') || s.includes('ček')) return 'check';
  return 'cash';
}

function cijeli(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isInteger(n) ? n : null;
}
function fening(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// Odgovori OsnovneInformacije (Naziv → Vrijednost) → snimak brojača; iznosi u feningu. Polje koje uređaj ne vrati ostaje null.
function snimakIzOdgovora(odgovori, procitano) {
  if (!odgovori || typeof odgovori !== 'object') return null;
  const o = odgovori;
  const snimak = {
    ibfm: typeof o.ibfm === 'string' && o.ibfm.trim() ? o.ibfm.trim() : null,
    last_BF: cijeli(o.last_BF),
    last_RF: cijeli(o.last_RF),
    cash: fening(o.cash ?? o.Gotovina),
    card: fening(o.card ?? o.Kartica),
    check: fening(o.check ?? o.Cek),
    transfer_order: fening(o.transfer_order ?? o.Virman),
    z_number: cijeli(o.z_number),
  };
  if (procitano) snimak.procitano = procitano;
  return snimak;
}

// Ishod slanja računa iz odgovora drajvera:
//   'fiskalizovan' — uređaj je potvrdio (VrstaOdgovora OK)
//   'greska'       — uređaj je izričito odbio (Greska) ili zahtjev nije ni otišao: smije se poslati ponovo
//   'nepoznato'    — istek čekanja, prekid veze, pad poziva, Upozorenje ili nepoznat odgovor: možda je odštampan
function ishodSlanja(rez) {
  if (!rez || typeof rez !== 'object') return 'nepoznato';
  if (rez.uspjeh) return 'fiskalizovan';
  if (rez.veza_pukla) return 'nepoznato';
  const raw = String(rez.raw || '');
  const m = /<VrstaOdgovora>\s*([^<]*?)\s*<\/VrstaOdgovora>/i.exec(raw);
  if (m) return /^gre[sš]ka$/i.test(m[1]) ? 'greska' : 'nepoznato';
  return raw ? 'nepoznato' : 'greska';
}

const broj = (s, k) => (s && Number.isInteger(s[k]) ? s[k] : null);

// Odluka za račun bez odgovora. prije = snimak prije slanja, poslije = snimak sad, iznos u feningu,
// vrsta = vrsta plaćanja ili lista plaćanja [{vrsta, iznos_fening}], tip = 'fiskalni' | 'reklamirani':
//   'fiskalizovan' — broj računa porastao tačno za jedan, a stanje te vrste plaćanja za iznos računa (ostalo isto)
//   'stampaj'      — ništa se nije promijenilo: račun nije odštampan, smije ponovo na uređaj
//   'voditelj'     — sve ostalo (i firmver bez last_BF): broj s trake uređaja potvrđuje voditelj, nikad automatska štampa
function odlukaOporavka(prije, poslije, iznos, vrsta, tip = 'fiskalni') {
  if (!prije || !poslije || typeof prije !== 'object' || typeof poslije !== 'object') return 'voditelj';
  const povrat = tip === 'reklamirani';
  const nas = povrat ? 'last_RF' : 'last_BF';
  const drugi = povrat ? 'last_BF' : 'last_RF';
  if (broj(prije, nas) == null || broj(poslije, nas) == null || broj(prije, drugi) == null || broj(poslije, drugi) == null) return 'voditelj';
  if (prije.ibfm && poslije.ibfm && prije.ibfm !== poslije.ibfm) return 'voditelj';   // drugi uređaj
  const zPrije = broj(prije, 'z_number');
  const zPoslije = broj(poslije, 'z_number');
  if (zPrije !== zPoslije) return 'voditelj';   // dnevni izvještaj između (ili uređaj broj vrati samo jednom)

  // stanje koje uređaj ne vraća ni prije ni poslije se ne gleda; vraćeno samo jednom = ne zna se
  const pomak = {};
  for (const k of STANJA_PLACANJA) {
    const p = broj(prije, k);
    const n = broj(poslije, k);
    if (p == null && n == null) continue;
    if (p == null || n == null) return 'voditelj';
    pomak[k] = n - p;
  }
  const dNas = poslije[nas] - prije[nas];
  const dDrugi = poslije[drugi] - prije[drugi];
  if (dNas === 0 && dDrugi === 0) return Object.values(pomak).every((d) => d === 0) ? 'stampaj' : 'voditelj';
  if (dNas !== 1 || dDrugi !== 0) return 'voditelj';

  const ukupno = Math.round(Number(iznos));
  if (!Number.isFinite(ukupno) || ukupno <= 0) return 'voditelj';
  const lista = Array.isArray(vrsta) ? vrsta : [{ vrsta, iznos_fening: ukupno }];
  const ocekivano = {};
  let zbir = 0;
  for (const pl of lista) {
    const f = Math.round(Number(pl && pl.iznos_fening));
    if (!Number.isFinite(f) || f < 0) return 'voditelj';
    const k = kljucPlacanja(pl && pl.vrsta);
    ocekivano[k] = (ocekivano[k] || 0) + f;
    zbir += f;
  }
  if (zbir !== ukupno) return 'voditelj';
  const znak = povrat ? -1 : 1;   // prodaja povećava stanje vrste plaćanja, povrat ga smanjuje
  for (const k of STANJA_PLACANJA) {
    const treba = (ocekivano[k] || 0) * znak;
    if (!(k in pomak)) { if (treba !== 0) return 'voditelj'; continue; }   // uređaj ne vraća stanje baš te vrste
    if (pomak[k] !== treba) return 'voditelj';
  }
  return 'fiskalizovan';
}

// Koliko još treba čekati prije čitanja brojača (0 = smije).
function preostaloDoProvjere(pokusajMs, sadMs = Date.now()) {
  const p = Number(pokusajMs);
  if (!Number.isFinite(p)) return 0;
  return Math.min(CEKANJE_OPORAVKA_MS, Math.max(0, CEKANJE_OPORAVKA_MS - (sadMs - p)));
}

// 'YYYY-MM-DD HH:MM:SS' po lokalnom satu (bez Intl: bs-BA u Chromiumu daje američki format)
function lokalnoVrijeme(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = {
  CEKANJE_OPORAVKA_MS, STANJA_PLACANJA,
  kljucPlacanja, snimakIzOdgovora, ishodSlanja, odlukaOporavka, preostaloDoProvjere, lokalnoVrijeme,
};
