/* ══════════════════════════════════════════════════════════════
   codec-js.js — pure-JS DEFLATE / INFLATE fallback
   Used when the browser has no Compression Streams (older Safari,
   embedded webviews, some TVs). Real LZ77 + Huffman, not a stub:
   INFLATE handles stored / fixed / dynamic blocks and zlib or raw
   streams; DEFLATE emits fixed-Huffman blocks with a hash-chain
   matcher (≈ level 4). Slower than native, but it means *every*
   device can open, read and rewrite compressed streams.
   ══════════════════════════════════════════════════════════════ */

const JSCodec = (() => {
  /* ───────────── INFLATE ───────────── */
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function buildTree(lengths) {
    let max = 0;
    for (let i = 0; i < lengths.length; i++) if (lengths[i] > max) max = lengths[i];
    const counts = new Uint16Array(max + 1);
    for (const l of lengths) if (l) counts[l]++;
    const offs = new Uint16Array(max + 1);
    let total = 0;
    for (let i = 1; i <= max; i++) { offs[i] = total; total += counts[i]; }
    const symbols = new Uint16Array(total);
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
    return { counts, symbols, max };
  }

  function jsInflate(input) {
    let p = 0;
    // zlib wrapper?
    if (input.length > 2 && (input[0] & 0x0f) === 8 && (((input[0] << 8) | input[1]) % 31) === 0) p = 2;
    let bitBuf = 0, bitCnt = 0;
    const readByte = () => (p < input.length ? input[p++] : 0);
    const bits = (n) => {
      while (bitCnt < n) { bitBuf |= readByte() << bitCnt; bitCnt += 8; }
      const v = bitBuf & ((1 << n) - 1);
      bitBuf >>>= n; bitCnt -= n;
      return v;
    };
    const decode = (tree) => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len <= tree.max; len++) {
        code |= bits(1);
        const count = tree.counts[len];
        if (code - first < count) return tree.symbols[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
      }
      return -1;
    };

    let out = new Uint8Array(Math.max(1024, input.length * 3));
    let o = 0;
    const ensure = (n) => {
      if (o + n <= out.length) return;
      let size = out.length * 2;
      while (size < o + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(out.subarray(0, o));
      out = next;
    };

    let fixedLit = null, fixedDist = null;
    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {                      // stored
        bitBuf = 0; bitCnt = 0;
        const len = input[p] | (input[p + 1] << 8);
        p += 4;
        ensure(len);
        out.set(input.subarray(p, p + len), o);
        o += len; p += len;
        continue;
      }
      let lit, dist;
      if (type === 1) {                      // fixed
        if (!fixedLit) {
          const l = new Uint8Array(288);
          for (let i = 0; i < 144; i++) l[i] = 8;
          for (let i = 144; i < 256; i++) l[i] = 9;
          for (let i = 256; i < 280; i++) l[i] = 7;
          for (let i = 280; i < 288; i++) l[i] = 8;
          fixedLit = buildTree(l);
          fixedDist = buildTree(new Uint8Array(30).fill(5));
        }
        lit = fixedLit; dist = fixedDist;
      } else if (type === 2) {               // dynamic
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const clen = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clen[CLORDER[i]] = bits(3);
        const clTree = buildTree(clen);
        const lens = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < lens.length) {
          const sym = decode(clTree);
          if (sym < 0) return null;
          if (sym < 16) lens[i++] = sym;
          else if (sym === 16) {
            if (!i) return null;
            const prev = lens[i - 1], rep = 3 + bits(2);
            for (let k = 0; k < rep; k++) lens[i++] = prev;
          } else if (sym === 17) {
            const rep = 3 + bits(3);
            for (let k = 0; k < rep; k++) lens[i++] = 0;
          } else {
            const rep = 11 + bits(7);
            for (let k = 0; k < rep; k++) lens[i++] = 0;
          }
        }
        lit = buildTree(lens.subarray(0, hlit));
        dist = buildTree(lens.subarray(hlit));
      } else return null;

      for (;;) {
        const sym = decode(lit);
        if (sym < 0) return null;
        if (sym < 256) { ensure(1); out[o++] = sym; continue; }
        if (sym === 256) break;
        const li = sym - 257;
        if (li >= LBASE.length) return null;
        const len = LBASE[li] + (LEXT[li] ? bits(LEXT[li]) : 0);
        const ds = decode(dist);
        if (ds < 0 || ds >= DBASE.length) return null;
        const d = DBASE[ds] + (DEXT[ds] ? bits(DEXT[ds]) : 0);
        if (d > o) return null;
        ensure(len);
        for (let k = 0; k < len; k++, o++) out[o] = out[o - d];
      }
    }
    return out.subarray(0, o);
  }

  /* ───────────── DEFLATE (fixed Huffman + hash chains) ───────────── */
  let litCodes = null;
  function fixedLitCodes() {
    if (litCodes) return litCodes;
    const codes = new Uint16Array(288), lens = new Uint8Array(288);
    const blCount = new Uint16Array(16);
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    for (let i = 0; i < 288; i++) blCount[l[i]]++;
    let code = 0;
    const nextCode = new Uint16Array(16);
    for (let b = 1; b < 16; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
    for (let i = 0; i < 288; i++) { codes[i] = nextCode[l[i]]++; lens[i] = l[i]; }
    litCodes = { codes, lens };
    return litCodes;
  }
  const LCODE = new Uint16Array(259), LXBITS = new Uint8Array(259), LXTRA = new Uint16Array(259);
  (function () {
    for (let i = 0; i < LBASE.length; i++) {
      const base = LBASE[i], ext = LEXT[i];
      const span = ext ? (1 << ext) : 1;
      for (let k = 0; k < span; k++) {
        const len = base + k;
        if (len > 258) break;
        LCODE[len] = 257 + i; LXBITS[len] = ext; LXTRA[len] = k;
      }
    }
    // length 258 has its own code point (285) and never uses extra bits
    LCODE[258] = 285; LXBITS[258] = 0; LXTRA[258] = 0;
  })();
  const DCODE_TAB = new Uint16Array(32769), DXBITS = new Uint8Array(32769), DXTRA = new Uint16Array(32769);
  (function () {
    for (let i = 0; i < DBASE.length; i++) {
      const base = DBASE[i], ext = DEXT[i];
      const span = ext ? (1 << ext) : 1;
      for (let k = 0; k < span; k++) {
        const d = base + k;
        if (d > 32768) break;
        DCODE_TAB[d] = i; DXBITS[d] = ext; DXTRA[d] = k;
      }
    }
  })();

  function jsDeflate(input, opts = {}) {
    const { codes, lens } = fixedLitCodes();
    const level = opts.level == null ? 4 : opts.level;
    const maxChain = level >= 6 ? 128 : level >= 4 ? 48 : 16;
    const niceLen = level >= 6 ? 128 : 64;

    let out = new Uint8Array(Math.max(1024, (input.length >> 1) + 64));
    let op = 0, bitBuf = 0, bitCnt = 0;
    const grow = () => {
      const next = new Uint8Array(out.length * 2);
      next.set(out.subarray(0, op));
      out = next;
    };
    const put = (byte) => { if (op >= out.length) grow(); out[op++] = byte; };
    const putBits = (value, n) => {
      bitBuf |= value << bitCnt;
      bitCnt += n;
      while (bitCnt >= 8) { put(bitBuf & 0xff); bitBuf >>>= 8; bitCnt -= 8; }
    };
    // Huffman codes are written MSB-first: reverse the bits
    const putCode = (code, len) => {
      let rev = 0, c = code;
      for (let i = 0; i < len; i++) { rev = (rev << 1) | (c & 1); c >>= 1; }
      putBits(rev, len);
    };
    const putSym = (sym) => putCode(codes[sym], lens[sym]);

    put(0x78); put(0x9c);                    // zlib header (default compression)
    putBits(1, 1); putBits(1, 2);            // BFINAL, BTYPE=fixed

    const n = input.length;
    const HASH_SIZE = 1 << 15, HASH_MASK = HASH_SIZE - 1;
    const head = new Int32Array(HASH_SIZE).fill(-1);
    const prev = new Int32Array(n).fill(-1);
    const hash = (i) => (((input[i] << 10) ^ (input[i + 1] << 5) ^ input[i + 2]) & HASH_MASK);

    let i = 0;
    while (i < n) {
      let bestLen = 0, bestDist = 0;
      if (i + 2 < n) {
        const h = hash(i);
        let cand = head[h], chain = maxChain;
        const limit = Math.min(258, n - i);
        while (cand >= 0 && chain-- > 0) {
          const dist = i - cand;
          if (dist > 32768) break;
          if (input[cand + bestLen] === input[i + bestLen]) {
            let len = 0;
            while (len < limit && input[cand + len] === input[i + len]) len++;
            if (len > bestLen) { bestLen = len; bestDist = dist; if (len >= niceLen) break; }
          }
          cand = prev[cand];
        }
        prev[i] = head[h];
        head[h] = i;
      }
      if (bestLen >= 3) {
        putSym(LCODE[bestLen]);
        if (LXBITS[bestLen]) putBits(LXTRA[bestLen], LXBITS[bestLen]);
        putCode(DCODE_TAB[bestDist], 5);          // 5-bit fixed distance symbol
        if (DXBITS[bestDist]) putBits(DXTRA[bestDist], DXBITS[bestDist]);
        // register the skipped positions so later matches can find them
        for (let k = 1; k < bestLen; k++) {
          const j = i + k;
          if (j + 2 < n) { const hh = hash(j); prev[j] = head[hh]; head[hh] = j; }
        }
        i += bestLen;
      } else {
        putSym(input[i]);
        i++;
      }
    }
    putSym(256);                             // end of block
    if (bitCnt > 0) put(bitBuf & 0xff);
    // adler32 trailer (zlib)
    let a = 1, b = 0;
    for (let k = 0; k < n; k++) { a = (a + input[k]) % 65521; b = (b + a) % 65521; }
    put((b >>> 8) & 0xff); put(b & 0xff); put((a >>> 8) & 0xff); put(a & 0xff);
    return out.subarray(0, op);
  }

  /* gzip container around the JS deflate (RFC 1952) */
  function jsGzip(input) {
    const raw = jsDeflate(input);
    const body = raw.subarray(2, raw.length - 4);      // strip zlib wrapper
    const header = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
    const crc = Util.crc32(input);
    const trailer = new Uint8Array(8);
    const dv = new DataView(trailer.buffer);
    dv.setUint32(0, crc, true);
    dv.setUint32(4, input.length >>> 0, true);
    return Util.concat([header, body, trailer]);
  }

  return { inflate: jsInflate, deflate: jsDeflate, gzip: jsGzip };
})();
