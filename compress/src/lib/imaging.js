/* ══════════════════════════════════════════════════════════════
   imaging.js — browser raster pipeline
   decode → (optional) resample → encode, plus objective quality
   measurement (PSNR / SSIM) so every lossy decision is auditable.
   ══════════════════════════════════════════════════════════════ */

const Imaging = (() => {
  const canOffscreen = typeof OffscreenCanvas !== 'undefined';
  const canDom = typeof document !== 'undefined' && !!document.createElement;
  const hasCanvas = canOffscreen || canDom;

  function makeCanvas(w, h) {
    if (canOffscreen) {
      try { return new OffscreenCanvas(w, h); } catch (e) { /* iOS canvas limits → fall through */ }
    }
    if (!canDom) {
      const err = new Error('NO_CANVAS');
      err.code = 'NO_CANVAS';
      throw err;
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* iOS/Safari cap canvas area (≈16.7 Mpx); decode big images at a reduced size */
  const MAX_AREA = 16 * 1024 * 1024;
  function fitArea(w, h) {
    const area = w * h;
    if (area <= MAX_AREA) return [w, h];
    const k = Math.sqrt(MAX_AREA / area);
    return [Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k))];
  }

  async function decode(bytes, mime, opts = {}) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(blob);
        const [mw, mh] = fitArea(bmp.width, bmp.height);
        if (mw !== bmp.width && typeof createImageBitmap === 'function') {
          // re-decode straight to the smaller raster: no giant intermediate canvas
          try {
            bmp.close && bmp.close();
            const small = await createImageBitmap(blob, { resizeWidth: mw, resizeHeight: mh, resizeQuality: 'high' });
            return { bmp: small, width: small.width, height: small.height, close: () => small.close && small.close() };
          } catch (e) { /* keep the original */ }
        }
        return { bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() };
      } catch (e) { /* fall through */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('decode failed'));
        i.src = url;
      });
      return { bmp: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch (e) { URL.revokeObjectURL(url); throw e; }
  }

  function resample(src, tw, th, smooth = true) {
    const c = makeCanvas(tw, th);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = smooth;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, tw, th);
    return c;
  }

  async function encode(src, type, quality) {
    let canvas = src;
    if (!src || typeof src.getContext !== 'function') {          // ImageBitmap / <img>
      canvas = makeCanvas(src.width, src.height);
      canvas.getContext('2d').drawImage(src, 0, 0);
    }
    if (canvas.convertToBlob) {
      const b = await canvas.convertToBlob({ type, quality });
      return new Uint8Array(await b.arrayBuffer());
    }
    return new Promise((res) => canvas.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), type, quality));
  }

  /* PSNR + a fast global SSIM-style score between two images */
  function measure(aCanvas, bCanvas) {
    const w = 192, h = Math.max(1, Math.round(w * aCanvas.height / Math.max(1, aCanvas.width)));
    const A = resample(aCanvas, w, h).getContext('2d').getImageData(0, 0, w, h).data;
    const B = resample(bCanvas, w, h).getContext('2d').getImageData(0, 0, w, h).data;
    let mse = 0, n = 0;
    const lumA = [], lumB = [];
    for (let i = 0; i < A.length; i += 4) {
      const ya = 0.299 * A[i] + 0.587 * A[i + 1] + 0.114 * A[i + 2];
      const yb = 0.299 * B[i] + 0.587 * B[i + 1] + 0.114 * B[i + 2];
      lumA.push(ya); lumB.push(yb);
      for (let k = 0; k < 3; k++) { const d = A[i + k] - B[i + k]; mse += d * d; n++; }
    }
    mse /= n;
    const psnr = mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse);
    // global luminance SSIM (mean/variance/covariance)
    let ma = 0, mb = 0;
    for (let i = 0; i < lumA.length; i++) { ma += lumA[i]; mb += lumB[i]; }
    ma /= lumA.length; mb /= lumB.length;
    let va = 0, vb = 0, cov = 0;
    for (let i = 0; i < lumA.length; i++) {
      const da = lumA[i] - ma, db = lumB[i] - mb;
      va += da * da; vb += db * db; cov += da * db;
    }
    va /= lumA.length; vb /= lumB.length; cov /= lumA.length;
    const C1 = 6.5025, C2 = 58.5225;
    const ssim = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    return { psnr, ssim: Math.max(0, Math.min(1, ssim)) };
  }

  return { decode, resample, encode, measure, makeCanvas, hasCanvas, canOffscreen, fitArea, MAX_AREA };
})();
