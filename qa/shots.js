/* qa/shots.js — refreshes the shipped screenshots/ from the built app
     node qa/shots.js       (needs playwright + a chromium download)   */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'screenshots');
const FIX = path.join(__dirname, 'fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

function serve(root) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(root, rel === '/' ? 'compress/index.html' : rel);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const BATCH = ['photos.pdf', 'photo1.jpg', 'noise.png', 'report.docx', 'text.pdf', 'deck.pptx', 'diagram.pdf'];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { server, base } = await serve(ROOT);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // 1 — empty state (desktop, dark)
  const desk = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  const page = await desk.newPage();
  await page.goto(base + '/compress/index.html');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'app-hub.png') });
  await page.screenshot({ path: path.join(SHOTS, 'app-empty.png'), fullPage: true });

  // a tool screen (upscale) — real run, real file
  await page.click('.tcard[data-tool="upscale"]');
  await page.setInputFiles('#tInput', path.join(FIX, 'diagram.png'));
  await page.click('#tRun');
  await page.waitForSelector('#toolResults .tout', { timeout: 120000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, 'app-tool-upscale.png') });
  await page.click('#toolBack');
  await page.waitForTimeout(300);

  // 1b — Lossless results (the 5 % preset, real files, honest labels)
  await page.click('.preset[data-id="lossless"]');
  await page.setInputFiles('#fileInput', BATCH.map(f => path.join(FIX, f)));
  await page.waitForFunction((n) => document.querySelectorAll('.row.done').length >= n &&
    document.querySelector('#stop') && document.querySelector('#stop').hidden, BATCH.length, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.addStyleTag({ content: '.foot{position:static!important;margin-top:18px}' });
  await page.screenshot({ path: path.join(SHOTS, 'app-lossless.png'), fullPage: true });
  await page.click('#clear');
  await page.waitForTimeout(400);

  // 2 — Extreme results
  await page.click('.preset[data-id="extreme"]');
  await page.setInputFiles('#fileInput', BATCH.map(f => path.join(FIX, f)));
  await page.waitForFunction((n) => document.querySelectorAll('.row.done').length >= n &&
    document.querySelector('#stop') && document.querySelector('#stop').hidden, BATCH.length, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // the totals bar is position:fixed — pin it inline so a full-page shot has no overlap
  await page.addStyleTag({ content: '.foot{position:static!important;margin-top:18px}' });
  await page.screenshot({ path: path.join(SHOTS, 'app-results.png'), fullPage: true });

  // 3 — compare slider on the re-encoded photo
  const cmp = page.locator('.row', { hasText: 'photo1.jpg' }).getByText(/^compare$/i);
  if (await cmp.count()) {
    await cmp.first().click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(SHOTS, 'app-compare.png') });
    await page.keyboard.press('Escape').catch(() => {});
  }

  // 4 — light theme
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'app-light.png'), fullPage: true });
  await desk.close();

  // 5 — phone (iPhone 13 class), touch, dark
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
  });
  const p2 = await phone.newPage();
  await p2.goto(base + '/compress/index.html');
  await p2.waitForTimeout(300);
  await p2.addStyleTag({ content: '.hdr{position:static!important}.foot{display:none!important}' });
  await p2.screenshot({ path: path.join(SHOTS, 'app-phone-empty.png'), fullPage: true });
  await p2.tap('.preset[data-id="extreme"]');
  await p2.setInputFiles('#fileInput', ['photo1.jpg', 'report.docx', 'text.pdf'].map(f => path.join(FIX, f)));
  await p2.waitForFunction(() => document.querySelectorAll('.row.done').length >= 3 &&
    document.querySelector('#stop') && document.querySelector('#stop').hidden, null, { timeout: 180000 }).catch(() => {});
  await p2.waitForTimeout(800);
  await p2.addStyleTag({ content: '.hdr{position:static!important}.foot{position:static!important;margin-top:16px}' });
  await p2.screenshot({ path: path.join(SHOTS, 'app-phone.png'), fullPage: true });
  await phone.close();

  await browser.close();
  server.close();
  console.log('screenshots refreshed →', fs.readdirSync(SHOTS).join(' · '));
})();
