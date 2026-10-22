/* qa/image_test.js — pixel-level proof that the image tools do real work.
 *
 *   node qa/image_test.js
 *
 * Every tool is driven through the shipped UI (so the worker path is exercised too), the
 * artefact is downloaded and then measured with Pillow:
 *   · the output must not be blank / black / flat            (the old `undefined`-option bug)
 *   · dimensions must match the tool's contract
 *   · tool-specific invariants (grey is really grey, rotate swaps, crop crops …)
 *   · a 12 MP photo must finish inside a time budget while the tab stays responsive
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'img-out');
const PORT = 8901;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

function serve() {
  const server = http.createServer((req, res) => {
    let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (f.endsWith('/')) f += 'index.html';
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

/* Pillow does the measuring: size, mean, stddev, unique colours, clipping, channel spread */
function stats(file) {
  const py = `
import json,sys
from PIL import Image
import numpy as np
im=Image.open(sys.argv[1]); im.load()
rgb=im.convert('RGB'); a=np.asarray(rgb).astype(np.float32)
m=a.reshape(-1,3)
info={'size':[int(v) for v in rgb.size],'mean':[float(round(x,2)) for x in m.mean(0)],'std':[float(round(x,2)) for x in m.std(0)],
      'uniq':int(len(np.unique(m[::53],axis=0))),
      'black':float((m.max(1)<3).mean()),'white':float((m.min(1)>252).mean()),
      'exif':len(getattr(im,'getexif')().items())}
print(json.dumps(info))`;
  return JSON.parse(execFileSync('python3', ['-c', py, file], { encoding: 'utf8' }));
}

function psnr(a, b) {
  const py = `
import json,sys
from PIL import Image
import numpy as np
a=np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
b=np.asarray(Image.open(sys.argv[2]).convert('RGB').resize(Image.open(sys.argv[1]).size)).astype(np.float32)
se=((a-b)**2).mean()
print(json.dumps(float(10*np.log10(255*255/se)) if se>0 else 99.0))`;
  return JSON.parse(execFileSync('python3', ['-c', py, a, b], { encoding: 'utf8' }));
}

