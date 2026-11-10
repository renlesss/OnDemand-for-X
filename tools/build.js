#!/usr/bin/env node
'use strict';
/*
 * Builds the packages in dist/ — no dependencies, deterministic (the same sources give the same bytes).
 *
 *   node tools/build.js                 everything
 *   node tools/build.js --only chromium (or firefox, source)
 *
 *   dist/chromium/  + ondemand-for-x-<version>-chromium.zip   Chrome, Edge, Brave, Lemur … (Manifest V3)
 *   dist/firefox/   + ondemand-for-x-<version>-firefox.zip    Firefox desktop and Android (Manifest V3, 128+)
 *   ondemand-for-x-<version>-source.zip                       the sources a store reviewer needs to rebuild the above
 *   dist/SHA256SUMS.txt
 *
 * What it does to the sources: generates i18n.js from locales/*.json, removes the TEST-HOOKS blocks from
 * content.js and hook.js, writes the manifest. It checks the result (manifest rules, file references, icon sizes,
 * forbidden APIs, version agreement) and stops with an error on the first problem.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { loadLocales, validate, source: i18nSource } = require('./lib/i18n.js');
const { createZip } = require('./lib/zip.js');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const CFG = pkg.xod || {};

const NAME = 'OnDemand for X (Twitter)';
const SHORT_NAME = 'OnDemand';
const DESCRIPTION = 'Your X (Twitter) timeline one batch at a time, only when you press the button. No endless scroll. Nothing hidden.';
const MATCHES = ['https://x.com/*', 'https://twitter.com/*'];
const ICON_SIZES = [16, 32, 48, 128];
const GECKO_MIN = 128;                                  // the first Firefox with Manifest V3 content scripts in the page's own world
const GECKO_ID = CFG.geckoId;

const fail = (msg) => { throw new Error(msg); };
const read = (p) => fs.readFileSync(p);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ───────────────────────────── preparing the files ───────────────────────────── */

function stripTestHooks(code, file) {
  const A = '/* TEST-HOOKS-START */';
  const B = '/* TEST-HOOKS-END */';
  const a = code.indexOf(A);
  const b = code.indexOf(B);
  if (a < 0 || b < a || code.indexOf(A, a + 1) >= 0) fail(`${file}: the TEST-HOOKS markers are missing or doubled`);
  return code.slice(0, a) + code.slice(b + B.length);
}

function syntaxCheck(code, file) {
  try { new vm.Script(code, { filename: file }); } catch (e) { fail(`${file}: syntax error: ${e.message}`); }
}

function versionOf(code, file) {
  const m = /const VERSION = '([^']+)'/.exec(code);
  if (!m) fail(`${file}: no VERSION constant`);
  return m[1];
}

function sharedFiles() {
  const files = new Map();                              // path inside the package -> Buffer
  const hook = read(path.join(SRC, 'hook.js')).toString('utf8');
  const content = read(path.join(SRC, 'content.js')).toString('utf8');
  if (versionOf(hook, 'src/hook.js') !== VERSION) fail(`src/hook.js says ${versionOf(hook, 'src/hook.js')}, package.json says ${VERSION}`);
  if (versionOf(content, 'src/content.js') !== VERSION) fail(`src/content.js says ${versionOf(content, 'src/content.js')}, package.json says ${VERSION}`);

  const locales = loadLocales(path.join(ROOT, 'locales'));
  const problems = validate(locales);
  if (problems.length) fail(`locales:\n - ${problems.join('\n - ')}`);

  const shipped = stripTestHooks(content, 'src/content.js');
  files.set('hook.js', Buffer.from(stripTestHooks(hook, 'src/hook.js')));
  files.set('content.js', Buffer.from(shipped));
  files.set('content.css', read(path.join(SRC, 'content.css')));
  files.set('i18n.js', Buffer.from(i18nSource(locales)));
  for (const n of ICON_SIZES) files.set(`icons/icon${n}.png`, read(path.join(ROOT, 'icons', `icon${n}.png`)));
  const license = path.join(ROOT, 'LICENSE');
  if (fs.existsSync(license)) files.set('LICENSE', read(license));
  return files;
}

/* ───────────────────────────── manifests ───────────────────────────── */

function chromiumManifest() {
  const icons = {};
  for (const n of ICON_SIZES) icons[String(n)] = `icons/icon${n}.png`;
  const m = {
    manifest_version: 3,
    name: NAME,
    short_name: SHORT_NAME,
    version: VERSION,
    description: DESCRIPTION,
    icons,
    permissions: ['storage'],
    content_scripts: [
      // X's page world, before any script of X runs (no page policy can block this). Browsers that ignore "world"
      // run it in the extension's world instead, where it does nothing; content.js then adds it as a <script> tag.
      { matches: MATCHES, js: ['hook.js'], run_at: 'document_start', world: 'MAIN' },
      { matches: MATCHES, js: ['i18n.js', 'content.js'], css: ['content.css'], run_at: 'document_start' },
    ],
    web_accessible_resources: [{ resources: ['hook.js'], matches: MATCHES }],
  };
  if (pkg.homepage) m.homepage_url = pkg.homepage;
  return m;
}

