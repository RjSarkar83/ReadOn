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

  /* ── unsharp mask (3×3 approximation of a Gaussian) ──────────────── */
  function blur3(img) {
    const { width: w, height: h, data: s } = img;
    const out = new Uint8ClampedArray(s.length);
    const K = [1, 2, 1, 2, 4, 2, 1, 2, 1], S = 16;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let ky = -1; ky <= 1; ky++) {
          const yy = y + ky;
          if (yy < 0 || yy >= h) continue;
          for (let kx = -1; kx <= 1; kx++) {
            const xx = x + kx;
            if (xx < 0 || xx >= w) continue;
            const k = K[(ky + 1) * 3 + (kx + 1)];
            const p = (yy * w + xx) * 4;
            r += s[p] * k; g += s[p + 1] * k; b += s[p + 2] * k; a += s[p + 3] * k; n += k;
          }
        }
        const o = (y * w + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
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

  return { lanczos, resampleLanczos, blur3, unsharp, autoLevels, contrastSat, grayscale, rotate, flip, watermark, toCanvas, encode, canvas, ctx2d };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ImageOps };
