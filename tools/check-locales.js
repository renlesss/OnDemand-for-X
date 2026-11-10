#!/usr/bin/env node
'use strict';
// node tools/check-locales.js   — checks every file in locales/ against en.json
const path = require('path');
const { loadLocales, validate } = require('./lib/i18n.js');

const dir = path.resolve(__dirname, '..', 'locales');
const locales = loadLocales(dir);
const problems = validate(locales);
const codes = Object.keys(locales);
console.log(`${codes.length} languages: ${codes.map((c) => `${c} (${locales[c]._name})`).join(', ')}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('locales OK');
