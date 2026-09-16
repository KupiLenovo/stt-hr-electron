// MAL-03 — desktop drži BAJT-PO-BAJT kopiju serverskog lib/fiskalni/tring.js uz lib/fiskalni/tring.sha256.
// Ovaj test pada čim se kopija i njen zapisani SHA raziđu (izmjena fajla bez ažuriranja sha, ili obrnuto).
// Serverski CI job `fiskalni-ogledalo` je druga brana: poredi OVU kopiju s kanonskim serverskim fajlom.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const tringPath = path.join(ROOT, 'lib', 'fiskalni', 'tring.js');
const shaPath = path.join(ROOT, 'lib', 'fiskalni', 'tring.sha256');
// Windows checkout (autocrlf) → normalizuj CRLF na LF prije hasha; kanonski hash je LF (kao Linux CI + .gitattributes eol=lf).
const lf = (s) => s.replace(/\r\n/g, '\n');
const zapisaniSha = () => fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];

test('SHA.1 tring.sha256 je 64-heksadecimalni SHA-256', () => {
    assert.match(zapisaniSha(), /^[0-9a-f]{64}$/);
});

test('SHA.2 SHA-256(lib/fiskalni/tring.js) == lib/fiskalni/tring.sha256', () => {
    const izracunat = crypto.createHash('sha256').update(lf(fs.readFileSync(tringPath, 'utf8')), 'utf8').digest('hex');
    assert.equal(izracunat, zapisaniSha(), 'tring.js promijenjen bez ažuriranja tring.sha256 (ili obrnuto) — kopija nije u sinhronu');
});
