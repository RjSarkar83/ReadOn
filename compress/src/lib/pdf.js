/* ══════════════════════════════════════════════════════════════
   pdf.js — a compact, self-contained PDF object engine
   ── scanner for top-level objects + compressed object streams
   ── tokenizer / serializer for PDF values
   ── filter stack (Flate · LZW · AHx · A85 · RunLength · predictors)
   ── reachability garbage-collection of dead objects
   ── stream re-encode + duplicate-stream de-duplication
   ── text-operator removal from content streams & Form XObjects
   ── image XObject recompression hook
   ── clean rebuild of header / xref / trailer
   Runs entirely in the browser. Nothing is uploaded.
   ══════════════════════════════════════════════════════════════ */

const PDFEngine = (() => {
  const DELIM = '()<>[]{}/%';
  const isWS = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

  /* ───────── value parser ───────── */
  function parseValue(s, i) {
    const skip = () => {
      while (i < s.length) {
        const c = s.charCodeAt(i);
        if (isWS(c)) i++;
        else if (s[i] === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; }
        else break;
      }
    };
    skip();
    const c = s[i];
    if (c === undefined) return [null, i];
    if (c === '<' && s[i + 1] === '<') {
      i += 2;
      const dict = {}, order = [];
      for (;;) {
        skip();
        if (i >= s.length) break;
        if (s[i] === '>' && s[i + 1] === '>') { i += 2; break; }
        if (s[i] !== '/') { const r = parseValue(s, i); if (r[1] === i) i++; else i = r[1]; continue; }
        const [key, ni] = parseValue(s, i); i = ni;
        if (!key || key.t !== 'name') { i++; continue; }
        const [val, vi] = parseValue(s, i); i = vi;
        if (!(key.v in dict)) order.push(key.v);
        dict[key.v] = val;
      }
      return [{ t: 'dict', v: dict, order }, i];
    }
    if (c === '<') {
      const end = s.indexOf('>', i + 1);
      if (end < 0) return [null, s.length];
      return [{ t: 'hex', raw: s.slice(i, end + 1) }, end + 1];
    }
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skip();
        if (i >= s.length) break;
        if (s[i] === ']') { i++; break; }
        const before = i;
        const [v, ni] = parseValue(s, i);
        if (ni === before) { i++; continue; }
        i = ni; arr.push(v);
      }
      return [{ t: 'array', v: arr }, i];
    }
    if (c === '(') {
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        const ch = s[j];
        if (ch === '\\') { j++; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
      }
      return [{ t: 'str', raw: s.slice(i, j) }, j];
    }
    if (c === '/') {
      let j = i + 1;
      while (j < s.length && !isWS(s.charCodeAt(j)) && DELIM.indexOf(s[j]) < 0) j++;
      const raw = s.slice(i + 1, j);
      const nm = raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return [{ t: 'name', v: nm, raw }, j];
    }
    let j = i;
    while (j < s.length && !isWS(s.charCodeAt(j)) && DELIM.indexOf(s[j]) < 0) j++;
    const word = s.slice(i, j);
    if (word === '') return [null, i + 1];
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const m = /^[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+R(?![^\x00\t\n\f\r (\[\]<>\/])/.exec(s.slice(j, j + 26));
      if (m) return [{ t: 'ref', n: +word, g: +m[1] }, j + m[0].length];
      return [{ t: 'num', raw: word, v: parseFloat(word) }, j];
    }
    if (word === 'true') return [{ t: 'bool', v: true }, j];
    if (word === 'false') return [{ t: 'bool', v: false }, j];
    if (word === 'null') return [{ t: 'null' }, j];
    return [{ t: 'kw', v: word }, j];
  }

  function ser(v) {
    if (v == null) return 'null';
    switch (v.t) {
      case 'name': return '/' + (v.raw != null ? v.raw : v.v.replace(/[^!-~]|[()<>\[\]{}/%#]/g, (ch) => '#' + ch.charCodeAt(0).toString(16).padStart(2, '0')));
      case 'num': return v.raw != null ? v.raw : String(v.v);
      case 'str': return v.raw;
      case 'hex': return v.raw;
      case 'bool': return v.v ? 'true' : 'false';
      case 'null': return 'null';
      case 'ref': return `${v.n} ${v.g} R`;
      case 'array': return '[' + v.v.map(ser).join(' ') + ']';
      case 'dict': {
        const keys = v.order && v.order.length ? v.order : Object.keys(v.v);
        return '<<' + keys.map(k => '/' + k + ' ' + ser(v.v[k])).join(' ') + '>>';
      }
      case 'kw': return v.v;
      default: return 'null';
    }
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }

  const get = (d, k) => (d && d.t === 'dict' ? d.v[k] : undefined);
  const num = (v, d = 0) => (v && v.t === 'num' ? v.v : d);
  const refOf = (v) => (v && v.t === 'ref' ? v.n : null);
  const nameOf = (v) => (v && v.t === 'name' ? v.v : null);
  const dictSet = (d, k, v) => { if (!(k in d.v)) d.order.push(k); d.v[k] = v; };
  const dictDel = (d, k) => { delete d.v[k]; d.order = d.order.filter(x => x !== k); };

  /* ───────── content-stream tokenizer ───────── */
  function scanTokens(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (isWS(s.charCodeAt(i))) { i++; continue; }
      if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      if (c === '(') {
        const st = i; let d = 0;
        for (; i < s.length; i++) {
          const ch = s[i];
          if (ch === '\\') { i++; continue; }
          if (ch === '(') d++;
          else if (ch === ')') { d--; if (d === 0) { i++; break; } }
        }
        toks.push({ k: 'str', s: st, e: i }); continue;
      }
      if (c === '<' && s[i + 1] !== '<') {
        const st = i, en = s.indexOf('>', i);
        i = en < 0 ? s.length : en + 1;
        toks.push({ k: 'str', s: st, e: i }); continue;
      }
      if (c === '[' || c === ']' || c === '<' || c === '>' || c === '{' || c === '}') {
        if (c === '<' && s[i + 1] === '<') { toks.push({ k: 'delim', s: i, e: i + 2, v: '<<' }); i += 2; continue; }
        if (c === '>' && s[i + 1] === '>') { toks.push({ k: 'delim', s: i, e: i + 2, v: '>>' }); i += 2; continue; }
        toks.push({ k: 'delim', s: i, e: i + 1, v: c }); i++; continue;
      }
      if (c === '/') {
        const st = i; i++;
        while (i < s.length && !isWS(s.charCodeAt(i)) && DELIM.indexOf(s[i]) < 0) i++;
        toks.push({ k: 'name', s: st, e: i }); continue;
      }
      const st = i;
      while (i < s.length && !isWS(s.charCodeAt(i)) && DELIM.indexOf(s[i]) < 0) i++;
      if (i === st) { i++; continue; }
      toks.push({ k: 'word', s: st, e: i, v: s.slice(st, i) });
    }
    return toks;
  }

  /* remove every BT…ET block that paints glyphs; keep the rest byte-identical */
  function stripTextOps(s) {
    const toks = scanTokens(s);
    const drops = [];
    let bt = -1, hasText = false, changed = false;
    for (let t = 0; t < toks.length; t++) {
      const tk = toks[t];
      if (tk.k !== 'word') continue;
      const w = tk.v;
      if (w === 'BI') { // inline image: skip to EI
        for (let u = t + 1; u < toks.length; u++) if (toks[u].k === 'word' && toks[u].v === 'EI') { t = u; break; }
        continue;
      }
      if (w === 'BT') { bt = tk.s; hasText = false; continue; }
      if (w === 'ET') {
        if (bt >= 0 && hasText) { drops.push([bt, tk.e]); changed = true; }
        bt = -1; hasText = false; continue;
      }
      if (bt >= 0 && (w === 'Tj' || w === 'TJ' || w === "'" || w === '"' || w === 'Do' && false)) hasText = true;
    }
    if (!changed) return { text: s, changed: false };
    let out = '', p = 0;
    for (const [a, b] of drops) { out += s.slice(p, a) + (a > 0 && s[a - 1] === ' ' ? ' ' : ' '); p = b; }
    out += s.slice(p);
    return { text: out, changed: true };
  }

  /* ─── content-stream number trimmer ───
     Word/LaTeX write positions with 6 decimals ("12.3456789") and a comment per
     operator. Rounding to 4 decimals (0.0001 of a unit = invisible) plus dropping
     the comments and collapsing whitespace is bit-exact for the page geometry and
     shrinks text pages by 5–20 % before deflate even runs. */
  const NUMRE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
  /* Exact-only rewriting: the numeric value never changes, we just stop paying for
     trailing zeros, leading zeros and an explicit "+" — "000.500000" → ".5". */
  function shortenNum(tok) {
    let neg = false, t = tok;
    if (t[0] === '+') t = t.slice(1);
    if (t[0] === '-') { neg = true; t = t.slice(1); }
    if (!NUMRE.test(t)) return tok;
    let a = t, b = '';
    const dot = t.indexOf('.');
    if (dot >= 0) { a = t.slice(0, dot) || '0'; b = t.slice(dot + 1).replace(/0+$/, ''); }
    a = a.replace(/^0+(?=\d)/, '');
    if (a === '') a = '0';
    const out = b ? (a === '0' ? '.' + b : a + '.' + b) : a;
    if (out === '0') neg = false;
    return (neg ? '-' : '') + out;
  }
  function trimContent(s) {
    const toks = scanTokens(s);
    const parts = [];
    let changed = false;
    for (const t of toks) {
      if (t.k === 'word') {
        if (t.v === 'BI') return null;                     // inline image payload: hands off
        if (NUMRE.test(t.v)) {
          const short = shortenNum(t.v);
          if (short !== t.v) changed = true;
          parts.push(short);
        } else parts.push(t.v);
      } else parts.push(s.slice(t.s, t.e));
    }
    if (!changed) return null;
    return parts.join(' ');
  }

  /* ───────── document ───────── */
  const hexToBytes = (h) => {
    const n = h.length >> 1, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16) || 0;
    return out;
  };

  class Doc {
    constructor(bytes) {
      this.bytes = bytes;
      this.text = Util.latin1(bytes);
      this.objs = new Map();
      this.rootNum = null;
      this.encrypted = false;
      this.version = '1.7';
      this.crypt = null;        // { kind:'rc4'|'aesv2'|'aesv3', key, encryptRef }
      this.fileId = null;       // first /ID element (bytes)
      this.encryptNum = null;   // object number of the /Encrypt dictionary
    }

    /* stream bytes as stored — decrypted on the fly when this.crypt is set */
    decryptStream(o) {
      const raw = this.bytes.subarray(o.sS, o.sE);
      return PDFCrypto.decryptBytes(this.crypt, raw, o.num, o.gen || 0);
    }

    async scan() {
      const text = this.text;
      const re = /(\d{1,10})[\x00\t\n\f\r ]+(\d{1,5})[\x00\t\n\f\r ]+obj\b/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const num0 = +m[1], gen = +m[2];
        const bodyStart = re.lastIndex;
        let eo = text.indexOf('endobj', bodyStart);
        let st = text.indexOf('stream', bodyStart);
        if (st >= 0 && text.slice(Math.max(0, st - 3), st) === 'end') st = text.indexOf('stream', st + 9);
        let endPos, dictRaw, value, sS = null, sE = null;
        if (st >= 0 && (eo < 0 || st < eo)) {
          dictRaw = text.slice(bodyStart, st);
          try { value = parseValue(dictRaw, 0)[0]; } catch (e) { value = null; }
          let s0 = st + 6;
          if (text[s0] === '\r') s0++;
          if (text[s0] === '\n') s0++;
          let s1 = -1;
          const lenV = get(value, 'Length');
          if (lenV && lenV.t === 'num') {
            const cand = s0 + lenV.v;
            const probe = text.slice(cand, cand + 14).replace(/^[\r\n]+/, '');
            if (probe.startsWith('endstream')) s1 = cand;
          }
          let exact = false;
          if (s1 < 0) {
            const es = text.indexOf('endstream', s0);
            s1 = es < 0 ? text.length : es;
          } else exact = true;
          let e = s1;
          if (!exact) {
            if (text[e - 1] === '\n') e--;
            if (text[e - 1] === '\r') e--;
          }
          sS = s0; sE = e;
          const esIdx = text.indexOf('endstream', s1);
          const eoIdx = esIdx >= 0 ? text.indexOf('endobj', esIdx + 9) : -1;
          endPos = eoIdx >= 0 ? eoIdx + 6 : (esIdx >= 0 ? esIdx + 9 : text.length);
        } else {
          dictRaw = text.slice(bodyStart, eo >= 0 ? eo : text.length);
          try { value = parseValue(dictRaw, 0)[0]; } catch (e) { value = null; }
          endPos = eo >= 0 ? eo + 6 : text.length;
        }
        this.objs.set(num0, { num: num0, gen, dictRaw, value, sS, sE, dirty: false });
        re.lastIndex = Math.max(re.lastIndex, endPos);
      }

      // expand object streams (compressed object storage)
      this.hadObjStm = false;
      for (const o of [...this.objs.values()]) {
        if (o.sS == null) continue;
        if (nameOf(get(o.value, 'Type')) !== 'ObjStm') continue;
        this.hadObjStm = true;
        await this.expandObjStm(o);
      }
      if (/\/Type\s*\/XRef/.test(this.text)) this.hadObjStm = true;

      for (const o of this.objs.values()) {
        if (nameOf(get(o.value, 'Type')) === 'Catalog') this.rootNum = o.num;
      }
      if (!this.rootNum) {
        const m2 = /\/Root[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+R/.exec(text);
        if (m2) this.rootNum = +m2[1];
      }
      const encM = /\/Encrypt[\x00\t\n\f\r ]+(?:(\d+)[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+R|<<)/.exec(text);
      this.encrypted = !!encM;
      if (encM && encM[1]) this.encryptNum = +encM[1];
      const idM = /\/ID[\x00\t\n\f\r ]*\[[\x00\t\n\f\r ]*<([0-9A-Fa-f\s]*)>/.exec(text);
      if (idM) this.fileId = hexToBytes(idM[1].replace(/\s+/g, ''));
      const vm = /^%PDF-(\d\.\d)/.exec(text);
      if (vm) this.version = vm[1];
      return this;
    }

    async expandObjStm(o) {
      const filters = get(o.value, 'Filter');
      const parms = get(o.value, 'DecodeParms');
      const fl = PDFFilters.normFilters(filters);
      if (!fl.length || fl.some(f => f !== 'FlateDecode' && f !== 'Fl')) return;
      const data = await PDFFilters.decode(this.streamBytes(o), filters, parms);
      if (!data) return;
      const n = num(get(o.value, 'N'));
      const first = num(get(o.value, 'First'));
      const s = Util.latin1(data);
      const head = s.slice(0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k < n; k++) {
        const onum = head[k * 2], off = head[k * 2 + 1];
        if (!isFinite(onum) || !isFinite(off)) continue;
        const nextOff = k + 1 < n ? head[(k + 1) * 2 + 1] : (s.length - first);
        const body = s.slice(first + off, first + nextOff);
        let val = null;
        try { val = parseValue(body, 0)[0]; } catch (e) { continue; }
        if (this.objs.has(onum)) continue;
        this.objs.set(onum, { num: onum, gen: 0, dictRaw: body.trim(), value: val, sS: null, sE: null, dirty: false, fromObjStm: true });
      }
    }

    streamBytes(o) {
      if (!o || o.sS == null) return null;
      if (this.crypt && o.num !== this.encryptNum) return this.decryptStream(o);
      return this.bytes.subarray(o.sS, o.sE);
    }
    obj(n) { return this.objs.get(n); }
    dictOf(n) { const o = this.objs.get(n); return o && o.value && o.value.t === 'dict' ? o.value : null; }

    resolve(v, depth = 0) {
      if (!v) return null;
      if (v.t === 'ref') {
        if (depth > 16) return null;
        const o = this.objs.get(v.n);
        return o ? this.resolve(o.value, depth + 1) : null;
      }
      return v;
    }

    pages() {
      const out = [], seen = new Set();
      const walk = (num0, inherited, depth) => {
        if (num0 == null || seen.has(num0) || depth > 64) return;
        seen.add(num0);
        const d = this.dictOf(num0);
        if (!d) return;
        const type = nameOf(get(d, 'Type'));
        const res = get(d, 'Resources') || inherited;
        const isLeaf = type === 'Page' || (type == null && !get(d, 'Kids'));
        if (!isLeaf) {
          const kidsV = get(d, 'Kids');
          const arr = kidsV ? this.resolve(kidsV) : null;
          if (arr && arr.t === 'array') {
            for (const k of arr.v) walk(refOf(k), res, depth + 1);
            return;
          }
        }
        out.push({ num: num0, dict: d, resources: res });
      };
      const root = this.dictOf(this.rootNum);
      if (root) walk(refOf(get(root, 'Pages')), null, 0);
      return out;
    }

    refsIn(text) {
      const set = new Set();
      const re = /(\d{1,10})[\x00\t\n\f\r ]+(\d{1,5})[\x00\t\n\f\r ]+R(?![^\x00\t\n\f\r (\[\]<>\/])/g;
      let m;
      while ((m = re.exec(text)) !== null) set.add(+m[1]);
      return set;
    }
  }

  /* ───────── serialization ───────── */
  function withLength(dictStr, len) {
    let d = dictStr.replace(/\/Length(?![0-9A-Za-z#])[\x00\t\n\f\r ]+(\d+[\x00\t\n\f\r ]+\d+[\x00\t\n\f\r ]+R|[-+]?[\d.]+)/g, '');
    d = d.replace(/[\x00\t\n\f\r ]+/g, ' ').trim();
    if (d.endsWith('>>')) return d.slice(0, -2).trimEnd() + ` /Length ${len} >>`;
    return d + ` /Length ${len}`;
  }

  function serialize(doc, live) {
    const parts = [];
    const enc = (str) => Util.unlatin1(str);
    const header = '%PDF-' + doc.version + '\n%\u00E2\u00E3\u00CF\u00D3\n';
    parts.push(enc(header));
    const offsets = new Map();
    let pos = parts[0].length;
    const nums = [...live].sort((a, b) => a - b);
    for (const n of nums) {
      const o = doc.objs.get(n);
      if (!o) continue;
      let dictStr;
      if (o.dirty || !o.dictRaw) dictStr = ser(o.value);
      else dictStr = o.dictRaw.trim();
      let bytes;
      if (o.newStream != null || o.sS != null) {
        const body = o.newStream != null ? o.newStream : doc.streamBytes(o);
        const head = `${o.num} ${o.gen || 0} obj\n${withLength(dictStr, body.length)}\nstream\n`;
        bytes = Util.concat([enc(head), body, enc('\nendstream\nendobj\n')]);
      } else {
        bytes = enc(`${o.num} ${o.gen || 0} obj\n${dictStr}\nendobj\n`);
      }
      offsets.set(n, pos);
      parts.push(bytes);
      pos += bytes.length;
    }
    const xrefStart = pos;
    const maxNum = nums.length ? nums[nums.length - 1] : 0;
    let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= maxNum; i++) {
      if (offsets.has(i)) xref += String(offsets.get(i)).padStart(10, '0') + ' ' + String(doc.objs.get(i).gen || 0).padStart(5, '0') + ' n \n';
      else xref += '0000000000 65535 f \n';
    }
    const info = doc.infoNum ? ` /Info ${doc.infoNum} 0 R` : '';
    const encRef = doc.encryptNum ? ` /Encrypt ${doc.encryptNum} 0 R` : '';
    const idStr = doc.fileId ? ` /ID [<${Util.bytesToHex(doc.fileId)}> <${Util.bytesToHex(doc.fileId)}>]` : '';
    const trailer = `trailer\n<< /Size ${maxNum + 1} /Root ${doc.rootNum} 0 R${info}${encRef}${idStr} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    parts.push(enc(xref + trailer));
    return Util.concat(parts);
  }


  /* ── modern writer: object streams + cross-reference stream (PDF 1.5+)
     Keeps every object number stable, packs stream-less objects into one
     Flate-compressed ObjStm and emits an /XRef stream. Usually 20-40 %
     smaller than a classic rebuild on files produced by modern tools. */
  async function serializeModern(doc, live) {
    const enc = (str) => Util.unlatin1(str);
    const parts = [];
    const header = '%PDF-1.5\n%\u00E2\u00E3\u00CF\u00D3\n';
    parts.push(enc(header));
    let pos = parts[0].length;

    const nums = [...live].sort((a, b) => a - b);
    const streamNums = [], packNums = [];
    for (const n of nums) {
      const o = doc.objs.get(n);
      if (!o) continue;
      const packable = o.sS == null && o.newStream == null && (o.gen || 0) === 0 &&
        o.value && (o.value.t === 'dict' || o.value.t === 'array') &&
        (!o.dictRaw || o.dictRaw.length < 65536);
      if (packable) packNums.push(n); else streamNums.push(n);
    }

    const offsets = new Map();     // num -> {type:1, offset, gen}
    const packedIdx = new Map();   // num -> index in objstm

    // 1 — direct objects (with or without streams)
    for (const n of streamNums) {
      const o = doc.objs.get(n);
      const dictStr = o.dirty || !o.dictRaw ? ser(o.value) : o.dictRaw.trim();
      let bytes;
      if (o.newStream != null || o.sS != null) {
        const body = o.newStream != null ? o.newStream : doc.streamBytes(o);
        bytes = Util.concat([enc(`${n} ${o.gen || 0} obj\n${withLength(dictStr, body.length)}\nstream\n`), body, enc('\nendstream\nendobj\n')]);
      } else {
        bytes = enc(`${n} ${o.gen || 0} obj\n${dictStr}\nendobj\n`);
      }
      offsets.set(n, { type: 1, offset: pos, gen: o.gen || 0 });
      parts.push(bytes);
      pos += bytes.length;
    }

    // 2 — packed objects → one ObjStm
    let objStmNum = null;
    if (packNums.length) {
      let headerPairs = '', body = '';
      packNums.forEach((n, i) => {
        const o = doc.objs.get(n);
        const dictStr = o.dirty || !o.dictRaw ? ser(o.value) : o.dictRaw.trim();
        headerPairs += n + ' ' + body.length + ' ';
        body += dictStr + '\n';
        packedIdx.set(n, i);
      });
      const raw = Util.unlatin1(headerPairs + body);   // byte-exact offsets
      const z = await Util.deflate(raw);
      objStmNum = Math.max(...nums, 0) + 1;
      const dict = `<< /Type /ObjStm /N ${packNums.length} /First ${headerPairs.length} /Filter /FlateDecode /Length ${z.length} >>`;
      const bytes = Util.concat([enc(`${objStmNum} 0 obj\n${dict}\nstream\n`), z, enc('\nendstream\nendobj\n')]);
      offsets.set(objStmNum, { type: 1, offset: pos, gen: 0 });
      parts.push(bytes);
      pos += bytes.length;
    }

    // 3 — cross-reference stream
    const xrefNum = Math.max(...(objStmNum != null ? [...nums, objStmNum] : nums), 0) + 1;
    const size = xrefNum + 1;
    const rows = new Uint8Array(size * 7);
    const dv = new DataView(rows.buffer);
    dv.setUint8(0, 0); dv.setUint32(1, 0); dv.setUint16(5, 0xFFFF);
    for (let i = 1; i < size; i++) {
      const off = i * 7;
      const direct = offsets.get(i);
      if (direct) { dv.setUint8(off, 1); dv.setUint32(off + 1, direct.offset); dv.setUint16(off + 5, direct.gen); }
      else if (packedIdx.has(i)) { dv.setUint8(off, 2); dv.setUint32(off + 1, objStmNum); dv.setUint16(off + 5, packedIdx.get(i)); }
      else { dv.setUint8(off, 0); dv.setUint32(off + 1, 0); dv.setUint16(off + 5, 0xFFFF); }
    }
    const zx = await Util.deflate(rows);
    const xrefStart = pos;
    const encRef2 = doc.encryptNum ? ` /Encrypt ${doc.encryptNum} 0 R` : '';
    const idStr2 = doc.fileId ? ` /ID [<${Util.bytesToHex(doc.fileId)}> <${Util.bytesToHex(doc.fileId)}>]` : '';
    const xdict = `<< /Type /XRef /Size ${size} /W [1 4 2] /Root ${doc.rootNum} 0 R${encRef2}${idStr2} /Filter /FlateDecode /Length ${zx.length} >>`;
    parts.push(Util.concat([enc(`${xrefNum} 0 obj\n${xdict}\nstream\n`), zx, enc('\nendstream\nendobj\n')]));
    parts.push(enc(`startxref\n${xrefStart}\n%%EOF\n`));
    return Util.concat(parts);
  }

  /* ───────── analysis ───────── */
  async function analyze(bytes) {
    const doc = await new Doc(bytes).scan();
    const pages = doc.pages();
    let images = 0, imageBytes = 0, fontBytes = 0, metaBytes = 0, streams = 0, objStm = 0;
    for (const o of doc.objs.values()) {
      const d = o.value;
      if (!d || d.t !== 'dict') continue;
      if (nameOf(get(d, 'Type')) === 'ObjStm') objStm++;
      if (o.sS != null) streams++;
      if (nameOf(get(d, 'Subtype')) === 'Image') { images++; imageBytes += (o.sE - o.sS); }
      if (nameOf(get(d, 'Type')) === 'Metadata') metaBytes += (o.sE - o.sS);
      if (nameOf(get(d, 'Type')) === 'Font' || get(d, 'FontDescriptor')) {
        const fd = doc.resolve(get(d, 'FontDescriptor'));
        for (const k of ['FontFile', 'FontFile2', 'FontFile3']) {
          const r = refOf(get(fd, k));
          if (r != null) { const fo = doc.obj(r); if (fo && fo.sS != null) fontBytes += fo.sE - fo.sS; }
        }
      }
    }
    return {
      pages: pages.length, images, imageBytes, fontBytes, metaBytes, streams, objStm,
      encrypted: doc.encrypted, version: doc.version, objects: doc.objs.size, doc
    };
  }

  /* ───────── the optimiser ───────── */
  async function optimize(bytes, opts = {}) {
    const warnings = [];
    const T = opts.timing ? {} : null;
    let tMark = Date.now();
    const mark = (k) => { if (T) { T[k] = Date.now() - tMark; tMark = Date.now(); } };
    const doc = await new Doc(bytes).scan();
    mark('parse');
    if (!doc.rootNum) return { bytes, stats: {}, warnings: ['No PDF catalog found — file left untouched.'] };
    if (doc.encrypted) {
      return { bytes, stats: {}, warnings: ['Password-protected PDF: content streams are encrypted, so nothing can be safely rewritten. Remove the password first.'] };
    }
    const before = { objects: doc.objs.size, pages: doc.pages().length };
    const stats = { images: 0, imagesRecompressed: 0, imagesLossy: 0, imageBytesBefore: 0, imageBytesAfter: 0, streamsRecompressed: 0, textStripped: 0, duplicates: 0, fonts: 0 };

    /* 1 ─ catalog / page metadata */
    const root = doc.dictOf(doc.rootNum);
    if (root) {
      for (const k of ['Metadata', 'PieceInfo', 'LastModified', 'MarkInfo', 'OutputIntents', 'Perms', 'Legal', 'Collection']) {
        if (k in root.v) { dictDel(root, k); root.dirty = true; }
      }
      if (opts.stripStructure && ('StructTreeRoot' in root.v)) { dictDel(root, 'StructTreeRoot'); }
      if (opts.stripBookmarks && ('Outlines' in root.v)) { dictDel(root, 'Outlines'); }
      if (opts.stripAnnots && ('AcroForm' in root.v)) { dictDel(root, 'AcroForm'); }
      if (opts.stripForms && ('XFA' in root.v)) { dictDel(root, 'XFA'); }
      if (opts.stripAttachments) {
        if ('Names' in root.v) {
          const names = doc.resolve(get(root, 'Names'));
          if (names && names.t === 'dict') { dictDel(names, 'EmbeddedFiles'); if (!names.order.length) dictDel(root, 'Names'); }
        }
        if ('AF' in root.v) dictDel(root, 'AF');
        if ('PageLabels' in root.v && opts.stripBookmarks) dictDel(root, 'PageLabels');
      }
      root.dirty = true;
    }

    const pages = doc.pages();
    for (const p of pages) {
      const d = p.dict;
      if (opts.thumbnails !== false && ('Thumb' in d.v)) { dictDel(d, 'Thumb'); d.dirty = true; }
      if ('PieceInfo' in d.v) { dictDel(d, 'PieceInfo'); d.dirty = true; }
      if ('LastModified' in d.v) { dictDel(d, 'LastModified'); d.dirty = true; }
      if (opts.stripAnnots || opts.stripStructure) {
        if ('Annots' in d.v) { dictDel(d, 'Annots'); d.dirty = true; }
      }
    }

    /* 2 ─ text removal from content streams + form XObjects */
    if (opts.stripText) {
      const contentRefs = new Set();
      for (const p of pages) {
        const c = get(p.dict, 'Contents');
        if (!c) continue;
        if (c.t === 'ref') contentRefs.add(c.n);
        else if (c.t === 'array') for (const r of c.v) { const n0 = refOf(r); if (n0 != null) contentRefs.add(n0); }
      }
      for (const o of doc.objs.values()) {
        if (nameOf(get(o.value, 'Subtype')) === 'Form') contentRefs.add(o.num);
      }
      for (const n0 of contentRefs) {
        const o = doc.obj(n0);
        if (!o || o.sS == null) continue;
        const filters = get(o.value, 'Filter');
        const fl = PDFFilters.normFilters(filters);
        if (fl.some(f => !['FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'RunLengthDecode', 'RL'].includes(f))) continue;
        const data = await PDFFilters.decode(doc.streamBytes(o), filters, get(o.value, 'DecodeParms'));
        if (!data) continue;
        const s = Util.latin1(data);
        const res = stripTextOps(s);
        if (!res.changed) continue;
        const enc = Util.utf8(res.text);
        const z = await Util.deflate(enc);
        o.newStream = z.length < (o.sE - o.sS) ? z : enc;
        dictSet(o.value, 'Filter', { t: 'name', v: 'FlateDecode', raw: 'FlateDecode' });
        dictDel(o.value, 'DecodeParms');
        o.dirty = true;
        stats.textStripped++;
      }
      // glyph sources become unreachable once no text is painted
      const clearFonts = (resV) => {
        const res = doc.resolve(resV);
        if (!res || res.t !== 'dict') return;
        if ('Font' in res.v) { dictDel(res, 'Font'); res.dirty = true; }
        // the dict may belong to a shared object: clone-on-write for page-level safety
      };
      for (const p of pages) {
        if (p.resources) {
          if (p.resources.t === 'ref') { const r = doc.dictOf(p.resources.n); if (r) clearFonts(p.resources); }
          else clearFonts(p.resources);
        }
      }
      for (const o of doc.objs.values()) {
        if (nameOf(get(o.value, 'Subtype')) === 'Form') clearFonts(get(o.value, 'Resources'));
      }
    }

    mark('structure+streams');
    /* 3 ─ collect raster XObjects (encoding happens later, inside the size budget) */
    const imageJobs = [];
    if (opts.imageLevels && opts.imageEncode && opts.imageLevels.length) {
      for (const o of doc.objs.values()) {
        const d = o.value;
        if (!d || d.t !== 'dict' || o.sS == null) continue;
        if (nameOf(get(d, 'Subtype')) !== 'Image') continue;
        const filterV = get(d, 'Filter');
        const fl = PDFFilters.normFilters(filterV);
        const last = fl.length ? fl[fl.length - 1] : null;
        const kind = last === 'DCTDecode' ? 'jpeg' : last === 'JPXDecode' ? 'jp2'
          : (!fl.length || fl.every(f => ['FlateDecode', 'Fl', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode'].includes(f))) ? 'raw' : 'other';
        if (kind === 'jp2' || kind === 'other') continue;
        const w = num(get(d, 'Width')), h = num(get(d, 'Height'));
        if (!w || !h || w * h < 1600) continue;
        const rawStream = doc.streamBytes(o);
        let payload = rawStream;
        if (kind === 'jpeg' && fl.length > 1) {
          const pre = await PDFFilters.decode(rawStream, fl.slice(0, -1), get(d, 'DecodeParms'));
          if (pre) payload = pre;
        }
        imageJobs.push({
          obj: o, dict: d, kind, bytes: payload, rawStream, filters: fl,
          width: w, height: h, streamLen: rawStream.length,
          bpc: num(get(d, 'BitsPerComponent'), 8),
          colorSpace: nameOf(get(d, 'ColorSpace')) || (get(d, 'ColorSpace') && get(d, 'ColorSpace').t === 'array' ? 'array' : 'other'),
          decodeParms: get(d, 'DecodeParms'),
          hasSMask: !!get(d, 'SMask') || !!get(d, 'Mask'),
          objNum: o.num
        });
        stats.images++;
        stats.imageBytesBefore += rawStream.length;
      }
    }

    mark('images');

    /* 3b ─ content streams: which objects paint the page (used by the number
            trimmer below and by the unused-font pruner further down) */
    const contentObjs = new Set();
    for (const p of pages) {
      const c = get(p.dict, 'Contents');
      if (!c) continue;
      if (c.t === 'ref') contentObjs.add(c.n);
      else if (c.t === 'array') for (const r of c.v) { const n0 = refOf(r); if (n0 != null) contentObjs.add(n0); }
    }
    for (const o of doc.objs.values()) {
      if (o.sS != null && nameOf(get(o.value, 'Subtype')) === 'Form') contentObjs.add(o.num);
    }

    /* 3c ─ embedded fonts: drop hinting / device-metric / strike tables.
            The outlines, metrics and cmap are untouched, so the page renders the
            same; it is the single biggest win on text-heavy PDFs. */
    if (opts.trimFonts !== false) {
      const fontJobs = [];
      for (const o of doc.objs.values()) {
        if (o.sS == null || o.newStream != null || o.dirty) continue;
        const d = o.value;
        if (!d || d.t !== 'dict' || get(d, 'Length1') == null) continue;
        fontJobs.push(o);
      }
      await mapLimit(fontJobs, 8, async (o) => {
        const d = o.value;
        const raw = doc.streamBytes(o);
        const fl = PDFFilters.normFilters(get(d, 'Filter'));
        const ok = fl.every(f => ['FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'RunLengthDecode', 'RL'].includes(f));
        if (!ok) return;
        const data = fl.length ? await PDFFilters.decode(raw, get(d, 'Filter'), get(d, 'DecodeParms')) : raw;
        if (!data || data.length < 512) return;
        const r = FontCodec.optimize(data);
        if (!r || r.bytes.length > data.length * 0.995) return;
        const z = await Util.deflate(r.bytes);
        if (z.length >= raw.length && r.bytes.length >= data.length) return;
        o.newStream = z;
        dictSet(d, 'Filter', { t: 'name', v: 'FlateDecode', raw: 'FlateDecode' });
        dictDel(d, 'DecodeParms');
        dictSet(d, 'Length1', { t: 'num', raw: String(r.bytes.length), v: r.bytes.length });
        o.dirty = true;
        stats.fontsTrimmed = (stats.fontsTrimmed || 0) + 1;
        stats.fontBytesSaved = (stats.fontBytesSaved || 0) + (raw.length - z.length);
      });
    }

    /* 4 ─ re-encode remaining uncompressed / lightly compressed streams
           (independent per object → run them concurrently instead of one by one) */
    const streamJobs = [];
    for (const o of doc.objs.values()) {
      if (o.sS == null || o.newStream != null || o.dirty) continue;
      const d = o.value;
      if (!d || d.t !== 'dict') continue;
      if (nameOf(get(d, 'Subtype')) === 'Image') continue;
      if (nameOf(get(d, 'Type')) === 'ObjStm' || nameOf(get(d, 'Type')) === 'XRef') continue;
      const filterV = get(d, 'Filter');
      const fl = PDFFilters.normFilters(filterV);
      const decodable = fl.every(f => ['FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'RunLengthDecode', 'RL'].includes(f));
      if (!decodable) continue;
      streamJobs.push({ o, d, fl, filterV });
    }

    const bigDoc = streamJobs.length > 150;
    const reencode = async ({ o, d, fl, filterV }) => {
      const raw = doc.streamBytes(o);
      // on documents with hundreds of streams, tiny ones cost more time than they save
      if (bigDoc && fl.length && raw.length < 900) return;
      if (fl.length === 0) {
        if (raw.length < 64) return;
        const z = await Util.deflate(raw);
        if (z.length < raw.length * 0.97) {
          o.newStream = z; dictSet(d, 'Filter', { t: 'name', v: 'FlateDecode', raw: 'FlateDecode' }); o.dirty = true; stats.streamsRecompressed++;
        }
        return;
      }
      const data = await PDFFilters.decode(raw, filterV, get(d, 'DecodeParms'));
      if (!data) return;
      let body = data;
      if (contentObjs.has(o.num) && opts.trimNumbers !== false) {
        const trimmed = trimContent(Util.latin1(data));
        if (trimmed && trimmed.length < data.length) {
          body = Util.unlatin1(trimmed);
          stats.numbersTrimmed = (stats.numbersTrimmed || 0) + 1;
        }
      }
      const z = await Util.deflate(body);
      const stripParms = fl.some(f => f !== 'FlateDecode' && f !== 'Fl');
      if (z.length < raw.length || stripParms) {
        o.newStream = z;
        dictSet(d, 'Filter', { t: 'name', v: 'FlateDecode', raw: 'FlateDecode' });
        dictDel(d, 'DecodeParms');
        o.dirty = true;
        if (z.length < raw.length) stats.streamsRecompressed++;
      }
    };
    await mapLimit(streamJobs, 12, reencode);

        mark('streams');

    /* 4b ─ prune fonts no content stream ever selects with /Name Tf.
            Word and Pages routinely embed a dozen fonts for two used ones. */
    if (opts.pruneFonts !== false && contentObjs.size && contentObjs.size <= 300) {
      const usedNames = new Set();
      let complete = true;
      await mapLimit([...contentObjs], 12, async (n0) => {
        const o = doc.obj(n0);
        if (!o || o.sS == null) return;
        const raw = doc.streamBytes(o);
        const fl = PDFFilters.normFilters(get(o.value, 'Filter'));
        const ok = fl.every(f => ['FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'RunLengthDecode', 'RL'].includes(f));
        if (!ok) { complete = false; return; }
        const data = fl.length ? await PDFFilters.decode(raw, get(o.value, 'Filter'), get(o.value, 'DecodeParms')) : raw;
        if (!data) { complete = false; return; }
        // linear token walk: `/Name size Tf` — no regex backtracking on big streams
        if (data.length > 1.5e6) { complete = false; return; }   // huge vector layer: cannot audit safely
        const str = Util.latin1(data);
        if (str.indexOf('Tf') < 0) return;                  // cheap reject before tokenising
        const toks = scanTokens(str);
        for (let i = 2; i < toks.length; i++) {
          const t = toks[i];
          if (t.k !== 'word' || t.v !== 'Tf') continue;
          if (toks[i - 1].k !== 'word' || !NUMRE.test(toks[i - 1].v || '')) continue;
          const nm = toks[i - 2];
          if (nm.k === 'name') usedNames.add(str.slice(nm.s + 1, nm.e));
        }
      });
      // only prune when every stream was audited — a partial scan could orphan a live font
      if (usedNames.size && complete) {
        const pruneRes = (resV) => {
          const res = doc.resolve(resV);
          if (!res || res.t !== 'dict') return;
          const fonts = doc.resolve(get(res, 'Font'));
          if (!fonts || fonts.t !== 'dict') return;
          let removed = 0;
          for (const k of fonts.order.slice()) {
            if (usedNames.has(k)) continue;
            dictDel(fonts, k);
            removed++;
          }
          if (removed) {
            fonts.dirty = true;
            res.dirty = true;
            stats.fontsRemoved = (stats.fontsRemoved || 0) + removed;
          }
        };
        for (const p of pages) if (p.resources) pruneRes(p.resources);
        for (const o of doc.objs.values()) if (nameOf(get(o.value, 'Subtype')) === 'Form') pruneRes(get(o.value, 'Resources'));
      }
    }

    /* 5 ─ duplicate stream de-duplication */
    if (opts.dedupe !== false) {
      const byKey = new Map();
      const remap = new Map();
      for (const o of doc.objs.values()) {
        if (o.sS == null) continue;
        const body = o.newStream != null ? o.newStream : doc.streamBytes(o);
        if (body.length < 512) continue;
        const d = o.value;
        let key = body.length + ':' + Util.crc32(body) + ':';
        if (d && d.t === 'dict') {
          const dd = { t: 'dict', v: {}, order: [] };
          for (const k of d.order) if (!['Length', 'SMask', 'Mask', 'Alternates'].includes(k)) { dd.order.push(k); dd.v[k] = d.v[k]; }
          key += ser(dd);
        }
        if (byKey.has(key)) remap.set(o.num, byKey.get(key));
        else byKey.set(key, o.num);
      }
      if (remap.size) {
        stats.duplicates = remap.size;
        const fix = (v, depth = 0) => {
          if (!v || depth > 40) return;
          if (v.t === 'ref') { if (remap.has(v.n)) v.n = remap.get(v.n); return; }
          if (v.t === 'array') { for (const x of v.v) fix(x, depth + 1); return; }
          if (v.t === 'dict') { for (const k of v.order) fix(v.v[k], depth + 1); }
        };
        for (const o of doc.objs.values()) {
          if (remap.has(o.num)) continue;
          if (!o.dirty) {
            let has = false;
            for (const r of doc.refsIn(o.dictRaw)) if (remap.has(r)) { has = true; break; }
            if (!has) continue;
          }
          fix(o.value);
          o.dirty = true;
        }
      }
    }

    mark('dedupe');
    /* 6 ─ garbage-collect unreachable objects */
    const live = new Set();
    const queue = [doc.rootNum];
    while (queue.length) {
      const n0 = queue.pop();
      if (n0 == null || live.has(n0) || !doc.objs.has(n0)) continue;
      live.add(n0);
      const o = doc.objs.get(n0);
      const dictText = o.dirty || o.newStream != null ? ser(o.value) : o.dictRaw;
      for (const r of doc.refsIn(dictText)) if (!live.has(r) && doc.objs.has(r)) queue.push(r);
    }
    for (const p of doc.pages()) if (!live.has(p.num)) live.add(p.num);

    mark('gc');
    /* 7 ─ serialize candidates (cheap), verify only what we intend to ship */
    const buildCandidates = async () => {
      const list = [{ bytes: serialize(doc, live), label: 'classic xref' }];
      if (parseFloat(doc.version) >= 1.5 || doc.hadObjStm) {
        try { list.push({ bytes: await serializeModern(doc, live), label: 'object streams' }); } catch (e) { /* classic only */ }
      }
      return list.filter(c => c.bytes.length < bytes.length).sort((a, b) => a.bytes.length - b.bytes.length);
    };
    const verify = async (candidate, quick) => {
      if (!candidate || candidate.length < 64) return false;
      try {
        if (quick && candidate.length > 3e6) {
          // very large rebuilds: structural check only (the writer is deterministic and
          // the full path is exercised by the QA gate on every smaller fixture)
          const tail = Util.latin1(candidate.subarray(Math.max(0, candidate.length - 2048)));
          return /startxref\s+\d+\s+%%EOF\s*$/.test(tail);
        }
        const check = await new Doc(candidate).scan();
        return !!check.rootNum && check.pages().length >= before.pages;
      } catch (e) { return false; }
    };
    const pickVerified = async (cands, quick) => {
      for (const c of cands) {
        if (await verify(c.bytes, quick)) return c;
        warnings.push(`${c.label} rebuild failed verification — skipped`);
      }
      return null;
    };

    let chosen = null;
    let cands = await buildCandidates();
    if (!cands.length) return { bytes, stats, warnings: warnings.concat('no verified rebuild was smaller — file returned untouched') };
    const baseline = cands[0];

    /* 8 ─ budgeted raster ladder, inside the same parse */
    const applyPayload = (job, payload) => {
      const d = job.dict, o = job.obj;
      if (!payload.lossless) stats.imagesLossy = (stats.imagesLossy || 0) + 1;
      o.newStream = payload.bytes;
      dictSet(d, 'Width', { t: 'num', raw: String(payload.width), v: payload.width });
      dictSet(d, 'Height', { t: 'num', raw: String(payload.height), v: payload.height });
      dictSet(d, 'Filter', { t: 'name', v: payload.filter, raw: payload.filter });
      if (payload.decodeParms) {
        const pv = {};
        const po = [];
        if (payload.decodeParms.predictor) { po.push('Predictor'); pv.Predictor = { t: 'num', raw: String(payload.decodeParms.predictor), v: payload.decodeParms.predictor }; }
        if (payload.decodeParms.colors) { po.push('Colors'); pv.Colors = { t: 'num', raw: String(payload.decodeParms.colors), v: payload.decodeParms.colors }; }
        if (payload.decodeParms.bpc) { po.push('BitsPerComponent'); pv.BitsPerComponent = { t: 'num', raw: String(payload.decodeParms.bpc), v: payload.decodeParms.bpc }; }
        if (payload.decodeParms.columns) { po.push('Columns'); pv.Columns = { t: 'num', raw: String(payload.decodeParms.columns), v: payload.decodeParms.columns }; }
        dictSet(d, 'DecodeParms', { t: 'dict', v: pv, order: po });
      } else {
        dictDel(d, 'DecodeParms');
      }
      // /Decode inverts sample interpretation ([1 0] masks are common). It must survive a
      // lossless re-filter, and must go only when the samples themselves are replaced.
      if (!payload.lossless) dictDel(d, 'Decode');
      if (payload.filter === 'DCTDecode') {
        dictSet(d, 'ColorSpace', { t: 'name', v: 'DeviceRGB', raw: 'DeviceRGB' });
        dictSet(d, 'BitsPerComponent', { t: 'num', raw: '8', v: 8 });
      } else if (payload.filter === 'FlateDecode') {
        if (payload.colorSpace) dictSet(d, 'ColorSpace', payload.colorSpace);
        dictSet(d, 'BitsPerComponent', { t: 'num', raw: '8', v: 8 });
      }
      o.dirty = true;
    };

    const target = opts.targetBytes || 0;
    if (imageJobs.length && (!target || baseline.bytes.length > target)) {
      const levels = opts.imageLevels;
      let bestPayloads = null, bestEstimate = Infinity, bestTotal = Infinity;
      let prevEstimate = Infinity;
      for (let li = 0; li < levels.length; li++) {
        const level = levels[li];
        const payloads = new Map();
        let total = 0, touched = 0;
        for (const job of imageJobs) {
          let payload = null;
          try { payload = await opts.imageEncode(job, level); } catch (e) { payload = null; }
          if (payload && payload.bytes && payload.bytes.length < job.streamLen * 0.995) { total += payload.bytes.length; touched++; payloads.set(job.objNum, payload); }
          else total += job.streamLen;
        }
        if (!target) break;                                       // pure-lossless mode: one rung only
        if (!touched) continue;                                   // this rung cannot help anything
        const estimate = baseline.bytes.length - stats.imageBytesBefore + total;
        if (estimate < bestEstimate) { bestEstimate = estimate; bestPayloads = payloads; bestTotal = total; }
        if (!target || estimate <= target) break;                 // first rung that meets the target wins
        // if the raster trade has bought <3 % of the file by now, more rungs will not help
        if (li >= 1 && 1 - bestEstimate / baseline.bytes.length < 0.03) break;
        prevEstimate = estimate;
      }
      if (bestPayloads && bestPayloads.size) {
        for (const job of imageJobs) {
          const payload = bestPayloads.get(job.objNum);
          if (payload) applyPayload(job, payload);
        }
        stats.imagesRecompressed = bestPayloads.size;
        stats.imageBytesAfter = bestTotal;
        for (const c of await buildCandidates()) {
          if (c.bytes.length < baseline.bytes.length) { cands = [c]; break; }
        }
      }
    } else if (imageJobs.length) {
      stats.imageBytesAfter = stats.imageBytesBefore;
    }

    mark('serialize');
    chosen = await pickVerified(cands, opts.quickVerify);
    mark('verify');
    if (!chosen) return { bytes, stats, warnings: warnings.concat('no verified rebuild was smaller — file returned untouched') };

    stats.objectsBefore = before.objects;
    stats.objectsAfter = live.size;
    stats.pages = before.pages;
    stats.writer = chosen.label;
    if (T) stats.timing = T;
    return { bytes: chosen.bytes, stats, warnings };
  }

  return { Doc, optimize, analyze, serialize, serializeModern, parseValue, ser, stripTextOps, trimContent, shortenNum, scanTokens, get, num, refOf, nameOf, dictSet, dictDel };
})();
