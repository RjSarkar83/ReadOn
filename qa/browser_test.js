/* qa/browser_test.js — end-to-end test in a real Chromium
   Drives the shipped index.html (file:// → also proves offline capability),
   downloads every artifact, and runs in-page validators for text formats.

   node qa/browser_test.js [presets...]
*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const http = require('http');
const ROOT = path.join(__dirname, '..');

/* tiny static server: exercises the app exactly like GitHub Pages does */
function serve(root) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(root, url === '/' ? 'compress/index.html' : url);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const FIX = path.join(__dirname, 'fixtures');
const DL = path.join(__dirname, 'downloads');
const SHOTS = path.join(__dirname, 'screens');

const REAL_DIR = path.join(FIX, 'real');
const REAL = fs.existsSync(REAL_DIR) ? fs.readdirSync(REAL_DIR).filter(f => f.endsWith('.pdf')) : [];
const FILES = ['text.pdf', 'photos.pdf', 'scan.pdf', 'text_objstm.pdf', 'photos_objstm.pdf',
  'scan_qdf.pdf', 'diagram.pdf', 'photo1.jpg', 'noise.png', 'diagram.png',
  'report.docx', 'deck.pptx', 'data.xlsx'].concat(REAL);
const fixturePath = (f) => (REAL.includes(f) ? path.join(REAL_DIR, f) : path.join(FIX, f));
const TEXT_FILES = ['data.json', 'icon.svg', 'page.html', 'theme.css', 'app.js', 'notes.txt'];
const EDGE_FILES = ['encrypted.pdf', 'broken.pdf', 'anim.gif'];

const presets = process.argv.slice(2).length ? process.argv.slice(2) : ['lossless', 'p10', 'p25', 'p50', 'p75', 'p90', 'extreme'];

