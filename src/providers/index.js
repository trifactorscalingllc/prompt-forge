'use strict';
// The provider registry. Order matters: `auto` picks the first signed-in provider in this order.
const claude = require('./claude');
const gemini = require('./gemini');
const openai = require('./openai');
const compatible = require('./compatible');
const { secretKey } = require('./base');

const IDS = ['claude', 'gemini', 'openai', 'compatible'];

function createProviders(deps) {
  return [claude.create(deps), gemini.create(deps), openai.create(deps), compatible.create(deps)];
}

module.exports = { createProviders, secretKey, IDS };