function firefoxManifest() {
  const m = chromiumManifest();
  m.host_permissions = MATCHES.slice();                 // Firefox treats these as the user's to grant; content scripts need them
  m.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: `${GECKO_MIN}.0`,
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: `${GECKO_MIN}.0` },
  };
  return m;
}

/* ───────────────────────────── checks ───────────────────────────── */

const ALLOWED_TOP_KEYS = ['manifest_version', 'name', 'short_name', 'version', 'description', 'icons', 'permissions',
  'content_scripts', 'web_accessible_resources', 'homepage_url', 'host_permissions', 'browser_specific_settings'];
const FORBIDDEN_CODE = [
  [/\beval\s*\(/, 'eval()'], [/\bnew\s+Function\b/, 'new Function'], [/\bimportScripts\b/, 'importScripts'],
  [/\bsendBeacon\b/, 'sendBeacon'], [/\bWebSocket\b/, 'WebSocket'], [/\bEventSource\b/, 'EventSource'],
  [/\.innerHTML\b/, 'innerHTML'], [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'], [/\bdocument\.write\b/, 'document.write'],
  [/\bXMLHttpRequest\s*\(\)|new\s+XMLHttpRequest/, 'new XMLHttpRequest'],
];
const ALLOWED_URLS = new Set(['http://www.w3.org/2000/svg']);

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function checkManifest(m, files, target) {
  const at = `${target} manifest`;
  if (m.manifest_version !== 3) fail(`${at}: not Manifest V3`);
  for (const k of Object.keys(m)) if (!ALLOWED_TOP_KEYS.includes(k)) fail(`${at}: unexpected key "${k}"`);
  if (!m.name || m.name.length > 45) fail(`${at}: name is empty or longer than 45 characters`);
  if (!m.description || m.description.length > 132) fail(`${at}: description is empty or longer than 132 characters (${(m.description || '').length})`);
  if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(m.version)) fail(`${at}: bad version ${m.version}`);
  if (JSON.stringify(m.permissions) !== JSON.stringify(['storage'])) fail(`${at}: permissions must be exactly ["storage"] (a new permission needs a deliberate change here and in PRIVACY.md and the store texts)`);
  for (const n of ICON_SIZES) {
    const f = files.get(`icons/icon${n}.png`);
    const size = f && pngSize(f);
    if (!size || size[0] !== n || size[1] !== n) fail(`${at}: icons/icon${n}.png is missing or not ${n}x${n}`);
    if (m.icons[String(n)] !== `icons/icon${n}.png`) fail(`${at}: icon ${n} not declared`);
  }
  const refs = [];
  let mainHooks = 0;
  for (const cs of m.content_scripts) {
    if (JSON.stringify(cs.matches) !== JSON.stringify(MATCHES)) fail(`${at}: content script matches must be exactly ${MATCHES.join(', ')}`);
    if (cs.run_at !== 'document_start') fail(`${at}: content scripts must run at document_start`);
    if (cs.all_frames) fail(`${at}: content scripts must not run in frames`);
    refs.push(...(cs.js || []), ...(cs.css || []));
    if (cs.world === 'MAIN') {
      mainHooks++;
      if (JSON.stringify(cs.js) !== JSON.stringify(['hook.js'])) fail(`${at}: only hook.js may run in the page's world`);
    } else if (cs.world !== undefined) fail(`${at}: unknown world ${cs.world}`);
  }
  if (mainHooks !== 1) fail(`${at}: expected exactly one page-world content script, found ${mainHooks}`);
  const order = m.content_scripts.find((c) => c.js.includes('content.js')).js;
  if (order.indexOf('i18n.js') !== 0 || order.indexOf('content.js') !== 1) fail(`${at}: i18n.js must load right before content.js`);
  for (const w of m.web_accessible_resources || []) refs.push(...w.resources);
  for (const r of refs) if (!files.has(r)) fail(`${at}: "${r}" is referenced but not in the package`);
  const wr = m.web_accessible_resources;
  if (!wr || wr.length !== 1 || JSON.stringify(wr[0].resources) !== JSON.stringify(['hook.js']) || JSON.stringify(wr[0].matches) !== JSON.stringify(MATCHES)) {
    fail(`${at}: only hook.js may be web-accessible, and only to ${MATCHES.join(', ')}`);
  }
  if (target === 'firefox') {
    const g = m.browser_specific_settings && m.browser_specific_settings.gecko;
    if (!g || typeof g.id !== 'string' || g.id.length > 80 || !/^([a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+|\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\})$/.test(g.id)) fail(`${at}: browser_specific_settings.gecko.id is missing or neither "name@domain" nor a {GUID} (set "xod.geckoId" in package.json)`);
    if (parseInt(g.strict_min_version, 10) < GECKO_MIN) fail(`${at}: strict_min_version must be at least ${GECKO_MIN}`);
    if (!g.data_collection_permissions || JSON.stringify(g.data_collection_permissions.required) !== JSON.stringify(['none'])) fail(`${at}: data_collection_permissions.required must be ["none"]`);
    if (!m.browser_specific_settings.gecko_android) fail(`${at}: gecko_android is missing (without it the add-on is desktop-only)`);
    if (JSON.stringify(m.host_permissions) !== JSON.stringify(MATCHES)) fail(`${at}: host_permissions must be exactly ${MATCHES.join(', ')}`);
  } else if (m.browser_specific_settings || m.host_permissions) fail(`${at}: Firefox-only keys in the Chromium manifest`);
}

function checkCode(files) {
  for (const [name, buf] of files) {
    if (!name.endsWith('.js')) continue;
    const code = buf.toString('utf8');
    syntaxCheck(code, name);
    if (/__XOD_TEST__|window\.__xod\s*=/.test(code)) fail(`${name}: test hooks are still in the shipped file`);
    for (const [re, label] of FORBIDDEN_CODE) if (re.test(code)) fail(`${name}: uses ${label}, which this extension must not`);
    if (name === 'content.js' && /\bfetch\s*\(/.test(code)) fail('content.js: must not make network requests');
    for (const m of code.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
      if (!ALLOWED_URLS.has(m[0]) && !/^https:\/\/(x|twitter)\.com\//.test(m[0])) fail(`${name}: unexpected URL ${m[0]}`);
    }
    if (buf.length > 200 * 1024) fail(`${name}: unexpectedly large (${buf.length} bytes)`);
  }
}

/* ───────────────────────────── writing ───────────────────────────── */

function entriesOf(files, manifest) {
  const all = new Map(files);
  all.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return [...all.keys()].sort().map((name) => ({ name, data: all.get(name) }));
}

function writeDir(dir, entries) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const { name, data } of entries) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
}

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', 'deliver', 'archive-v1']);
const EXCLUDE_FILES = /(\.pem|\.key|\.crx|\.zip|\.log|\.DS_Store)$/;
function sourceEntries() {
  const out = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (ent.isDirectory()) { if (!EXCLUDE_DIRS.has(ent.name)) walk(full); continue; }
      if (EXCLUDE_FILES.test(ent.name)) continue;
      out.push({ name: rel, data: read(full) });
    }
  }(ROOT));
  return out;
}

