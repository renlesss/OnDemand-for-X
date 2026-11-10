#!/usr/bin/env node
'use strict';
/*
 * Checks store/listing.md against the limits of the two stores, so a text edit cannot break a submission:
 *   node tools/check-store.js        (also part of `npm run check`)
 *
 * Fields are the code blocks marked  ```text field=<id> [min=N] [max=N]
 *   - length limits are counted in characters (code points)
 *   - the short description must be the one the build writes into the manifest
 *   - Edge search terms: at most 7 terms, 30 characters each, 21 words in all
 *   - Arabic texts contain Arabic, English texts do not
 *   - no markup (< >) in any text
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const text = fs.readFileSync(path.join(ROOT, 'store', 'listing.md'), 'utf8');
const build = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');

const REQUIRED = ['name-en', 'name-ar', 'manifest-description', 'amo-summary-en', 'amo-summary-ar', 'description-en', 'description-ar',
  'edge-search-terms', 'amo-tags', 'release-notes-en', 'release-notes-ar'];
const len = (s) => [...s].length;
const hasArabic = (s) => /[؀-ۿ]/.test(s);

const fields = new Map();
for (const m of text.matchAll(/^```text field=([\w-]+)([^\n]*)\n([\s\S]*?)\n```$/gm)) {
  const opts = {};
  for (const o of m[2].trim().split(/\s+/).filter(Boolean)) { const [k, v] = o.split('='); opts[k] = Number(v); }
  if (fields.has(m[1])) { console.error(`store/listing.md: field "${m[1]}" appears twice`); process.exit(1); }
  fields.set(m[1], { value: m[3], opts });
}

const problems = [];
for (const id of REQUIRED) if (!fields.has(id)) problems.push(`field "${id}" is missing`);

for (const [id, { value, opts }] of fields) {
  const n = len(value);
  if (!value.trim()) problems.push(`${id}: empty`);
  if (opts.max !== undefined && n > opts.max) problems.push(`${id}: ${n} characters, the limit is ${opts.max}`);
  if (opts.min !== undefined && n < opts.min) problems.push(`${id}: ${n} characters, at least ${opts.min} are required`);
  if (/[<>]/.test(value)) problems.push(`${id}: contains < or > (texts are plain text)`);
  if (/\r/.test(value)) problems.push(`${id}: contains a carriage return`);
  if (/-ar$/.test(id) && id !== 'edge-search-terms' && !hasArabic(value)) problems.push(`${id}: should be Arabic`);
  if (/-en$/.test(id) && hasArabic(value)) problems.push(`${id}: should not contain Arabic`);
}

const desc = /const DESCRIPTION = '([^']*)'/.exec(build);
if (!desc) problems.push('tools/build.js: DESCRIPTION constant not found');
else if (fields.has('manifest-description') && fields.get('manifest-description').value.trim() !== desc[1]) {
  problems.push('manifest-description differs from DESCRIPTION in tools/build.js (change both)');
}
const name = /const NAME = '([^']*)'/.exec(build);
if (name && fields.has('name-en') && fields.get('name-en').value.trim() !== name[1]) problems.push('name-en differs from NAME in tools/build.js');

if (fields.has('edge-search-terms')) {
  const terms = fields.get('edge-search-terms').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const words = terms.reduce((a, t) => a + t.split(/\s+/).length, 0);
  if (terms.length > 7) problems.push(`edge-search-terms: ${terms.length} terms, at most 7`);
  if (words > 21) problems.push(`edge-search-terms: ${words} words, at most 21`);
  for (const t of terms) if (len(t) > 30) problems.push(`edge-search-terms: "${t}" is longer than 30 characters`);
}

if (problems.length) {
  console.error('store/listing.md:\n - ' + problems.join('\n - '));
  process.exit(1);
}
const show = ['manifest-description', 'amo-summary-en', 'amo-summary-ar', 'description-en', 'description-ar'].map((id) => `${id} ${len(fields.get(id).value)}`).join(', ');
console.log(`store texts OK (${fields.size} fields; ${show})`);
