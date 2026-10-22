/* qa/pwa_test.js — installability + offline check
   Serves the repo over http, waits for the service worker, kills the server and
   reloads: the app must come back from cache with all presets and its engine. */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8100 + Math.floor(Math.random() * 90);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

let online = true;
const server = http.createServer((req, res) => {
  if (!online) { res.writeHead(503); return res.end(); }
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const f = path.join(ROOT, rel);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

server.listen(PORT, '127.0.0.1', async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  // Playwright sets navigator.webdriver; the app skips the SW in that case on purpose
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  const base = `http://127.0.0.1:${PORT}`;
  await page.goto(base + '/compress/index.html');
  await page.waitForTimeout(2500);

  const state = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    const cache = keys.length ? await caches.open(keys[0]) : null;
    const urls = cache ? (await cache.keys()).map(k => new URL(k.url).pathname) : [];
    const man = await fetch('manifest.webmanifest').then(r => (r.ok ? r.json() : null)).catch(() => null);
    const link = document.querySelector('link[rel="manifest"]');
    return { reg: reg ? (reg.active ? 'active' : 'installing') : 'none', keys, urls, man, link: !!link,
      theme: (document.querySelector('meta[name="theme-color"]') || {}).content };
  });

  check('service worker registers and activates', state.reg === 'active', state.reg);
  check('shell registers from the app folder', state.reg === 'active', state.reg);
  check('shell is cached (bundle, manifest, both icons)',
    ['/compress/index.html', '/compress/manifest.webmanifest', '/compress/icon-192.png', '/compress/icon-512.png']
      .every(u => state.urls.includes(u)), `${state.urls.length} urls`);
  check('manifest parses', !!(state.man && state.man.name), state.man ? `${state.man.name} · ${state.man.display}` : 'missing');
  check('manifest is linked + themed', state.link && !!state.theme, 'theme-color ' + state.theme);
  check('icons declared', !!(state.man && state.man.icons && state.man.icons.length >= 2),
    state.man && state.man.icons ? state.man.icons.map(i => i.sizes).join(', ') : '');

  online = false;                                    // simulate no connection
  await page.reload({ waitUntil: 'load' });
  const offline = await page.evaluate(() => ({
    presets: document.querySelectorAll('.preset').length,
    parts: typeof Compressor !== 'undefined' && !!Compressor.PRESETS,
    worker: !!document.getElementById('worker-src'),
    drop: !!document.querySelector('#fileInput')
  }));
  check('app loads offline', offline.parts && offline.drop, JSON.stringify(offline));
  check('all seven presets offline', offline.presets === 7, offline.presets + ' presets');
  check('worker payload survived', offline.worker);
  check('no page errors', errors.length === 0, errors.join(' · '));

  await browser.close();
  server.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} PWA checks passed`);
  process.exit(failed ? 1 : 0);
});
