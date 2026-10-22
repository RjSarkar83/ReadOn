/* qa/bench.js — measures every fixture at every preset inside a real browser
   and writes ../benchmark.csv (bytes in/out, saved %, fidelity kind, PSNR, SSIM, ms).

   node qa/bench.js
*/
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(ROOT, 'benchmark.csv');

const FILES = ['text.pdf', 'text_objstm.pdf', 'photos.pdf', 'photos_objstm.pdf', 'scan.pdf',
  'diagram.pdf', 'photo1.jpg', 'noise.png', 'diagram.png', 'report.docx', 'deck.pptx', 'data.xlsx'];
const PRESETS = ['lossless', 'p10', 'p25', 'p50', 'p75', 'p90'];

function serve(root) {
  const server = http.createServer((req, res) => {
    const f = path.join(root, req.url === '/' ? 'compress/index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200); fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

(async () => {
  const { server, base } = await serve(ROOT);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  await page.goto(base + '/compress/index.html');
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  const data = {};
  for (const n of FILES) data[n] = fs.readFileSync(path.join(FIX, n)).toString('base64');

  const rows = [['file', 'preset', 'in_bytes', 'out_bytes', 'saved_pct', 'fidelity', 'psnr_db', 'ssim_pct', 'notes', 'ms']];
  for (const preset of PRESETS) {
    const res = await page.evaluate(async ({ files, data, preset }) => {
      const out = {};
      for (const f of files) {
        const bytes = Uint8Array.from(atob(data[f]), c => c.charCodeAt(0));
        const file = new File([bytes], f);
        const t0 = performance.now();
        const r = await Compressor.compress(file, { preset, options: {} });
        out[f] = {
          inb: bytes.length, outb: r.bytes.length, kind: r.kind,
          psnr: r.psnr, ssim: r.ssim, notes: (r.notes || []).join(' | '),
          ms: Math.round(performance.now() - t0)
        };
      }
      return out;
    }, { files: FILES, data, preset });
    for (const f of FILES) {
      const r = res[f];
      rows.push([f, preset, r.inb, r.outb, (100 * (1 - r.outb / r.inb)).toFixed(1), r.kind,
        r.psnr == null ? '' : r.psnr.toFixed(1), r.ssim == null ? '' : (r.ssim * 100).toFixed(1), r.notes, r.ms]);
    }
    console.log('bench', preset, 'done');
  }
  const csv = rows.map(r => r.map(c => (String(c).includes(',') ? `"${c}"` : c)).join(',')).join('\n');
  fs.writeFileSync(OUT, csv);
  console.log('wrote', OUT, rows.length - 1, 'rows');
  if (errors.length) console.log('page errors:', errors.join(' | '));
  await browser.close();
  server.close();
})();
