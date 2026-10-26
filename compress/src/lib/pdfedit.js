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
  const hexBytes = (b) => { let h = ''; for (let i = 0; i < b.length; i++) h += (b[i] < 16 ? '0' : '') + b[i].toString(16); return h; };
  const strv = (s) => {
    const str = String(s);
    if (/^[\x20-\x7E]*$/.test(str)) return { t: 'str', raw: '(' + str.replace(/([\\()])/g, '\\$1') + ')' };
    let h = 'FEFF';
    for (let i = 0; i < str.length; i++) h += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    return { t: 'hex', raw: '<' + h + '>' };
  };

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
    let doc = await new Doc(bytes).scan();
    if (!doc.rootNum) throw new Error('not a readable PDF');
    if (doc.encrypted) {
      // Auto-unlock owner-permission-locked PDFs (empty user password "")
      const unlocked = await unlock(bytes, '').catch(() => null);
      if (unlocked && unlocked.bytes) {
        doc = await new Doc(unlocked.bytes).scan();
      }
      if (doc.encrypted) throw new Error('password-protected PDF — remove the password first');
    }
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
    const pageMeta = [];
    for (const item of plan) {
      if (!bySrc.has(item.doc)) bySrc.set(item.doc, importDoc(item.doc, dst));
      const mapped = bySrc.get(item.doc);
      const pn = mapped.map.get(item.num);
      // Capture inherited page attributes from ancestor /Pages nodes before re-parenting
      const inh = {};
      for (const k of ['MediaBox', 'CropBox', 'Resources', 'Rotate']) {
        const iv = inherited(item.doc, item.num, k);
        if (iv) inh[k] = cloneVal(iv, mapped.map);
      }
      pageMeta.push({ pn, inh });
    }
    const pageNums = pageMeta.map((x) => x.pn);
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

    for (const { pn, inh } of pageMeta) {
      const d = dst.objs.get(pn).value;
      if (!d || d.t !== 'dict') continue;
      dictSet(d, 'Type', nm('Page'));
      for (const k of ['MediaBox', 'CropBox', 'Resources', 'Rotate']) {
        if (!get(d, k) && inh[k]) dictSet(d, k, inh[k]);
      }
      dictSet(d, 'Parent', ref(pagesNum));
      const rot = num(dst.resolve(get(d, 'Rotate')), 0);
      if (opts.rotate) {
        const r = (((rot + opts.rotate) % 360) + 360) % 360;
        if (r) dictSet(d, 'Rotate', numv(r)); else dictDel(d, 'Rotate');
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

  const WINANSI_SPECIAL = {
    '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84, '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87,
    '\u02C6': 0x88, '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C, '\u017D': 0x8E, '\u2018': 0x91,
    '\u2019': 0x92, '\u201C': 0x93, '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97, '\u02DC': 0x98,
    '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B, '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F
  };
  function winAnsiEsc(label) {
    const str = String(label).replace(/\u20B9/g, 'Rs.');
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      const ch = str[i];
      if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
      else if (code >= 0x20 && code <= 0x7E) out += ch;
      else if (WINANSI_SPECIAL[ch] != null) out += '\\' + WINANSI_SPECIAL[ch].toString(8).padStart(3, '0');
      else if (code >= 0xA0 && code <= 0xFF) out += '\\' + code.toString(8).padStart(3, '0');
      else out += '?';
    }
    return out;
  }

  /* stamp text on every page (page numbers / watermark) — collision-free content stream */
  async function stamp(bytes, o = {}) {
    const doc = await parse(bytes);
    const pages = doc.pages();
    const text = o.text != null ? o.text : '';
    const size = o.size || 12;
    const opacity = o.opacity != null ? o.opacity : 1;
    const color = o.color || [0.15, 0.15, 0.15];
    const fontKey = 'F_AVStamp', gsKey = 'GS_AVStamp';
    const fontNum = addObj(doc, (() => {
      const f = dict(['Type', 'Subtype', 'BaseFont', 'Encoding']);
      f.v.Type = nm('Font'); f.v.Subtype = nm('Type1'); f.v.BaseFont = nm(o.font || 'Helvetica'); f.v.Encoding = nm('WinAnsiEncoding');
      return f;
    })());
    let gsNum = null;
    if (opacity < 1) {
      const g = dict(['Type', 'ca', 'CA']);
      g.v.Type = nm('ExtGState'); g.v.ca = numv(opacity); g.v.CA = numv(opacity);
      gsNum = addObj(doc, g);
    }
    const qBytes = Util.utf8('q\n'), QBytes = Util.utf8('\nQ\n');
    const qStream = addObj(doc, (() => { const sd = dict(['Length']); sd.v.Length = numv(qBytes.length); return sd; })(), qBytes);
    const QStream = addObj(doc, (() => { const sd = dict(['Length']); sd.v.Length = numv(QBytes.length); return sd; })(), QBytes);

    pages.forEach((p, i) => {
      const label = typeof o.perPage === 'function' ? o.perPage(i + 1, pages.length) : text;
      if (!label) return;
      const d = p.dict;
      const boxV = inherited(doc, p.num, 'CropBox') || inherited(doc, p.num, 'MediaBox');
      const box = doc.resolve(boxV);
      const mb = box && box.t === 'array' ? box.v.map((x) => { const rx = doc.resolve(x); return rx && rx.t === 'num' ? rx.v : 0; }) : [0, 0, 612, 792];
      const x0 = Math.min(mb[0], mb[2]), y0 = Math.min(mb[1], mb[3]);
      const w = Math.abs(mb[2] - mb[0]) || 612, h = Math.abs(mb[3] - mb[1]) || 792;
      const esc = winAnsiEsc(label);
      let x, y, rot = 0, fs = size;
      if (o.mode === 'watermark') {
        fs = o.size || Math.round(Math.min(w, h) / 11);
        const tw = fs * 0.52 * String(label).length;
        const rad = 35 * Math.PI / 180;
        const cx = x0 + w / 2, cy = y0 + h / 2;
        x = cx - (tw / 2) * Math.cos(rad) + (fs * 0.35) * Math.sin(rad);
        y = cy - (tw / 2) * Math.sin(rad) - (fs * 0.35) * Math.cos(rad);
        rot = 35;
      } else if (o.pos === 'tl') { x = x0 + 36; y = y0 + h - 36 - fs; }
      else if (o.pos === 'tr') { x = x0 + w - 36 - fs * 0.52 * String(label).length; y = y0 + h - 36 - fs; }
      else if (o.pos === 'bl') { x = x0 + 36; y = y0 + 28; }
      else if (o.pos === 'br') { x = x0 + w - 36 - fs * 0.52 * String(label).length; y = y0 + 28; }
      else { x = x0 + (w - fs * 0.52 * String(label).length) / 2; y = y0 + 28; }

      const body = [
        'q',
        gsNum != null ? `/${gsKey} gs` : '',
        `BT /${fontKey} ${fs} Tf ${color[0]} ${color[1]} ${color[2]} rg`,
        rot ? `${Math.cos(rot * Math.PI / 180).toFixed(5)} ${Math.sin(rot * Math.PI / 180).toFixed(5)} ${(-Math.sin(rot * Math.PI / 180)).toFixed(5)} ${Math.cos(rot * Math.PI / 180).toFixed(5)} ${x.toFixed(2)} ${y.toFixed(2)} Tm` : `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
        `(${esc}) Tj`,
        'ET',
        'Q'
      ].filter(Boolean).join('\n');
      const bodyBytes = Util.unlatin1(body);
      const sDict = dict([]);
      dictSet(sDict, 'Length', numv(bodyBytes.length));
      const stream = addObj(doc, sDict, bodyBytes);

      // Clone page Resources safely so we never overwrite /F1 or shared /ExtGState
      const origRes = doc.resolve(inherited(doc, p.num, 'Resources'));
      const newRes = origRes && origRes.t === 'dict' ? cloneVal(origRes, new Map()) : dict([]);
      const origFonts = doc.resolve(get(newRes, 'Font'));
      const newFonts = origFonts && origFonts.t === 'dict' ? cloneVal(origFonts, new Map()) : dict([]);
      dictSet(newFonts, fontKey, ref(fontNum));
      dictSet(newRes, 'Font', ref(addObj(doc, newFonts)));

      if (gsNum != null) {
        const origGs = doc.resolve(get(newRes, 'ExtGState'));
        const newGs = origGs && origGs.t === 'dict' ? cloneVal(origGs, new Map()) : dict([]);
        dictSet(newGs, gsKey, ref(gsNum));
        dictSet(newRes, 'ExtGState', ref(addObj(doc, newGs)));
      }
      dictSet(d, 'Resources', ref(addObj(doc, newRes)));

      const old = doc.resolve(get(d, 'Contents')) && get(d, 'Contents');
      if (!old) dictSet(d, 'Contents', ref(stream));
      else {
        const existing = old.t === 'array' ? old.v.slice() : [old];
        dictSet(d, 'Contents', { t: 'array', v: [ref(qStream), ...existing, ref(QStream), ref(stream)] });
      }
      d.dirty = true;
      const o2 = doc.objs.get(p.num);
      if (o2) o2.dirty = true;
    });

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

  /* ── text extraction (with ToUnicode CMap + CID + pdf.js fallback) ── */
  function parseCMap(cmapText) {
    const map = new Map();
    let twoByte = /begincodespacerange[\s\S]*?<[0-9A-Fa-f]{4}>/.test(cmapText);
    const hexToUnicode = (hx) => {
      hx = hx.replace(/\s+/g, '');
      let s = '';
      if (hx.length >= 4 && hx.length % 4 === 0) {
        for (let i = 0; i < hx.length; i += 4) s += String.fromCodePoint(parseInt(hx.slice(i, i + 4), 16));
      } else {
        for (let i = 0; i + 1 < hx.length; i += 2) s += String.fromCharCode(parseInt(hx.slice(i, i + 2), 16));
      }
      return s;
    };
    for (const m of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        if (pair[1].length === 4) twoByte = true;
        map.set(parseInt(pair[1], 16), hexToUnicode(pair[2]));
      }
    }
    for (const m of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const rng of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
        const lo = parseInt(rng[1], 16), hi = parseInt(rng[2], 16);
        if (rng[1].length === 4) twoByte = true;
        if (rng[3] != null) {
          let code = parseInt(rng[3], 16);
          for (let c = lo; c <= hi && c - lo < 4096; c++, code++) map.set(c, String.fromCodePoint(code));
        } else if (rng[4] != null) {
          const items = [...rng[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map(x => hexToUnicode(x[1]));
          for (let c = lo, k = 0; c <= hi && k < items.length; c++, k++) map.set(c, items[k]);
        }
      }
    }
    return { map, twoByte };
  }

  async function buildPageFontMaps(doc, res) {
    const fonts = new Map();
    const rdict = doc.resolve(res);
    const fdict = rdict && rdict.t === 'dict' ? doc.resolve(get(rdict, 'Font')) : null;
    if (!fdict || fdict.t !== 'dict') return fonts;
    for (const fname of Object.keys(fdict.v)) {
      const fobj = doc.resolve(fdict.v[fname]);
      if (!fobj || fobj.t !== 'dict') continue;
      const encName = nameOf(doc.resolve(get(fobj, 'Encoding'))) || '';
      const isIdentity = /Identity/i.test(encName) || nameOf(get(fobj, 'Subtype')) === 'Type0';
      const tuRef = refOf(get(fobj, 'ToUnicode'));
      if (tuRef != null) {
        const tuo = doc.obj(tuRef);
        if (tuo && tuo.sS != null) {
          const data = await PDFFilters.decode(doc.streamBytes(tuo), get(tuo.value, 'Filter'), get(tuo.value, 'DecodeParms'));
          if (data) {
            const parsed = parseCMap(Util.latin1(data));
            if (isIdentity) parsed.twoByte = true;
            fonts.set(fname, parsed);
            continue;
          }
        }
      }
      if (isIdentity) fonts.set(fname, { map: new Map(), twoByte: true });
    }
    return fonts;
  }

  async function extractStreamWithForms(doc, streamStr, resDict, fontMaps, visited) {
    const toks = PDFEngine.scanTokens(streamStr);
    const xobjs = resDict && resDict.t === 'dict' ? doc.resolve(get(resDict, 'XObject')) : null;
    let out = '', line = '', curFont = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.k === 'word') {
        if (t.v === 'Tf' && i >= 2) {
          const fnTok = toks[i - 2];
          if (fnTok) {
            const fn = streamStr.slice(fnTok.s, fnTok.e).replace(/^\//, '');
            curFont = fontMaps ? fontMaps.get(fn) || null : null;
          }
        } else if (t.v === 'Td' || t.v === 'TD') {
          const y = toks[i - 1];
          if (y && y.k === 'word' && Math.abs(parseFloat(y.v) || 0) > 0.5) { out += line + '\n'; line = ''; }
        } else if (t.v === 'T*' || t.v === 'ET') {
          if (line) { out += line + '\n'; line = ''; }
        } else if (t.v === 'Do' && i >= 1 && xobjs && xobjs.t === 'dict') {
          const xoTok = toks[i - 1];
          const xoName = xoTok ? streamStr.slice(xoTok.s, xoTok.e).replace(/^\//, '') : '';
          const xoRef = xoName ? refOf(xobjs.v[xoName]) : null;
          if (xoRef != null && !visited.has(xoRef)) {
            const xoObj = doc.obj(xoRef);
            if (xoObj && xoObj.sS != null && xoObj.value && nameOf(doc.resolve(get(xoObj.value, 'Subtype'))) === 'Form') {
              visited.add(xoRef);
              const fdata = await PDFFilters.decode(doc.streamBytes(xoObj), get(xoObj.value, 'Filter'), get(xoObj.value, 'DecodeParms'));
              if (fdata) {
                const formRes = doc.resolve(get(xoObj.value, 'Resources')) || resDict;
                const formFonts = await buildPageFontMaps(doc, formRes);
                for (const [k, v] of fontMaps) if (!formFonts.has(k)) formFonts.set(k, v);
                if (line) { out += line + '\n'; line = ''; }
                out += await extractStreamWithForms(doc, Util.latin1(fdata), formRes, formFonts, visited);
              }
            }
          }
        } else if (/^-?\d/.test(t.v)) {
          const kern = parseFloat(t.v);
          if (kern < -180 && line && !line.endsWith(' ')) line += ' ';
        }
      } else if (t.k === 'str') {
        line += decodePdfString(streamStr.slice(t.s, t.e), curFont);
      }
    }
    if (line) out += line;
    return out;
  }

  async function extractText(bytes) {
    const doc = await parse(bytes);
    const pages = doc.pages();
    const out = [];
    let readableChars = 0, rawChars = 0;
    for (const p of pages) {
      const resDict = doc.resolve(inherited(doc, p.num, 'Resources'));
      const fontMaps = await buildPageFontMaps(doc, resDict);
      const refs = [];
      const c = doc.resolve(get(p.dict, 'Contents')) && get(p.dict, 'Contents');
      if (c && c.t === 'ref') refs.push(c.n);
      else if (c && c.t === 'array') for (const x of c.v) { const n = refOf(x); if (n != null) refs.push(n); }
      let text = '';
      const visited = new Set();
      for (const n of refs) {
        const o = doc.obj(n);
        if (!o || o.sS == null) continue;
        const data = await PDFFilters.decode(doc.streamBytes(o), get(o.value, 'Filter'), get(o.value, 'DecodeParms'));
        if (!data) continue;
        text += await extractStreamWithForms(doc, Util.latin1(data), resDict, fontMaps, visited);
      }
      const clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      rawChars += text.length;
      readableChars += (clean.match(/[\p{L}\p{N}]/gu) || []).length;
      out.push(clean);
    }

    // Fallback to Mozilla pdf.js on main thread when a PDF uses external CID CMaps / complex encodings
    if (pages.length > 0 && readableChars < Math.max(4, rawChars * 0.15) && typeof Compressor !== 'undefined' && Compressor.ensurePdfJs) {
      if (typeof document === 'undefined') {
        const e = new Error('NO_CANVAS');
        e.code = 'NO_CANVAS';
        throw e;
      }
      try {
        const pdfjs = await Compressor.ensurePdfJs();
        if (pdfjs) {
          const pdoc = Compressor.openPdfJsDoc
            ? await Compressor.openPdfJsDoc(pdfjs, bytes)
            : await pdfjs.getDocument({ data: bytes.slice(), disableAutoFetch: true, disableStream: true }).promise;
          const jsOut = [];
          for (let i = 1; i <= pdoc.numPages; i++) {
            const pg = await pdoc.getPage(i);
            const tc = await pg.getTextContent();
            let line = '', pageTxt = '', lastY = null;
            for (const it of tc.items) {
              const y = it.transform ? it.transform[5] : null;
              if (lastY != null && y != null && Math.abs(y - lastY) > 4) {
                pageTxt += line.trimEnd() + '\n';
                line = '';
              }
              line += (line && !line.endsWith(' ') && !String(it.str || '').startsWith(' ') ? ' ' : '') + (it.str || '');
              if (y != null) lastY = y;
            }
            if (line) pageTxt += line.trimEnd();
            jsOut.push(pageTxt.trim());
          }
          try { pdoc.destroy(); } catch (e) {}
          if (jsOut.join('').replace(/\s/g, '').length > readableChars) return jsOut;
        }
      } catch (e) { /* keep native extraction */ }
    }
    return out;
  }

  function textFromContent(s, fontMaps) {
    const toks = PDFEngine.scanTokens(s);
    let out = '', line = '', curFont = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.k === 'word') {
        if (t.v === 'Tf' && i >= 2) {
          const fnTok = toks[i - 2];
          if (fnTok) {
            const fn = s.slice(fnTok.s, fnTok.e).replace(/^\//, '');
            curFont = fontMaps ? fontMaps.get(fn) || null : null;
          }
        } else if (t.v === 'Td' || t.v === 'TD') {
          const y = toks[i - 1];
          if (y && y.k === 'word' && Math.abs(parseFloat(y.v) || 0) > 0.5) { out += line + '\n'; line = ''; }
        } else if (t.v === 'T*' || t.v === 'ET') {
          if (line) { out += line + '\n'; line = ''; }
        } else if (/^-?\d/.test(t.v)) {
          // Large negative TJ kerning adjustment represents a word space
          const kern = parseFloat(t.v);
          if (kern < -180 && line && !line.endsWith(' ')) line += ' ';
        }
      } else if (t.k === 'str') {
        line += decodePdfString(s.slice(t.s, t.e), curFont);
      }
    }
    if (line) out += line;
    return out;
  }

  function decodePdfString(raw, fontInfo) {
    let bytes;
    if (raw[0] === '<') {
      const hex = raw.slice(1, -1).replace(/\s+/g, '');
      bytes = new Uint8Array(Math.floor(hex.length / 2));
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    } else {
      let body = raw.slice(1, -1);
      body = body.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, g) => {
        if (/^[0-7]/.test(g)) return String.fromCharCode(parseInt(g, 8));
        return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[g] || g;
      });
      bytes = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
    }

    if (fontInfo && fontInfo.map && fontInfo.map.size > 0) {
      let out = '';
      if (fontInfo.twoByte && bytes.length >= 2) {
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          const cid = (bytes[i] << 8) | bytes[i + 1];
          out += fontInfo.map.has(cid) ? fontInfo.map.get(cid) : (cid >= 32 && cid < 127 ? String.fromCharCode(cid) : '');
        }
      } else {
        for (let i = 0; i < bytes.length; i++) {
          const cid = bytes[i];
          out += fontInfo.map.has(cid) ? fontInfo.map.get(cid) : String.fromCharCode(cid);
        }
      }
      return out;
    }

    // UTF-16BE BOM check
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out;
    }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /* ── embedded JPEGs + lossless PNG extraction ────────────────────── */
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

  async function extractImages(bytes) {
    const doc = await parse(bytes);
    const out = [];
    // Collect SMask object numbers so we don't also export standalone alpha masks as separate grayscale images
    const smaskRefs = new Set();
    for (const o of doc.objs.values()) {
      if (!o.value || o.value.t !== 'dict') continue;
      const sm = refOf(get(o.value, 'SMask'));
      if (sm != null) smaskRefs.add(sm);
    }

    for (const o of doc.objs.values()) {
      if (o.sS == null || !o.value || o.value.t !== 'dict') continue;
      if (smaskRefs.has(o.num)) continue;
      if (nameOf(doc.resolve(get(o.value, 'Subtype'))) !== 'Image') continue;
      const imMask = doc.resolve(get(o.value, 'ImageMask'));
      if (imMask && imMask.t === 'bool' && imMask.v === true) continue;
      const w = num(doc.resolve(get(o.value, 'Width'))), h = num(doc.resolve(get(o.value, 'Height')));
      if (!w || !h) continue;
      const fltV = doc.resolve(get(o.value, 'Filter'));
      const fl = PDFFilters.normFilters(fltV);
      const last = fl.length ? fl[fl.length - 1] : '';
      const raw = doc.streamBytes(o);

      // Decode optional /SMask alpha channel if present
      let alphaMask = null;
      const smRef = refOf(get(o.value, 'SMask'));
      if (smRef != null) {
        const smo = doc.obj(smRef);
        if (smo && smo.sS != null && smo.value && smo.value.t === 'dict') {
          const sw = num(doc.resolve(get(smo.value, 'Width'))), sh = num(doc.resolve(get(smo.value, 'Height')));
          const sbpc = num(doc.resolve(get(smo.value, 'BitsPerComponent')), 8);
          const sflt = doc.resolve(get(smo.value, 'Filter'));
          const sraw = doc.streamBytes(smo);
          const sdec = PDFFilters.normFilters(sflt).length ? await PDFFilters.decode(sraw, sflt, doc.resolve(get(smo.value, 'DecodeParms'))) : sraw;
          if (sdec && sw === w && sh === h && sbpc === 8 && sdec.length >= w * h) alphaMask = sdec;
        }
      }

      if ((last === 'DCTDecode' || last === 'DCT') && !alphaMask) {
        let body = raw;
        if (fl.length > 1) {
          const pre = await PDFFilters.decode(raw, fl.slice(0, -1), doc.resolve(get(o.value, 'DecodeParms')));
          if (pre) body = pre;
        }
        out.push({ name: `image-${out.length + 1}.jpg`, bytes: body.slice(), width: w, height: h, kind: 'JPG' });
      } else if (last === 'JPXDecode') {
        let body = raw;
        if (fl.length > 1) {
          const pre = await PDFFilters.decode(raw, fl.slice(0, -1), doc.resolve(get(o.value, 'DecodeParms')));
          if (pre) body = pre;
        }
        out.push({ name: `image-${out.length + 1}.jp2`, bytes: body.slice(), width: w, height: h, kind: 'JP2' });
      } else if (typeof PNGCodec !== 'undefined' && PNGCodec.encodeRaw) {
        const bpc = num(doc.resolve(get(o.value, 'BitsPerComponent')), 8);
        const csVal = doc.resolve(get(o.value, 'ColorSpace'));
        const samples = fl.length ? await PDFFilters.decode(raw, fltV, doc.resolve(get(o.value, 'DecodeParms'))) : raw;
        if (!samples) continue;
        const nPix = w * h;
        let rgb = null, gray = null;

        // Check /Indexed palette color space: [/Indexed base hival lookup]
        if (csVal && csVal.t === 'array' && nameOf(doc.resolve(csVal.v[0])) === 'Indexed' && csVal.v.length >= 4 && bpc === 8 && samples.length >= nPix) {
          let palBytes = null;
          const lk = csVal.v[3];
          if (lk && lk.t === 'ref') {
            const lko = doc.obj(lk.n);
            if (lko && lko.sS != null) {
              const lflt = doc.resolve(get(lko.value, 'Filter'));
              palBytes = PDFFilters.normFilters(lflt).length ? await PDFFilters.decode(doc.streamBytes(lko), lflt, doc.resolve(get(lko.value, 'DecodeParms'))) : doc.streamBytes(lko);
            }
          }
          const lkRes = doc.resolve(lk);
          if (!palBytes && lkRes && (lkRes.t === 'str' || lkRes.t === 'hex')) palBytes = PDFCrypto.valueBytes(lkRes);
          if (palBytes && palBytes.length >= 3) {
            rgb = new Uint8Array(nPix * 3);
            for (let i = 0; i < nPix; i++) {
              const idx = samples[i] * 3;
              rgb[i * 3] = palBytes[idx] || 0;
              rgb[i * 3 + 1] = palBytes[idx + 1] || 0;
              rgb[i * 3 + 2] = palBytes[idx + 2] || 0;
            }
          }
        } else if (bpc === 1 && samples.length >= Math.ceil(w / 8) * h) {
          const rowBytes = Math.ceil(w / 8);
          gray = new Uint8Array(nPix);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const bit = (samples[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
              gray[y * w + x] = bit ? 255 : 0;
            }
          }
        } else if (bpc === 8) {
          if (samples.length === nPix * 3) rgb = samples;
          else if (samples.length === nPix) gray = samples;
          else if (samples.length === nPix * 4) {
            rgb = new Uint8Array(nPix * 3);
            for (let i = 0, s = 0, d = 0; i < nPix; i++, s += 4, d += 3) {
              const c = samples[s] / 255, m = samples[s + 1] / 255, y = samples[s + 2] / 255, k = samples[s + 3] / 255;
              rgb[d] = Math.round(255 * (1 - c) * (1 - k));
              rgb[d + 1] = Math.round(255 * (1 - m) * (1 - k));
              rgb[d + 2] = Math.round(255 * (1 - y) * (1 - k));
            }
          }
        }

        let png = null;
        if (alphaMask && (rgb || gray) && PNGCodec.encodeRGBA) {
          const rgba = new Uint8ClampedArray(nPix * 4);
          for (let i = 0; i < nPix; i++) {
            rgba[i * 4] = rgb ? rgb[i * 3] : gray[i];
            rgba[i * 4 + 1] = rgb ? rgb[i * 3 + 1] : gray[i];
            rgba[i * 4 + 2] = rgb ? rgb[i * 3 + 2] : gray[i];
            rgba[i * 4 + 3] = alphaMask[i];
          }
          png = await PNGCodec.encodeRGBA({ data: rgba, width: w, height: h });
        } else if (rgb) {
          png = await PNGCodec.encodeRaw(rgb, w, h, 3);
        } else if (gray) {
          png = await PNGCodec.encodeRaw(gray, w, h, 1);
        }
        if (png) out.push({ name: `image-${out.length + 1}.png`, bytes: png, width: w, height: h, kind: 'PNG' });
      }
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
    const box = pages[0] ? doc.resolve(inherited(doc, pages[0].num, 'MediaBox')) : null;
    const mb = box && box.t === 'array' ? box.v.map((x) => { const rx = doc.resolve(x); return rx && rx.t === 'num' ? Math.round(rx.v) : 0; }) : null;
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
      const boxV = inherited(doc, p.num, 'CropBox') || inherited(doc, p.num, 'MediaBox');
      const box = doc.resolve(boxV);
      if (!box || box.t !== 'array') continue;
      const v = box.v.map((x) => { const rx = doc.resolve(x); return rx && rx.t === 'num' ? rx.v : 0; });
      const x0 = Math.min(v[0], v[2]), y0 = Math.min(v[1], v[3]);
      const x1 = Math.max(v[0], v[2]), y1 = Math.max(v[1], v[3]);
      const nb = [x0 + l, y0 + b, x1 - r, y1 - t];
      if (nb[2] - nb[0] < 24 || nb[3] - nb[1] < 24) continue;      // refuse to crop a page away
      dictSet(p.dict, 'CropBox', { t: 'array', v: nb.map((x) => ({ t: 'num', v: +x.toFixed(2), raw: String(+x.toFixed(2)) })) });
      if (!get(p.dict, 'MediaBox')) dictSet(p.dict, 'MediaBox', cloneVal(box, new Map()));
      p.dict.dirty = true;
      const po = doc.objs.get(p.num);
      if (po) po.dirty = true;
    }
    const keep = new Set(doc.objs.keys());
    const out = serialize(doc, keep);
    const check = await new Doc(out).scan();
    if (!check.rootNum) throw new Error('rebuild failed verification');
    return { bytes: out, pages: check.pages().length };
  }


  /* ── repair: strip header junk + rescue orphaned /Page objects + new xref ── */
  async function repair(bytes) {
    let clean = bytes;
    // Strip leading HTTP/MIME garbage before %PDF-
    const rawHead = Util.latin1(bytes.subarray(0, Math.min(bytes.length, 4096)));
    const pdfIdx = rawHead.indexOf('%PDF-');
    if (pdfIdx > 0) clean = bytes.subarray(pdfIdx);

    let doc = null;
    try {
      doc = await parse(clean);
    } catch (e) {
      if (/password-protected/i.test(e.message)) throw e;
      doc = await new Doc(clean).scan();
    }

    let pages = doc ? doc.pages() : [];
    // Emergency rescue when /Root or /Pages tree is missing/damaged: scan all objects for /Type /Page
    if (!pages.length && doc && doc.objs && doc.objs.size > 0) {
      let fallbackBox = null;
      const rescued = [];
      const sortedNums = [...doc.objs.keys()].sort((a, b) => a - b);
      for (const n of sortedNums) {
        const o = doc.objs.get(n);
        if (!o || !o.value || o.value.t !== 'dict') continue;
        const tp = nameOf(get(o.value, 'Type'));
        if (tp === 'Pages' && !fallbackBox && get(o.value, 'MediaBox')) fallbackBox = get(o.value, 'MediaBox');
        if (tp === 'Page' || (!tp && get(o.value, 'Contents') && (get(o.value, 'MediaBox') || get(o.value, 'Resources')))) {
          if (!get(o.value, 'MediaBox')) {
            dictSet(o.value, 'MediaBox', fallbackBox || { t: 'array', v: [numv(0), numv(0), numv(595.28), numv(841.89)] });
          }
          rescued.push({ num: n, dict: o.value });
        }
      }
      pages = rescued;
    }
    if (!pages.length) throw new Error('no pages found — nothing to rebuild');
    const plan = pages.map((p) => ({ doc, num: p.num }));
    return compose(plan, {});
  }

  /* ── PDF → Word: the embedded text layer becomes a real styled .docx ── */
  async function toDocx(bytes, title) {
    const pages = await extractText(bytes);
    const esc = (t) => String(t).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}`
      + (text ? `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>` : '') + '</w:p>';
    const body = [];
    pages.forEach((text, i) => {
      if (i) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      const lines = text ? text.split('\n') : [''];
      lines.forEach((line, li) => {
        const trimmed = line.trim();
        const isHeading = trimmed.length > 0 && trimmed.length <= 72 && (li === 0 && i === 0 || /^(chapter\s+\d+|section\s+\d+|\d+\.\s+[A-Z])/i.test(trimmed));
        body.push(para(line, isHeading ? 'Heading2' : null));
      });
    });
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
</w:styles>`;
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
    const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title || 'Converted document')}</dc:title><dc:creator>ArtViSiON Tools</dc:creator></cp:coreProperties>`;
    const enc = (t) => new TextEncoder().encode(t);
    const zip = await ZipCodec.write([
      { name: '[Content_Types].xml', data: enc(ct) },
      { name: '_rels/.rels', data: enc(rels) },
      { name: 'docProps/core.xml', data: enc(core) },
      { name: 'word/_rels/document.xml.rels', data: enc(docRels) },
      { name: 'word/styles.xml', data: enc(styles) },
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
    let doc = await new Doc(bytes).scan();
    if (!doc.rootNum) throw new Error('not a readable PDF');
    if (doc.encrypted) {
      // Allow adding a real open password to owner-permission-locked PDFs
      const unlocked = await unlock(bytes, '').catch(() => null);
      if (unlocked && unlocked.bytes) {
        bytes = unlocked.bytes;
        doc = await new Doc(bytes).scan();
      }
      if (doc.encrypted) throw new Error('this PDF is already protected — unlock it first');
    }
    const pages = doc.pages().length;
    if (!pages) throw new Error('no pages found');
    const userPw = opts.password || '';
    if (!userPw) throw new Error('choose a password first');
    const perms = opts.perms != null ? opts.perms : -3904;   // print + copy, no edit
    const id = crypto.getRandomValues(new Uint8Array(16));
    let ownerPw = opts.ownerPassword;
    if (!ownerPw) { const b = crypto.getRandomValues(new Uint8Array(16)); ownerPw = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
    const built = await PDFCrypto.buildProtect(userPw, ownerPw, perms, id);

    const hexStr = hexBytes;
    // Write encrypted strings as <hex> so PDF readers never normalize 0x0D (\r) bytes in AES ciphertext
    const walkIn = (owner, v) => {
      if (!v) return v;
      if (v.t === 'str' || v.t === 'hex') {
        const enc = PDFCrypto.encryptBytes(built.crypt, PDFCrypto.valueBytes(v), owner.num, owner.gen || 0);
        return { t: 'hex', raw: '<' + hexStr(enc) + '>' };
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


  /* ── text → PDF: vector WinAnsi layout + native Unicode Canvas layout ── */
  const HELV_W = { ' ':278,'!':278,'"':355,'#':556,'$':556,'%':889,'&':667,"'":191,'(':333,')':333,'*':389,'+':584,',':278,'-':333,'.':278,'/':278,
    '0':556,'1':556,'2':556,'3':556,'4':556,'5':556,'6':556,'7':556,'8':556,'9':556,':':278,';':278,'<':584,'=':584,'>':584,'?':556,'@':1015,
    'A':667,'B':667,'C':722,'D':722,'E':667,'F':611,'G':778,'H':722,'I':278,'J':500,'K':667,'L':556,'M':833,'N':722,'O':778,'P':667,'Q':778,'R':722,
    'S':667,'T':611,'U':722,'V':667,'W':944,'X':667,'Y':667,'Z':611,'[':278,'\\':278,']':278,'^':469,'_':556,'`':333,
    'a':556,'b':556,'c':500,'d':556,'e':556,'f':278,'g':556,'h':556,'i':222,'j':222,'k':500,'l':222,'m':833,'n':556,'o':556,'p':556,'q':556,'r':333,
    's':500,'t':278,'u':556,'v':500,'w':722,'x':500,'y':500,'z':500,'{':334,'|':260,'}':334,'~':584 };
  const W = (ch, mono) => (mono ? 600 : (HELV_W[ch] != null ? HELV_W[ch] : 556)) / 1000;

  function needsUnicodeCanvas(s) {
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code <= 0xFF) continue;
      if (WINANSI_SPECIAL[str[i]] != null || str[i] === '\u20B9') continue;
      return true;
    }
    return false;
  }

  async function unicodeTextToPdf(text, opts = {}) {
    if (typeof ImageOps === 'undefined' || (!self.document && typeof OffscreenCanvas === 'undefined')) {
      if (typeof window === 'undefined' && typeof importScripts === 'function') {
        const e = new Error('NO_CANVAS'); e.code = 'NO_CANVAS'; throw e;
      }
      return null;
    }
    const scale = 2.25; // ~162 DPI crisp A4 text
    const pageW = 595.28, pageH = 841.89;
    const cw = Math.round(pageW * scale), ch = Math.round(pageH * scale);
    const size = (opts.size || 10.5) * scale;
    const leading = (opts.leading || Math.round((opts.size || 10.5) * 1.5 * 10) / 10) * scale;
    const margin = (opts.margin || 56) * scale;
    const maxW = cw - margin * 2;
    const fontStack = opts.mono
      ? `${size.toFixed(1)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
      : `${size.toFixed(1)}px system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans Devanagari", sans-serif`;

    const measureCanvas = ImageOps.canvas(32, 32);
    const mctx = ImageOps.ctx2d(measureCanvas);
    mctx.font = fontStack;
    const wrapped = [];
    for (const rawLine of String(text).split(/\r\n|\r|\n/)) {
      if (!rawLine) { wrapped.push(''); continue; }
      let line = '';
      for (const tok of rawLine.split(/(\s+)/)) {
        const cand = line + tok;
        if (mctx.measureText(cand).width > maxW && line.trim()) {
          wrapped.push(line.replace(/\s+$/, ''));
          line = tok.replace(/^\s+/, '');
          while (mctx.measureText(line).width > maxW && line.length > 1) {
            let cut = 1;
            while (cut < line.length && mctx.measureText(line.slice(0, cut + 1)).width <= maxW) cut++;
            wrapped.push(line.slice(0, cut));
            line = line.slice(cut);
          }
        } else line = cand;
      }
      wrapped.push(line.replace(/\s+$/, ''));
    }
    const perPage = Math.max(1, Math.floor((ch - margin * 2 - 20 * scale) / leading));
    const pages = [];
    for (let i = 0; i < wrapped.length; i += perPage) pages.push(wrapped.slice(i, i + perPage));
    if (!pages.length) pages.push(['']);

    const items = [];
    for (let pi = 0; pi < pages.length; pi++) {
      const c = ImageOps.canvas(cw, ch);
      const ctx = ImageOps.ctx2d(c);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = '#111827';
      ctx.font = fontStack;
      ctx.textBaseline = 'alphabetic';
      let y = margin + size;
      for (const ln of pages[pi]) {
        if (ln) ctx.fillText(ln, margin, y);
        y += leading;
      }
      if (opts.footer !== false) {
        ctx.fillStyle = '#6b7280';
        ctx.font = `${(7.5 * scale).toFixed(1)}px system-ui, sans-serif`;
        ctx.fillText(`${opts.title || ''}  ·  ${pi + 1} / ${pages.length}`, margin, ch - margin + 18 * scale);
      }
      const blob = c.convertToBlob ? await c.convertToBlob({ type: 'image/jpeg', quality: 0.90 }) : await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.90));
      items.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: cw, height: ch });
    }
    return imagesToPdf(items, { pageSize: 'a4', margin: 0 });
  }

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
    if (!Array.isArray(input) && (needsUnicodeCanvas(input) || needsUnicodeCanvas(opts.title))) {
      const uni = await unicodeTextToPdf(input, opts);
      if (uni) return uni;
    }
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

    const lines = Array.isArray(input) ? input : wrapText(String(input), maxW, size, mono);
    const esc = winAnsiEsc;

    const pages = [];
    for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
    if (!pages.length) pages.push(['']);

    const objs = [];
    const addObj2 = (body) => { objs.push(body); return objs.length; };
    const catalogNum = addObj2(null);
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
        content += `BT /F1 7.5 Tf 1 0 0 1 ${margin} ${(margin - 20).toFixed(2)} Tm (${esc(opts.title || '')}  \\267  ${pi + 1} / ${pages.length}) Tj ET\n`;
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
    const cleanText = String(text || '').replace(/^\uFEFF/, '');
    const delim = !cleanText.includes(',') && cleanText.includes(';') ? ';' : ',';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < cleanText.length; i++) {
      const c = cleanText[i];
      if (q) { if (c === '"' && cleanText[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const nonEmpty = rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''));
    if (!nonEmpty.length) throw new Error('the CSV is empty');

    const size = 8.5, pad = 4;
    const cols = Math.max(...nonEmpty.map((r) => r.length));
    const widths = new Array(cols).fill(0);
    for (const r of nonEmpty) for (let c = 0; c < cols; c++) {
      const w = [...(r[c] || '')].reduce((n, ch) => n + W(ch, false) * size, 0) + pad * 2;
      widths[c] = Math.min(180, Math.max(widths[c], w));
    }
    const margin = 40;
    const avail = 595.28 - margin * 2;
    const total = widths.reduce((a, b) => a + b, 0) || 1;
    const scale = total > avail ? avail / total : 1;
    const colW = widths.map((w) => Math.max(18, w * scale));
    const rowH = size * 1.9;
    const perPage = Math.max(2, Math.floor((841.89 - margin * 2 - rowH) / rowH));

    // Native Unicode Canvas table rendering if non-WinAnsi scripts (e.g. Hindi/CJK/Arabic) appear in cells
    if (needsUnicodeCanvas(cleanText)) {
      if (typeof ImageOps === 'undefined' || (!self.document && typeof OffscreenCanvas === 'undefined')) {
        if (typeof window === 'undefined' && typeof importScripts === 'function') {
          const e = new Error('NO_CANVAS'); e.code = 'NO_CANVAS'; throw e;
        }
      } else {
        const sc = 2.25, cw = Math.round(595.28 * sc), ch = Math.round(841.89 * sc);
        const header0 = nonEmpty[0], body0 = nonEmpty.slice(1);
        const chunks0 = [];
        for (let i = 0; i < body0.length; i += perPage - 1) chunks0.push(body0.slice(i, i + perPage - 1));
        if (!chunks0.length) chunks0.push([]);
        const items = [];
        for (let pi = 0; pi < chunks0.length; pi++) {
          const c = ImageOps.canvas(cw, ch);
          const ctx = ImageOps.ctx2d(c);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);
          let y = margin * sc;
          const allRows = [header0, ...chunks0[pi]];
          allRows.forEach((r, ri) => {
            let x = margin * sc;
            for (let ci = 0; ci < cols; ci++) {
              const w = colW[ci] * sc, h = rowH * sc;
              if (ri === 0) { ctx.fillStyle = '#ededed'; ctx.fillRect(x, y, w, h); }
              ctx.strokeStyle = '#b8b8b8'; ctx.lineWidth = Math.max(1, 0.55 * sc);
              ctx.strokeRect(x, y, w, h);
              ctx.fillStyle = '#111827';
              ctx.font = `${ri === 0 ? '600 ' : ''}${(size * sc).toFixed(1)}px system-ui, "Noto Sans", "Noto Sans Devanagari", sans-serif`;
              ctx.save();
              ctx.beginPath(); ctx.rect(x + 2, y + 1, Math.max(2, w - 4), h - 2); ctx.clip();
              ctx.fillText(String(r[ci] == null ? '' : r[ci]), x + pad * sc, y + h - size * 0.55 * sc);
              ctx.restore();
              x += w;
            }
            y += rowH * sc;
          });
          ctx.fillStyle = '#6b7280';
          ctx.font = `${(7 * sc).toFixed(1)}px system-ui, sans-serif`;
          ctx.fillText(`page ${pi + 1} / ${chunks0.length}`, margin * sc, ch - (margin - 18) * sc);
          const blob = c.convertToBlob ? await c.convertToBlob({ type: 'image/jpeg', quality: 0.90 }) : await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.90));
          items.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: cw, height: ch });
        }
        const pdfRes = await imagesToPdf(items, { pageSize: 'a4', margin: 0 });
        return { bytes: pdfRes.bytes, pages: pdfRes.pages, rows: nonEmpty.length, cols };
      }
    }

    const draw = (chunk, first, pageNo, pageCount) => {
      let s = '';
      let y = 841.89 - margin;
      const drawRow = (cells, bold) => {
        let x = margin;
        s += `0.55 w 0.72 0.72 0.72 RG\n`;
        for (let c = 0; c < cols; c++) {
          if (bold) s += `0.93 0.93 0.93 rg ${x.toFixed(2)} ${(y - rowH + 3).toFixed(2)} ${colW[c].toFixed(2)} ${(rowH - 3).toFixed(2)} re f 0 0 0 rg\n`;
          s += `${x.toFixed(2)} ${(y - rowH).toFixed(2)} ${colW[c].toFixed(2)} ${rowH.toFixed(2)} re S\n`;
          const rawVal = String(cells[c] == null ? '' : cells[c]).replace(/[\r\n]+/g, ' ');
          const maxChars = Math.max(1, Math.floor((colW[c] - pad * 2) / (size * 0.5)));
          const clipped = rawVal.length > maxChars ? rawVal.slice(0, Math.max(1, maxChars - 1)) + '.' : rawVal;
          const shown = winAnsiEsc(clipped);
          s += `BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${(x + pad).toFixed(2)} ${(y - rowH + size * 0.72).toFixed(2)} Tm (${shown}) Tj ET\n`;
          x += colW[c];
        }
        y -= rowH;
      };
      if (first) drawRow(chunk[0], true);
      for (const r of (first ? chunk.slice(1) : chunk)) drawRow(r, false);
      s += `BT /F1 7 Tf 1 0 0 1 ${margin} ${(margin - 18).toFixed(2)} Tm (page ${pageNo} / ${pageCount}) Tj ET\n`;
      return s;
    };

    const header = nonEmpty[0], body = nonEmpty.slice(1);
    const chunks = [];
    for (let i = 0; i < body.length; i += perPage - 1) chunks.push(body.slice(i, i + perPage - 1));
    if (!chunks.length) chunks.push([]);
    const streams = [];
    for (let i = 0; i < chunks.length; i++) streams.push(draw([header].concat(chunks[i]), true, i + 1, chunks.length));

    const objs = [];
    const addO = (b) => { objs.push(b); return objs.length; };
    const catNum = addO(null), pagesNum = addO(null);
    const fontNum = addO('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const boldNum = addO('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const s of streams) {
      const z = await Util.deflate(Util.unlatin1(s));
      const cNum = addO(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n${Util.latin1(z)}\nendstream`);
      kids.push(addO(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 ${fontNum} 0 R /F2 ${boldNum} 0 R >> >> /Contents ${cNum} 0 R >>`));
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
    return { bytes, pages: check.pages().length, rows: nonEmpty.length, cols };
  }

  return { merge, select, rotate, reverse, crop, splitEvery, stamp, extractText, extractJpegs, extractImages, imagesToPdf, info, parse, compose, textFromContent, repair, toDocx, unlock, protect, textToPdf, csvToPdf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { PDFEdit };
