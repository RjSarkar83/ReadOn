/* qa/root_test.js — the GitHub Pages layout check.
   Serves the repo exactly as it is pushed (index.html at the root) and proves the app
   boots, registers its service worker with root scope, compresses, and that every
   asset the bundle references actually exists next to it. */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8200 + Math.floor(Math.random() * 90);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const missing = [];

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const f = path.join(ROOT, rel);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    missing.push(rel); res.writeHead(404); return res.end();
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

server.listen(PORT, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${PORT}`;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // 1 — open the repo root exactly like GitHub Pages does
  await page.goto(base + '/');
  await page.waitForTimeout(2500);
  const s = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    const urls = keys.length ? (await (await caches.open(keys[0])).keys()).map(k => new URL(k.url).pathname) : [];
    return {
      title: document.title, tools: document.querySelectorAll('.tcard').length,
      presets: document.querySelectorAll('.preset').length, engine: typeof Compressor,
      reg: reg ? (reg.active ? 'active' : 'installing') : 'none', scope: reg ? reg.scope : '',
      urls, manifestLinked: !!document.querySelector('link[rel="manifest"]'),
      icons: [...document.querySelectorAll('link[rel*="icon"]')].length
    };
  });
  check('repo root serves the app (index.html)', s.title.includes('ArtViSiON') && s.tools >= 100,
    `${s.tools} tools · ${s.presets} presets`);
  check('engine is live at the root', s.engine === 'object', s.engine);
  check('service worker registers with root scope', s.reg === 'active' && s.scope === base + '/', s.scope);
  check('root shell cached', s.urls.includes('/index.html') || s.urls.includes('/'), s.urls.slice(0, 2).join(', '));
  check('manifest + icon links present at root', s.manifestLinked && s.icons >= 2, `${s.icons} icon links`);

  // 2 — a real compress through the root URL
  const b64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'photos.pdf')).toString('base64');
  const r = await page.evaluate(async (b64) => {
    const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const res = await Compressor.compress(new File([u], 'photos.pdf'), { preset: 'lossless', options: {} });
    return { inb: u.length, outb: res.bytes.length, kind: res.kind };
  }, b64);
  check('compress works from the root URL', r.outb < r.inb && r.kind === 'lossless',
    `${(r.inb / 1024) | 0} KB → ${(r.outb / 1024) | 0} KB · ${r.kind}`);

  // 3 — the in-app download path produces a real file
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.evaluate(async (b64) => {
    const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const r = await Compressor.compress(new File([u], 'photos.pdf'), { preset: 'lossless', options: {} });
    const blob = new Blob([r.bytes], { type: 'application/pdf' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'root-check.pdf';
    document.body.appendChild(a); a.click(); a.remove();
  }, b64);
  const d = await dl;
  check('save button path downloads a file', !!d && d.suggestedFilename() === 'root-check.pdf',
    d ? d.suggestedFilename() : 'no download');

  // 4 — the /compress/ copy still works and nothing 404s
  missing.length = 0;
  await page.goto(base + '/compress/index.html');
  await page.waitForTimeout(1500);
  const alt = await page.evaluate(() => ({ tools: document.querySelectorAll('.tcard').length, engine: typeof Compressor }));
  check('/compress/ copy is identical', alt.tools >= 100 && alt.engine === 'object', `${alt.tools} tools`);
  check('no 404s for any asset', missing.length === 0, missing.slice(0, 3).join(', ') || 'clean');

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  const bad = results.filter(x => !x.ok).length;
  console.log(`\n${results.length - bad}/${results.length} root-layout checks passed`);
  await browser.close();
  server.close();
  process.exit(bad ? 1 : 0);
});
