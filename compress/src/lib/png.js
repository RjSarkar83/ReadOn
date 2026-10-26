/* ══════════════════════════════════════════════════════════════
   png.js — true LOSSLESS PNG re-compressor
   • strips metadata chunks (text / exif / time / private)
   • un-filters scanlines, re-filters with the best of 5 predictor
     strategies (libpng "minimum sum of absolute differences")
   • re-deflates and keeps whichever payload is smaller
   Pixels are bit-for-bit identical to the source.
   ══════════════════════════════════════════════════════════════ */

const PNGCodec = (() => {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const KEEP = new Set([
    'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP',
    'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'sPLT', 'hIST'
  ]);
  const STRIP = new Set([
    'tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'oFFs', 'pCAL', 'sCAL', 'sTER',
    'dSIG', 'prVW', 'mkBF', 'mkTS', 'mkBS', 'caNv', 'spAL'
  ]);

  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  function parse(bytes) {
    for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null;
    const chunks = [];
    let p = 8;
    while (p + 8 <= bytes.length) {
      const len = u32(bytes, p);
      const type = Util.latin1(bytes.subarray(p + 4, p + 8));
      if (p + 12 + len > bytes.length) break;
      const data = bytes.subarray(p + 8, p + 8 + len);
      chunks.push({ type, data, raw: bytes.subarray(p, p + 12 + len) });
      p += 12 + len;
      if (type === 'IEND') break;
    }
    const hdr = chunks.find(c => c.type === 'IHDR');
    if (!hdr) return null;
    const ihdr = {
      width: u32(hdr.data, 0), height: u32(hdr.data, 4), bitDepth: hdr.data[8],
      colorType: hdr.data[9], compression: hdr.data[10], filter: hdr.data[11],
      interlace: hdr.data[12]
    };
    return { chunks, ihdr };
  }

  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, Util.crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  // remove filter bytes -> raw scanlines
  function unfilter(raw, w, h, bpp, stride) {
    const out = new Uint8Array(h * stride);
    let ip = 0;
    for (let y = 0; y < h; y++) {
      const ft = raw[ip++];
      const o = y * stride;
      const po = (y - 1) * stride;
      for (let x = 0; x < stride; x++) {
        const cur = raw[ip + x];
        const a = x >= bpp ? out[o + x - bpp] : 0;
        const b = y > 0 ? out[po + x] : 0;
        const c = x >= bpp && y > 0 ? out[po + x - bpp] : 0;
        let v;
        switch (ft) {
          case 0: v = cur; break;
          case 1: v = cur + a; break;
          case 2: v = cur + b; break;
          case 3: v = cur + ((a + b) >> 1); break;
          case 4: v = cur + paeth(a, b, c); break;
          default: return null;
        }
        out[o + x] = v & 0xff;
      }
      ip += stride;
    }
    return out;
  }

  // strategy: -1 = adaptive per row, 0..4 = force filter
  function refilter(raw, w, h, bpp, stride, strategy) {
    const out = new Uint8Array(h * (stride + 1));
    const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride),
                  new Uint8Array(stride), new Uint8Array(stride)];
    let op = 0;
    for (let y = 0; y < h; y++) {
      const o = y * stride, po = (y - 1) * stride;
      const use = strategy >= 0 ? [strategy] : [0, 1, 2, 3, 4];
      let best = -1, bestScore = Infinity, bestBuf = null;
      for (const ft of use) {
        const buf = cand[ft];
        let score = 0;
        for (let x = 0; x < stride; x++) {
          const cur = raw[o + x];
          const a = x >= bpp ? raw[o + x - bpp] : 0;
          const b = y > 0 ? raw[po + x] : 0;
          const c = x >= bpp && y > 0 ? raw[po + x - bpp] : 0;
          let v;
          switch (ft) {
            case 0: v = cur; break;
            case 1: v = cur - a; break;
            case 2: v = cur - b; break;
            case 3: v = cur - ((a + b) >> 1); break;
            default: v = cur - paeth(a, b, c);
          }
          v &= 0xff;
          buf[x] = v;
          score += v < 128 ? v : 256 - v;
        }
        if (score < bestScore) { bestScore = score; best = ft; bestBuf = buf; }
      }
      out[op++] = best;
      out.set(bestBuf, op);
      op += stride;
    }
    return out;
  }

  async function optimize(bytes) {
    const png = parse(bytes);
    if (!png) return null;
    const { chunks, ihdr } = png;
    const keep = (t) => t === 'IDAT' || KEEP.has(t) || !(t.charCodeAt(0) & 0x20);
    const dropped = [];
    let removedBytes = 0;
    for (const c of chunks) {
      if (!keep(c.type) && !dropped.includes(c.type)) dropped.push(c.type);
      if (!keep(c.type)) removedBytes += c.raw.length;
    }
    const kept = chunks.filter(c => keep(c.type));
    const idat = Util.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data));
    const animated = chunks.some(c => c.type === 'acTL');
    let bestIdat = idat, method = 'original';

    if (!animated && ihdr.interlace === 0 && ihdr.bitDepth >= 8) {
      const ch = CHANNELS[ihdr.colorType];
      const bpp = Math.max(1, Math.ceil(ihdr.bitDepth * ch / 8));
      const stride = Math.ceil(ihdr.width * ihdr.bitDepth * ch / 8);
      const rawIn = await Util.tryInflate(idat);
      if (rawIn && rawIn.length >= ihdr.height * (stride + 1)) {
        const flat = unfilter(rawIn, ihdr.width, ihdr.height, bpp, stride);
        if (flat) {
          const strategies = [
            [-1, 'adaptive'], [4, 'Paeth'], [2, 'Up'], [1, 'Sub'], [3, 'Average'], [0, 'None']
          ];
          for (const [s, label] of strategies) {
            const filt = refilter(flat, ihdr.width, ihdr.height, bpp, stride, s);
            const z = await Util.deflate(filt);
            if (z.length < bestIdat.length) { bestIdat = z; method = label; }
          }
          if (bestIdat === idat) method = 'original';
        }
      }
    } else if (animated || ihdr.interlace === 1) {
      // cannot safely re-filter: only re-deflate the existing payload
      const z = await Util.deflate(idat);
      if (z.length < bestIdat.length) { bestIdat = z; method = 're-deflate'; }
    }

    const out = [new Uint8Array(SIG)];
    let wroteIdat = false;
    for (const c of kept) {
      if (c.type === 'IDAT') {
        if (!wroteIdat) { out.push(chunk('IDAT', bestIdat)); wroteIdat = true; }
        continue;
      }
      out.push(c.raw);
    }
    const result = Util.concat(out);
    return {
      bytes: result.length < bytes.length ? result : bytes,
      gain: Util.pct(result.length, bytes.length),
      method,
      dropped: [...new Set(dropped)],
      removedBytes,
      lossless: true
    };
  }

  /* Optimise a raw (predictor-free) sample plane — used for PDF image
     streams stored as Flate. Tries every PNG predictor, keeps the best. */
  async function compressSamples(samples, width, height, channels, bpc = 8) {
    const bpp = Math.max(1, Math.ceil(bpc * channels / 8));
    const stride = Math.ceil(width * bpc * channels / 8);
    if (samples.length < stride * height) return null;
    // predictor search is O(rows x stride) per strategy — scale it with the image
    const strat = samples.length > 8e6 ? [-1]
      : samples.length > 2e6 ? [-1, 4]
        : [-1, 4, 2, 1, 3, 0];
    let best = null;
    for (const s of strat) {
      const filt = refilter(samples, width, height, bpp, stride, s);
      const z = await Util.deflate(filt);
      if (!best || z.length < best.length) best = z;
    }
    return best;
  }

  /* Lossy 8-bit palette quantiser (TinyPNG-style PLTE + tRNS).
     Preserves full alpha transparency and .png format while cutting size 60–85 %. */
  async function quantize(rgba, width, height, maxColors = 256) {
    const nPix = width * height;
    if (!rgba || rgba.length < nPix * 4 || width < 1 || height < 1) return null;
    maxColors = Math.max(8, Math.min(256, maxColors | 0));

    // 1 — build 16-bit RGBA histogram with exact 8-bit channel accumulators
    const counts = new Uint32Array(65536);
    const rSum = new Float64Array(65536);
    const gSum = new Float64Array(65536);
    const bSum = new Float64Array(65536);
    const aSum = new Float64Array(65536);
    const strideStep = nPix > 1500000 ? 2 : 1;
    let hasTrans = false;
    for (let i = 0; i < nPix; i += strideStep) {
      const p = i * 4;
      const a = rgba[p + 3];
      if (a < 252) hasTrans = true;
      if (a < 4) {
        counts[0]++;
        continue;
      }
      const key = ((rgba[p] >> 4) << 12) | ((rgba[p + 1] >> 4) << 8) | ((rgba[p + 2] >> 4) << 4) | (a >> 4);
      counts[key]++;
      rSum[key] += rgba[p];
      gSum[key] += rgba[p + 1];
      bSum[key] += rgba[p + 2];
      aSum[key] += a;
    }

    const items = [];
    for (let k = 0; k < 65536; k++) {
      const c = counts[k];
      if (!c) continue;
      if (k === 0 && aSum[0] === 0) {
        items.push({ c, r: 0, g: 0, b: 0, a: 0 });
      } else {
        items.push({
          c,
          r: Math.round(rSum[k] / c),
          g: Math.round(gSum[k] / c),
          b: Math.round(bSum[k] / c),
          a: hasTrans ? Math.round(aSum[k] / c) : 255
        });
      }
    }
    if (!items.length) items.push({ c: 1, r: 0, g: 0, b: 0, a: 255 });

    // 2 — median-cut split up to maxColors boxes
    const makeBox = (list) => {
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, aMin = 255, aMax = 0, pop = 0;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        pop += it.c;
        if (it.r < rMin) rMin = it.r; if (it.r > rMax) rMax = it.r;
        if (it.g < gMin) gMin = it.g; if (it.g > gMax) gMax = it.g;
        if (it.b < bMin) bMin = it.b; if (it.b > bMax) bMax = it.b;
        if (it.a < aMin) aMin = it.a; if (it.a > aMax) aMax = it.a;
      }
      const dr = (rMax - rMin) * 1.1, dg = (gMax - gMin) * 1.3, db = (bMax - bMin) * 0.9, da = (aMax - aMin) * 1.4;
      const span = Math.max(dr, dg, db, da);
      const ch = span === dg ? 'g' : span === dr ? 'r' : span === da ? 'a' : 'b';
      const score = list.length > 1 ? span * Math.pow(pop, 0.35) : -1;
      return { list, pop, ch, score };
    };

    const boxes = [makeBox(items)];
    while (boxes.length < maxColors) {
      let bi = -1, bestScore = 0;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].score > bestScore) { bestScore = boxes[i].score; bi = i; }
      }
      if (bi < 0) break;
      const box = boxes[bi];
      const ch = box.ch;
      box.list.sort((x, y) => x[ch] - y[ch]);
      const half = box.pop / 2;
      let acc = 0, cut = 1;
      for (let i = 0; i < box.list.length - 1; i++) {
        acc += box.list[i].c;
        if (acc >= half) { cut = i + 1; break; }
      }
      boxes.splice(bi, 1, makeBox(box.list.slice(0, cut)), makeBox(box.list.slice(cut)));
    }

    const pal = boxes.map((bx) => {
      let rs = 0, gs = 0, bs = 0, as = 0, pop = 0;
      for (let i = 0; i < bx.list.length; i++) {
        const it = bx.list[i];
        rs += it.r * it.c; gs += it.g * it.c; bs += it.b * it.c; as += it.a * it.c; pop += it.c;
      }
      const a = hasTrans ? Math.round(as / pop) : 255;
      return a < 4 ? { r: 0, g: 0, b: 0, a: 0 } : { r: Math.round(rs / pop), g: Math.round(gs / pop), b: Math.round(bs / pop), a };
    });

    // put alpha < 255 entries first so tRNS chunk stays tiny
    pal.sort((x, y) => (x.a < 255 ? 0 : 1) - (y.a < 255 ? 0 : 1));
    const pLen = pal.length;
    const pR = new Uint8Array(pLen), pG = new Uint8Array(pLen), pB = new Uint8Array(pLen), pA = new Uint8Array(pLen);
    let trnsLen = 0;
    for (let i = 0; i < pLen; i++) {
      pR[i] = pal[i].r; pG[i] = pal[i].g; pB[i] = pal[i].b; pA[i] = pal[i].a;
      if (pal[i].a < 255) trnsLen = i + 1;
    }

    // 3 — map pixels with a 16-bit cell cache
    const lut = new Int16Array(65536);
    lut.fill(-1);
    const idx = new Uint8Array(nPix);
    let zeroIdx = -1;
    for (let i = 0; i < pLen; i++) if (pA[i] < 4) { zeroIdx = i; break; }

    for (let i = 0; i < nPix; i++) {
      const p = i * 4;
      const a = hasTrans ? rgba[p + 3] : 255;
      if (a < 4 && zeroIdx >= 0) { idx[i] = zeroIdx; continue; }
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      const key = ((r >> 4) << 12) | ((g >> 4) << 8) | ((b >> 4) << 4) | (a >> 4);
      let best = lut[key];
      if (best < 0) {
        let bestD = Infinity;
        for (let j = 0; j < pLen; j++) {
          const dr = r - pR[j], dg = g - pG[j], db = b - pB[j], da = a - pA[j];
          const d = dr * dr * 2 + dg * dg * 4 + db * db + da * da * 4;
          if (d < bestD) { bestD = d; best = j; if (d === 0) break; }
        }
        lut[key] = best;
      }
      idx[i] = best;
    }

    // 4 — filter + deflate (None vs Sub vs Adaptive on 8-bit indices)
    const f0 = refilter(idx, width, height, 1, width, 0);
    let bestIdat = await Util.deflate(f0);
    if (nPix <= 2500000) {
      const f1 = refilter(idx, width, height, 1, width, -1);
      const z1 = await Util.deflate(f1);
      if (z1.length < bestIdat.length) bestIdat = z1;
    }

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const plte = new Uint8Array(pLen * 3);
    for (let i = 0; i < pLen; i++) { plte[i * 3] = pR[i]; plte[i * 3 + 1] = pG[i]; plte[i * 3 + 2] = pB[i]; }

    const parts = [new Uint8Array(SIG), chunk('IHDR', ihdr), chunk('PLTE', plte)];
    if (trnsLen > 0) parts.push(chunk('tRNS', pA.subarray(0, trnsLen)));
    parts.push(chunk('IDAT', bestIdat), chunk('IEND', new Uint8Array(0)));
    return Util.concat(parts);
  }

  /* Lossless 8-bit Gray / RGB / RGBA raw samples → valid PNG */
  async function encodeRaw(samples, width, height, channels) {
    if (!samples || !width || !height) return null;
    const colorType = channels === 1 ? 0 : channels === 3 ? 2 : channels === 4 ? 6 : -1;
    if (colorType < 0 || samples.length < width * height * channels) return null;
    const stride = width * channels;
    const filtered = refilter(samples, width, height, channels, stride, -1);
    const idat = await Util.deflate(filtered);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Util.concat([new Uint8Array(SIG), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
  }

  return { optimize, quantize, encodeRaw, parse, compressSamples, unfilter, refilter };
})();
