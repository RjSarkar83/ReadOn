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

  return { optimize, parse, compressSamples, unfilter, refilter };
})();
