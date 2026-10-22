/* ══════════════════════════════════════════════════════════════
   pdfedit.js — real PDF page operations on top of PDFEngine

   merge · split · extract · delete · rotate · page numbers · watermark
   metadata · text extraction · embedded-JPEG extraction · images → PDF

   Everything here is a genuine structural rewrite: objects are imported
   into a fresh document (references renumbered), pages are re-parented
   into a new page tree, and the result is serialised with the same
   writer the compressor uses and re-parsed before it is handed back.
   ══════════════════════════════════════════════════════════════ */

const PDFEdit = (() => {
  const { Doc, serialize, get, num, refOf, nameOf, dictSet, dictDel } = PDFEngine;

  const ref = (n) => ({ t: 'ref', n, g: 0 });
  const nm = (s) => ({ t: 'name', v: s, raw: s });
  const numv = (v) => ({ t: 'num', v, raw: String(v) });
  const dict = (order) => ({ t: 'dict', v: {}, order: order.slice() });
  const strv = (s) => ({ t: 'str', raw: '(' + String(s).replace(/([\\()])/g, '\\$1') + ')' });

  function blank() {
    const d = new Doc(new Uint8Array(0));
    d.objs = new Map();
    d.rootNum = null;
    d.infoNum = null;
    d.version = '1.7';
    d._max = 0;
    return d;
  }

  function addObj(doc, value, stream) {
    if (!doc._max) {                    // a freshly parsed document has no high-water mark yet
      let m = 0;
      for (const k of doc.objs.keys()) if (k > m) m = k;
      doc._max = m;
    }
    const n = ++doc._max;
    doc.objs.set(n, {
      num: n, gen: 0, value, dictRaw: null,
      sS: stream ? 0 : null, sE: stream ? 0 : null,
      newStream: stream || null, dirty: true
    });
    return n;
  }

  /* deep-copy a parsed value, rewriting indirect references through `map` */
  function cloneVal(v, map) {
    if (!v) return v;
    if (v.t === 'ref') return { t: 'ref', n: map.has(v.n) ? map.get(v.n) : v.n, g: 0 };
    if (v.t === 'array') return { t: 'array', v: v.v.map((x) => cloneVal(x, map)) };
    if (v.t === 'dict') {
      const d = { t: 'dict', v: {}, order: v.order.slice() };
      for (const k of d.order) d.v[k] = cloneVal(v.v[k], map);
      return d;
    }
    return v;
  }

  function importDoc(src, dst) {
    const map = new Map();
    for (const n of src.objs.keys()) map.set(n, ++dst._max);
    for (const [n, o] of src.objs) {
      const nn = map.get(n);
      const copy = { num: nn, gen: 0, value: cloneVal(o.value, map), dictRaw: null, sS: null, sE: null, dirty: true, newStream: null };
      if (o.sS != null) {
        const body = src.streamBytes(o);
        copy.newStream = body.slice ? body.slice() : Uint8Array.from(body);
        copy.sS = 0;
      }
      dst.objs.set(nn, copy);
    }
    return { map, pages: src.pages().map((p) => map.get(p.num)) };
  }

  /* reachability over parsed values (the compressor walks raw text; here we already
     own every value, so a value walk is simpler and safe) */
  function liveSet(doc) {
    const live = new Set();
    const seen = new Set();
    const walk = (v) => {
      if (!v) return;
      if (v.t === 'ref') {
        if (seen.has(v.n) || !doc.objs.has(v.n)) return;
        seen.add(v.n);
        live.add(v.n);
        walk(doc.objs.get(v.n).value);
        return;
      }
      if (v.t === 'array') { for (const x of v.v) walk(x); return; }
      if (v.t === 'dict') { for (const k of v.order) walk(v.v[k]); }
    };
    walk(ref(doc.rootNum));
    if (doc.infoNum) walk(ref(doc.infoNum));
    if (doc.encryptNum) live.add(doc.encryptNum);   // the security dictionary is referenced by the trailer
    return live;
  }

  async function parse(bytes) {
    const doc = await new Doc(bytes).scan();
    if (!doc.rootNum) throw new Error('not a readable PDF');
    if (doc.encrypted) throw new Error('password-protected PDF — remove the password first');
    return doc;
  }

  async function finish(dst) {
    const bytes = serialize(dst, liveSet(dst));
    const check = await new Doc(bytes).scan();          // never hand back something we cannot re-read
    if (!check.rootNum || !check.pages().length) throw new Error('rebuild failed verification');
    return { bytes, pages: check.pages().length };
  }

  /* ── core: build a new document from a list of {doc, num} pages ───── */
  async function compose(plan, opts = {}) {
    const dst = blank();
    const bySrc = new Map();
    const pageNums = [];
    for (const item of plan) {
      if (!bySrc.has(item.doc)) bySrc.set(item.doc, importDoc(item.doc, dst));
      pageNums.push(bySrc.get(item.doc).map.get(item.num));
    }
    const pagesNum = addObj(dst, dict(['Type', 'Kids', 'Count']));
    const rootNum = addObj(dst, dict(['Type', 'Pages']));
    dst.rootNum = rootNum;
    const root = dst.objs.get(rootNum).value;
    root.v.Type = nm('Catalog');
    root.v.Pages = ref(pagesNum);
    const pagesDict = dst.objs.get(pagesNum).value;
    pagesDict.v.Type = nm('Pages');
    pagesDict.v.Kids = { t: 'array', v: pageNums.map(ref) };
    pagesDict.v.Count = numv(pageNums.length);

    for (const pn of pageNums) {
      const d = dst.objs.get(pn).value;
      if (!d || d.t !== 'dict') continue;
      dictSet(d, 'Type', nm('Page'));
      dictSet(d, 'Parent', ref(pagesNum));
      const rot = num(get(d, 'Rotate'), 0);
      if (opts.rotate) {
        const r = (((rot + opts.rotate) % 360) + 360) % 360;
        if (r) dictSet(d, 'Rotate', numv(r)); else dictDel(d, 'Rotate');
      }
      if (opts.info) {
        const box = get(d, 'MediaBox');
        if (box) {
          // keep the page geometry as-is; nothing to do, documented for clarity
        }
      }
    }
    if (opts.info) dst.infoNum = addObj(dst, infoDict(opts.info));
    return finish(dst);
  }

  function infoDict(info) {
    const d = dict([]);
    const map = { title: 'Title', author: 'Author', subject: 'Subject', keywords: 'Keywords', creator: 'Creator', producer: 'Producer' };
    for (const k of Object.keys(map)) {
      if (info[k] != null && info[k] !== '') dictSet(d, map[k], strv(info[k]));
    }
    dictSet(d, 'Producer', strv(info.producer || 'ArtViSiON Tools'));
    return d;
  }

  /* ── public operations ───────────────────────────────────────────── */
  async function merge(list) {
    const docs = [];
    for (const f of list) docs.push(await parse(f.bytes));
    const plan = [];
    for (const d of docs) for (const p of d.pages()) plan.push({ doc: d, num: p.num });
    if (!plan.length) throw new Error('no pages found');
    return compose(plan, {});
  }

  async function select(bytes, indices, opts = {}) {
    const doc = await parse(bytes);
    const pages = doc.pages();
    const wanted = indices.filter((i) => i >= 1 && i <= pages.length).map((i) => pages[i - 1]);
    if (!wanted.length) throw new Error('no pages selected');
    return compose(wanted.map((p) => ({ doc, num: p.num })), opts);
  }

  async function rotate(bytes, deg) {
    const doc = await parse(bytes);
    return compose(doc.pages().map((p) => ({ doc, num: p.num })), { rotate: deg });
  }

  async function splitEvery(bytes) {
    const doc = await parse(bytes);
    const pages = doc.pages();
    const out = [];
    for (let i = 0; i < pages.length; i++) {
      const r = await compose([{ doc, num: pages[i].num }], {});
      out.push({ name: `page-${String(i + 1).padStart(2, '0')}.pdf`, bytes: r.bytes });
    }
    return out;
  }

  /* stamp text on every page (page numbers / watermark) — real content stream */
  async function stamp(bytes, o = {}) {
    const doc = await parse(bytes);
    const pages = doc.pages();
    const text = o.text != null ? o.text : '';
    const size = o.size || 12;
    const opacity = o.opacity != null ? o.opacity : 1;
    const color = o.color || [0.15, 0.15, 0.15];
    const fontNum = addObj(doc, (() => {
      const f = dict(['Type', 'Subtype', 'BaseFont', 'Encoding']);
      f.v.Type = nm('Font'); f.v.Subtype = nm('Type1'); f.v.BaseFont = nm(o.font || 'Helvetica'); f.v.Encoding = nm('WinAnsiEncoding');
      return f;
    })());
    const fontRes = addObj(doc, (() => { const d = dict(['F1']); d.v.F1 = ref(fontNum); return d; })());

    pages.forEach((p, i) => {
      const label = typeof o.perPage === 'function' ? o.perPage(i + 1, pages.length) : text;
      if (!label) return;
      const d = p.dict;
      const box = doc.resolve(get(d, 'MediaBox')) || doc.resolve(get(inherited(doc, p.num, 'MediaBox'), 'x'));
      const mb = box && box.t === 'array' ? box.v.map((x) => (x && x.t === 'num' ? x.v : 0)) : [0, 0, 612, 792];
      const w = Math.abs(mb[2] - mb[0]) || 612, h = Math.abs(mb[3] - mb[1]) || 792;
      const esc = String(label).replace(/([\\()])/g, '\\$1');
      let x, y, rot = 0, fs = size;
      if (o.mode === 'watermark') {
        fs = o.size || Math.round(Math.min(w, h) / 12);
        const tw = fs * 0.52 * String(label).length;
        x = (w - tw) / 2;
        y = (h - fs) / 2;
        rot = 35;
      } else if (o.pos === 'tl') { x = 36; y = h - 36 - fs; }
      else if (o.pos === 'tr') { x = w - 36 - fs * 0.52 * String(label).length; y = h - 36 - fs; }
      else if (o.pos === 'bl') { x = 36; y = 36; }
      else { x = (w - fs * 0.52 * String(label).length) / 2; y = 36; }

      const body = [
        'q',
        opacity < 1 ? `/GS0 gs` : '',
        `BT /F1 ${fs} Tf ${color[0]} ${color[1]} ${color[2]} rg`,
        rot ? `${Math.cos(rot * Math.PI / 180).toFixed(5)} ${Math.sin(rot * Math.PI / 180).toFixed(5)} ${(-Math.sin(rot * Math.PI / 180)).toFixed(5)} ${Math.cos(rot * Math.PI / 180).toFixed(5)} ${x} ${y} Tm` : `1 0 0 1 ${x} ${y} Tm`,
        `(${esc}) Tj`,
        'ET',
        'Q'
      ].filter(Boolean).join('\n');
      const bodyBytes = Util.utf8(body);
      const sDict = dict([]);
      dictSet(sDict, 'Length', numv(bodyBytes.length));
      const stream = addObj(doc, sDict, bodyBytes);

      // resources: add /F1 and (optionally) an ExtGState for opacity
      let resV = get(d, 'Resources');
      let res = resV ? doc.resolve(resV) : null;
      if (!res || res.t !== 'dict') {
        const nres = addObj(doc, dict(['Font']));
        dictSet(doc.objs.get(nres).value, 'Font', ref(fontRes));
        dictSet(d, 'Resources', ref(nres));
        res = doc.objs.get(nres).value;
        resV = ref(nres);
      } else {
        const fonts = doc.resolve(get(res, 'Font'));
        if (!fonts || fonts.t !== 'dict') dictSet(res, 'Font', ref(fontRes));
        else dictSet(fonts, 'F1', ref(fontNum));
        res.dirty = true;
      }
      if (opacity < 1) {
        const g = dict(['Type', 'ca', 'CA']);
        g.v.Type = nm('ExtGState'); g.v.ca = numv(opacity); g.v.CA = numv(opacity);
        const gn = addObj(doc, g);
        const egs = dict(['GS0']);
        egs.v.GS0 = ref(gn);
        const egsN = addObj(doc, egs);
        dictSet(res, 'ExtGState', ref(egsN));
      }

      const old = get(d, 'Contents');
      if (!old) dictSet(d, 'Contents', ref(stream));
      else if (old.t === 'array') old.v.push(ref(stream));
      else dictSet(d, 'Contents', { t: 'array', v: [old, ref(stream)] });
      d.dirty = true;
      const o2 = doc.objs.get(p.num);
      if (o2) o2.dirty = true;
    });

    // one parse, one writer for the whole document
    const keep = new Set();
    for (const n of doc.objs.keys()) keep.add(n);
    const bytesOut = serialize(doc, keep);
    const check = await new Doc(bytesOut).scan();
    if (!check.rootNum || check.pages().length < pages.length) throw new Error('rebuild failed verification');
    return { bytes: bytesOut, pages: check.pages().length };
  }

  function inherited(doc, pageNum, key) {
    let cur = pageNum, depth = 0;
    while (cur && depth++ < 32) {
      const d = doc.dictOf(cur);
      if (!d) return null;
      const v = get(d, key);
      if (v) return v;
      const parent = refOf(get(d, 'Parent'));
      cur = parent;
    }
    return null;
  }

  /* ── text extraction (the embedded text layer, not OCR) ──────────── */
  async function extractText(bytes) {
    const doc = await parse(bytes);
    const pages = doc.pages();
    const out = [];
    for (const p of pages) {
      const refs = [];
      const c = get(p.dict, 'Contents');
      if (c && c.t === 'ref') refs.push(c.n);
      else if (c && c.t === 'array') for (const x of c.v) { const n = refOf(x); if (n != null) refs.push(n); }
      let text = '';
      for (const n of refs) {
        const o = doc.obj(n);
        if (!o || o.sS == null) continue;
        const data = await PDFFilters.decode(doc.streamBytes(o), get(o.value, 'Filter'), get(o.value, 'DecodeParms'));
        if (!data) continue;
        text += textFromContent(Util.latin1(data));
      }
      out.push(text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    }
    return out;
  }

  function textFromContent(s) {
    const toks = PDFEngine.scanTokens(s);
    let out = '', line = '', lastY = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.k === 'word') {
        if (t.v === 'Td' || t.v === 'TD') {
          const y = toks[i - 1];
          if (y && y.k === 'word' && Math.abs(parseFloat(y.v) || 0) > 0.5) { out += line + '\n'; line = ''; }
        } else if (t.v === 'T*' || t.v === 'ET') {
          if (line) { out += line + '\n'; line = ''; }
        } else if (t.v === 'TJ' || t.v === 'Tj' || t.v === "'" || t.v === '"') {
          // strings already pushed below
        }
      } else if (t.k === 'str') {
        line += decodePdfString(s.slice(t.s, t.e));
      }
    }
    if (line) out += line;
    return out;
  }

  function decodePdfString(raw) {
    if (raw[0] === '<') {
      const hex = raw.slice(1, -1).replace(/\s+/g, '');
      let s = '';
      for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return s;
    }
    let body = raw.slice(1, -1);
    body = body.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, g) => {
      if (/^[0-7]/.test(g)) return String.fromCharCode(parseInt(g, 8));
      return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[g] || g;
    });
    return body;
  }

  /* ── embedded JPEGs (real image extraction, no rasteriser needed) ─── */
  async function extractJpegs(bytes) {
    const doc = await parse(bytes);
    const out = [];
    for (const o of doc.objs.values()) {
      if (o.sS == null || !o.value || o.value.t !== 'dict') continue;
      if (nameOf(get(o.value, 'Subtype')) !== 'Image') continue;
      const fl = PDFFilters.normFilters(get(o.value, 'Filter'));
      if (fl[fl.length - 1] !== 'DCTDecode') continue;
      const raw = doc.streamBytes(o);
      let body = raw;
      if (fl.length > 1) {
        const pre = await PDFFilters.decode(raw, fl.slice(0, -1), get(o.value, 'DecodeParms'));
        if (pre) body = pre;
      }
      out.push({
        name: `image-${out.length + 1}.jpg`, bytes: body.slice(),
        width: num(get(o.value, 'Width')), height: num(get(o.value, 'Height'))
      });
    }
    return out;
  }

  /* ── images → PDF (JPEG payloads embedded verbatim, DCTDecode) ───── */
  async function imagesToPdf(items, opts = {}) {
    const dst = blank();
    const kids = [];
    const pagesNum = addObj(dst, dict(['Type', 'Kids', 'Count']));
    const rootNum = addObj(dst, dict(['Type', 'Pages']));
    dst.rootNum = rootNum;
    const root = dst.objs.get(rootNum).value;
    root.v.Type = nm('Catalog'); root.v.Pages = ref(pagesNum);

    for (const it of items) {
      const iw = it.width, ih = it.height;
      const A4 = [595.28, 841.89];
      const margin = opts.margin != null ? opts.margin : 24;
      let pw, ph;
      if (opts.pageSize === 'image') { pw = iw * 0.75; ph = ih * 0.75; }
      else if (opts.pageSize === 'letter') { pw = 612; ph = 792; }
      else { pw = A4[0]; ph = A4[1]; }
      const aw = pw - margin * 2, ah = ph - margin * 2;
      const s = Math.min(aw / iw, ah / ih);
      const dw = iw * s, dh = ih * s;
      const x = (pw - dw) / 2, y = (ph - dh) / 2;

      const imgNum = addObj(dst, (() => {
        const d = dict(['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Filter']);
        d.v.Type = nm('XObject'); d.v.Subtype = nm('Image');
        d.v.Width = numv(iw); d.v.Height = numv(ih);
        d.v.ColorSpace = nm(it.cmyk ? 'DeviceCMYK' : 'DeviceRGB');
        d.v.BitsPerComponent = numv(8);
        d.v.Filter = nm('DCTDecode');
        return d;
      })(), it.bytes);

      const content = `q\n${dw.toFixed(3)} 0 0 ${dh.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm\n/Im0 Do\nQ`;
      const cBytes = Util.utf8(content);
      const contentNum = addObj(dst, (() => { const d = dict(['Length']); d.v.Length = numv(cBytes.length); return d; })(), cBytes);
      const res = dict(['XObject']);
      const xo = dict(['Im0']);
      xo.v.Im0 = ref(imgNum);
      const xoNum = addObj(dst, xo);
      res.v.XObject = ref(xoNum);
      const resNum = addObj(dst, res);

      const pageNum = addObj(dst, (() => {
        const d = dict(['Type', 'Parent', 'MediaBox', 'Resources', 'Contents']);
        d.v.Type = nm('Page');
        d.v.Parent = ref(pagesNum);
        d.v.MediaBox = { t: 'array', v: [numv(0), numv(0), numv(+pw.toFixed(2)), numv(+ph.toFixed(2))] };
        d.v.Resources = ref(resNum);
        d.v.Contents = ref(contentNum);
        return d;
      })());
      kids.push(pageNum);
    }
    const pagesDict = dst.objs.get(pagesNum).value;
    pagesDict.v.Type = nm('Pages');
    pagesDict.v.Kids = { t: 'array', v: kids.map(ref) };
    pagesDict.v.Count = numv(kids.length);
    return finish(dst);
  }

  /* ── page count / quick probe ────────────────────────────────────── */
  async function info(bytes) {
    const doc = await parse(bytes);
    const pages = doc.pages();
    const box = pages[0] ? doc.resolve(get(pages[0].dict, 'MediaBox')) : null;
    const mb = box && box.t === 'array' ? box.v.map((x) => (x && x.t === 'num' ? Math.round(x.v) : 0)) : null;
    return { pages: pages.length, box: mb, version: doc.version, size: bytes.length };
  }

  /* ── reverse page order ─────────────────────────────────────────── */
  async function reverse(bytes) {
    const doc = await parse(bytes);
    const pages = doc.pages().slice().reverse();
    return compose(pages.map((p) => ({ doc, num: p.num })), {});
  }

  /* ── crop margins (real /CropBox + /MediaBox insets, in points) ──── */
  async function crop(bytes, inset) {
    const doc = await parse(bytes);
    const l = inset.left || 0, r = inset.right || 0, t = inset.top || 0, b = inset.bottom || 0;
    for (const p of doc.pages()) {
      const boxV = get(p.dict, 'MediaBox') || get(doc.dictOf(refOf(get(p.dict, 'Parent')) || 0) || {}, 'MediaBox');
      const box = doc.resolve(boxV);
      if (!box || box.t !== 'array') continue;
      const v = box.v.map((x) => (x && x.t === 'num' ? x.v : 0));
      const nb = [v[0] + l, v[1] + b, v[2] - r, v[3] - t];
      if (nb[2] - nb[0] < 24 || nb[3] - nb[1] < 24) continue;      // refuse to crop a page away
      dictSet(p.dict, 'CropBox', { t: 'array', v: nb.map((x) => ({ t: 'num', v: +x.toFixed(2), raw: String(+x.toFixed(2)) })) });
      p.dict.dirty = true;
    }
    const keep = new Set(doc.objs.keys());
    const out = serialize(doc, keep);
    const check = await new Doc(out).scan();
    if (!check.rootNum) throw new Error('rebuild failed verification');
    return { bytes: out, pages: check.pages().length };
  }


  /* ── repair: rebuild the file from its pages (new xref, no junk) ──── */
  async function repair(bytes) {
    const doc = await parse(bytes);
    const pages = doc.pages();
    if (!pages.length) throw new Error('no pages found — nothing to rebuild');
    const plan = pages.map((p) => ({ doc, num: p.num }));
    return compose(plan, {});
  }

  /* ── PDF → Word: the embedded text layer becomes a real .docx ─────── */
  async function toDocx(bytes, title) {
    const pages = await extractText(bytes);
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}`
      + (text ? `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>` : '') + '</w:p>';
    const body = [];
    pages.forEach((text, i) => {
      if (i) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      const lines = text ? text.split('\n') : [''];
      for (const line of lines) body.push(para(line));
    });
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
    const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title || 'Converted document')}</dc:title><dc:creator>ArtViSiON Tools</dc:creator></cp:coreProperties>`;
    const enc = (t) => new TextEncoder().encode(t);
    const zip = await ZipCodec.write([
      { name: '[Content_Types].xml', data: enc(ct) },
      { name: '_rels/.rels', data: enc(rels) },
      { name: 'docProps/core.xml', data: enc(core) },
      { name: 'word/document.xml', data: enc(document) }
    ]);
    return { bytes: zip, pages: pages.length, chars: pages.join('\n').length };
  }


  /* ── security: open a protected PDF, and write a protected one ───── */
  async function unlock(bytes, password) {
    const doc = await new Doc(bytes).scan();
    if (!doc.rootNum) throw new Error('not a readable PDF');
    if (!doc.encrypted) return { bytes, pages: doc.pages().length, unchanged: true };
    const encObj = doc.obj(doc.encryptNum);
    let encDict = encObj ? encObj.value : null;
    if (encDict && encDict.t === 'ref') encDict = doc.resolve(encDict);
    if (!encDict || encDict.t !== 'dict') throw new Error('the /Encrypt dictionary is unreadable');
    const id = doc.fileId || new Uint8Array(16);
    const prep = await PDFCrypto.prepareDecrypt(encDict, id, password || '');
    if (!prep.ok) throw new Error('wrong password — this file needs its user password to open');

    doc.crypt = prep.crypt;
    // strings inside dictionaries are encrypted too: decrypt them, then drop the encryption
    const walk = (v) => {
      if (!v) return v;
      if (v.t === 'str' || v.t === 'hex') {
        const dec = PDFCrypto.decryptBytes(prep.crypt, PDFCrypto.valueBytes(v), v.onum || 0, v.ogen || 0);
        return { t: 'str', raw: '(' + PDFCrypto.toStr(dec).replace(/[\\()]/g, (c) => '\\' + c) + ')' };
      }
      if (v.t === 'array') { v.v = v.v.map(walk); return v; }
      if (v.t === 'dict') { for (const k of Object.keys(v.v)) v.v[k] = walk(v.v[k]); return v; }
      return v;
    };
    for (const o of doc.objs.values()) {
      if (o.num === doc.encryptNum) continue;
      if (o.value) o.value = walk(o.value);
      if (o.sS != null) {
        // decryption is not a filter: /Filter and /DecodeParms must stay
        o.newStream = doc.decryptStream(o);
        o.sS = null; o.sE = null;
      }
      o.dirty = true;
    }
    // forget the encryption dictionary and rebuild with a clean xref
    doc.objs.delete(doc.encryptNum);
    doc.encryptNum = null;
    doc.encrypted = false;
    doc.crypt = null;
    const out = serialize(doc, liveSet(doc));
    const check = await new Doc(out).scan();
    if (!check.rootNum || check.encrypted) throw new Error('rebuild failed verification');
    return { bytes: out, pages: check.pages().length, unchanged: false };
  }

  async function protect(bytes, opts = {}) {
    const doc = await new Doc(bytes).scan();
    if (!doc.rootNum) throw new Error('not a readable PDF');
    if (doc.encrypted) throw new Error('this PDF is already protected — unlock it first');
    const pages = doc.pages().length;
    if (!pages) throw new Error('no pages found');
    const userPw = opts.password || '';
    if (!userPw) throw new Error('choose a password first');
    const perms = opts.perms != null ? opts.perms : -3904;   // print + copy, no edit
    const id = crypto.getRandomValues(new Uint8Array(16));
    // a distinct owner password, so the user password really is the user password
    let ownerPw = opts.ownerPassword;
    if (!ownerPw) { const b = crypto.getRandomValues(new Uint8Array(16)); ownerPw = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
    const built = await PDFCrypto.buildProtect(userPw, ownerPw, perms, id);

    // encrypt every stream and every string, exactly like a real writer does
    const hexStr = (b) => { let h = ''; for (let i = 0; i < b.length; i++) h += (b[i] < 16 ? '0' : '') + b[i].toString(16); return h; };
    // strings are encrypted with the key of the object that holds them
    const walkIn = (owner, v) => {
      if (!v) return v;
      if (v.t === 'str' || v.t === 'hex') {
        const enc = PDFCrypto.encryptBytes(built.crypt, PDFCrypto.valueBytes(v), owner.num, owner.gen || 0);
        return { t: 'str', raw: '(' + PDFCrypto.toStr(enc).replace(/[\\()]/g, (c) => '\\' + c) + ')' };
      }
      if (v.t === 'array') { v.v = v.v.map((x) => walkIn(owner, x)); return v; }
      if (v.t === 'dict') { for (const k of Object.keys(v.v)) v.v[k] = walkIn(owner, v.v[k]); return v; }
      return v;
    };
    for (const o of doc.objs.values()) {
      if (o.value) o.value = walkIn(o, o.value);
      if (o.sS != null || o.newStream != null) {
        const raw = o.newStream != null ? o.newStream : doc.streamBytes(o);
        o.newStream = PDFCrypto.encryptBytes(built.crypt, raw, o.num, o.gen || 0);
        o.sS = null; o.sE = null;
      }
      o.dirty = true;
    }
    // /Encrypt dictionary (AES-256, R6) + file id
    const d = built.dict;
    const encTxt = `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /CFM /AESV3 /Length 32 /AuthEvent /DocOpen >> >> /StmF /StdCF /StrF /StdCF /P ${d.P | 0} /O <${hexStr(d.O)}> /U <${hexStr(d.U)}> /OE <${hexStr(d.OE)}> /UE <${hexStr(d.UE)}> /Perms <${hexStr(d.PERMS)}> /EncryptMetadata true >>`;
    const encObj = { num: 0, gen: 0, value: null, dictRaw: encTxt, sS: null, sE: null, dirty: false };
    let nextNum = 1;
    for (const n of doc.objs.keys()) if (n >= nextNum) nextNum = n + 1;
    encObj.num = nextNum;
    doc.objs.set(nextNum, encObj);
    doc.encryptNum = nextNum;
    doc.fileId = id;
    doc.version = '1.7';
    const out = serialize(doc, liveSet(doc));
    const check = await new Doc(out).scan();
    if (!check.rootNum || !check.encrypted) throw new Error('could not write the protected file');
    return { bytes: out, pages, size: out.length };
  }


  /* ── text → PDF: a real layout writer (Helvetica / Courier), no library ──
     Lines are wrapped with real glyph widths, paginated with a header band and
     written with Flate-compressed content streams. */
  const HELV_W = { ' ':278,'!':278,'"':355,'#':556,'$':556,'%':889,'&':667,"'":191,'(':333,')':333,'*':389,'+':584,',':278,'-':333,'.':278,'/':278,
    '0':556,'1':556,'2':556,'3':556,'4':556,'5':556,'6':556,'7':556,'8':556,'9':556,':':278,';':278,'<':584,'=':584,'>':584,'?':556,'@':1015,
    'A':667,'B':667,'C':722,'D':722,'E':667,'F':611,'G':778,'H':722,'I':278,'J':500,'K':667,'L':556,'M':833,'N':722,'O':778,'P':667,'Q':778,'R':722,
    'S':667,'T':611,'U':722,'V':667,'W':944,'X':667,'Y':667,'Z':611,'[':278,'\\':278,']':278,'^':469,'_':556,'`':333,
    'a':556,'b':556,'c':500,'d':556,'e':556,'f':278,'g':556,'h':556,'i':222,'j':222,'k':500,'l':222,'m':833,'n':556,'o':556,'p':556,'q':556,'r':333,
    's':500,'t':278,'u':556,'v':500,'w':722,'x':500,'y':500,'z':500,'{':334,'|':260,'}':334,'~':584 };
  const W = (ch, mono) => (mono ? 600 : (HELV_W[ch] != null ? HELV_W[ch] : 556)) / 1000;

  function wrapText(text, maxW, size, mono) {
    const out = [];
    for (const rawLine of text.split(/\r\n|\r|\n/)) {
      if (!rawLine) { out.push(''); continue; }
      let line = '', w = 0;
      for (const word of rawLine.split(/(\s+)/)) {
        const ww = [...word].reduce((n, c) => n + W(c, mono) * size, 0);
        if (w + ww > maxW && line.trim()) { out.push(line.replace(/\s+$/, '')); line = word.replace(/^\s+/, ''); w = [...line].reduce((n, c) => n + W(c, mono) * size, 0); }
        else { line += word; w += ww; }
      }
      out.push(line.replace(/\s+$/, ''));
    }
    return out;
  }

  async function textToPdf(input, opts = {}) {
    const size = opts.size || 10.5;
    const leading = opts.leading || Math.round(size * 1.45 * 10) / 10;
    const mono = !!opts.mono;
    const font = mono ? 'Courier' : 'Helvetica';
    const pageW = 595.28, pageH = 841.89;                 // A4 portrait
    const margin = opts.margin || 56;
    const maxW = pageW - margin * 2;
    const top = pageH - margin;
    const bottom = margin + 18;
    const perPage = Math.max(1, Math.floor((top - bottom) / leading));

    // a "page" of input may be a string (text) or an array of cells (table row)
    const lines = Array.isArray(input) ? input : wrapText(String(input), maxW, size, mono);
    const esc = (t) => t.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7E]/g, (c) => {
      const map = { '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-', '\u2022': '*', '\u2026': '...' };
      return map[c] != null ? map[c] : '?';
    });

    const pages = [];
    for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
    if (!pages.length) pages.push(['']);

    const objs = [];               // index = object number - 1
    const addObj2 = (body) => { objs.push(body); return objs.length; };
    const catalogNum = addObj2(null);          // placeholder
    const pagesNum = addObj2(null);
    const fontNum = addObj2(`<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`);
    const kids = [];
    for (let pi = 0; pi < pages.length; pi++) {
      let content = 'BT\n';
      content += `/F1 ${size} Tf\n${leading} TL\n`;
      let y = top;
      for (const line of pages[pi]) {
        if (line && line.length) content += `1 0 0 1 ${margin.toFixed(2)} ${y.toFixed(2)} Tm (${esc(line)}) Tj\n`;
        y -= leading;
      }
      content += 'ET\n';
      if (opts.footer !== false) {
        content += `BT /F1 7.5 Tf 1 0 0 1 ${margin} ${(margin - 20).toFixed(2)} Tm (${esc(opts.title || '')}  ·  ${pi + 1} / ${pages.length}) Tj ET\n`;
      }
      const z = await Util.deflate(Util.unlatin1(content));
      const contentNum = addObj2(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n${Util.latin1(z)}\nendstream`);
      const pageNum = addObj2(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`);
      kids.push(pageNum);
    }
    objs[catalogNum - 1] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
    objs[pagesNum - 1] = `<< /Type /Pages /Kids [${kids.map((n) => n + ' 0 R').join(' ')}] /Count ${kids.length} >>`;

    let out = '%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n';
    const offsets = [];
    for (let i = 0; i < objs.length; i++) {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogNum} 0 R /Producer (ArtViSiON Tools) >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = Util.unlatin1(out);
    const check = await new Doc(bytes).scan();
    if (!check.rootNum || check.pages().length !== pages.length) throw new Error('layout failed verification');
    return { bytes, pages: pages.length };
  }

  /* CSV → PDF: a ruled table, column widths measured from the real content */
  async function csvToPdf(text, opts = {}) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    if (!rows.length) throw new Error('the CSV is empty');
    const size = 8.5, pad = 4;
    const cols = Math.max(...rows.map((r) => r.length));
    const widths = new Array(cols).fill(0);
    for (const r of rows) for (let c = 0; c < cols; c++) {
      const w = [...(r[c] || '')].reduce((n, ch) => n + W(ch, false) * size, 0) + pad * 2;
      widths[c] = Math.min(180, Math.max(widths[c], w));
    }
    const margin = 40;
    const avail = 595.28 - margin * 2;
    const total = widths.reduce((a, b) => a + b, 0);
    const scale = total > avail ? avail / total : 1;
    const colW = widths.map((w) => w * scale);
    const rowH = size * 1.9;
    const perPage = Math.floor((841.89 - margin * 2 - rowH) / rowH);

    const draw = (chunk, first, pageNo, pageCount) => {
      let s = '';
      let y = 841.89 - margin;
      const drawRow = (cells, bold) => {
        let x = margin;
        s += `0.55 w 0.72 0.72 0.72 RG\n`;
        for (let c = 0; c < cols; c++) {
          if (bold) s += `0.93 0.93 0.93 rg ${x.toFixed(2)} ${(y - rowH + 3).toFixed(2)} ${colW[c].toFixed(2)} ${(rowH - 3).toFixed(2)} re f 0 0 0 rg\n`;
          s += `${x.toFixed(2)} ${(y - rowH).toFixed(2)} ${colW[c].toFixed(2)} ${rowH.toFixed(2)} re S\n`;
          const val = String(cells[c] == null ? '' : cells[c]).replace(/[\\()]/g, (ch) => '\\' + ch).replace(/[^\x20-\x7E]/g, '?');
          const maxChars = Math.max(1, Math.floor((colW[c] - pad * 2) / (size * 0.5)));
          const shown = val.length > maxChars ? val.slice(0, maxChars - 1) + '…'.replace('…', '.') : val;
          s += `BT /F1 ${size} Tf 1 0 0 1 ${(x + pad).toFixed(2)} ${(y - rowH + size * 0.72).toFixed(2)} Tm (${shown}) Tj ET\n`;
          x += colW[c];
        }
        y -= rowH;
      };
      if (first) drawRow(chunk[0], true);
      for (const r of (first ? chunk.slice(1) : chunk)) drawRow(r, false);
      s += `BT /F1 7 Tf 1 0 0 1 ${margin} ${(margin - 18).toFixed(2)} Tm (page ${pageNo} / ${pageCount}) Tj ET\n`;
      return s;
    };

    // paginate: header repeated on every page
    const header = rows[0], body = rows.slice(1);
    const chunks = [];
    for (let i = 0; i < body.length; i += perPage - 1) chunks.push(body.slice(i, i + perPage - 1));
    if (!chunks.length) chunks.push([]);
    const streams = [];
    for (let i = 0; i < chunks.length; i++) streams.push(draw([header].concat(chunks[i]), true, i + 1, chunks.length));

    const objs = [];
    const addO = (b) => { objs.push(b); return objs.length; };
    const catNum = addO(null), pagesNum = addO(null);
    const fontNum = addO('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const s of streams) {
      const z = await Util.deflate(Util.unlatin1(s));   // latin1 chars → bytes
      const cNum = addO(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n${Util.latin1(z)}\nendstream`);
      kids.push(addO(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${cNum} 0 R >>`));
    }
    objs[catNum - 1] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
    objs[pagesNum - 1] = `<< /Type /Pages /Kids [${kids.map((n) => n + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n';
    const offs = [];
    for (let i = 0; i < objs.length; i++) { offs.push(out.length); out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`; }
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offs) out += String(o).padStart(10, '0') + ' 00000 n \n';
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catNum} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = Util.unlatin1(out);
    const check = await new Doc(bytes).scan();
    if (!check.pages().length) throw new Error('table layout failed verification');
    return { bytes, pages: check.pages().length, rows: rows.length, cols };
  }

  return { merge, select, rotate, reverse, crop, splitEvery, stamp, extractText, extractJpegs, imagesToPdf, info, parse, compose, textFromContent, repair, toDocx, unlock, protect, textToPdf, csvToPdf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { PDFEdit };