function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
  const files = sharedFiles();
  checkCode(files);
  fs.mkdirSync(DIST, { recursive: true });
  const sums = [];
  const targets = [
    ['chromium', chromiumManifest],
    ['firefox', firefoxManifest],
  ];
  for (const [target, make] of targets) {
    if (only && only !== target) continue;
    if (target === 'firefox' && !GECKO_ID) fail('package.json needs "xod": { "geckoId": "name@domain" } for the Firefox package');
    const manifest = make();
    checkManifest(manifest, files, target);
    const entries = entriesOf(files, manifest);
    writeDir(path.join(DIST, target), entries);
    const zipName = `ondemand-for-x-${VERSION}-${target}.zip`;
    const zip = createZip(entries);
    fs.writeFileSync(path.join(DIST, zipName), zip);
    sums.push([sha256(zip), zipName]);
    console.log(`${target.padEnd(9)} ${entries.length} files  ${zipName}  ${zip.length} bytes`);
  }
  if (!only || only === 'source') {
    const entries = sourceEntries();
    if (entries.some((e) => /\.(pem|key)$/.test(e.name))) fail('a key file ended up in the source package');
    const zipName = `ondemand-for-x-${VERSION}-source.zip`;
    const zip = createZip(entries);
    fs.writeFileSync(path.join(DIST, zipName), zip);
    sums.push([sha256(zip), zipName]);
    console.log(`source    ${entries.length} files  ${zipName}  ${zip.length} bytes`);
  }
  if (!only) fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), sums.map(([h, n]) => `${h}  ${n}`).join('\n') + '\n');
  console.log('build OK');
}

try { main(); } catch (e) { console.error(`BUILD FAILED: ${e.message}`); process.exit(1); }
