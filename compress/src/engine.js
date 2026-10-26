/* ══════════════════════════════════════════════════════════════
   engine.js — the compression brain
   Presets 10 / 25 / 50 / 75 / 90 %, Extreme, AND exact KB / MB
   byte budgets: always runs the lossless pass first, computes a
   genuinely progressive byte budget below both original AND
   lossless size, and climbs quality + resolution ladders (plus
   binary-search solvers & PDF page-raster fallback) so every
   single option produces a distinctly smaller output.
   ══════════════════════════════════════════════════════════════ */

const Compressor = (() => {
  const PRESETS = [
    { id: 'lossless', label: 'Lossless', target: 5, bitExact: true, hint: 'Bit-exact first · ≥5 % target · 98 % SSIM floor' },
    { id: 'p10', label: '10%', target: 10, hint: 'Visually lossless' },
    { id: 'p25', label: '25%', target: 25, hint: 'Light · print-safe' },
    { id: 'p50', label: '50%', target: 50, hint: 'Balanced' },
    { id: 'p75', label: '75%', target: 75, hint: 'Small · screen' },
    { id: 'p90', label: '90%', target: 90, hint: 'Aggressive · preview' },
    { id: 'extreme', label: 'Extreme', target: 95, hint: 'Smallest possible · web/social' }
  ];

  /* quality ladder — index 0 is the gentlest */
  const LADDER = [
    { q: 0.97, dim: 0 },
    { q: 0.95, dim: 0 },
    { q: 0.94, dim: 0 },
    { q: 0.90, dim: 0 },
    { q: 0.86, dim: 3200 },
    { q: 0.82, dim: 2600 },
    { q: 0.76, dim: 2200 },
    { q: 0.70, dim: 1800 },
    { q: 0.62, dim: 1500 },
    { q: 0.52, dim: 1280 },
    { q: 0.42, dim: 1050 },
    { q: 0.34, dim: 900 }
  ];

  const EXTREME_RUNGS = [
    { q: 0.28, dim: 780 },
    { q: 0.22, dim: 660 },
    { q: 0.16, dim: 540 }
  ];

  /* Per-preset ceilings ensure every option (10% → 25% → 50% → 75% → 90% → Extreme)
     produces a genuinely distinct, progressively smaller output — even when Rung 1 alone
     already drops a bloated 5 MB file by >50 %. */
  const PRESET_CEIL = {
    p10:     { maxQ: 0.94, maxDim: 0,    maxCols: 256, gentleKeep: 0.92 },
    p25:     { maxQ: 0.90, maxDim: 0,    maxCols: 160, gentleKeep: 0.78 },
    p50:     { maxQ: 0.86, maxDim: 2800, maxCols: 88,  gentleKeep: 0.56 },
    p75:     { maxQ: 0.74, maxDim: 1400, maxCols: 40,  gentleKeep: 0.34 },
    p90:     { maxQ: 0.52, maxDim: 1050, maxCols: 20,  gentleKeep: 0.18 },
    extreme: { maxQ: 0.28, maxDim: 760,  maxCols: 12,  gentleKeep: 0.09 }
  };

  const ladderFor = (preset) => {
    if (!preset) return LADDER;
    const all = preset.id === 'extreme' || preset.customBytes > 0 ? LADDER.concat(EXTREME_RUNGS)
      : preset.target >= 90 ? LADDER.concat(EXTREME_RUNGS.slice(0, 2))
      : preset.target >= 75 ? LADDER.concat(EXTREME_RUNGS.slice(0, 1))
      : LADDER;
    if (preset.bitExact || preset.customBytes > 0) return all;
    const ceil = PRESET_CEIL[preset.id];
    if (!ceil) return all;
    const filtered = all.filter(s => s.q <= ceil.maxQ + 0.001);
    return filtered.length ? filtered : all.slice(-2);
  };

  function needCanvas() {
    if (!Imaging.hasCanvas) {
      const e = new Error('NO_CANVAS');
      e.code = 'NO_CANVAS';
      throw e;
    }
  }

  const MIME = {
    jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic'
  };

  const ext = (name) => (name.split('.').pop() || '').toLowerCase();
  const base = (name) => name.replace(/\.[^.]+$/, '');

  async function gzip(bytes) {
    if (typeof CompressionStream !== 'undefined') {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (e) { /* fall through to the JS codec */ }
    }
    return JSCodec.gzip(bytes);
  }

  /* Progressive budget: guarantees 10% > 25% > 50% > 75% > 90% > Extreme even when
     a 5 MB file already drops to 3 MB during the lossless pass. */
  function effectiveBudget(originalSize, losslessSize, preset) {
    if (preset && preset.customBytes > 0) return Math.max(512, Math.floor(preset.customBytes));
    const rawBudget = Math.round(originalSize * (1 - preset.target / 100));
    if (!preset || preset.bitExact || !losslessSize) return rawBudget;
    const baseSz = Math.min(originalSize, losslessSize);
    const progBudget = Math.round(baseSz * (1 - (preset.target * 0.85) / 100));
    return Math.max(512, Math.min(rawBudget, progBudget));
  }

  function result(f, bytes, opts = {}) {
    const kind = opts.kind || (opts.lossless ? 'lossless' : 'lossy');
    return {
      name: f.name, size: f.size, bytes, outName: opts.outName || f.name,
      type: opts.type || 'file', kind, lossless: kind === 'lossless', path: opts.path || '',
      notes: opts.notes || [], psnr: opts.psnr, ssim: opts.ssim,
      saved: 1 - bytes.length / f.size
    };
  }

  function flattenWhite(src, w, h) {
    const c = Imaging.makeCanvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = '#FFFFFF';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);
    return c;
  }

  /* ══════════ exact byte-budget image solver ══════════ */
  async function solveImageBudget(dec, alpha, kind, budget, forcedFmt, o, report, ceil) {
    const origMax = Math.max(dec.width, dec.height);
    let capDim = o.maxDim > 0 ? Math.min(origMax, o.maxDim) : origMax;
    if (ceil && ceil.maxDim > 0) capDim = Math.min(capDim, ceil.maxDim);
    const scales = [1.0, 0.82, 0.66, 0.52, 0.40, 0.30, 0.22, 0.16, 0.11, 0.08];

    let formats;
    if (forcedFmt === 'jpeg') formats = ['jpeg'];
    else if (forcedFmt === 'png') formats = ['png'];
    else if (forcedFmt === 'webp') formats = ['webp'];
    else if (o.allowWebp) formats = ['webp', alpha ? 'png' : 'jpeg'];
    else if (alpha) formats = ['png', 'webp'];
    else if (kind === 'webp') formats = ['webp'];
    else if (kind === 'png') formats = ['png', 'jpeg'];
    else formats = ['jpeg'];

    let fallbackSmallest = null;

    for (const fmt of formats) {
      if (fmt === 'png') {
        const basePal = [256, 160, 88, 40, 20, 12];
        const palSteps = ceil ? basePal.filter(c => c <= ceil.maxCols) : basePal;
        if (!palSteps.length) palSteps.push(12);
        for (let si = 0; si < scales.length; si++) {
          const longEdge = Math.max(Math.min(80, origMax), Math.round(capDim * scales[si]));
          const sc = longEdge < origMax ? longEdge / origMax : 1;
          const w = Math.max(1, Math.round(dec.width * sc));
          const h = Math.max(1, Math.round(dec.height * sc));
          if (si > 0 && w === dec.width && h === dec.height) continue;
          report && report(`png ${w}×${h}`);
          const canvas = Imaging.resample(dec.bmp, w, h);
          const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
          for (const cols of palSteps) {
            const qBytes = await PNGCodec.quantize(rgba, w, h, cols);
            if (!qBytes) continue;
            if (!fallbackSmallest || qBytes.length < fallbackSmallest.bytes.length) {
              fallbackSmallest = { bytes: qBytes, ext: 'png', mode: 'png8', cols, w, h, mime: 'image/png' };
            }
            if (qBytes.length <= budget) {
              const score = await scoreCanvas(dec.bmp, canvas, qBytes, 'image/png');
              return { bytes: qBytes, ext: 'png', mode: 'png8', cols, w, h, mime: 'image/png', psnr: score.psnr, ssim: score.ssim };
            }
          }
          if (longEdge <= 80) break;
        }
        continue;
      }

      const mime = fmt === 'webp' ? 'image/webp' : 'image/jpeg';
      const outExt = fmt === 'webp' ? 'webp' : 'jpg';
      const hiCap = ceil ? Math.min(0.92, ceil.maxQ) : 0.92;
      for (let si = 0; si < scales.length; si++) {
        const longEdge = Math.max(Math.min(80, origMax), Math.round(capDim * scales[si]));
        const sc = longEdge < origMax ? longEdge / origMax : 1;
        const w = Math.max(1, Math.round(dec.width * sc));
        const h = Math.max(1, Math.round(dec.height * sc));
        if (si > 0 && w === dec.width && h === dec.height) continue;
        report && report(`${outExt} ${w}×${h}`);
        const canvas = (fmt === 'jpeg' && alpha) ? flattenWhite(dec.bmp, w, h) : Imaging.resample(dec.bmp, w, h);

        const hiBytes = await Imaging.encode(canvas, mime, hiCap);
        if (hiBytes.length <= budget) {
          const score = await scoreCanvas(dec.bmp, canvas, hiBytes, mime);
          return { bytes: hiBytes, ext: outExt, mode: fmt, q: hiCap, w, h, mime, psnr: score.psnr, ssim: score.ssim };
        }

        const minQ = si >= scales.length - 2 ? 0.06 : 0.12;
        const loBytes = await Imaging.encode(canvas, mime, minQ);
        if (!fallbackSmallest || loBytes.length < fallbackSmallest.bytes.length) {
          fallbackSmallest = { bytes: loBytes, ext: outExt, mode: fmt, q: minQ, w, h, mime, canvas };
        }

        if (loBytes.length <= budget) {
          let lo = minQ, hi = hiCap, bestBytes = loBytes, bestQ = minQ;
          for (let iter = 0; iter < 6; iter++) {
            const mid = +((lo + hi) / 2).toFixed(3);
            const enc = await Imaging.encode(canvas, mime, mid);
            if (enc.length <= budget) {
              bestBytes = enc; bestQ = mid; lo = mid;
            } else {
              hi = mid;
            }
          }
          const score = await scoreCanvas(dec.bmp, canvas, bestBytes, mime);
          return { bytes: bestBytes, ext: outExt, mode: fmt, q: bestQ, w, h, mime, psnr: score.psnr, ssim: score.ssim };
        }
        if (longEdge <= 80) break;
      }
    }

    if (fallbackSmallest) {
      const c = fallbackSmallest.canvas || Imaging.resample(dec.bmp, fallbackSmallest.w, fallbackSmallest.h);
      const score = await scoreCanvas(dec.bmp, c, fallbackSmallest.bytes, fallbackSmallest.mime);
      return Object.assign(fallbackSmallest, { psnr: score.psnr, ssim: score.ssim });
    }
    return null;
  }

  /* ══════════ images ══════════ */
  async function losslessImage(bytes, kind) {
    if (kind === 'png') {
      const r = await PNGCodec.optimize(bytes);
      return r ? { bytes: r.bytes, notes: r.dropped.length ? ['removed ' + r.dropped.join(', ')] : [], method: r.method } : { bytes, notes: [] };
    }
    if (kind === 'jpeg') {
      const r = JPEGCodec.stripLossless(bytes);
      if (r && r.bytes.length < bytes.length) {
        return { bytes: r.bytes, notes: r.dropped.length ? ['removed ' + r.dropped.join(', ')] : [] };
      }
      return { bytes, notes: [] };
    }
    return { bytes, notes: [] };
  }

  async function processImage(f, bytes, kind, preset, o, report) {
    const notes = [];
    const forcedFmt = o.outFormat && o.outFormat !== 'auto' ? o.outFormat : null;
    const isCustom = preset.customBytes > 0;

    // 1 — always try lossless first (when format is not forcibly changed)
    const sameFmt = !forcedFmt || (forcedFmt === 'jpeg' && kind === 'jpeg') || (forcedFmt === 'png' && kind === 'png') || (forcedFmt === 'webp' && kind === 'webp');
    const ll = sameFmt ? await losslessImage(bytes, kind) : { bytes, notes: [] };
    const best = { bytes: ll.bytes, lossless: true, notes: ll.notes.slice() };
    if (sameFmt) notes.push(...ll.notes);

    const budget = effectiveBudget(f.size, best.bytes.length, preset);

    if (sameFmt && isCustom && best.bytes.length <= budget) {
      notes.push(`fits under ${Util.fmtBytes(budget)} losslessly`);
      return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });
    }
    if (sameFmt && preset.bitExact && (preset.target === 0 || best.bytes.length <= budget)) {
      return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });
    }
    if (sameFmt && !isCustom && !preset.bitExact && best.bytes.length <= budget) {
      return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });
    }
    needCanvas();

    // 2 — decode pixels
    let dec;
    try { dec = await Imaging.decode(best.bytes, MIME[ext(f.name)] || 'image/png'); }
    catch (e) { return result(f, best.bytes, { type: 'image', kind: 'lossless', notes: notes.concat('unsupported raster — kept as is') }); }

    const alpha = await hasAlpha(dec);

    // 2b — Exact KB / MB budget mode uses binary-search solver
    if (isCustom) {
      const hit = await solveImageBudget(dec, alpha, kind, budget, forcedFmt, o, report);
      dec.close && dec.close();
      if (!hit) return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });
      const outName = base(f.name) + '.' + hit.ext;
      notes.push(
        hit.mode === 'jpeg' ? `re-encoded JPEG q${Math.round(hit.q * 100)}`
        : hit.mode === 'webp' ? `re-encoded WebP q${Math.round(hit.q * 100)}`
        : `quantised 8-bit PNG (${hit.cols} colours)`
      );
      if (hit.w !== dec.width || hit.h !== dec.height) notes.push(`resampled to ${hit.w}×${hit.h}`);
      if (hit.bytes.length <= budget) notes.push(`target ≤ ${Util.fmtBytes(budget)} reached`);
      else notes.push(`minimum safe size reached (target ${Util.fmtBytes(budget)})`);
      return result(f, hit.bytes, { type: 'image', kind: 'lossy', notes, outName, psnr: hit.psnr, ssim: hit.ssim });
    }

    // 3 — Standard preset ladder (never aborts early on SSIM unless lossless bitExact)
    const ladder = preset.bitExact ? LADDER.slice(0, 5) : ladderFor(preset);
    const ceil = (!preset.bitExact && !isCustom) ? PRESET_CEIL[preset.id] : null;
    const wantWebp = forcedFmt === 'webp' || (!forcedFmt && (o.allowWebp || preset.id === 'extreme'));
    const ssimFloor = preset.bitExact ? 0.99 : 0.72;

    const src = await Imaging.resample(dec.bmp, dec.width, dec.height);
    let chosen = null, pngWorth = true, rung = 0;

    needCanvas();
    for (const step of ladder) {
      report && report(step.q);
      const rawCap = Math.min(step.dim || 1e9, o.maxDim || 1e9, (ceil && ceil.maxDim) || 1e9);
      const dim = rawCap < 1e9 ? rawCap : 0;
      const scale = dim && Math.max(dec.width, dec.height) > dim ? dim / Math.max(dec.width, dec.height) : 1;
      const w = Math.max(1, Math.round(dec.width * scale));
      const h = Math.max(1, Math.round(dec.height * scale));
      const canvas = scale < 1 ? Imaging.resample(dec.bmp, w, h) : src;

      const cand = [];
      rung++;

      const allowPng = forcedFmt === 'png' || (!forcedFmt && (kind === 'png' || kind === 'gif' || kind === 'bmp'));
      if (allowPng && (rung === 1 || pngWorth || alpha || forcedFmt === 'png')) {
        if (preset.bitExact) {
          const png = await Imaging.encode(canvas, 'image/png');
          cand.push({ bytes: png, ext: 'png', mode: 'png', usew: w, useh: h, mime: 'image/png' });
          if (rung === 1) pngWorth = png.length < (o.pngBudget || 4 * 1024 * 1024);
        } else {
          const baseCols = step.q >= 0.88 ? 256 : step.q >= 0.68 ? 128 : step.q >= 0.42 ? 64 : step.q >= 0.25 ? 32 : 16;
          const cols = ceil ? Math.min(baseCols, ceil.maxCols) : baseCols;
          if (rung === 1 || scale < 1 || cols < 256) {
            const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
            const qpng = await PNGCodec.quantize(rgba, w, h, cols);
            if (qpng) cand.push({ bytes: qpng, ext: 'png', mode: 'png8', cols, usew: w, useh: h, mime: 'image/png' });
            if (rung === 1) {
              pngWorth = (qpng ? qpng.length : Infinity) < (o.pngBudget || 6 * 1024 * 1024);
            }
          }
        }
      }

      const allowJpeg = forcedFmt === 'jpeg' || (!forcedFmt && !alpha);
      if (allowJpeg) {
        const jCanvas = (forcedFmt === 'jpeg' && alpha) ? flattenWhite(dec.bmp, w, h) : canvas;
        const jpeg = await Imaging.encode(jCanvas, 'image/jpeg', step.q);
        cand.push({ bytes: jpeg, ext: 'jpg', mode: 'jpeg', usew: w, useh: h, mime: 'image/jpeg' });
      }

      if (wantWebp) {
        const webp = await Imaging.encode(canvas, 'image/webp', Math.min(0.97, step.q + 0.05));
        cand.push({ bytes: webp, ext: 'webp', mode: 'webp', usew: w, useh: h, mime: 'image/webp' });
      }

      cand.sort((a, b) => a.bytes.length - b.bytes.length);
      if (!cand.length) continue;

      let rec = null, weak = null;
      for (const c of cand) {
        const sc = await scoreCanvas(dec.bmp, canvas, c.bytes, c.mime);
        const r = { ...c, step, psnr: sc.psnr, ssim: sc.ssim };
        if (typeof r.ssim !== 'number' || r.ssim >= ssimFloor) { rec = r; break; }
        weak = weak || r;
      }
      if (!rec) rec = weak;

      const meets = rec.bytes.length <= budget;
      // Only abort on SSIM floor in strict/lossless bitExact mode
      if (preset.bitExact && typeof rec.ssim === 'number' && rec.ssim < 0.98 && chosen) break;
      if (meets) { chosen = rec; break; }
      if (!chosen || rec.bytes.length < chosen.bytes.length) chosen = rec;
    }

    // 3b — If standard ladder still exceeded budget on 25%+ (e.g. 5 MB transparent PNG or huge 5 MB image),
    // engage the binary-search solver so the chosen preset ALWAYS reaches its progressive size!
    if (!preset.bitExact && (!chosen || chosen.bytes.length > budget * 1.12)) {
      const hit = await solveImageBudget(dec, alpha, kind, budget, forcedFmt, o, report);
      if (hit && (!chosen || hit.bytes.length < chosen.bytes.length)) {
        dec.close && dec.close();
        const outName = base(f.name) + '.' + hit.ext;
        notes.push(
          hit.mode === 'jpeg' ? `re-encoded JPEG q${Math.round(hit.q * 100)}`
          : hit.mode === 'webp' ? `re-encoded WebP q${Math.round(hit.q * 100)}`
          : `quantised 8-bit PNG (${hit.cols} colours)`
        );
        if (hit.w !== dec.width || hit.h !== dec.height) notes.push(`resampled to ${hit.w}×${hit.h}`);
        return result(f, hit.bytes, { type: 'image', kind: 'lossy', notes, outName, psnr: hit.psnr, ssim: hit.ssim });
      }
    }

    dec.close && dec.close();
    if (!chosen) return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });

    if (preset.bitExact && typeof chosen.ssim === 'number' && chosen.ssim < 0.98) {
      notes.push(`★ SSIM ${(chosen.ssim * 100).toFixed(2)} % — below the 98 % floor, kept bit-exact`);
      return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });
    }
    const improve = !sameFmt || chosen.bytes.length < best.bytes.length * 0.98;
    if (!improve) {
      notes.push('no pixel-safe path to the target — kept the untouched encode');
      return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });
    }

    const outName = base(f.name) + '.' + chosen.ext;
    notes.push(
      chosen.mode === 'jpeg' ? `re-encoded JPEG q${Math.round(chosen.step.q * 100)}`
      : chosen.mode === 'webp' ? 're-encoded WebP'
      : chosen.mode === 'png8' ? `quantised 8-bit PNG (${chosen.cols} colours)`
      : 're-encoded PNG'
    );
    if (chosen.step.dim && Math.max(src.width, src.height) > chosen.step.dim) notes.push(`resampled to ${chosen.usew}×${chosen.useh}`);
    const pngExact = chosen.mode === 'png' && !(chosen.step.dim && Math.max(src.width, src.height) > chosen.step.dim);
    const fid = pngExact ? 'lossless' : preset.bitExact ? 'near' : 'lossy';
    if (fid === 'near') notes.push('no resampling · SSIM floor 98 %');
    return result(f, chosen.bytes, {
      type: 'image', kind: fid, notes, outName,
      psnr: chosen.psnr, ssim: chosen.ssim
    });
  }

  async function hasAlpha(dec) {
    const c = Imaging.resample(dec.bmp, Math.min(96, dec.width), Math.min(96, dec.height));
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let transPixels = 0;
    const total = d.length >> 2;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 246) transPixels++;
    return transPixels > Math.max(1, Math.floor(total * 0.001));
  }

  async function scoreCanvas(original, canvas, encodedBytes, mime) {
    try {
      const dec = await Imaging.decode(encodedBytes, mime || 'image/jpeg');
      const c2 = Imaging.resample(dec.bmp, canvas.width, canvas.height);
      const m = Imaging.measure(original, c2);
      dec.close && dec.close();
      return m;
    } catch (e) { return { psnr: undefined, ssim: undefined }; }
  }

  /* ══════════ PDF ══════════ */
  function pdfPolicy(preset, o) {
    const heavy = preset.target;
    return {
      stripText: o.pdfText === 'on' || (o.pdfText !== 'off' && !preset.bitExact && heavy >= 25),
      stripAnnots: o.pdfAnnots === 'on' || (o.pdfAnnots !== 'off' && heavy >= 50),
      stripBookmarks: o.pdfBookmarks === 'on' || (o.pdfBookmarks !== 'off' && heavy >= 75),
      stripStructure: o.pdfBookmarks === 'on' || (o.pdfBookmarks !== 'off' && heavy >= 75),
      stripAttachments: o.pdfAttachments === 'on' || (o.pdfAttachments !== 'off' && heavy >= 50)
    };
  }

  /* Load local vendor/pdf.min.js cleanly from /, /compress/, /ReadOn/compress/, file://, or CDN fallback */
  let pdfjsReady = null, pdfjsWorkerSrc = '', pdfjsMainThreadReady = null;
  function loadScriptOnce(src) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => { s.remove(); resolve(false); };
      document.head.appendChild(s);
    });
  }
  function ensurePdfJs() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(null);
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = (async () => {
      const bases = (/\/compress(\/|$)/.test(location.pathname)
        ? ['../vendor/', './vendor/', 'vendor/']
        : ['./vendor/', 'vendor/', '../vendor/']
      ).concat(['https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/']);
      for (const base of bases) {
        const ok = await loadScriptOnce(base + 'pdf.min.js');
        if (ok && window.pdfjsLib) {
          pdfjsWorkerSrc = base + 'pdf.worker.min.js';
          if (window.pdfjsLib.GlobalWorkerOptions) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerSrc;
          }
          // On file:// protocol, Chrome blocks new Worker('file:///...'). Preload main-thread worker handler.
          if (location.protocol === 'file:' && !window.pdfjsWorker) {
            await loadScriptOnce(pdfjsWorkerSrc);
          }
          return window.pdfjsLib;
        }
      }
      pdfjsReady = null;
      return null;
    })();
    return pdfjsReady;
  }
  async function openPdfJsDoc(pdfjs, bytes) {
    const baseParams = { data: bytes.slice(), isEvalSupported: false, disableAutoFetch: true, disableStream: true };
    try {
      return await pdfjs.getDocument(baseParams).promise;
    } catch (e1) {
      // Fallback: load pdf.worker.min.js onto main thread (sets window.pdfjsWorker) for file:// or strict CSP
      if (pdfjsWorkerSrc && !window.pdfjsWorker) {
        if (!pdfjsMainThreadReady) pdfjsMainThreadReady = loadScriptOnce(pdfjsWorkerSrc);
        await pdfjsMainThreadReady;
      }
      try {
        return await pdfjs.getDocument(Object.assign({}, baseParams, { disableWorker: true })).promise;
      } catch (e2) {
        return null;
      }
    }
  }

  function buildRasterPdf(pages) {
    const parts = [];
    const offsets = [0];
    let pos = 0;
    const pushStr = (s) => { const u = Util.unlatin1(s); parts.push(u); pos += u.length; };
    const pushBytes = (u) => { parts.push(u); pos += u.length; };

    pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const nPages = pages.length;
    const kidsRefs = [];
    for (let i = 0; i < nPages; i++) kidsRefs.push(`${3 + i * 3} 0 R`);

    offsets.push(pos);
    pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    offsets.push(pos);
    pushStr(`2 0 obj\n<< /Type /Pages /Count ${nPages} /Kids [${kidsRefs.join(' ')}] >>\nendobj\n`);

    for (let i = 0; i < nPages; i++) {
      const p = pages[i];
      const pageObj = 3 + i * 3;
      const contentObj = pageObj + 1;
      const imgObj = pageObj + 2;
      const content = `q ${p.ptW.toFixed(2)} 0 0 ${p.ptH.toFixed(2)} 0 0 cm /Im0 Do Q`;

      offsets.push(pos);
      pushStr(`${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.ptW.toFixed(2)} ${p.ptH.toFixed(2)}] /Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);

      offsets.push(pos);
      pushStr(`${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

      offsets.push(pos);
      pushStr(`${imgObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      pushBytes(p.jpeg);
      pushStr('\nendstream\nendobj\n');
    }

    const xrefPos = pos;
    const totalObjs = offsets.length;
    let xref = `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
    for (let i = 1; i < totalObjs; i++) {
      xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    xref += `trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    pushStr(xref);
    return Util.concat(parts);
  }

  let lastPdfPageCache = null;

  async function getMasterRasterPages(bytes, report) {
    const headLen = Math.min(bytes.length, 65536);
    const tailOff = Math.max(0, bytes.length - 65536);
    const cacheKey = `${bytes.length}:${Util.crc32(bytes.subarray(0, headLen))}:${Util.crc32(bytes.subarray(tailOff))}`;
    if (lastPdfPageCache && lastPdfPageCache.key === cacheKey) {
      return lastPdfPageCache.pages;
    }

    const pdfjs = await ensurePdfJs();
    if (!pdfjs) return null;
    const doc = await openPdfJsDoc(pdfjs, bytes);
    if (!doc) return null;
    const nPages = doc.numPages;
    if (!nPages || nPages > 2500) { try { doc.destroy(); } catch (e) {} return null; }

    const masterScale = nPages > 160 ? 0.96 : nPages > 70 ? 1.16 : nPages > 25 ? 1.34 : 1.52;
    const workCanvas = Imaging.makeCanvas(64, 64);
    const pages = [];
    let totalCachedBytes = 0;

    try {
      for (let p = 1; p <= nPages; p++) {
        if (p === 1 || p === nPages || p % 3 === 0) report && report(`render ${p}/${nPages}`);
        let ptW = 595.28, ptH = 841.89, effScale = masterScale;
        let w = 595, h = 842;
        try {
          const page = await doc.getPage(p);
          const vp1 = page.getViewport({ scale: 1 });
          ptW = vp1.width || 595.28;
          ptH = vp1.height || 841.89;
          const maxLong = Math.max(ptW, ptH) * masterScale;
          effScale = maxLong > 2200 ? masterScale * (2200 / maxLong) : masterScale;
          const vp = page.getViewport({ scale: effScale });
          w = Math.max(48, Math.round(vp.width));
          h = Math.max(48, Math.round(vp.height));
          workCanvas.width = w;
          workCanvas.height = h;
          const ctx = workCanvas.getContext('2d', { alpha: false });
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
          try {
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
          } catch (renderErr) { /* keep partial page paint rather than aborting entire PDF */ }
          try { page.cleanup && page.cleanup(); } catch (e) {}
        } catch (pageErr) {
          workCanvas.width = w; workCanvas.height = h;
          const ctx = workCanvas.getContext('2d', { alpha: false });
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
        }
        const masterJpg = await Imaging.encode(workCanvas, 'image/jpeg', 0.89);
        totalCachedBytes += masterJpg.length;
        pages.push({ masterJpg, w, h, ptW, ptH, scale: effScale });
        if (p % 2 === 0) await new Promise(r => setTimeout(r, 0));
      }
    } finally {
      workCanvas.width = 1; workCanvas.height = 1;
      try { doc.destroy(); } catch (e) {}
    }

    if (!pages.length) return null;
    if (totalCachedBytes <= 56 * 1024 * 1024) {
      lastPdfPageCache = { key: cacheKey, pages };
    }
    return pages;
  }

  async function rasterizePdfToBudget(bytes, budget, preset, report) {
    const masterPages = await getMasterRasterPages(bytes, report);
    if (!masterPages || !masterPages.length) return null;
    const nPages = masterPages.length;

    const isCustom = !!(preset && preset.customBytes > 0);
    const perPageBudget = Math.max(1500, Math.floor((budget - 600 - nPages * 340) / nPages));

    // Distinct per-preset DPI scale & JPEG quality ceilings so every option (10% → Extreme)
    // produces a genuinely distinct size, while reusing compressed master JPEGs across variants!
    const pagePenalty = nPages > 160 ? 0.72 : nPages > 70 ? 0.85 : 1.0;
    let initScale, qCeil;
    if (isCustom) {
      initScale = (perPageBudget > 220000 ? 1.50
        : perPageBudget > 100000 ? 1.22
        : perPageBudget > 45000 ? 0.96
        : perPageBudget > 20000 ? 0.72
        : perPageBudget > 9000 ? 0.54 : 0.40) * pagePenalty;
      qCeil = 0.86;
    } else if (preset && preset.id === 'extreme') {
      initScale = 0.46 * pagePenalty; qCeil = 0.25;
    } else if (preset && preset.target >= 90) {
      initScale = 0.64 * pagePenalty; qCeil = 0.39;
    } else if (preset && preset.target >= 75) {
      initScale = 0.86 * pagePenalty; qCeil = 0.55;
    } else if (preset && preset.target >= 50) {
      initScale = 1.10 * pagePenalty; qCeil = 0.69;
    } else if (preset && preset.target >= 25) {
      initScale = 1.34 * pagePenalty; qCeil = 0.80;
    } else {
      initScale = 1.52 * pagePenalty; qCeil = 0.88;
    }
    initScale = Math.max(0.26, +initScale.toFixed(2));

    const encodePass = async (targetScale, maxQ, minQ) => {
      const pagesOut = [];
      for (let i = 0; i < nPages; i++) {
        const mp = masterPages[i];
        if (i === 0 || i === nPages - 1 || i % 5 === 0) report && report(`pack ${i + 1}/${nPages}`);
        const rel = Math.min(1, targetScale / Math.max(0.1, mp.scale));
        const w = Math.max(48, Math.round(mp.w * rel));
        const h = Math.max(48, Math.round(mp.h * rel));
        const dec = await Imaging.decode(mp.masterJpg, 'image/jpeg');
        let bestJpg;
        try {
          const cv = Imaging.resample(dec.bmp, w, h);
          bestJpg = await Imaging.encode(cv, 'image/jpeg', maxQ);
          if (bestJpg.length > perPageBudget && maxQ > minQ + 0.02) {
            const loJpg = await Imaging.encode(cv, 'image/jpeg', minQ);
            if (loJpg.length >= perPageBudget) {
              bestJpg = loJpg;
            } else {
              bestJpg = loJpg;
              let lo = minQ, hi = maxQ;
              for (let it = 0; it < 4; it++) {
                const mid = +((lo + hi) / 2).toFixed(3);
                const enc = await Imaging.encode(cv, 'image/jpeg', mid);
                if (enc.length <= perPageBudget) { bestJpg = enc; lo = mid; }
                else hi = mid;
              }
            }
          }
        } finally {
          dec.close && dec.close();
        }
        pagesOut.push({ jpeg: bestJpg, w, h, ptW: mp.ptW, ptH: mp.ptH });
        if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
      }
      return buildRasterPdf(pagesOut);
    };

    const minQ1 = preset && preset.id === 'extreme' ? 0.12 : 0.20;
    let bestPdf = await encodePass(initScale, qCeil, minQ1);
    if (bestPdf && bestPdf.length > budget * (isCustom ? 1.0 : 1.15) && initScale > 0.32) {
      const ratio = Math.sqrt(budget / Math.max(1, bestPdf.length)) * 0.86;
      const nextScale = Math.max(0.24, +(initScale * Math.min(0.72, Math.max(0.35, ratio))).toFixed(2));
      if (nextScale < initScale - 0.04) {
        const pass2 = await encodePass(nextScale, Math.min(qCeil, 0.60), 0.10);
        if (pass2 && pass2.length < bestPdf.length) bestPdf = pass2;
      }
    }
    return bestPdf;
  }

  async function processPDF(f, bytes, preset, o, report) {
    const notes = [];
    const pol = pdfPolicy(preset, o);
    const isCustom = preset.customBytes > 0;
    const rawBudget = isCustom ? Math.max(1024, Math.floor(preset.customBytes))
      : (preset.target > 0 ? Math.floor(f.size * (1 - preset.target / 100)) : 0);

    const flattenAlpha = !preset.bitExact && (isCustom || preset.target >= 10);
    const allLossyLevels = [
      { q: 0.94, dim: 0, flattenAlpha }, { q: 0.90, dim: 3200, flattenAlpha },
      { q: 0.86, dim: 2600, flattenAlpha }, { q: 0.80, dim: 2200, flattenAlpha }, { q: 0.70, dim: 1800, flattenAlpha },
      { q: 0.60, dim: 1500, flattenAlpha }, { q: 0.45, dim: 1120, flattenAlpha }, { q: 0.34, dim: 900, flattenAlpha },
      { q: 0.28, dim: 760, flattenAlpha: true }, { q: 0.22, dim: 640, flattenAlpha: true },
      { q: 0.16, dim: 520, flattenAlpha: true }, { q: 0.12, dim: 420, flattenAlpha: true }
    ];
    const pCeil = (!preset.bitExact && !isCustom) ? PRESET_CEIL[preset.id] : null;
    const filteredPdfLevels = pCeil ? allLossyLevels.filter(l => l.q <= pCeil.maxQ + 0.001) : allLossyLevels;
    const levels = preset.bitExact
      ? (preset.target === 0
        ? [{ q: 0, dim: 0, label: 'lossless raster', flattenAlpha: false }]
        : [{ q: 0, dim: 0, label: 'lossless raster', flattenAlpha: false }, { q: 0.97, dim: 0, flattenAlpha: false }, { q: 0.95, dim: 0, flattenAlpha: false }])
      : (isCustom ? [{ q: 0, dim: 0, label: 'lossless raster', flattenAlpha: false }].concat(allLossyLevels)
        : filteredPdfLevels);

    const cache = new Map();
    const encode = (job, level) => encodePdfImage(job, level, cache, o);
    const opts = Object.assign({}, pol, {
      recompressImage: null,
      imageLevels: levels,
      imageEncode: encode,
      targetBytes: rawBudget,
      targetPct: preset.bitExact ? 0 : preset.target,
      customBytes: isCustom ? rawBudget : 0
    });

    report && report('structural rebuild');
    let workBytes = bytes;
    let res = await PDFEngine.optimize(workBytes, opts);
    if (res.warnings && res.warnings.some(w => /Password-protected/i.test(w)) && typeof PDFEdit !== 'undefined' && PDFEdit.unlock) {
      try {
        const unl = await PDFEdit.unlock(bytes, '');
        if (unl && unl.bytes && !unl.unchanged) {
          workBytes = unl.bytes;
          notes.push('owner lock removed');
          res = await PDFEngine.optimize(workBytes, opts);
        }
      } catch (e) { /* requires open password */ }
    }
    let stats = res.stats || {};

    const effBudget = effectiveBudget(f.size, res.bytes.length < f.size && !stats.imagesLossy ? res.bytes.length : f.size, preset);

    if ((preset.target > 0 || isCustom) && !preset.bitExact && res.bytes.length > effBudget && !pol.stripText && o.pdfText !== 'off') {
      report && report('text layer');
      const res2 = await PDFEngine.optimize(workBytes, Object.assign({}, opts, { stripText: true }));
      if (res2.bytes.length < res.bytes.length) { res = res2; stats = res2.stats || {}; }
    }
    closeCache(cache);

    // Universal fallback for stubborn PDFs (JPXDecode, CCITT/JBIG2 scans, Form XObjects, heavy fonts/vectors):
    // When pdfText !== 'off' and structural/XObject pass is stuck above the target budget on 10%+ or Custom KB/MB,
    // stream-render pages via pdf.js and JPEG-optimise to reach the progressive target!
    const stuckHeavyPdf = workBytes.length > 512 * 1024 && !stats.imagesLossy && res.bytes.length > effBudget * 1.25 && (isCustom || preset.target >= 25);
    const allowPageRaster = (o.pdfText !== 'off' || stuckHeavyPdf) && !preset.bitExact && (isCustom || (preset.target >= 10 && workBytes.length > 45 * 1024));
    if (allowPageRaster && res.bytes.length > effBudget * 1.10) {
      if (typeof document === 'undefined') {
        const err = new Error('NO_CANVAS');
        err.code = 'NO_CANVAS';
        throw err;
      }
      const rast = await rasterizePdfToBudget(workBytes, effBudget, preset, report);
      if (rast && rast.length < res.bytes.length * 0.95) {
        const hitNote = rast.length <= effBudget ? `target ≤ ${Util.fmtBytes(effBudget)} reached` : `packed to smallest readable PDF`;
        return result(f, rast, {
          type: 'pdf', kind: 'lossy',
          notes: [`pages rasterised & JPEG-optimised`, hitNote]
        });
      }
    }

    const friendly = [];
    if (stats.pages) friendly.push(stats.pages + ' pages');
    if (stats.textStripped) friendly.push('text layer + fonts removed');
    if (stats.imagesRecompressed) {
      const n = stats.imagesRecompressed, lossy = stats.imagesLossy || 0;
      friendly.push(lossy === n ? `${n} image${n > 1 ? 's' : ''} re-encoded` : lossy ? `${lossy} of ${n} images re-encoded` : `${n} image${n > 1 ? 's' : ''} re-packed losslessly`);
    }
    if (stats.fontsTrimmed) friendly.push(`${stats.fontsTrimmed} font${stats.fontsTrimmed > 1 ? 's' : ''} trimmed (hinting + device tables)`);
    if (stats.fontsRemoved) friendly.push(`${stats.fontsRemoved} unused font${stats.fontsRemoved > 1 ? 's' : ''} dropped`);
    if (stats.numbersTrimmed) friendly.push(`${stats.numbersTrimmed} content stream${stats.numbersTrimmed > 1 ? 's' : ''} tightened`);
    if (stats.objectsBefore && stats.objectsAfter && stats.objectsBefore > stats.objectsAfter) friendly.push((stats.objectsBefore - stats.objectsAfter) + ' dead objects dropped');
    if (stats.duplicates) friendly.push(stats.duplicates + ' duplicate streams merged');
    if (res.warnings.length) notes.push(...res.warnings);

    const invisible = !!(stats.textStripped || pol.stripText || pol.stripAnnots || pol.stripBookmarks || pol.stripAttachments);
    const kind = (invisible && stats.textStripped) ? 'invisible'
      : stats.imagesLossy ? (preset.bitExact ? 'near' : 'lossy')
      : 'lossless';
    if (kind === 'near') friendly.push('near-lossless · gentle high-q raster re-encode, no resampling');

    const out = result(f, res.bytes, {
      type: 'pdf', kind, notes: (friendly.length ? friendly : ['structural rebuild']).concat(notes)
    });
    if (isCustom) {
      if (out.bytes.length <= effBudget) out.notes.push(`target ≤ ${Util.fmtBytes(effBudget)} reached`);
      else out.notes.push(`target ${Util.fmtBytes(effBudget)} not reachable without page rasterising`);
    } else {
      const gotPct = (1 - out.bytes.length / f.size) * 100;
      if (preset.target > 0 && gotPct < preset.target - 2) out.notes.push('target not reachable without visible damage');
    }
    return out;
  }

  function closeCache(cache) {
    for (const dec of cache.values()) { try { dec && dec.close && dec.close(); } catch (e) {} }
    cache.clear();
  }

  async function encodePdfImage(job, level, cache, o) {
    try {
      if (level.q) needCanvas();
      if (job.kind === 'jpeg') {
        const clean = JPEGCodec.stripLossless(job.bytes);
        const src = clean && clean.bytes.length < job.bytes.length ? clean.bytes : job.bytes;
        if (!level.q) {
          return src.length < job.streamLen ? { bytes: src, width: job.width, height: job.height, filter: 'DCTDecode', lossless: true } : null;
        }
        if (job.hasSMask && !job.smaskAlpha && !(job.hasHardMask && level.flattenAlpha)) return null;
        const keepInCache = cache.size < 6 && (job.width * job.height <= 3500000);
        let dec = cache.get(job.objNum), ownDec = false;
        if (!dec) {
          dec = await Imaging.decode(src, 'image/jpeg');
          if (keepInCache) cache.set(job.objNum, dec);
          else ownDec = true;
        }
        try {
          const dim = level.dim || o.maxDim || 0;
          const scale = dim && Math.max(dec.width, dec.height) > dim ? dim / Math.max(dec.width, dec.height) : 1;
          const w = Math.max(1, Math.round(dec.width * scale));
          const h = Math.max(1, Math.round(dec.height * scale));
          let canvas;
          if (job.hasSMask && job.smaskAlpha && level.flattenAlpha) {
            const full = Imaging.resample(dec.bmp, job.width, job.height);
            const ctx = full.getContext('2d');
            const id = ctx.getImageData(0, 0, job.width, job.height);
            const d = id.data, a = job.smaskAlpha;
            for (let i = 0, p = 0; i < job.width * job.height; i++, p += 4) {
              const al = a[i];
              d[p] = ((d[p] * al + 255 * (255 - al)) / 255) | 0;
              d[p + 1] = ((d[p + 1] * al + 255 * (255 - al)) / 255) | 0;
              d[p + 2] = ((d[p + 2] * al + 255 * (255 - al)) / 255) | 0;
              d[p + 3] = 255;
            }
            ctx.putImageData(id, 0, 0);
            canvas = scale < 1 ? Imaging.resample(full, w, h) : full;
          } else if (job.hasSMask && !job.hasHardMask) {
            return src.length < job.streamLen ? { bytes: src, width: job.width, height: job.height, filter: 'DCTDecode', lossless: true } : null;
          } else {
            canvas = Imaging.resample(dec.bmp, w, h);
          }
          const encoded = await Imaging.encode(canvas, 'image/jpeg', level.q);
          if (encoded.length >= src.length * 0.97 && !(job.hasSMask && level.flattenAlpha)) {
            return src.length < job.streamLen ? { bytes: src, width: job.width, height: job.height, filter: 'DCTDecode', lossless: true } : null;
          }
          return { bytes: encoded, width: w, height: h, filter: 'DCTDecode', dropSMask: !!(job.opaqueSMask || (job.hasSMask && level.flattenAlpha)) };
        } finally {
          if (ownDec && dec && dec.close) { try { dec.close(); } catch (e) {} }
        }
      }
      if (job.kind === 'raw') {
        const ch = job.channels || (job.colorSpace === 'DeviceGray' ? 1 : job.colorSpace === 'DeviceRGB' ? 3 : job.colorSpace === 'DeviceCMYK' ? 4 : 0);
        const parms = { predictor: 15, colors: ch || 1, bpc: job.bpc, columns: job.width };
        const rawSamples = await PDFFilters.decode(job.rawStream, job.filters, job.decodeParms);
        if (!rawSamples) return null;
        if (!level.q && job.rawStream.length < rawSamples.length * 0.02 && rawSamples.length > 4e6) return null;
        const lkey = 'lossless:' + job.objNum;
        let lossless = cache.get(lkey);
        if (lossless === undefined) {
          lossless = (ch && !job.palette && job.bpc === 8) ? await PNGCodec.compressSamples(rawSamples, job.width, job.height, ch, job.bpc) : null;
          if (cache.size < 8) cache.set(lkey, lossless);
        }
        const canFlattenSMask = !job.hasSMask || ((!!job.smaskAlpha || !!job.hasHardMask) && !!level.flattenAlpha);
        const okBpc = job.bpc === 8 || job.bpc === 16 || (job.bpc === 1 && ch === 1 && !job.palette);
        if (!level.q || !okBpc || !ch || !canFlattenSMask) {
          return lossless && lossless.length < job.streamLen
            ? { bytes: lossless, width: job.width, height: job.height, filter: 'FlateDecode', decodeParms: parms, lossless: true } : null;
        }
        let samples = rawSamples;
        if (job.bpc === 16) {
          if (rawSamples.length < job.width * job.height * ch * 2) return null;
          samples = new Uint8Array(job.width * job.height * ch);
          for (let i = 0, n = samples.length; i < n; i++) samples[i] = rawSamples[i * 2];
        } else if (job.bpc === 1) {
          const rowBytes = Math.ceil(job.width / 8);
          if (rawSamples.length < rowBytes * job.height) return null;
          samples = new Uint8Array(job.width * job.height);
          const v1 = job.invert1Bit ? 0 : 255, v0 = job.invert1Bit ? 255 : 0;
          for (let y = 0; y < job.height; y++) {
            const rOff = y * rowBytes, dOff = y * job.width;
            for (let x = 0; x < job.width; x++) {
              samples[dOff + x] = ((rawSamples[rOff + (x >> 3)] >> (7 - (x & 7))) & 1) ? v1 : v0;
            }
          }
        }
        if (samples.length < job.width * job.height * ch) return null;
        const rgba = toRGBA(samples, job.width, job.height, ch, job.palette, job.hasSMask ? job.smaskAlpha : null);
        const canvas = Imaging.makeCanvas(job.width, job.height);
        canvas.getContext('2d').putImageData(new ImageData(rgba, job.width, job.height), 0, 0);
        const dim = level.dim || o.maxDim || 0;
        const scale = dim && Math.max(job.width, job.height) > dim ? dim / Math.max(job.width, job.height) : 1;
        const w = Math.max(1, Math.round(job.width * scale));
        const h = Math.max(1, Math.round(job.height * scale));
        const small = Imaging.resample(canvas, w, h);
        const encoded = await Imaging.encode(small, 'image/jpeg', level.q);
        if (lossless && lossless.length <= encoded.length && !job.hasSMask) {
          return lossless.length < job.streamLen
            ? { bytes: lossless, width: job.width, height: job.height, filter: 'FlateDecode', decodeParms: parms, lossless: true } : null;
        }
        return {
          bytes: encoded, width: w, height: h, filter: 'DCTDecode',
          colorSpace: { t: 'name', v: 'DeviceRGB', raw: 'DeviceRGB' },
          dropSMask: !!(job.opaqueSMask || (job.hasSMask && level.flattenAlpha))
        };
      }
    } catch (e) {
      if (e && e.code === 'NO_CANVAS') throw e;
      return null;
    }
    return null;
  }

  function toRGBA(samples, w, h, ch, palette, smaskAlpha) {
    const out = new Uint8ClampedArray(w * h * 4);
    const nPix = w * h;
    if (palette) {
      for (let i = 0, d = 0; i < nPix; i++, d += 4) {
        const idx = samples[i] * 3;
        let r = palette[idx] || 0, g = palette[idx + 1] || 0, b = palette[idx + 2] || 0;
        if (smaskAlpha) {
          const al = smaskAlpha[i];
          r = ((r * al + 255 * (255 - al)) / 255) | 0;
          g = ((g * al + 255 * (255 - al)) / 255) | 0;
          b = ((b * al + 255 * (255 - al)) / 255) | 0;
        }
        out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = 255;
      }
      return out;
    }
    if (ch === 4) {
      for (let i = 0, s = 0, d = 0; i < nPix; i++, s += 4, d += 4) {
        const c = samples[s] / 255, m = samples[s + 1] / 255, y = samples[s + 2] / 255, k = samples[s + 3] / 255;
        let r = Math.round(255 * (1 - c) * (1 - k));
        let g = Math.round(255 * (1 - m) * (1 - k));
        let b = Math.round(255 * (1 - y) * (1 - k));
        if (smaskAlpha) {
          const al = smaskAlpha[i];
          r = ((r * al + 255 * (255 - al)) / 255) | 0;
          g = ((g * al + 255 * (255 - al)) / 255) | 0;
          b = ((b * al + 255 * (255 - al)) / 255) | 0;
        }
        out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = 255;
      }
      return out;
    }
    for (let i = 0, s = 0, d = 0; i < nPix; i++, d += 4) {
      let r, g, b;
      if (ch === 3) { r = samples[s++]; g = samples[s++]; b = samples[s++]; }
      else { r = g = b = samples[s++]; }
      if (smaskAlpha) {
        const al = smaskAlpha[i];
        r = ((r * al + 255 * (255 - al)) / 255) | 0;
        g = ((g * al + 255 * (255 - al)) / 255) | 0;
        b = ((b * al + 255 * (255 - al)) / 255) | 0;
      }
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = 255;
    }
    return out;
  }

  /* ══════════ ZIP containers: DOCX · PPTX · XLSX · EPUB · ODT · ZIP ══════════ */
  const RASTER = /\.(png|jpe?g|webp)$/i;
  const INNER_DOC = /\.(pdf|svg|json|html?|css|m?js|xml|txt|csv|md)$/i;

  async function processZip(f, bytes, preset, o, report) {
    const entries = await ZipCodec.list(bytes);
    if (!entries) return result(f, bytes, { type: 'archive', kind: 'lossless', notes: ['ZIP64 or unsupported — copied'] });
    const notes = [];
    const isGenericZip = ext(f.name) === 'zip';
    let rebalanced = false;

    // 1 — Read & losslessly optimise entries first so we know exact lossless baseline & media share
    const unpacked = [];
    let mediaBytes = 0;
    for (let idx = 0; idx < entries.length; idx++) {
      const e = entries[idx];
      if (idx % 6 === 0) report && report(`unpack ${idx + 1}/${entries.length}`);
      if (e.name.endsWith('/')) { unpacked.push({ e, data: new Uint8Array(0), store: true, media: false }); continue; }
      let data = await ZipCodec.readEntry(e);
      if (!data) { unpacked.push({ e, data: null, store: true, media: false }); continue; }
      const isRast = RASTER.test(e.name) && data.length > 1024;
      const isInner = isGenericZip && INNER_DOC.test(e.name) && data.length > 1024;
      if (isRast) {
        const rKind = /\.png$/i.test(e.name) ? 'png' : /\.webp$/i.test(e.name) ? 'webp' : 'jpeg';
        const ll = await losslessImage(data, rKind);
        if (ll.bytes.length < data.length && rKind === 'png' && !rebalanced) {
          rebalanced = true; notes.push('PNG predictors re-optimised inside the archive');
        }
        data = ll.bytes;
      }
      if (isRast || isInner) mediaBytes += data.length;
      unpacked.push({ e, data, store: false, isRast, isInner });
    }

    const losslessZip = await ZipCodec.write(unpacked.map(u => ({ name: u.e.name, data: u.data, store: u.store, mode: u.e.extAttr >>> 0 })));
    const baseZipBytes = losslessZip.length < bytes.length ? losslessZip : bytes;
    const budget = effectiveBudget(f.size, baseZipBytes.length, preset);

    if (preset.bitExact || baseZipBytes.length <= budget || mediaBytes === 0) {
      notes.push(`${entries.length} entries re-packed`);
      if (baseZipBytes === bytes) notes.push('already tightly packed — nothing safe left to remove');
      return result(f, baseZipBytes, { type: 'archive', kind: 'lossless', notes });
    }

    // 2 — Budgeted media/inner compression so every preset & KB/MB budget shrinks progressively
    const zCeil = (!preset.bitExact && !(preset.customBytes > 0)) ? PRESET_CEIL[preset.id] : null;
    const zipOpts = zCeil && zCeil.maxDim ? Object.assign({}, o, { maxDim: o.maxDim > 0 ? Math.min(o.maxDim, zCeil.maxDim) : zCeil.maxDim }) : o;
    const nonMediaOverhead = Math.max(0, baseZipBytes.length - mediaBytes);
    const totalMediaBudget = Math.max(4096, budget - nonMediaOverhead);
    let lossy = 0;

    for (let idx = 0; idx < unpacked.length; idx++) {
      const u = unpacked[idx];
      if (!u.data || (!u.isRast && !u.isInner)) continue;
      report && report(`media ${idx + 1}/${unpacked.length}`);
      let share = Math.max(1536, Math.floor(totalMediaBudget * (u.data.length / Math.max(1, mediaBytes))));
      if (zCeil) share = Math.min(share, Math.max(1536, Math.floor(u.data.length * zCeil.gentleKeep)));
      if (u.data.length <= share) continue;

      if (u.isRast) {
        needCanvas();
        const rKind = /\.png$/i.test(u.e.name) ? 'png' : /\.webp$/i.test(u.e.name) ? 'webp' : 'jpeg';
        try {
          const dec = await Imaging.decode(u.data, MIME[rKind] || 'image/jpeg');
          const alpha = rKind === 'png' ? await hasAlpha(dec) : false;
          const forcedFmt = isGenericZip ? null : rKind;
          const hit = await solveImageBudget(dec, alpha, rKind, share, forcedFmt, zipOpts, null, zCeil);
          dec.close && dec.close();
          if (hit && hit.bytes.length < u.data.length * 0.95) {
            if (isGenericZip && hit.ext && !u.e.name.toLowerCase().endsWith('.' + hit.ext)) {
              u.outName = u.e.name.replace(/\.[^.]+$/, '.' + hit.ext);
            }
            u.data = hit.bytes;
            lossy++;
          }
        } catch (err) {
          if (err && err.code === 'NO_CANVAS') throw err;
        }
      } else if (u.isInner) {
        try {
          const innerBlob = new Blob([u.data]);
          innerBlob.name = u.e.name.split('/').pop();
          const innerRes = await compress(innerBlob, {
            preset: preset.id,
            options: Object.assign({}, o, { customBytes: share })
          });
          if (innerRes && innerRes.bytes && innerRes.bytes.length < u.data.length * 0.96) {
            u.data = innerRes.bytes;
            if (innerRes.kind !== 'lossless') lossy++;
          }
        } catch (err) {
          if (err && err.code === 'NO_CANVAS') throw err;
        }
      }
    }

    const rebuilt = await ZipCodec.write(unpacked.map(u => ({
      name: u.outName || u.e.name, data: u.data, store: u.store, mode: u.e.extAttr >>> 0
    })));
    notes.push(`${entries.length} entries re-packed`);
    if (lossy) notes.push(`${lossy} embedded item${lossy > 1 ? 's' : ''} compressed`);
    const useBytes = rebuilt.length < baseZipBytes.length ? rebuilt : baseZipBytes;
    if (useBytes === bytes) notes.push('already tightly packed — nothing safe left to remove');
    if (preset.customBytes > 0 && useBytes.length <= budget) notes.push(`target ≤ ${Util.fmtBytes(budget)} reached`);
    return result(f, useBytes, { type: 'archive', kind: lossy ? 'lossy' : 'lossless', notes });
  }

  /* ══════════ text / markup ══════════ */
  function minifyCSS(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*([{}:;,>~+])\s*/g, '$1')
      .replace(/;}/g, '}').replace(/\s+/g, ' ').trim();
  }
  function minifyHTML(s) {
    return s.replace(/<!--(?!\[if)[\s\S]*?-->/g, '').replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();
  }
  function minifyXML(s) {
    return s.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();
  }
  function minifyJS(s) {
    let out = '';
    let i = 0, inS = null, inC = false, inLC = false;
    while (i < s.length) {
      const c = s[i], n = s[i + 1];
      if (inS) { out += c; if (c === '\\') { out += n; i += 2; continue; } if (c === inS) inS = null; i++; continue; }
      if (inC) { if (c === '*' && n === '/') { inC = false; i += 2; continue; } i++; continue; }
      if (inLC) { if (c === '\n') { inLC = false; out += '\n'; } i++; continue; }
      if (c === '"' || c === "'" || c === '`') { inS = c; out += c; i++; continue; }
      if (c === '/' && n === '*') { inC = true; i += 2; continue; }
      if (c === '/' && n === '/') { inLC = true; i += 2; continue; }
      if (/\s/.test(c)) {
        let j = i; while (j < s.length && /\s/.test(s[j])) j++;
        const prev = out[out.length - 1] || '', next = s[j] || '';
        out += /[\w$)\]}"'`]/.test(prev) && /[\w$(\[{/'"`]/.test(next) ? ' ' : '';
        i = j; continue;
      }
      out += c; i++;
    }
    return out.trim();
  }
  const SVG_MIN = (s) => s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .replace(/\s*([{};:,])\s*/g, '$1')
    .trim();

  async function processText(f, bytes, kind, preset, o) {
    const text = new TextDecoder().decode(bytes);
    const e = ext(f.name);
    let out = text, notes = [];
    if (e === 'json') { try { out = JSON.stringify(JSON.parse(text)); notes.push('JSON minified'); } catch (err) { notes.push('invalid JSON — gzip only'); } }
    else if (e === 'svg') { out = SVG_MIN(text); notes.push('SVG minified'); }
    else if (e === 'html' || e === 'htm') { out = minifyHTML(text); notes.push('HTML minified'); }
    else if (e === 'css') { out = minifyCSS(text); notes.push('CSS minified'); }
    else if (e === 'js' || e === 'mjs') { out = minifyJS(text); notes.push('JS minified (comment/whitespace safe)'); }
    else if (e === 'xml' || e === 'rss' || e === 'atom') { out = minifyXML(text); notes.push('XML minified'); }
    else if (['md', 'txt', 'csv'].includes(e)) { out = text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n'); notes.push('whitespace normalised'); }

    let bytesOut = new TextEncoder().encode(out);
    if (bytesOut.length >= bytes.length * 0.995) { bytesOut = bytes; notes = []; }
    const budget = effectiveBudget(f.size, bytesOut.length, preset);
    const worthGzip = (!preset.bitExact && bytesOut.length >= 32768 && bytesOut.length > budget)
      || (preset.customBytes > 0 && bytesOut.length > budget);
    if (worthGzip) {
      const gz = await gzip(bytesOut);
      if (gz.length < bytesOut.length * 0.95) {
        return result(f, gz, { type: 'text', kind: 'lossless', outName: f.name + '.gz', notes: notes.concat('gzip container') });
      }
    }
    if (preset.target > 0 && (1 - bytesOut.length / f.size) * 100 < preset.target - 2 && notes.length) {
      notes.push('target not reachable by minification alone');
    }
    return result(f, bytesOut, { type: 'text', kind: 'lossless', notes });
  }

  /* ══════════ dispatch ══════════ */
  async function compress(file, opts) {
    const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
    const o = (opts && opts.options) || {};
    let preset;
    if (o.customBytes && o.customBytes > 0) {
      const customB = Math.max(256, Math.floor(o.customBytes));
      const pct = Math.max(0, Math.min(99, (1 - customB / Math.max(1, bytes.length)) * 100));
      preset = { id: 'custom', label: Util.fmtBytes(customB), target: pct, customBytes: customB, hint: 'Target ≤ ' + Util.fmtBytes(customB) };
    } else {
      preset = PRESETS.find(p => p.id === (opts && opts.preset)) || PRESETS[3];
      if (preset.bitExact && o.losslessStrict) preset = Object.assign({}, preset, { target: 0 });
    }
    const report = opts && opts.onProgress;
    const fname = file.name || 'file';
    const kind = Util.sniff(bytes, fname);
    const f = { name: fname, size: bytes.length };

    const textual = /^(svg|json|html|htm|css|js|mjs|xml|txt|csv|md)$/i.test(ext(fname)) || kind === 'svg';
    if (bytes.length < (textual ? 24 : 256)) {
      return result(f, bytes, { type: 'file', kind: 'lossless', notes: ['too small to touch'] });
    }

    switch (kind) {
      case 'pdf': return processPDF(f, bytes, preset, o, report);
      case 'png':
      case 'jpeg':
      case 'webp':
      case 'bmp':
        return processImage(f, bytes, kind === 'jpeg' ? 'jpeg' : kind, preset, o, report);
      case 'svg': return processText(f, bytes, 'svg', preset, o);
      case 'gif': {
        const animated = (Util.latin1(bytes).match(/\x2C/g) || []).length > 2;
        if (animated) return result(f, bytes, { type: 'image', kind: 'lossless', notes: ['animated GIF kept untouched'] });
        return processImage(f, bytes, 'gif', preset, o, report);
      }
      case 'zip': return processZip(f, bytes, preset, o, report);
      case 'heic': {
        const gz = await gzip(bytes);
        return gz.length < bytes.length * 0.95
          ? result(f, gz, { type: 'other', kind: 'lossless', outName: fname + '.gz', notes: ['HEIC cannot be re-encoded in a browser — gzip container offered'] })
          : result(f, bytes, { type: 'other', kind: 'lossless', notes: ['HEIC/HEIF is not decodable in the browser — kept untouched'] });
      }
      default: {
        if (ext(fname) === 'tif' || ext(fname) === 'tiff') {
          return result(f, bytes, { type: 'other', kind: 'lossless', notes: ['TIFF is not decodable in the browser — convert to PNG/JPG first'] });
        }
        if (['json', 'html', 'htm', 'css', 'js', 'mjs', 'xml', 'svg', 'txt', 'csv', 'md'].includes(ext(fname))) {
          return processText(f, bytes, 'text', preset, o);
        }
        const gz = await gzip(bytes);
        if (gz.length < bytes.length * 0.95) {
          return result(f, gz, { type: 'other', kind: 'lossless', outName: fname + '.gz', notes: ['gzip container (format unknown)'] });
        }
        return result(f, bytes, { type: 'other', kind: 'lossless', notes: ['no safe reduction available'] });
      }
    }
  }

  return { compress, PRESETS, LADDER, EXTREME_RUNGS, ladderFor, ensurePdfJs, openPdfJsDoc, effectiveBudget, gzip, needCanvas, encodePdfImage, closeCache, processImage, processPDF, processZip, processText, minifyCSS, minifyJS, minifyHTML, minifyXML, SVG_MIN };
})();
