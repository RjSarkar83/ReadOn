/* qa/ui_test.js — interaction / race tests for the queue UI */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

function serve(root) {
  const server = http.createServer((req, res) => {
    const f = path.join(root, req.url === '/' ? 'compress/index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200); fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  const { server, base } = await serve(ROOT);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/compress/index.html');

  /* 1 — a second batch dropped while the first is still running */
  await page.click('.preset[data-id="p50"]');
  await page.setInputFiles('#fileInput', [path.join(FIX, 'scan.pdf')]);
  await page.waitForTimeout(120);
  await page.setInputFiles('#fileInput', [path.join(FIX, 'photo1.jpg'), path.join(FIX, 'report.docx')]);
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.row')];
    return rows.length === 3 && rows.every(r => r.classList.contains('done'));
  }, null, { timeout: 180000 });
  const rows1 = await page.evaluate(() => [...document.querySelectorAll('.row')].map(r => r.querySelector('.badge') && r.querySelector('.badge').textContent));
  check('mid-run drop is queued and completed', rows1.length === 3 && rows1.every(Boolean), rows1.join(','));

  /* 2 — preset change after results marks them stale and offers a re-run */
  await page.click('.preset[data-id="p90"]');
  const rerunVisible = await page.isVisible('#rerun');
  const staleCount = await page.evaluate(() => [...document.querySelectorAll('.n2 em')].filter(e => e.textContent.includes('preset changed')).length);
  check('preset change marks results stale', rerunVisible && staleCount === 3, `${staleCount} stale, re-run button ${rerunVisible ? 'shown' : 'hidden'}`);

  /* 3 — re-run applies the new preset to every row */
  const before = await page.evaluate(() => [...document.querySelectorAll('.size b')].map(b => b.textContent));
  await page.click('#rerun');
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.row')];
    return rows.length === 3 && rows.every(r => r.classList.contains('done') && ![...r.querySelectorAll('.n2 em')].some(e => e.textContent.includes('preset changed')));
  }, null, { timeout: 180000 });
  const after = await page.evaluate(() => [...document.querySelectorAll('.size b')].map(b => b.textContent));
  check('re-run recompresses with the new preset', JSON.stringify(before) !== JSON.stringify(after), `${before.join(' / ')} → ${after.join(' / ')}`);

  /* 4 — theme cycle keeps working and persists */
  await page.click('#themeBtn');
  const theme1 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.reload();
  const theme2 = await page.evaluate(() => document.documentElement.dataset.theme);
  check('theme persists across reload', theme1 === theme2, theme2);

  /* 5 — clear empties the queue and hides the footer */
  await page.setInputFiles('#fileInput', [path.join(FIX, 'photo1.jpg')]);
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.row')];
    return rows.length === 1 && rows[0].classList.contains('done');
  }, null, { timeout: 120000 });
  await page.click('#clear');
  await page.waitForTimeout(150);
  const cleared = await page.evaluate(() => ({
    rows: document.querySelectorAll('.row').length,
    queueHidden: document.querySelector('#queue').hidden,
    footHidden: document.querySelector('#foot').hidden
  }));
  check('clear resets the workspace', cleared.rows === 0 && cleared.queueHidden && cleared.footHidden, JSON.stringify(cleared));

  /* 6 — keyboard shortcut opens the picker (no navigation, no crash) */
  const beforeUrl = page.url();
  await page.keyboard.press('Control+o');
  await page.waitForTimeout(120);
  check('keyboard shortcut is safe', page.url() === beforeUrl, '');

  /* 7 — options: disabling text removal keeps the text layer */
  await page.reload();
  await page.click('.preset[data-id="p50"]');
  await page.click('#adv summary');
  await page.click('.seg[data-opt="pdfText"] button[data-v="off"]');
  await page.setInputFiles('#fileInput', [path.join(FIX, 'text.pdf')]);
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.row')];
    return rows.length === 1 && rows[0].classList.contains('done');
  }, null, { timeout: 120000 });
  const noteOff = await page.evaluate(() => document.querySelector('.row .n2').innerText);
  check('pdfText=off keeps the text layer', !/text layer/i.test(noteOff), noteOff.replace(/\n/g, ' '));

  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.close();
  fs.writeFileSync(path.join(__dirname, 'ui-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
  if (failed.length) process.exitCode = 1;
})();