(async () => {
  fs.mkdirSync(DL, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const { server, base } = await serve(ROOT);
  const APP = base + '/compress/index.html';
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForTimeout(250);

  const summary = { presets: {}, text: {}, edge: {}, errors };

  /* ── text/markup formats, validated in-page ── */
  const readFixtures = {};
  for (const n of [...TEXT_FILES]) readFixtures[n] = fs.readFileSync(path.join(FIX, n)).toString('base64');

  const textReport = await page.evaluate(async ({ names, data }) => {
    const b64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const out = {};
    for (const n of names) {
      const bytes = b64(data[n]);
      const f = new File([bytes], n, { type: 'text/plain' });
      const r = await Compressor.compress(f, { preset: 'p50', options: {} });
      let valid = true, why = '';
      const txt = new TextDecoder().decode(r.bytes);
      try {
        if (n.endsWith('.json')) JSON.parse(txt);
        else if (n.endsWith('.svg') || n.endsWith('.xml')) {
          const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
          if (doc.getElementsByTagName('parsererror').length) throw new Error('xml parse');
        } else if (n.endsWith('.html')) {
          const doc = new DOMParser().parseFromString(txt, 'text/html');
          if (!doc.querySelector('h1') || !doc.querySelector('p')) throw new Error('html structure lost');
        } else if (n.endsWith('.css')) {
          const o = (txt.match(/{/g) || []).length, c = (txt.match(/}/g) || []).length;
          if (o !== c || o === 0) throw new Error('css braces unbalanced');
        } else if (n.endsWith('.js')) {
          new Function(txt);               // compile-only syntax check
          if (!txt.includes('greet') || !txt.includes('/ab+c/')) throw new Error('token lost');
        }
      } catch (e) { valid = false; why = e.message; }
      out[n] = { before: bytes.length, after: r.bytes.length, saved: +(100 * (1 - r.bytes.length / bytes.length)).toFixed(1), valid, why, notes: r.notes };
    }
    return out;
  }, { names: TEXT_FILES, data: readFixtures });
  summary.text = textReport;

  /* ── edge cases: must not throw, must report a reason ── */
  const edgeData = {};
  for (const n of EDGE_FILES) edgeData[n] = fs.readFileSync(path.join(FIX, n)).toString('base64');
  summary.edge = await page.evaluate(async ({ names, data }) => {
    const out = {};
    for (const n of names) {
      const bytes = Uint8Array.from(atob(data[n]), c => c.charCodeAt(0));
      const f = new File([bytes], n);
      try {
        const r = await Compressor.compress(f, { preset: 'p50', options: {} });
        out[n] = { ok: true, same: r.bytes.length === bytes.length, notes: r.notes };
      } catch (e) { out[n] = { ok: false, error: e.message }; }
    }
    return out;
  }, { names: EDGE_FILES, data: edgeData });

  /* ── the real UI, one preset at a time ── */
  for (const preset of presets) {
    await page.click(`.preset[data-id="${preset}"]`);
    const clear = await page.$('#clear');
    if (clear && await page.isVisible('#clear')) await page.click('#clear');
    await page.setInputFiles('#fileInput', FILES.map(fixturePath));
    await page.waitForFunction(
      (n) => { const rows = [...document.querySelectorAll('.row')]; return rows.length === n && rows.every(r => r.classList.contains('done')); },
      FILES.length, { timeout: 900000 });

    const rows = await page.evaluate(() => [...document.querySelectorAll('.row')].map(r => ({
      name: r.querySelector('.n1').textContent,
      from: r.querySelector('.size s') && r.querySelector('.size s').textContent,
      to: r.querySelector('.size b') && r.querySelector('.size b').textContent,
      saved: r.querySelector('.saved').innerText.replace(/\s+/g, ' '),
      tags: [...r.querySelectorAll('.badge')].map(b => b.textContent).join(','),
      notes: [...r.querySelectorAll('.n2 em')].map(e => e.textContent).join(' | ')
    })));
    const totals = await page.evaluate(() => ({
      saved: document.querySelector('#totalSaved').textContent,
      abs: document.querySelector('#totalAbs').textContent,
      meta: document.querySelector('#totalMeta').textContent
    }));

    const dir = path.join(DL, preset);
    fs.mkdirSync(dir, { recursive: true });
    const saveOnce = async (selector, name) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const [dl] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }),
            page.click(selector, { force: true })
          ]);
          await dl.saveAs(path.join(dir, name || dl.suggestedFilename()));
          return true;
        } catch (e) { await page.waitForTimeout(400); }
      }
      console.warn('  ! could not capture download for ' + selector);
      return false;
    };
    const rowCount = (await page.$$('.row')).length;
    for (let i = 0; i < rowCount; i++) {
      await saveOnce(`.row:nth-child(${i + 1}) .acts .btn.solid`);
      await page.waitForTimeout(60);
    }
    if (await page.$('#dlAll')) await saveOnce('#dlAll', '_all.zip');

    await page.screenshot({ path: path.join(SHOTS, `results-${preset}.png`), fullPage: true });
    summary.presets[preset] = { rows, totals };
    console.log(`\n[${preset}] ${totals.saved} · ${totals.meta}`);
    for (const r of rows) console.log(`  ${r.name.padEnd(18)} ${String(r.from).padStart(9)} → ${String(r.to).padStart(9)}  ${r.saved.padEnd(16)} ${r.tags.padEnd(10)} ${r.notes}`);
  }

  /* ── compare modal ── */
  const cmp = await page.$('.acts .btn:has-text("Compare")');
  if (cmp) {
    await cmp.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOTS, 'compare.png') });
    await page.keyboard.press('Escape');
  }

  /* ── responsive + theme smoke test ── */
  for (const [w, h, tag] of [[390, 844, 'phone'], [820, 1180, 'tablet'], [1440, 1000, 'desktop']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    summary[`layout_${tag}`] = { overflow };
    await page.screenshot({ path: path.join(SHOTS, `layout-${tag}.png`), fullPage: true });
  }
  await page.click('#themeBtn');
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(SHOTS, 'theme-light.png') });
  await page.click('#themeBtn');

  await browser.close();
  server.close();
  fs.writeFileSync(path.join(__dirname, 'browser-results.json'), JSON.stringify(summary, null, 2));
  console.log('\npage errors:', errors.length ? errors.join('\n') : 'none');
  console.log('text formats:', Object.entries(summary.text).map(([k, v]) => `${k} ${v.saved}% ${v.valid ? 'ok' : 'INVALID ' + v.why}`).join(' · '));
  console.log('edge cases:', Object.entries(summary.edge).map(([k, v]) => `${k} ${v.ok ? (v.same ? 'unchanged' : 'changed') : 'THREW'}`).join(' · '));
  if (errors.length) process.exitCode = 1;
})();
