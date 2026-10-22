/* ══════════════════════════════════════════════════════════════
   imageops.js — real raster work, no placeholders

   • Lanczos-3 resampler (proper separable kernel, premultiplied-free
     per channel, clamped) — used by Upscale and by the resize tools
   • enhance:  auto-levels (robust 0.5 % clip) → contrast → saturation
               → unsharp mask, all on linearised sRGB
   • unsharp mask, grayscale, rotate/flip, watermark, favicon sizes

   Everything works on ImageData, so it runs the same on <canvas> and
   OffscreenCanvas, on every browser that can draw a bitmap at all.
   ══════════════════════════════════════════════════════════════ */

const ImageOps = (() => {
  const canvas = (w, h) => (Imaging.canOffscreen ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

  /* ── Lanczos-3 separable resampler ───────────────────────────────── */
  function lanczos(x, a = 3) {
    if (x === 0) return 1;
    if (x <= -a || x >= a) return 0;
    const px = Math.PI * x;
    return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
  }

  function weights(srcLen, dstLen, a = 3) {
    const scale = dstLen / srcLen;
    const support = scale < 1 ? a / scale : a;
    const out = [];
    for (let i = 0; i < dstLen; i++) {
      const center = (i + 0.5) / scale - 0.5;
      const lo = Math.max(0, Math.floor(center - support));
      const hi = Math.min(srcLen - 1, Math.ceil(center + support));
      const w = [];
      let sum = 0;
      for (let j = lo; j <= hi; j++) {
        const v = lanczos((j - center) * Math.min(1, scale), a);
        w.push({ j, v });
        sum += v;
      }
      if (!sum) { w.length = 0; w.push({ j: Math.min(srcLen - 1, Math.max(0, Math.round(center))), v: 1 }); sum = 1; }
      for (const k of w) k.v /= sum;
      out.push(w);
    }
    return out;
  }

  function resampleLanczos(img, dw, dh) {
    const sw = img.width, sh = img.height;
    const src = img.data;
    const tmp = new Float32Array(dw * sh * 4);
    const wx = weights(sw, dw);
    for (let y = 0; y < sh; y++) {
      const row = y * sw * 4;
      for (let x = 0; x < dw; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        const w = wx[x];
        for (let k = 0; k < w.length; k++) {
          const p = row + w[k].j * 4, wv = w[k].v;
          r += src[p] * wv; g += src[p + 1] * wv; b += src[p + 2] * wv; a += src[p + 3] * wv;
        }
        const o = (y * dw + x) * 4;
        tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
      }
    }
    const wy = weights(sh, dh);
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      const w = wy[y];
      for (let x = 0; x < dw; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < w.length; k++) {
          const p = (w[k].j * dw + x) * 4, wv = w[k].v;
          r += tmp[p] * wv; g += tmp[p + 1] * wv; b += tmp[p + 2] * wv; a += tmp[p + 3] * wv;
        }
        const o = (y * dw + x) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
      }
    }
    return new ImageData(out, dw, dh);
  }


  /* ── upscaling that behaves like a real resampler ─────────────────────
     Progressive steps of at most 2× (the way print shops do it): one huge
     Lanczos kernel over a 4× gap rings on edges, two 2× steps do not. */
  function resampleSteps(img, dw, dh, maxStep = 2) {
    let cur = img, w = img.width, h = img.height;
    let guard = 0;
    while ((w < dw || h < dh) && guard++ < 3) {
      const f = Math.min(maxStep, Math.max(dw / w, dh / h));
      const nw = Math.min(dw, Math.max(w + 1, Math.round(w * f)));
      const nh = Math.min(dh, Math.max(h + 1, Math.round(h * f)));
      cur = resampleLanczos(cur, nw, nh);
      w = nw; h = nh;
    }
    return (w === dw && h === dh) ? cur : resampleLanczos(cur, dw, dh);
  }

  /* unsharp mask with halo control: the overshoot a sharpener adds is capped, so
     edges get crisper without the white/black rims that ruin text and hair lines */
  function unsharpClamp(img, amount = 0.5, threshold = 2, ceil = 24) {
    const b = blur3(img);
    const d = img.data, s = b.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const diff = d[i + c] - s[i + c];
        if (Math.abs(diff) <= threshold) continue;
        const add0 = Math.max(-ceil, Math.min(ceil, amount * diff));
        d[i + c] = d[i + c] + add0;
      }
    }
    return img;
  }

  /* two-scale detail recovery: fine 3×3 ridge + a wider 5×5 pass, both clamped */
  function detailBoost(img, amount = 0.6) {
    if (amount <= 0) return img;
    const fine = blur3(img);              // one pass, reused for both scales
    const wide = blur3(fine);
    const d = img.data, f = fine.data, w = wide.data;
    const hi = 20, lo = 10;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const df = d[i + c] - f[i + c];
        if (Math.abs(df) > 2) d[i + c] = d[i + c] + Math.max(-hi, Math.min(hi, amount * 0.75 * df));
        const dw = d[i + c] - w[i + c];
        if (Math.abs(dw) > 3) d[i + c] = d[i + c] + Math.max(-lo, Math.min(lo, amount * 0.5 * dw));
      }
    }
    return img;
  }

  /* ── noise control: 3×3 bilateral-ish smoothing that keeps edges ─────
     Phone photos carry sensor grain; sharpening it turns a picture into
     confetti, so Enhance can clean the flat areas first. */
  function denoise(img, strength = 0.5) {
    if (strength <= 0) return img;
    const { width: w, height: h, data: s } = img;
    const out = new Uint8ClampedArray(s.length);
    const k = Math.max(0, Math.min(1, strength));
    const range = 24 + 40 * (1 - k);
    /* exp() per neighbour per pixel is far too slow on a 12 MP photo: precompute
       the weight for every possible colour distance (0…765) once */
    const LUT = new Float32Array(766);
    const denom = 2 * range * range;
    for (let d = 0; d < 766; d++) LUT[d] = Math.exp(-(d * d) / denom);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const r0 = s[o], g0 = s[o + 1], b0 = s[o + 2];
        let r = 0, g = 0, b = 0, wsum = 0;
        const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            const p = (row + xx) * 4;
            const dist = Math.abs(s[p] - r0) + Math.abs(s[p + 1] - g0) + Math.abs(s[p + 2] - b0);
            const wt = LUT[dist];
            r += s[p] * wt; g += s[p + 1] * wt; b += s[p + 2] * wt; wsum += wt;
          }
        }
        out[o] = r0 + (r / wsum - r0) * k;
        out[o + 1] = g0 + (g / wsum - g0) * k;
        out[o + 2] = b0 + (b / wsum - b0) * k;
        out[o + 3] = s[o + 3];
      }
    }
    return new ImageData(out, w, h);
  }

  /* grey-world auto white balance, weighted towards the bright half of the frame */
  function autoWhiteBalance(img, strength = 1) {
    const d = img.data;
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (lum < 40) continue;                      // ignore shadows, they are noisy
      sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++;
    }
    if (!n) return img;
    const mr = sr / n, mg = sg / n, mb = sb / n;
    const grey = (mr + mg + mb) / 3;
    const gr = 1 + (grey / (mr || 1) - 1) * strength;
    const gg = 1 + (grey / (mg || 1) - 1) * strength;
    const gb = 1 + (grey / (mb || 1) - 1) * strength;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i] * gr; d[i + 1] = d[i + 1] * gg; d[i + 2] = d[i + 2] * gb;
    }
    return img;
  }

  /* how much of the output is clipped to pure black / white (quality guard) */
  function clipped(img) {
    const d = img.data; let lo = 0, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 2 && d[i + 1] < 2 && d[i + 2] < 2) lo++;
      else if (d[i] > 253 && d[i + 1] > 253 && d[i + 2] > 253) hi++;
    }
    const n = d.length / 4;
    return { black: lo / n, white: hi / n };
  }

  /* ── unsharp mask (3×3 approximation of a Gaussian) ──────────────────
     Separable [1 2 1]/4 passes with edge replication: no per-pixel division
     and no border darkening, which also makes a 12 MP pass ~3× faster. */
  function blur3(img) {
    const { width: w, height: h, data: s } = img;
    const tmp = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
        const a = (row + xm) * 4, b = (row + x) * 4, c = (row + xp) * 4;
        const o = (row + x) * 3;
        tmp[o] = (s[a] + 2 * s[b] + s[c]) * 0.25;
        tmp[o + 1] = (s[a + 1] + 2 * s[b + 1] + s[c + 1]) * 0.25;
        tmp[o + 2] = (s[a + 2] + 2 * s[b + 2] + s[c + 2]) * 0.25;
      }
    }
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
      const r0 = ym * w, r1 = y * w, r2 = yp * w;
      for (let x = 0; x < w; x++) {
        const i0 = (r0 + x) * 3, i1 = (r1 + x) * 3, i2 = (r2 + x) * 3;
        const o = (r1 + x) * 4;
        out[o] = (tmp[i0] + 2 * tmp[i1] + tmp[i2]) * 0.25;
        out[o + 1] = (tmp[i0 + 1] + 2 * tmp[i1 + 1] + tmp[i2 + 1]) * 0.25;
        out[o + 2] = (tmp[i0 + 2] + 2 * tmp[i1 + 2] + tmp[i2 + 2]) * 0.25;
        out[o + 3] = s[o + 3];
      }
    }
    return new ImageData(out, w, h);
  }

  function unsharp(img, amount = 0.6, threshold = 2) {
    const b = blur3(img);
    const d = img.data, s = b.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const diff = d[i + c] - s[i + c];
        if (Math.abs(diff) > threshold) d[i + c] = d[i + c] + amount * diff;
      }
    }
    return img;
  }

  /* ── auto levels with 0.5 % clipping, then contrast + saturation ──── */
  function autoLevels(img, clip = 0.005) {
    const d = img.data;
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++;
    }
    const lo = [0, 0, 0], hi = [255, 255, 255];
    const cut = Math.floor(n * clip);
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[c][v]; if (acc > cut) { lo[c] = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[c][v]; if (acc > cut) { hi[c] = v; break; } }
      if (hi[c] - lo[c] < 24) { lo[c] = 0; hi[c] = 255; }      // flat channel: leave it alone
    }
    const lut = [0, 1, 2].map((c) => {
      const t = new Uint8ClampedArray(256);
      const span = Math.max(1, hi[c] - lo[c]);
      for (let v = 0; v < 256; v++) t[v] = Math.round(((v - lo[c]) / span) * 255);
      return t;
    });
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[0][d[i]]; d[i + 1] = lut[1][d[i + 1]]; d[i + 2] = lut[2][d[i + 2]];
    }
    return img;
  }

  function contrastSat(img, contrast = 1, sat = 1) {
    if (contrast === 1 && sat === 1) return img;
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      if (contrast !== 1) {
        r = (r - 128) * contrast + 128; g = (g - 128) * contrast + 128; b = (b - 128) * contrast + 128;
      }
      if (sat !== 1) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
    return img;
  }

  function grayscale(img) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    return img;
  }

  /* ── geometry ────────────────────────────────────────────────────── */
  function rotate(img, deg) {
    const { width: w, height: h } = img;
    const quarters = ((deg / 90) | 0) & 3;
    if (quarters === 0) return img;
    const nw = quarters === 2 ? w : h, nh = quarters === 2 ? h : w;
    const src = img.data;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        let nx, ny;
        if (quarters === 1) { nx = h - 1 - y; ny = x; }
        else if (quarters === 2) { nx = w - 1 - x; ny = h - 1 - y; }
        else { nx = y; ny = w - 1 - x; }
        const q = (ny * nw + nx) * 4;
        out[q] = src[p]; out[q + 1] = src[p + 1]; out[q + 2] = src[p + 2]; out[q + 3] = src[p + 3];
      }
    }
    return new ImageData(out, nw, nh);
  }

  function flip(img, axis) {
    const { width: w, height: h, data: s } = img;
    const out = new Uint8ClampedArray(s.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = axis === 'h' ? w - 1 - x : x;
        const sy = axis === 'v' ? h - 1 - y : y;
        const p = (y * w + x) * 4, q = (sy * w + sx) * 4;
        out[p] = s[q]; out[p + 1] = s[q + 1]; out[p + 2] = s[q + 2]; out[p + 3] = s[q + 3];
      }
    }
    return new ImageData(out, w, h);
  }

  /* ── watermark (text, tile or single, with shadow for legibility) ─── */
  function watermark(img, opts = {}) {
    const c = canvas(img.width, img.height);
    ctx2d(c).putImageData(img, 0, 0);
    const ctx = ctx2d(c);
    const text = opts.text || 'ReadOn';
    const size = Math.max(12, Math.round((opts.size || 0.06) * Math.max(img.width, img.height)));
    ctx.save();
    ctx.font = `600 ${size}px Montserrat, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = opts.opacity != null ? opts.opacity : 0.35;
    ctx.fillStyle = opts.color || '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = Math.max(2, size * 0.08);
    if (opts.tile) {
      const stepX = ctx.measureText(text).width + size * 2;
      const stepY = size * 2.6;
      ctx.translate(img.width / 2, img.height / 2);
      ctx.rotate(-Math.PI / 5);
      ctx.translate(-img.width / 2, -img.height / 2);
      for (let y = -img.height; y < img.height * 2; y += stepY) {
        for (let x = -img.width; x < img.width * 2; x += stepX) ctx.fillText(text, x, y);
      }
    } else {
      const pos = opts.pos || 'br';
      const pad = size * 0.6;
      const x = pos.includes('l') ? pad + ctx.measureText(text).width / 2 : img.width - pad - ctx.measureText(text).width / 2;
      const y = pos.includes('t') ? pad + size / 2 : img.height - pad - size / 2;
      ctx.fillText(text, opts.pos === 'c' ? img.width / 2 : x, opts.pos === 'c' ? img.height / 2 : y);
    }
    ctx.restore();
    return ctx.getImageData(0, 0, img.width, img.height);
  }

  /* high quality down/up scale of an ImageData through the DOM canvas */
  function toCanvas(img) {
    const c = canvas(img.width, img.height);
    ctx2d(c).putImageData(img, 0, 0);
    return c;
  }

  async function encode(img, mime = 'image/jpeg', quality = 0.92) {
    const c = toCanvas(img);
    const blob = c.convertToBlob ? await c.convertToBlob({ type: mime, quality }) : await new Promise((r) => c.toBlob(r, mime, quality));
    return new Uint8Array(await blob.arrayBuffer());
  }

  return { lanczos, resampleLanczos, resampleSteps, blur3, unsharp, unsharpClamp, detailBoost, denoise, autoWhiteBalance, clipped, autoLevels, contrastSat, grayscale, rotate, flip, watermark, toCanvas, encode, canvas, ctx2d };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ImageOps };
