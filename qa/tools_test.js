/* qa/tools_test.js — drives every tool the way a user does, then checks the artefact

     node qa/tools_test.js            all tools
     node qa/tools_test.js enhance      one tool

   Each file tool: open the card → choose a fixture → Run → Save → the downloaded
   bytes are validated independently (pdfinfo for PDFs, Pillow for images,
   zipfile for archives, plain text checks otherwise).  Text tools are typed in
   and the output must be non-empty and format-plausible. */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'tool-out');
const PORT = 8090 + Math.floor(Math.random() * 90);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

function serve() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

/* tool → [fixtures, expected output kind] */
const PLAN = {
  enhance: [['photo1.jpg'], 'image'],
  upscale: [['diagram.png'], 'image'],
  resize: [['photo1.jpg'], 'image'],
  convert: [['diagram.png'], 'image'],
  grayscale: [['photo1.jpg'], 'image'],
  rotate: [['photo1.jpg'], 'image'],
  watermark: [['photo1.jpg'], 'image'],
  favicon: [['diagram.png'], 'zip'],
  strip: [['page_scan.jpg'], 'image'],
  'img2pdf': [['photo1.jpg', 'diagram.png'], 'pdf'],
  'svg2png': [['icon.svg'], 'image'],
  'pdf-merge': [['text.pdf', 'diagram.pdf'], 'pdf'],
  'pdf-split': [['text.pdf'], 'zip'],
  'pdf-extract': [['text.pdf'], 'pdf'],
  'pdf-delete': [['text.pdf'], 'pdf'],
  'pdf-rotate': [['diagram.pdf'], 'pdf'],
  'pdf-numbers': [['text.pdf'], 'pdf'],
  'pdf-watermark': [['text.pdf'], 'pdf'],
  'pdf-info': [['diagram.pdf'], 'pdf'],
  'pdf-text': [['text.pdf'], 'text'],
  'pdf-docx': [['text.pdf'], 'docx'],
  'pdf-repair': [['damaged.pdf'], 'pdf'],
  'img-b64': [['icon.svg'], 'text'],
  'pdf-images': [['photos.pdf'], 'zip'],
  'docx-text': [['report.docx'], 'text'],
  'docx-html': [['report.docx'], 'html'],
  'xlsx-csv': [['data.xlsx'], 'csv'],
  'zip-unpack': [['report.docx'], 'any'],
  'zip-pack': [['notes.txt', 'data.json'], 'zip'],
  crop: [['photo1.jpg'], 'image'],
  frame: [['photo1.jpg'], 'image'],
  diff: [['photo1.jpg', 'page_scan.jpg'], 'image'],
  palette: [['photo1.jpg'], 'text'],
  'pdf-reverse': [['text.pdf'], 'pdf'],
  'pdf-crop': [['scan.pdf'], 'pdf'],
  'pdf-interleave': [['text.pdf', 'diagram.pdf'], 'pdf'],
  'pptx-text': [['deck.pptx'], 'text'],
  'csv-xlsx': [['data.csv'], 'xlsx'],
  'txt-pdf': [['notes.txt'], 'pdf'],
  'csv-pdf': [['data.csv'], 'pdf'],
  'docx-pdf': [['report.docx'], 'pdf']
};

/* [tool, fixture, password, expected kind] — exercises the crypto round trip.
   pdf-protect output is re-opened here with the password we just set. */
const SEC_PLAN = [
  ['pdf-unlock', 'enc_rc4_40.pdf', 'user1', 'pdf'],
  ['pdf-unlock', 'enc_rc4_128.pdf', 'user1', 'pdf'],
  ['pdf-unlock', 'enc_aes128.pdf', 'user1', 'pdf'],
  ['pdf-unlock', 'enc_aes256.pdf', 'user1', 'pdf'],
  ['pdf-unlock', 'enc_owner_only.pdf', '', 'pdf'],   // permissions-only encryption: opens with no password
  ['pdf-protect', 'text.pdf', 'secret123', 'pdf']
];

