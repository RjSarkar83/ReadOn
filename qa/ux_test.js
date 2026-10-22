/* qa/ux_test.js — friendliness, touch ergonomics and "no dead ends" checks.
   Every failure a user can hit must explain itself; nothing may freeze or break the page. */
const { chromium, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const PORT = 8899;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

function serve() {
  const server = http.createServer((req, res) => {
    let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

const openTool = async (page, id) => {
  if (await page.locator('#toolPane').isVisible()) { await page.click('#toolBack'); await page.waitForTimeout(80); }
  await page.click(`.tcard[data-tool="${id}"]`);
  await page.waitForTimeout(120);
};

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  /* ── desktop: no dead ends ─────────────────────────────── */
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/compress/index.html`);
  await page.waitForTimeout(300);

  // 1 — Run with no file tells the user what to do, in plain words
  await openTool(page, 'pdf-merge');
  await page.click('#tRun');
  await page.waitForTimeout(250);
  const noFile = (await page.locator('#toolResults').innerText()).replace(/\s+/g, ' ');
  check('run without a file explains itself', /choose a file first/i.test(noFile), noFile.slice(0, 70));

  // 2 — the retry button exists and works (still no file -> same friendly message again)
  check('failure card offers Try again', await page.locator('#toolRetry').count() === 1);
  await page.click('#toolRetry');
  await page.waitForTimeout(200);
  check('retry keeps the page alive', /choose a file first/i.test(await page.locator('#toolResults').innerText()));

  // 3 — a wrong file type is skipped with a clear toast, not a silent nothing
  await openTool(page, 'pdf-merge');
  await page.setInputFiles('#tInput', path.join(FIX, 'photo1.jpg'));
  await page.waitForTimeout(400);
  const state1 = await page.locator('#tState').innerText();
  const toast1 = (await page.locator('#toast').innerText().catch(() => '')) || '';
  check('wrong file type is refused clearly', /no file yet/i.test(state1) && /skipped/i.test(toast1), `${state1} · ${toast1.slice(0, 46)}`);

  // 4 — a good file re-enables the flow
  await page.setInputFiles('#tInput', path.join(FIX, 'text.pdf'));
  await page.waitForTimeout(300);
  check('a valid file is accepted right after', /ready/i.test(await page.locator('#tState').innerText()));

  // 5 — a damaged file ends in a readable message, page still responsive
  await openTool(page, 'pdf-text');
  await page.setInputFiles('#tInput', path.join(FIX, 'damaged.pdf'));
  await page.waitForTimeout(200);
  await page.click('#tRun');
  await page.waitForTimeout(1500);
  const damaged = (await page.locator('#tResults, #toolResults').first().innerText()).replace(/\s+/g, ' ');
  check('damaged file gives a readable outcome', damaged.length > 0 && !/undefined|\[object/i.test(damaged), damaged.slice(0, 60));

  // 6 — search filters and clears without a flash of empty groups
  await page.click('#toolBack');
  await page.waitForTimeout(120);
  await page.fill('#toolSearch', 'watermark');
  await page.waitForTimeout(220);
  const visible = await page.locator('.tcard:visible').count();
  check('search narrows the grid', visible > 0 && visible < 12, `${visible} cards`);
  await page.fill('#toolSearch', '');
  await page.waitForTimeout(220);
  check('clearing search restores every tool', await page.locator('.tcard:visible').count() > 100);

  // 7 — option values survive a tool switch cleanly (no ghost password)
  await openTool(page, 'pdf-unlock');
  await page.fill('[data-opt="password"]', 'ghost');
  await openTool(page, 'pdf-unlock');
  check('tool options reset when reopened', (await page.locator('[data-opt="password"]').inputValue()) === '');

  // 8 — the Reader is shipped with the app and its link resolves from both locations
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.waitForTimeout(250);
  const relRoot = await page.getAttribute('#readerLink', 'href');
  await Promise.all([page.waitForNavigation(), page.click('#readerLink')]);
  await page.waitForTimeout(900);
  check('Reader opens from the repo root', /reader\.html$/.test(page.url()) && (await page.title()).includes('ArtViSiON'), `${relRoot} → ${page.url().split('/').pop()}`);
  const engines = await page.evaluate(() => ({ pdf: typeof pdfjsLib, docx: typeof mammoth, zip: typeof JSZip, pdfOut: typeof jspdf }));
  check('Reader engines load (bundled, not CDN)', Object.values(engines).every((t) => t !== 'undefined'), JSON.stringify(engines));
  await page.setInputFiles('#file', path.join(FIX, 'text.pdf'));
  await page.waitForTimeout(2500);
  check('Reader opens a PDF', /BOOK READY/i.test(await page.locator('body').innerText()));
  await Promise.all([page.waitForNavigation(), page.click('header a[href="./compress/index.html"]')]);
  await page.waitForTimeout(500);
  check('Reader links back to the tools', await page.locator('.tcard').count() > 100);
  await page.goto(`http://127.0.0.1:${PORT}/compress/index.html`);
  await page.waitForTimeout(250);
  check('Reader link resolves from /compress/ too', (await page.getAttribute('#readerLink', 'href')) === '../reader.html');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.waitForTimeout(250);

  check('no console errors on desktop', errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();

  /* ── mobile: touch targets, sticky run, no horizontal scroll ── */
  for (const dev of ['Pixel 5', 'iPhone 12']) {
    const m = await browser.newContext({ ...devices[dev] });
    const mp = await m.newPage();
    await mp.goto(`http://127.0.0.1:${PORT}/compress/index.html`);
    await mp.waitForTimeout(350);
    const noScroll = await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(`${dev}: no sideways scrolling`, noScroll);
    const small = await mp.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.tcard, .btn, .hbtn, .preset, .seg button').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && r.height < 38) bad.push(`${el.className.split(' ')[0]} ${Math.round(r.height)}px`);
      });
      return bad.slice(0, 3);
    });
    check(`${dev}: tap targets ≥ 38px`, small.length === 0, small.join(', '));
    await mp.click('.tcard[data-tool="pdf-numbers"]');
    await mp.waitForTimeout(200);
    const sticky = await mp.evaluate(() => {
      const cta = document.querySelector('#tCTA');
      const r = cta.getBoundingClientRect();
      return { pos: getComputedStyle(cta).position, inView: r.bottom <= window.innerHeight + 2 && r.top < window.innerHeight };
    });
    check(`${dev}: Run stays reachable (sticky bar)`, sticky.pos === 'sticky' && sticky.inView, JSON.stringify(sticky));
    await m.close();
  }

  await browser.close();
  server.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} UX checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
