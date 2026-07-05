// Run: npm run build && CARD_TOKEN_KEY=<64-hex> DATA_DIR=/tmp/scv-test node scripts/test-saved-card.mjs
import assert from 'node:assert/strict';
import { encryptToken, decryptToken } from '../dist/server/tokenVault.js';

const tok = 'pp-token-1234567890abcdef';
const enc = encryptToken(tok);
assert.ok(enc && enc !== tok, 'encrypts');
assert.equal(decryptToken(enc), tok, 'round-trip');
assert.notEqual(encryptToken(tok), enc, 'fresh iv per call');
assert.equal(decryptToken('garbage'), null, 'corrupt → null');
console.log('tokenVault: ALL PASS');
