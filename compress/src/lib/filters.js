/* ══════════════════════════════════════════════════════════════
   filters.js — PDF stream codecs
   Flate (+ PNG/TIFF predictors) · LZW · ASCIIHex · ASCII85 ·
   RunLength.  Decode → optimise → re-encode with Flate.
   ══════════════════════════════════════════════════════════════ */

const PDFFilters = (() => {
  /* accept raw PDF value trees or plain names */
  const normFilters = (filters) => {
    if (!filters) return [];
    if (typeof filters === 'string') return [filters];
    if (Array.isArray(filters)) return filters.map(f => (f && f.t === 'name' ? f.v : typeof f === 'string' ? f : null)).filter(Boolean);
    if (filters.t === 'name') return [filters.v];
    if (filters.t === 'array') return filters.v.map(f => (f && f.t === 'name' ? f.v : null)).filter(Boolean);
    return [];
  };
  const numOf = (v, d) => (v && v.t === 'num' ? v.v : typeof v === 'number' ? v : d);
  const toPlain = (v) => {
    if (!v) return {};
    if (v.t === 'dict') {
      const o = {};
      for (const k of Object.keys(v.v)) {
        const x = v.v[k];
        if (x && x.t === 'num') o[k] = x.v;
        else if (x && x.t === 'bool') o[k] = x.v;
        else if (x && x.t === 'name') o[k] = x.v;
        else if (x && x.t === 'array') o[k] = x.v.map(y => numOf(y, 0));
        else o[k] = x;
      }
      return o;
    }
    return v;
  };
  const normParms = (p) => {
    if (!p) return [];
    if (Array.isArray(p)) return p.map(toPlain);
    if (p.t === 'array') return p.v.map(toPlain);
    return [toPlain(p)];
  };
  function applyPredictor(data, parms) {
    const pred = parms.Predictor || 1;
    if (pred <= 1) return data;
    const colors = parms.Colors || 1;
    const bpc = parms.BitsPerComponent || 8;
    const columns = parms.Columns || 1;
    const bpp = Math.max(1, Math.ceil(colors * bpc / 8));
    const rowLen = Math.ceil(columns * colors * bpc / 8);
    if (pred === 2) { // TIFF, 8-bit
      const out = new Uint8Array(data);
      if (bpc !== 8) return out;
      for (let r = 0; r + rowLen <= out.length; r += rowLen)
        for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
      return out;
    }
    // PNG predictors
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    for (let r = 0; r < rows; r++) {
      const ft = data[r * (rowLen + 1)];
      const src = r * (rowLen + 1) + 1, dst = r * rowLen, prev = dst - rowLen;
      for (let x = 0; x < rowLen; x++) {
        const raw = data[src + x];
        const a = x >= bpp ? out[dst + x - bpp] : 0;
        const b = r > 0 ? out[prev + x] : 0;
        const c = x >= bpp && r > 0 ? out[prev + x - bpp] : 0;
        let v;
        switch (ft) {
          case 0: v = raw; break;
          case 1: v = raw + a; break;
          case 2: v = raw + b; break;
          case 3: v = raw + ((a + b) >> 1); break;
          case 4: {
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            break;
          }
          default: v = raw;
        }
        out[dst + x] = v & 0xff;
      }
    }
    return out;
  }

  function lzwDecode(data, early = 1) {
    const out = [];
    let dict = [], codeLen = 9, next = 258, prev = null;
    for (let i = 0; i < 256; i++) dict[i] = [i];
    dict[256] = null; dict[257] = null;
    let bitBuf = 0, bitCnt = 0, p = 0;
    for (;;) {
      while (bitCnt < codeLen && p < data.length) { bitBuf = (bitBuf << 8) | data[p++]; bitCnt += 8; }
      if (bitCnt < codeLen) break;
      const code = (bitBuf >> (bitCnt - codeLen)) & ((1 << codeLen) - 1);
      bitCnt -= codeLen;
      if (code === 256) { dict = dict.slice(0, 258); codeLen = 9; next = 258; prev = null; continue; }
      if (code === 257) break;
      let entry;
      if (code < next && dict[code]) entry = dict[code];
      else if (prev) entry = prev.concat(prev[0]);
      else break;
      for (const b of entry) out.push(b);
      if (prev) { dict[next++] = prev.concat(entry[0]); }
      prev = entry;
      if (next + early >= (1 << codeLen) && codeLen < 12) codeLen++;
    }
    return new Uint8Array(out);
  }

  function asciiHex(data) {
    let s = Util.latin1(data).replace(/\s+/g, '');
    const end = s.indexOf('>');
    if (end >= 0) s = s.slice(0, end);
    if (s.length & 1) s += '0';
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16) || 0;
    return out;
  }

  function ascii85(data) {
    let s = Util.latin1(data).replace(/\s+/g, '');
    if (s.startsWith('<~')) s = s.slice(2);
    const end = s.indexOf('~>');
    if (end >= 0) s = s.slice(0, end);
    const out = [];
    let i = 0;
    while (i < s.length) {
      if (s[i] === 'z') { out.push(0, 0, 0, 0); i++; continue; }
      const chunk = s.slice(i, i + 5);
      i += 5;
      let v = 0, n = chunk.length;
      for (let k = 0; k < 5; k++) v = v * 85 + (k < n ? chunk.charCodeAt(k) - 33 : 84);
      const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      for (let k = 0; k < n - 1; k++) out.push(bytes[k]);
    }
    return new Uint8Array(out);
  }

  function runLength(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
      const n = data[i++];
      if (n === 128) break;
      if (n < 128) { for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]); }
      else { const b = data[i++]; for (let k = 0; k < 257 - n; k++) out.push(b); }
    }
    return new Uint8Array(out);
  }

  // filter list may be a name or array; parms likewise
  async function decode(bytes, filters, parmsList) {
    let data = bytes;
    const fl = normFilters(filters);
    if (!fl.length) return data;                                   // already raw
    const pl = normParms(parmsList);
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i];
      const p = pl[i] || {};
      if (f === 'FlateDecode' || f === 'Fl') {
        const inf = await Util.tryInflate(data);
        if (!inf) return null;
        data = applyPredictor(inf, p);
      } else if (f === 'LZWDecode' || f === 'LZW') {
        data = applyPredictor(lzwDecode(data, p.EarlyChange == null ? 1 : p.EarlyChange), p);
      } else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data);
      else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
      else if (f === 'RunLengthDecode' || f === 'RL') data = runLength(data);
      else if (f === 'Crypt') continue;
      else return null; // image codecs: caller decides
    }
    return data;
  }

  return { decode, applyPredictor, lzwDecode, asciiHex, ascii85, runLength, normFilters, normParms, toPlain };
})();
