/* qa/lossless_check.js — runs the real Lossless preset in Chromium and writes
   every output byte-for-byte to qa/out/lossless/ for the independent pixel check.

   node qa/lossless_check.js
*/
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'out', 'lossless');

const FILES = ['text.pdf', 'text_objstm.pdf', 'photos.pdf', 'photos_objstm.pdf', 'photos_lin.pdf',
  'scan.pdf', 'scan_qdf.pdf', 'diagram.pdf', 'lzw.pdf',
  'photo1.jpg', 'photo2.jpg', 'page_scan.jpg', 'noise.png', 'diagram.png', 'icon.svg',
  'report.docx', 'deck.pptx', 'data.xlsx', 'notes.txt', 'data.json'];

function serve(root) {
  const server = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200); fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

(async () => {
  const { server, base } = await serve(ROOT);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/compress/index.html');
  await page.waitForFunction(() => typeof Compressor !== 'undefined');
  fs.mkdirSync(OUT, { recursive: true });

  const rows = [];
  for (const name of FILES) {
    const file = path.join(FIX, name);
    if (!fs.existsSync(file)) continue;
    const b64 = fs.readFileSync(file).toString('base64');
    const r = await page.evaluate(async ({ name, b64, strict }) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const f = new File([bytes], name);
      const t0 = performance.now();
      const res = await Compressor.compress(f, { preset: 'lossless', options: strict ? { losslessStrict: true } : {} });
      return { inb: bytes.length, outb: res.bytes.length, kind: res.kind, outName: res.outName,
        notes: (res.notes || []).join(' | '), psnr: res.psnr, ssim: res.ssim,
        ms: Math.round(performance.now() - t0),
        data: btoa(Array.from(res.bytes, c => String.fromCharCode(c)).join('')) };
    }, { name, b64, strict: false });
    fs.writeFileSync(path.join(OUT, r.outName), Buffer.from(r.data, 'base64'));
    rows.push([name, r.inb, r.outb, (100 * (1 - r.outb / r.inb)).toFixed(1), r.kind, r.outName,
      r.psnr == null ? '' : r.psnr.toFixed(1), r.ssim == null ? '' : (r.ssim * 100).toFixed(1), r.notes, r.ms]);
    console.log(`${name.padEnd(18)} ${(100 * (1 - r.outb / r.inb)).toFixed(1).padStart(6)}%  ${r.kind.padEnd(10)} → ${r.outName}`);
  }
  const csv = [['file', 'in_bytes', 'out_bytes', 'saved_pct', 'fidelity', 'out', 'psnr_db', 'ssim_pct', 'notes', 'ms']].concat(rows)
    .map(r => r.map(v => /[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
  fs.writeFileSync(path.join(__dirname, 'out', 'lossless.csv'), csv + '\n');
  if (errors.length) console.log('PAGE ERRORS:', errors.join(' | '));
  await browser.close(); server.close();
})();