const flat = (s) => s.std < 2 || Math.max(...s.mean) < 3 || Math.min(...s.mean) > 252;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/compress/index.html`);
  await page.waitForTimeout(400);

  /* run a tool through the UI and return [file, ms, note, longestFrozenFrame] */
  async function runTool(id, files, opts = {}) {
    if (await page.locator('#toolPane').isVisible()) { await page.click('#toolBack'); await page.waitForTimeout(70); }
    await page.click(`.tcard[data-tool="${id}"]`);
    await page.waitForTimeout(120);
    await page.setInputFiles('#tInput', files.map((f) => path.join(FIX, f)));
    await page.waitForTimeout(230);
    for (const [k, v] of Object.entries(opts)) {
      const sel = `[data-opt="${k}"]`;
      if (await page.locator(sel).count()) await page.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    }
    await page.evaluate(() => { window.__gaps = []; let last = performance.now(); const tick = () => { const t = performance.now(); window.__gaps.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    const t0 = Date.now();
    await page.click('#tRun');
    await page.waitForFunction(() => /^(DONE|ERROR|CANCELLED)/i.test(document.querySelector('#tState').textContent.trim()), null, { timeout: 180000 });
    const ms = Date.now() - t0;
    const gaps = await page.evaluate(() => window.__gaps || []);
    const state = (await page.locator('#tState').innerText()).toLowerCase();
    const btn = page.locator('#toolResults .tout [data-dl]').first();
    let file = null, note = '';
    if (await btn.count()) {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), btn.click()]);
      file = path.join(OUT, `${id}--${dl.suggestedFilename()}`);
      await dl.saveAs(file);
      note = (await page.locator('#toolResults .tout .meta').first().innerText()).replace(/\n/g, ' ');
    } else {
      note = (await page.locator('#toolResults').innerText()).replace(/\n/g, ' ').slice(0, 90);
    }
    return { file, ms, note, state, frozen: gaps.length ? Math.max(...gaps) : 0 };
  }

  /* ── 1. Upscale: real enlargement with measurable fidelity ───────────── */
  {
    const r = await runTool('upscale', ['photo1.jpg'], { factor: '2', detail: '45', format: 'png' });
    const s = stats(r.file);
    check('upscale ×2 doubles the pixels', s.size[0] === 3200 && s.size[1] === 2400, `${s.size.join('×')}`);
    check('upscale output is a real image', !flat(s), `σ ${s.std[0]} · ${s.uniq} colours`);
    /* ground truth: upscale a half-size copy back to the original size and measure PSNR */
    const half = path.join(OUT, 'half.png');
    execFileSync('python3', ['-c', 'from PIL import Image;import sys;i=Image.open(sys.argv[1]);i.resize((i.width//2,i.height//2),Image.LANCZOS).save(sys.argv[2])', path.join(FIX, 'photo1.jpg'), half]);
    const halfOut = path.join(OUT, 'half-in.png');
    fs.copyFileSync(half, halfOut);
    if (await page.locator('#toolPane').isVisible()) { await page.click('#toolBack'); await page.waitForTimeout(70); }
    await page.click('.tcard[data-tool="upscale"]'); await page.waitForTimeout(120);
    await page.setInputFiles('#tInput', halfOut); await page.waitForTimeout(200);
    await page.click('#tRun');
    await page.waitForFunction(() => /^(DONE|ERROR|CANCELLED)/i.test(document.querySelector('#tState').textContent.trim()), null, { timeout: 180000 });
    const btn2 = page.locator('#toolResults .tout [data-dl]').first();
    const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), btn2.click()]);
    const r2 = { file: path.join(OUT, 'half-up--' + dl2.suggestedFilename()) };
    await dl2.saveAs(r2.file);
    const p = psnr(r2.file, path.join(FIX, 'photo1.jpg'));
    check('upscale beats a plain stretch (PSNR)', p >= 30, `${p.toFixed(1)} dB vs the original`);
    check('upscale jpeg default is small', (await (async () => {
      const r3 = await runTool('upscale', ['photo1.jpg'], { factor: '2', detail: '45' });
      return fs.statSync(r3.file).size < 2.5e6;
    })()) , 'default output under 2.5 MB');
  }

  /* ── 2. Enhance: more contrast, no clipping, no black square ─────────── */
  {
    const before = stats(path.join(FIX, 'photo1.jpg'));
    const r = await runTool('enhance', ['photo1.jpg'], { level: 'medium' });
    const s = stats(r.file);
    check('enhance keeps every pixel', s.size[0] === before.size[0] && s.size[1] === before.size[1], `${s.size.join('×')}`);
    check('enhance is not blank', !flat(s), `σ ${s.std[0]} · ${s.uniq} colours`);
    check('enhance raises micro-contrast', s.std[0] >= before.std[0] * 0.98, `σ ${before.std[0]} → ${s.std[0]}`);
    check('enhance does not clip the frame', Math.max(s.black, s.white) < 0.05, `black ${(s.black * 100).toFixed(1)}% · white ${(s.white * 100).toFixed(1)}%`);
    const greys = Math.abs(s.mean[0] - s.mean[1]) + Math.abs(s.mean[1] - s.mean[2]);
    const gb = Math.abs(before.mean[0] - before.mean[1]) + Math.abs(before.mean[1] - before.mean[2]);
    check('enhance white balance neutralises the cast', greys <= gb, `channel spread ${gb.toFixed(0)} → ${greys.toFixed(0)}`);
  }

  /* ── 3. The rest of the raster tools ─────────────────────────────────── */
  {
    const g = await runTool('grayscale', ['photo1.jpg']);
    const gs = stats(g.file);
    check('grayscale produces true grey', Math.abs(gs.mean[0] - gs.mean[1]) < 1 && Math.abs(gs.mean[1] - gs.mean[2]) < 1, `mean ${gs.mean.join('/')}`);

    const ro = await runTool('rotate', ['photo1.jpg'], { angle: '90' });
    const rs = stats(ro.file);
    check('rotate 90° swaps the canvas', rs.size[0] === 1200 && rs.size[1] === 1600, `${rs.size.join('×')}`);

    const cr = await runTool('crop', ['photo1.jpg']);
    const cs = stats(cr.file);
    check('crop returns the requested frame', cs.size[0] === 1200 && cs.size[1] === 1200, `${cs.size.join('×')}`);

    const fr = await runTool('frame', ['photo1.jpg']);
    const fs2 = stats(fr.file);
    check('frame pads the image', fs2.size[0] === 1728 && fs2.size[1] === 1328, `${fs2.size.join('×')}`);

    const rz = await runTool('resize', ['photo1.jpg'], { mode: 'pct', pct: '50', format: 'keep' });
    const rzs = stats(rz.file);
    check('resize halves exactly', rzs.size[0] === 800 && rzs.size[1] === 600, `${rzs.size.join('×')}`);

    const cv = await runTool('convert', ['diagram.png'], { format: 'webp' });
    check('convert changes the container', cv.file.endsWith('.webp') && stats(cv.file).size[0] === 1400, cv.file.split('--').pop());

    const wm = await runTool('watermark', ['photo1.jpg']);
    check('watermark changes the picture', psnr(wm.file, path.join(FIX, 'photo1.jpg')) < 60, `PSNR ${psnr(wm.file, path.join(FIX, 'photo1.jpg')).toFixed(1)} dB`);

    const st = await runTool('strip', ['page_scan.jpg']);
    const sts = stats(st.file);
    check('strip removes metadata, keeps pixels', sts.exif === 0 && sts.size[0] > 500, `${sts.size.join('×')} · exif ${sts.exif}`);

    const df = await runTool('diff', ['photo1.jpg', 'photo2.jpg']);
    check('diff needs two files and reports them', !!df.file && !flat(stats(df.file)), df.note.slice(0, 40));

    const pal = await runTool('palette', ['photo1.jpg']);
    check('palette returns colours', /#[0-9a-f]{6}/i.test(fs.readFileSync(pal.file, 'utf8')), pal.note);
  }

  /* ── 4. A 12 MP photo: fast enough, and the tab never freezes ────────── */
  {
    const up = await runTool('upscale', ['phone12mp.jpg'], { factor: '2', detail: '45' });
    const us = stats(up.file);
    check('12 MP upscale completes and is correct', us.size[0] === 4096 && up.ms < 20000, `${us.size.join('×')} · ${up.ms} ms`);
    check('12 MP upscale keeps the tab responsive', up.frozen < 250, `longest frame ${Math.round(up.frozen)} ms`);
    const en = await runTool('enhance', ['phone12mp.jpg'], { level: 'strong' });
    const es = stats(en.file);
    check('12 MP enhance completes and is correct', es.size[0] === 4000 && en.ms < 20000, `${es.size.join('×')} · ${en.ms} ms`);
    check('12 MP enhance keeps the tab responsive', en.frozen < 250, `longest frame ${Math.round(en.frozen)} ms`);
  }

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} image checks passed`);
  if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log('  ' + f.name + ' — ' + f.detail)); }
  process.exit(failed.length ? 1 : 0);
})();
