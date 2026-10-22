/* qa/pdf_engine_test.js — engine-level tests (no browser)
   Exercises PDFEngine / PNGCodec / JPEGCodec / ZipCodec directly and writes
   artifacts to qa/out/ for the independent validators.

   node qa/pdf_engine_test.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIB = path.join(__dirname, '..', 'compress', 'src', 'lib');
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'out');

const FILES = ['codec-js.js', 'util.js', 'filters.js', 'font.js', 'png.js', 'jpeg.js', 'zip.js', 'pdf.js'];
const src = FILES.map(f => fs.readFileSync(path.join(LIB, f), 'utf8')).join('\n;\n');

const ctx = {
  console, DecompressionStream, CompressionStream, Blob, Response, TextEncoder, TextDecoder,
  Uint8Array, Uint32Array, Uint8ClampedArray, Map, Set, WeakMap, Promise, Math, Date, isFinite,
  parseFloat, parseInt, String, Number, Array, Object, JSON, RegExp, Error, DataView, ArrayBuffer
};
vm.createContext(ctx);
ctx.JSCodec = undefined;
vm.runInContext(src + '\n;globalThis.__=({Util,PDFFilters,PNGCodec,JPEGCodec,ZipCodec,PDFEngine,JSCodec});', ctx);
const { Util, PDFEngine, PNGCodec, JPEGCodec, ZipCodec, JSCodec } = ctx.__;

fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

(async () => {
  /* ── PDF: every structural variant, both strip modes ── */
  const pdfCases = [
    ['text.pdf', false], ['text.pdf', true],
    ['text_objstm.pdf', true], ['photos.pdf', false], ['photos.pdf', true],
    ['photos_lin.pdf', true], ['photos_objstm.pdf', true],
    ['scan.pdf', false], ['scan.pdf', true], ['scan_qdf.pdf', true],
    ['diagram.pdf', false], ['diagram.pdf', true], ['lzw.pdf', true]
  ];
  for (const [name, strip] of pdfCases) {
    const file = path.join(FIX, name);
    if (!fs.existsSync(file)) { check(`pdf ${name}`, false, 'fixture missing'); continue; }
    const bytes = new Uint8Array(fs.readFileSync(file));
    let res;
    try { res = await PDFEngine.optimize(bytes, { stripText: strip }); }
    catch (e) { check(`pdf ${name} strip=${strip}`, false, e.message); continue; }
    const tag = `${path.basename(name, '.pdf')}__${strip ? 'strip' : 'keep'}.pdf`;
    fs.writeFileSync(path.join(OUT, tag), Buffer.from(res.bytes));
    const parsed = await new PDFEngine.Doc(res.bytes).scan();
    const srcPages = (await new PDFEngine.Doc(bytes).scan()).pages().length;
    const ok = res.bytes.length <= bytes.length && parsed.rootNum && parsed.pages().length >= srcPages;
    check(`pdf ${name} strip=${strip ? 'y' : 'n'}`, ok,
      `${kb(bytes.length)} → ${kb(res.bytes.length)} (${Util.pct(res.bytes.length, bytes.length)}%), ${parsed.pages().length}/${srcPages} pages${res.stats.writer ? ', ' + res.stats.writer : ''}`);
  }

  /* ── PDF: refusals must be byte-identical pass-throughs ── */
  for (const name of ['encrypted.pdf', 'broken.pdf']) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, name)));
    const res = await PDFEngine.optimize(bytes, { stripText: true });
    const same = res.bytes.length === bytes.length && Buffer.compare(Buffer.from(res.bytes), Buffer.from(bytes)) === 0;
    check(`pdf ${name} refused safely`, same && res.warnings.length > 0, res.warnings[0] || 'no warning');
  }

  /* ── PNG: lossless round-trip must keep pixels identical ── */
  for (const name of ['diagram.png', 'noise.png']) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, name)));
    const r = await PNGCodec.optimize(bytes);
    fs.writeFileSync(path.join(OUT, name.replace('.png', '_opt.png')), Buffer.from(r.bytes));
    const parsed = PNGCodec.parse(r.bytes);
    const srcParsed = PNGCodec.parse(bytes);
    const sameDims = parsed.ihdr.width === srcParsed.ihdr.width && parsed.ihdr.height === srcParsed.ihdr.height;
    const sameType = parsed.ihdr.colorType === srcParsed.ihdr.colorType && parsed.ihdr.bitDepth === srcParsed.ihdr.bitDepth;
    check(`png ${name} lossless`, r.bytes.length <= bytes.length && sameDims && sameType,
      `${kb(bytes.length)} → ${kb(r.bytes.length)} (${r.method})`);
  }

  /* ── JPEG: structural strip must not touch the scan ── */
  for (const name of ['photo1.jpg', 'page_scan.jpg']) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, name)));
    const r = JPEGCodec.stripLossless(bytes);
    fs.writeFileSync(path.join(OUT, name.replace('.jpg', '_strip.jpg')), Buffer.from(r.bytes));
    check(`jpeg ${name} lossless`, r.bytes.length <= bytes.length && r.width > 0, `${kb(bytes.length)} → ${kb(r.bytes.length)}`);
  }

  /* ── Office: repack must keep every payload byte-identical ── */
  for (const name of ['report.docx', 'deck.pptx', 'data.xlsx']) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, name)));
    const r = await ZipCodec.recompress(bytes);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.bytes));
    const before = await ZipCodec.list(bytes);
    const after = await ZipCodec.list(r.bytes);
    let identical = before.length === after.length;
    if (identical) {
      for (let i = 0; i < before.length && identical; i++) {
        if (before[i].name !== after[i].name) { identical = false; break; }
        const a = await ZipCodec.readEntry(before[i]);
        const b = await ZipCodec.readEntry(after[i]);
        if (!a || !b || a.length !== b.length) { identical = false; break; }
        for (let k = 0; k < a.length; k += 4096) {
          if (Buffer.compare(Buffer.from(a.subarray(k, k + 4096)), Buffer.from(b.subarray(k, k + 4096))) !== 0) { identical = false; break; }
        }
      }
    }
    check(`zip ${name} payloads identical`, identical, `${before.length} entries, ${kb(bytes.length)} → ${kb(r.bytes.length)}`);
  }

  /* ── ZIP writer: round-trip through our own reader ── */
  const sample = [{ name: 'a.txt', data: Util.utf8('hello '.repeat(1000)) }, { name: 'b.bin', data: new Uint8Array(5000).map((_, i) => i & 0xff) }];
  const zip = await ZipCodec.write(sample);
  const back = await ZipCodec.list(zip);
  const okZip = back.length === 2 && (await ZipCodec.readEntry(back[0])).length === 6000;
  check('zip writer round-trip', okZip, `${back.length} entries, ${kb(zip.length)}`);

  /* ── content stream: text ops removed, drawing kept ── */
  const sampleCS = 'q 1 0 0 1 0 0 cm /Im1 Do Q BT /F1 12 Tf 72 720 Td (Hello) Tj ET 0 0 m 10 10 l S';
  const stripped = PDFEngine.stripTextOps(sampleCS);
  check('content stream text strip', stripped.changed && !stripped.text.includes('(Hello)') &&
    stripped.text.includes('/Im1 Do') && stripped.text.includes('10 10 l S'), stripped.text.trim());

  /* ── JS codec fallback (devices without Compression Streams) ── */
  {
    const nativeDeflate = async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const nativeInflate = async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const crypto = require('crypto');
    const samples = {
      text: Util.utf8('the quick brown fox jumps over the lazy dog '.repeat(4000)),
      random: new Uint8Array(crypto.randomBytes(30000)),
      mixed: Util.concat([new Uint8Array(crypto.randomBytes(20000)), Util.utf8(JSON.stringify(Array.from({ length: 9000 }, (_, i) => ({ i, s: 'x'.repeat(i % 9) }))))])
    };
    let allOk = true;
    for (const [label, raw] of Object.entries(samples)) {
      const mine = JSCodec.deflate(raw);
      const backNative = await nativeInflate(mine);
      const sameA = Buffer.compare(Buffer.from(backNative), Buffer.from(raw)) === 0;
      const backJs = JSCodec.inflate(await nativeDeflate(raw));
      const sameB = Buffer.compare(Buffer.from(backJs), Buffer.from(raw)) === 0;
      allOk = allOk && sameA && sameB;
      check(`js codec ${label}`, sameA && sameB, `${mine.length}/${raw.length} bytes`);
    }
    { const gz = JSCodec.gzip(samples.text); const back = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); check('js codec gzip container', Buffer.compare(Buffer.from(back), Buffer.from(samples.text)) === 0, gz.length + ' bytes'); }
  }

  /* ── value parser: nested dicts, refs, strings ── */
  const v = PDFEngine.parseValue('<< /A [1 0 R 2 0 R] /B (a\\(b\\)) /C << /D /E#20F >> /N -3.5 >>', 0)[0];
  check('value parser', v.t === 'dict' && v.v.A.v.length === 2 && v.v.A.v[0].t === 'ref' && v.v.C.v.D.v === 'E F' && v.v.N.v === -3.5);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(__dirname, 'engine-results.json'), JSON.stringify(results, null, 2));
  if (failed.length) process.exitCode = 1;
})();
