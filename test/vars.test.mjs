import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findVars, fillVars } = require('../src/vars.js');

test('findVars lists each variable once, in order, case-insensitively', () => {
  assert.deepEqual(findVars('Hi {{client}}, about {{ Offer Name }} for {{CLIENT}}.'), ['client', 'Offer Name']);
  assert.deepEqual(findVars('no slots, just {braces} and {{ }}'), []);
});

test('fillVars fills what has a value and leaves a visible slot for what does not', () => {
  const r = fillVars('Hi {{client}}, about {{offer}}.', { Client: 'Acme', offer: '' });
  assert.equal(r.text, 'Hi Acme, about {{offer}}.');
  assert.deepEqual(r.missing, ['offer']);
});