const TEXT_PLAN = {
  'json-format': ['{"a":1,"b":[2,3]}', (t) => t.includes('\n') && t.includes('"a"')],
  'json-minify': ['{ "a" : 1 }', (t) => t === '{"a":1}'],
  'json-csv': ['[{"a":1,"b":"x"},{"a":2,"b":"y"}]', (t) => t.split('\n')[0] === 'a,b'],
  'csv-json': ['a,b\n1,2', (t) => t.includes('"a": 1')],
  'csv-tsv': ['a,b\n1,2', (t) => t.includes('\t')],
  'json-keys': ['{"a":{"b":1}}', (t) => t.includes('a.b')],
  'css-min': ['.a { color : red ; }', (t) => t === '.a{color:red}'],
  'js-min': ['var a = 1; // hi\nvar b = 2;', (t) => !t.includes('//')],
  'html-min': ['<div>  <b>x</b>  </div>', (t) => t.includes('<div><b>')],
  'svg-min': ['<svg xmlns="http://www.w3.org/2000/svg">\n  <!-- c -->\n  <rect width="1" height="1"/>\n</svg>', (t) => !t.includes('<!--')],
  'xml-min': ['<a>\n  <b>x</b>\n</a>', (t) => t.includes('<a><b>')],
  'md-html': ['# T\n\n- one\n- two', (t) => t.includes('<h1>') && t.includes('<li>')],
  'html-text': ['<p>a</p><p>b</p>', (t) => t.includes('a') && !t.includes('<p>')],
  'b64-enc': ['ReadOn', (t) => t === 'UmVhZE9u'],
  'b64-dec': ['UmVhZE9u', (t) => t === 'ReadOn'],
  'url-enc': ['a b&c', (t) => t === 'a%20b%26c'],
  'url-dec': ['a%20b%26c', (t) => t === 'a b&c'],
  'hex': ['ReadOn', (t) => /^526561644f6e$/i.test(t.trim())],
  'sha256': ['abc', (t) => t === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  'sha512': ['abc', (t) => t.startsWith('ddaf35a193617aba')],
  'uuid': ['', (t) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t.split('\n')[0])],
  'count': ['one two three', (t) => /words\s+3/.test(t)],
  'case': ['hello world', (t) => t === 'Hello World'],
  'sort': ['b\na\nc', (t) => t.split('\n')[0] === 'a'],
  'dedupe': ['a\nb\na', (t) => t === 'a\nb'],
  'trim': ['a   \n\n\n\nb', (t) => t === 'a\n\nb'],
  'slug': ['Hello World! 2026', (t) => t === 'hello-world-2026'],
  'lorem': ['', (t) => t.split('\n\n').length >= 3],
  'time': ['', (t) => t.includes('ISO 8601')],
  'color': ['#D75A5A', (t) => t.includes('#d75a5a') && t.includes('rgb(215, 90, 90)')],
  'escape-html': ['<a href="x">&', (t) => t.includes('&lt;a')],
  'rot13': ['Hello', (t) => t === 'Uryyb'],
  'join-lines': ['one\ntwo\n\nthree', (t) => t.startsWith('one two')],
  'extract': ['mail me at a@b.co or c@d.org', (t) => t.includes('a@b.co') && t.includes('c@d.org')],
  'freq': ['red red blue', (t) => /2\s+red/.test(t)],
  'replace': ['aaa', (t) => t === 'bbb', { find: 'a', with: 'b' }],
  'password': ['', (t) => t.split('\n')[0].length >= 8],
  'json-yaml': ['{"a":1,"b":{"c":[1,2]}}', (t) => t.includes('a: 1') && t.includes('- 2')],
  'csv-pick': ['a,b,c\n1,2,3', (t) => t.split('\n')[0] === 'a,c', { cols: '1,3' }],
  'reverse': ['abc', (t) => t === 'cba'],
  'unaccent': ['café naïve', (t) => t === 'cafe naive'],
  'invisible': ['a\u200Bb', (t) => t === 'ab'],
  'caesar': ['abc', (t) => t === 'def', { shift: 3 }],
  'rot47': ['Hello', (t) => t === 'w6==@'],
  'morse': ['SOS', (t) => t === '... --- ...'],
  'nato': ['AB', (t) => t === 'Alfa Bravo'],
  'binary': ['A', (t) => t === '01000001'],
  'base32': ['MZXW6===', (t) => t === 'foo', { mode: 'dec' }],
  'jwt': ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwibmFtZSI6IngifQ.sig', (t) => t.includes('HS256') && t.includes('"sub": "1"')],
  'totp': ['', (t) => t.includes('287082'), { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', t: 59 }],
  'bases': ['255', (t) => t.includes('FF')],
  'roman': ['1994', (t) => t.includes('MCMXCIV')],
  'subnet': ['', (t) => t.includes('192.168.1.255') && t.includes('254'), { cidr: '192.168.1.10/24' }],
  'diff-text': ['a\nb', (t) => t.includes('- b') && t.includes('  a'), { b: 'a' }],
  'eol': ['a\nb', (t) => t.length >= 3],
  'tabs': ['a\tb', (t) => t === 'a    b'],
  'sort-words': ['b a c', (t) => t === 'a b c'],
  'date-diff': ['', (t) => /days\s+30/.test(t), { a: '2026-01-01', b: '2026-01-31' }],
  'age': ['', (t) => /(2[4-8]) years/.test(t), { birth: '2000-01-01' }],
  'unit': ['', (t) => t.includes('0.621') || t.includes('1609'), { value: '1', from: 'km', to: 'mi' }],
  'percent': ['', (t) => t.includes('25'), { a: '10', b: '250' }],
  'emi': ['', (t) => t.includes('8,884.88'), { p: 100000, rate: 12, months: 12 }],
  'bmi': ['', (t) => t.includes('22.9'), { kg: 70, cm: 175, age: 30 }],
  'wcag': ['', (t) => t.includes('21.00'), { fg: '#000000', bg: '#ffffff' }]
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} — ${detail}`);
};

function validate(kind, file) {
  const size = fs.statSync(file).size;
  if (!size) return [false, 'empty file'];
  try {
    if (kind === 'pdf' || file.endsWith('.pdf')) {
      const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
      const pages = (info.match(/Pages:\s+(\d+)/) || [])[1];
      const qc = execFileSync('qpdf', ['--check', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const warns = (qc.match(/WARNING/g) || []).length;
      return [!!pages && +pages > 0 && warns === 0, `${size} B · ${pages} pages · qpdf warnings=${warns}`];
    }
    if (kind === 'zip' || file.endsWith('.zip')) {
      const out = execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(len(z.namelist()), z.testzip())', file], { encoding: 'utf8' });
      return [/(None|0)/.test(out) || out.includes('None'), `${size} B · ${out.trim()}`];
    }
    if (kind === 'image' || /\.(png|jpe?g|webp|gif|ico)$/i.test(file)) {
      const out = execFileSync('python3', ['-c', 'import sys;from PIL import Image;im=Image.open(sys.argv[1]);im.load();print(im.format, im.size)', file], { encoding: 'utf8' });
      return [/\d+/.test(out), `${size} B · ${out.trim()}`];
    }
    const txt = fs.readFileSync(file, 'utf8');
    if (kind === 'xlsx') {
      const out = execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(len(z.namelist()), z.testzip())', file], { encoding: 'utf8' });
      return [out.includes('None'), `${size} B · ${out.trim()}`];
    }
    if (kind === 'docx') {
      const out = execFileSync('python3', ['-c',
        'import sys,docx;d=docx.Document(sys.argv[1]);t="\\n".join(p.text for p in d.paragraphs);print(len(d.paragraphs), len(t), t.strip()[:40].replace("\\n"," "))',
        file], { encoding: 'utf8' });
      const paras = parseInt(out.split(' ')[0], 10);
      return [paras > 3, `${size} B · python-docx opens it · ${out.trim()}`];
    }
    if (kind === 'csv') return [txt.includes(','), `${size} B · ${txt.split('\n').length} lines`];
    if (kind === 'html') return [/<html|<p>|<h\d>/i.test(txt), `${size} B · ${txt.length} chars`];
    return [txt.trim().length > 0, `${size} B · ${txt.length} chars`];
  } catch (e) {
    return [false, String(e.message || e).slice(0, 120)];
  }
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/compress/index.html`);
  await page.waitForTimeout(300);

  const only = process.argv[2];
  const cards = await page.locator('.tcard').count();
  check("hub renders", cards >= 100, `${cards} cards`);

  for (const [id, [fixtures, kind]] of Object.entries(PLAN)) {
    if (only && only !== id) continue;
    if (await page.locator('#toolPane').isVisible()) { await page.click('#toolBack'); await page.waitForTimeout(90); }
    await page.click(`.tcard[data-tool="${id}"]`);
    await page.waitForTimeout(120);
    await page.setInputFiles('#tInput', fixtures.map((f) => path.join(FIX, f)));
    await page.waitForTimeout(180);
    await page.click('#tRun');
    let ok = true, detail = '';
    try {
      await page.waitForSelector('#toolResults .tout .btn', { timeout: 120000 });
      const btns = page.locator('#toolResults .tout [data-dl]');
      const n = await btns.count();
      if (!n) throw new Error('no output produced');
      const dir = path.join(OUT, id);
      fs.mkdirSync(dir, { recursive: true });
      let best = null;
      for (let i = 0; i < Math.min(n, 3); i++) {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), btns.nth(i).click()]);
        const p = path.join(dir, dl.suggestedFilename());
        await dl.saveAs(p);
        const [good, why] = validate(kind, p);
        if (good) { best = `${dl.suggestedFilename()} — ${why}`; break; }
        detail = why;
      }
      ok = !!best;
      detail = best || ('all outputs rejected: ' + detail);
    } catch (e) {
      ok = false;
      detail = String(e.message || e).split('\n')[0].slice(0, 140);
    }
    check(id, ok, detail);
  }

  for (const [id, fixture, pw, kind] of SEC_PLAN) {
    if (only && only !== id) continue;
    const label = `${id}:${fixture}`;
    // fresh load per case: no browser form-state can leak a stale password into the next run
    await page.goto(`http://127.0.0.1:${PORT}/compress/index.html`);
    await page.waitForTimeout(250);
    await page.click(`.tcard[data-tool="${id}"]`);
    await page.waitForTimeout(120);
    await page.setInputFiles('#tInput', path.join(FIX, fixture));
    await page.waitForTimeout(150);
    // type it in like a human; the field is reused, so clear it first
    const pwField = page.locator('[data-opt="password"]').first();
    await pwField.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    if (pw) await page.keyboard.type(pw);
    await page.click('#tRun');
    let ok = true, detail = '';
    try {
      await page.waitForSelector('#toolResults .tout .btn', { timeout: 120000 });
      const btn = page.locator('#toolResults .tout [data-dl]').first();
      const dir = path.join(OUT, label.replace(/[:.]/g, '_'));
      fs.mkdirSync(dir, { recursive: true });
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), btn.click()]);
      const p = path.join(dir, dl.suggestedFilename());
      await dl.saveAs(p);
      if (!p.endsWith('.pdf')) throw new Error(`refused ${dl.suggestedFilename()}: ${fs.readFileSync(p, 'utf8').replace(/\s+/g, ' ').slice(0, 160)}`);
      let good = true, why = '';
      if (id === 'pdf-protect') {
        const pages = execFileSync('qpdf', ['--show-npages', `--password=${pw}`, p], { encoding: 'utf8' }).trim();
        good = +pages > 0;
        why = `${fs.statSync(p).size} B · ${pages} pages (password opens it)`;
      } else {
        [good, why] = validate(kind, p);
      }
      if (good && id === 'pdf-unlock') {
        const txt = execFileSync('pdftotext', ['-upw', pw, p, '-'], { encoding: 'utf8' });
        good = txt.includes('Chapter 1');
        why += txt.includes('Chapter 1') ? ' · text extracted' : ' · TEXT MISSING';
      }
      if (good && id === 'pdf-protect') {
        const enc = execFileSync('qpdf', ['--show-encryption', `--password=${pw}`, p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        good = /R = 6/.test(enc) && enc.includes(`User password = ${pw}`);
        why += good ? ' · AES-256 R6, password accepted' : ' · wrong encryption parameters';
        let rejected = false;
        try { execFileSync('qpdf', ['--show-npages', '--password=wrongpw', p], { stdio: 'pipe' }); } catch (e) { rejected = true; }
        good = good && rejected;
        why += rejected ? ' · wrong password rejected' : ' · WRONG PASSWORD ACCEPTED';
      }
      ok = good;
      detail = `${dl.suggestedFilename()} — ${why}`;
    } catch (e) {
      ok = false;
      detail = String(e.message || e).split('\n')[0].slice(0, 140);
    }
    check(label, ok, detail);
  }

  for (const [id, [input, verify, opts]] of Object.entries(TEXT_PLAN)) {
    if (only && only !== id) continue;
    if (await page.locator('#toolPane').isVisible()) { await page.click('#toolBack'); await page.waitForTimeout(90); }
    await page.click(`.tcard[data-tool="${id}"]`);
    await page.waitForTimeout(120);
    for (const [k, v] of Object.entries(opts || {})) {
      const sel = `[data-opt="${k}"]`;
      await page.evaluate(([sel2, val]) => {
        const el = document.querySelector(sel2);
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, [sel, v]);
    }
    await page.fill('#tIn', input);
    await page.click('#tRun');
    await page.waitForTimeout(400);
    let ok = false, out = '', detail = '';
    try {
      await page.waitForFunction(() => document.querySelector('#tState').textContent === 'done' || document.querySelector('#tState').textContent === 'error', null, { timeout: 20000 });
      out = await page.inputValue('#tOut');
      ok = verify(out);
      detail = ok ? `${out.length} chars` : `unexpected: ${JSON.stringify(out.slice(0, 60))}`;
    } catch (e) {
      detail = String(e.message || e).split('\n')[0].slice(0, 120);
    }
    check(id, ok, detail);
  }

  /* pure-function checks that the text areas cannot express (CR/LF is normalised by <textarea>) */
  const unit = await page.evaluate(async () => {
    const out = {};
    out.crlf = await Tools.get('eol').run('a\nb', { to: 'crlf' }).then((r) => r.text.length === 4 && r.text.includes('\r\n'));
    out.cr = await Tools.get('eol').run('a\nb', { to: 'cr' }).then((r) => r.text.length === 3 && r.text.includes('\r'));
    out.base32round = await Tools.get('base32').run('ReadOn', { mode: 'enc' })
      .then((r) => Tools.get('base32').run(r.text, { mode: 'dec' }))
      .then((r) => r.text === 'ReadOn');
    out.totpRFC = await Tools.get('totp').run('', { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', t: 1111111109, digits: '8' })
      .then((r) => r.text.includes('07081804'));
    out.subnet31 = await Tools.get('subnet').run('', { cidr: '10.0.0.5/31' }).then((r) => r.text.includes('255.255.255.254'));
    out.caesarWrap = await Tools.get('caesar').run('xyz', { shift: 3 }).then((r) => r.text === 'abc');
    out.romanRange = await Tools.get('roman').run('MMMM', {}).then((r) => /outside the classic/.test(r.text));
    out.jsonYaml = await Tools.get('json-yaml').run('{"a":[{"b":1}]}', {}).then((r) => r.text.includes('b: 1') && r.text.startsWith('a:'));
    return out;
  });
  for (const [k, v] of Object.entries(unit)) check('unit · ' + k, !!v);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' · '));
  await browser.close();
  server.close();

  /* evidence per tool id, so TOOLS.md is generated from the run, never hand-written */
  const evidence = {};
  for (const r of results) {
    const id = String(r.name).split(':')[0].split(' ')[0];
    if (!r.ok) continue;
    evidence[id] = String(r.detail || 'produced output').replace(/\|/g, '/').slice(0, 120);
  }
  fs.writeFileSync(path.join(__dirname, 'tool-evidence.json'), JSON.stringify(evidence, null, 1) + '\n');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} tool checks passed`);
  if (failed.length) {
    console.log('FAILURES:');
    failed.forEach((f) => console.log('  ' + f.name + ' — ' + f.detail));
  }
  process.exit(failed.length ? 1 : 0);
})();
