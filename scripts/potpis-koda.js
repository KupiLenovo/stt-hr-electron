// Potpis koda Windows instalacije i provjera potpisa ažuriranja — PLT-39 / PLT-22. PRIPREMLJENO, ALI ISKLJUČENO.
//
// ┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
// │ POTPIS_UKLJUCEN = false dok ne stigne certifikat za potpis koda (Eldin). Dok je false, build je kao do sada (nepotpisan│
// │ instalater, bez provjere potpisa ažuriranja) — inače bi svako ažuriranje palo na provjeri potpisa.                      │
// └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
//
// Kad certifikat stigne:
//   1. PUBLISHER_NAME = tačno ime izdavača iz certifikata (polje „CN" subjekta, npr. kako ga Windows pokaže u „Digital Signatures").
//      electron-builder ga upisuje u app-update.yml; electron-updater tada instalira SAMO instalater potpisan tim imenom.
//   2. Tajne u GitHub okruženju `izdanje` ili repou (CSC_LINK + CSC_KEY_PASSWORD za .pfx; za certifikat na HSM-u / u oblaku —
//      a novi OV/EV certifikati su od 2023. samo takvi — vidi uputstvo izdavača certifikata i `win.sign` u electron-builderu).
//   3. POTPIS_UKLJUCEN = true. forceCodeSigning tada obara build ako potpisivanje ne uspije — nepotpisan instalater s
//      uključenom provjerom ne smije izaći (sve kase bi odbile ažuriranje).
//   4. Prvo izdanje s potpisom provjeriti na jednom računaru (beta kanal) prije objave svima.
// VAŽNO: verzije prije uključenja ne provjeravaju potpis; provjera važi od PRVE verzije izgrađene s POTPIS_UKLJUCEN = true.
'use strict';

const POTPIS_UKLJUCEN = false;
const PUBLISHER_NAME = [];   // npr. ['<ime iz certifikata>'] — popuniti tek kad certifikat stigne

/**
 * Dodatak konfiguraciji electron-buildera (spaja se preko `build` iz package.json).
 * @returns {object} prazan objekat kad je potpis isključen
 */
function opcijePotpisa({ ukljucen = POTPIS_UKLJUCEN, publisherName = PUBLISHER_NAME } = {}) {
    if (!ukljucen) return {};
    const imena = (Array.isArray(publisherName) ? publisherName : [publisherName]).map((x) => String(x || '').trim()).filter(Boolean);
    if (!imena.length) throw new Error('Potpis je uključen, a PUBLISHER_NAME je prazan — upiši ime izdavača iz certifikata (scripts/potpis-koda.js).');
    return {
        forceCodeSigning: true,
        win: { publisherName: imena, verifyUpdateCodeSignature: true },
    };
}

module.exports = { POTPIS_UKLJUCEN, PUBLISHER_NAME, opcijePotpisa };
