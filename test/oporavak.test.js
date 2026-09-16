// MAL-04 — pravilo oporavka u glavnom procesu (lib/fiskalni/oporavak.js). Čista logika, bez I/O.
// Isti skup pravila kao serverski client-v2/src/lib/fiskalni-oporavak.js (g155/MAL-01) — ključne odluke duplirane ovdje.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const O = require('../lib/fiskalni/oporavak');

const snim = (o) => ({ ibfm: 'AL901930', last_BF: null, last_RF: null, cash: null, card: null, check: null, transfer_order: null, z_number: 1, ...o });

test('OPOR.1 snimakIzOdgovora — fening iz decimala, cijeli brojevi, null za nevraćeno', () => {
    const s = O.snimakIzOdgovora({ ibfm: 'AL901930', last_BF: '41', cash: '1000.00', z_number: '2' });
    assert.equal(s.last_BF, 41);
    assert.equal(s.cash, 100000);
    assert.equal(s.z_number, 2);
    assert.equal(s.card, null, 'polje koje uređaj ne vrati ostaje null');
});

test('OPOR.2 ishodSlanja — uspjeh→fiskalizovan, veza_pukla→nepoznato, Greska→greska', () => {
    assert.equal(O.ishodSlanja({ uspjeh: true }), 'fiskalizovan');
    assert.equal(O.ishodSlanja({ uspjeh: false, veza_pukla: true }), 'nepoznato');
    assert.equal(O.ishodSlanja({ uspjeh: false, raw: '<KasaOdgovor><VrstaOdgovora>Greska</VrstaOdgovora></KasaOdgovor>' }), 'greska');
    assert.equal(O.ishodSlanja({ uspjeh: false, raw: '<KasaOdgovor><VrstaOdgovora>Upozorenje</VrstaOdgovora></KasaOdgovor>' }), 'nepoznato');
    assert.equal(O.ishodSlanja(null), 'nepoznato');
});

test('OPOR.3 odlukaOporavka — broj +1 i cash za iznos → fiskalizovan', () => {
    const prije = snim({ last_BF: 41, last_RF: 5, cash: 100000, card: 0, check: 0, transfer_order: 0 });
    const poslije = snim({ last_BF: 42, last_RF: 5, cash: 100500, card: 0, check: 0, transfer_order: 0 });
    assert.equal(O.odlukaOporavka(prije, poslije, 500, [{ vrsta: 'Gotovina', iznos_fening: 500 }], 'fiskalni'), 'fiskalizovan');
});

test('OPOR.4 odlukaOporavka — ništa se nije promijenilo → stampaj (nije odštampan)', () => {
    const s = snim({ last_BF: 41, last_RF: 5, cash: 100000, card: 0, check: 0, transfer_order: 0 });
    assert.equal(O.odlukaOporavka(s, { ...s }, 500, [{ vrsta: 'Gotovina', iznos_fening: 500 }], 'fiskalni'), 'stampaj');
});

test('OPOR.5 odlukaOporavka — broj +1 ali stanje ne odgovara → voditelj', () => {
    const prije = snim({ last_BF: 41, last_RF: 5, cash: 100000, card: 0, check: 0, transfer_order: 0 });
    const poslije = snim({ last_BF: 42, last_RF: 5, cash: 100000, card: 0, check: 0, transfer_order: 0 });   // cash se nije pomjerio
    assert.equal(O.odlukaOporavka(prije, poslije, 500, [{ vrsta: 'Gotovina', iznos_fening: 500 }], 'fiskalni'), 'voditelj');
});

test('OPOR.6 odlukaOporavka — reklamirani (povrat): last_RF+1 i cash -iznos → fiskalizovan', () => {
    const prije = snim({ last_BF: 41, last_RF: 5, cash: 100000, card: 0, check: 0, transfer_order: 0 });
    const poslije = snim({ last_BF: 41, last_RF: 6, cash: 99500, card: 0, check: 0, transfer_order: 0 });
    assert.equal(O.odlukaOporavka(prije, poslije, 500, [{ vrsta: 'Gotovina', iznos_fening: 500 }], 'reklamirani'), 'fiskalizovan');
});

test('OPOR.7 odlukaOporavka — bez last_BF (firmver ne vraća) → voditelj (nikad automatska štampa)', () => {
    assert.equal(O.odlukaOporavka(snim({ last_BF: null }), snim({ last_BF: null }), 500, 'Gotovina', 'fiskalni'), 'voditelj');
});

test('OPOR.8 preostaloDoProvjere — 0 kad je prošlo 45 s, inače koliko još', () => {
    assert.equal(O.preostaloDoProvjere(Date.now() - 46000), 0);
    assert.ok(O.preostaloDoProvjere(Date.now()) > 0);
});
