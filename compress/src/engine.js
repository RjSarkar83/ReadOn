/* ══════════════════════════════════════════════════════════════
   engine.js — the compression brain
   Presets 10 / 25 / 50 / 75 / 90 % are *targets*, not blind quality
   dumps: the engine always runs the lossless pass first and only
   adds raster work — climbing a ladder from best to strongest —
   until the target is met.  Whatever it does is reported per file.
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

  /* preset-specific rungs; Extreme keeps going below the standard ladder */
  const EXTREME_RUNGS = [
    { q: 0.30, dim: 800 },
    { q: 0.24, dim: 700 },
    { q: 0.18, dim: 640 }
  ];
  const ladderFor = (preset) => (preset && preset.id === 'extreme' ? LADDER.concat(EXTREME_RUNGS) : LADDER);

  /* raster work needs a canvas — bail out in environments without one (worker fallback) */
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

  /* ══════════ generic helpers ══════════ */
  async function gzip(bytes) {
    if (typeof CompressionStream !== 'undefined') {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (e) { /* fall through to the JS codec */ }
    }
    return JSCodec.gzip(bytes);
  }

  function targetBytes(original, preset) {
    return Math.round(original * (1 - preset.target / 100));
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
    // bit-exact preset: only the five gentlest rungs, so a stubborn PNG does not crawl the whole ladder
    const ladder = preset.bitExact ? LADDER.slice(0, 5) : ladderFor(preset);
    const wantWebp = o.allowWebp || preset.id === 'extreme';
    const ssimFloor = preset.id === 'extreme' ? 0.68 : preset.bitExact ? 0.99 : 0.80;
    // 1 — always try lossless first
    const ll = await losslessImage(bytes, kind);
    let best = { bytes: ll.bytes, lossless: true, notes: ll.notes.slice() };
    notes.push(...ll.notes);

    const needsTarget = preset.target > 0 && (1 - best.bytes.length / f.size) * 100 < preset.target - 0.5;
    if (!needsTarget) return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });
    needCanvas();

    // 2 — measure the pixels so we can score whatever we produce
    let dec;
    try { dec = await Imaging.decode(best.bytes, MIME[ext(f.name)] || 'image/png'); }
    catch (e) { return result(f, best.bytes, { type: 'image', kind: 'lossless', notes: notes.concat('unsupported raster — kept as is') }); }

    const alpha = await hasAlpha(dec);
    const src = await Imaging.resample(dec.bmp, dec.width, dec.height);
    let chosen = null, pngWorth = true, rung = 0;

    needCanvas();
    for (const step of ladder) {
      report && report(step.q);
      const dim = Math.min(step.dim || 1e9, o.maxDim || 1e9) < 1e9 ? Math.min(step.dim || 1e9, o.maxDim || 1e9) : 0;
      const scale = dim && Math.max(dec.width, dec.height) > dim ? dim / Math.max(dec.width, dec.height) : 1;
      const w = Math.max(1, Math.round(dec.width * scale));
      const h = Math.max(1, Math.round(dec.height * scale));
      const canvas = scale < 1 ? Imaging.resample(dec.bmp, w, h) : src;

      // candidates — never trade away transparency
      const cand = [];
      rung++;
      // a lossless PNG can only beat JPEG on flat art; test it once, then stop paying for it
      if ((kind === 'png' || kind === 'gif' || kind === 'bmp') && (rung === 1 || pngWorth || alpha)) {
        const png = await Imaging.encode(canvas, 'image/png');
        cand.push({ bytes: png, ext: 'png', mode: 'png', usew: w, useh: h, mime: 'image/png' });
        if (rung === 1) pngWorth = png.length < (o.pngBudget || 4 * 1024 * 1024);
      }
      if (!alpha || o.allowWebp) {
        const jpeg = await Imaging.encode(canvas, 'image/jpeg', step.q);
        cand.push({ bytes: jpeg, ext: alpha ? 'webp' : 'jpg', mode: 'jpeg', usew: w, useh: h, mime: 'image/jpeg', skipIfAlpha: alpha });
      }
      if (wantWebp) {
        const webp = await Imaging.encode(canvas, 'image/webp', Math.min(0.97, step.q + 0.05));
        cand.push({ bytes: webp, ext: 'webp', mode: 'webp', usew: w, useh: h, mime: 'image/webp' });
      }
      for (let k = cand.length - 1; k >= 0; k--) if (cand[k].skipIfAlpha && alpha) cand.splice(k, 1);
      cand.sort((a, b) => a.bytes.length - b.bytes.length);
      if (!cand.length) continue;

      // walk smallest → largest and take the first encode that clears the fidelity
      // floor; only when the whole rung is under it do we keep the best (smallest)
      let rec = null, weak = null;
      for (const c of cand) {
        const sc = await scoreCanvas(dec.bmp, canvas, c.bytes, c.mime);
        const r = { ...c, step, psnr: sc.psnr, ssim: sc.ssim };
        if (typeof r.ssim !== 'number' || r.ssim >= ssimFloor) { rec = r; break; }
        weak = weak || r;
      }
      if (!rec) rec = weak;

      const meets = rec.bytes.length <= targetBytes(f.size, preset);
      // a rung that drops below the fidelity floor is not taken, even for Extreme
      if (typeof rec.ssim === 'number' && rec.ssim < ssimFloor && chosen) break;
      // prefer the gentlest step that meets the target; otherwise keep the strongest
      if (meets) { chosen = rec; break; }
      chosen = rec;
    }

    if (!chosen) return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });
    // Lossless quality guard: below 98 % SSIM we would rather not shrink at all
    if (preset.bitExact && typeof chosen.ssim === 'number' && chosen.ssim < 0.98) {
      notes.push(`★ SSIM ${(chosen.ssim * 100).toFixed(2)} % — below the 98 % floor, kept bit-exact`);
      return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });
    }
    const improve = chosen.bytes.length < best.bytes.length * 0.98;
    if (!improve) {
      notes.push('no pixel-safe path to the target — kept the untouched encode');
      return result(f, best.bytes, { type: 'image', kind: 'lossless', notes });
    }

    const outName = base(f.name) + '.' + chosen.ext;
    notes.push(chosen.mode === 'jpeg' ? `re-encoded JPEG q${Math.round(chosen.step.q * 100)}` :
      chosen.mode === 'webp' ? 're-encoded WebP' : 're-encoded PNG');
    if (chosen.step.dim && Math.max(dec.width, dec.height) > chosen.step.dim) notes.push(`resampled to ${chosen.usew}×${chosen.useh}`);
    const pngExact = chosen.mode === 'png' && !(chosen.step.dim && Math.max(dec.width, dec.height) > chosen.step.dim);
    // at the Lossless preset a pixel-level re-encode is only allowed at SSIM ≥ 0.99,
    // and it is reported as its own fidelity class — never as "lossless"
    const fid = pngExact ? 'lossless' : preset.bitExact ? 'near' : 'lossy';
    if (fid === 'near') notes.push('no resampling · SSIM floor 98 %');
    return result(f, chosen.bytes, {
      type: 'image', kind: fid, notes, outName,
      psnr: chosen.psnr, ssim: chosen.ssim
    });
  }

  async function hasAlpha(dec) {
    const c = Imaging.resample(dec.bmp, Math.min(64, dec.width), Math.min(64, dec.height));
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
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

  async function processPDF(f, bytes, preset, o, report) {
    const notes = [];
    const pol = pdfPolicy(preset, o);
    const targetBytes = preset.target > 0 ? Math.floor(f.size * (1 - preset.target / 100)) : 0;

    // one parse, one rebuild: structure → text layer → budgeted raster ladder
    const levels = preset.bitExact
      ? [{ q: 0, dim: 0, label: 'lossless raster' }, { q: 0.97, dim: 0 }, { q: 0.95, dim: 0 }]
      : [
      { q: 0, dim: 0, label: 'lossless raster' },
      { q: 0.97, dim: 0 }, { q: 0.94, dim: 0 }, { q: 0.90, dim: 3200 },
      { q: 0.86, dim: 2600 }, { q: 0.80, dim: 2200 }, { q: 0.70, dim: 1800 },
      { q: 0.60, dim: 1500 }, { q: 0.45, dim: 1280 }, { q: 0.34, dim: 900 }
    ].concat(preset.id === 'extreme' ? [{ q: 0.34, dim: 900 }, { q: 0.30, dim: 800 }] : []);
    if (preset.bitExact) levels.length = Math.min(levels.length, 3);

    const cache = new Map();
    const encode = (job, level) => encodePdfImage(job, level, cache, o);
    const opts = Object.assign({}, pol, {
      recompressImage: null,
      imageLevels: levels,
      imageEncode: encode,
      targetBytes
    });

    report && report('structural rebuild');
    let res = await PDFEngine.optimize(bytes, opts);
    let stats = res.stats || {};

    // structural pass could not meet the target and the user left text removal on 'auto'
    // → one extra pass with the text layer removed (never overrides an explicit choice)
    // never at the Lossless preset: a removed text layer is not bit-exact
    if (preset.target > 0 && !preset.bitExact && res.bytes.length > targetBytes && !pol.stripText && o.pdfText !== 'off') {
      report && report('text layer');
      const res2 = await PDFEngine.optimize(bytes, Object.assign({}, opts, { stripText: true }));
      if (res2.bytes.length < res.bytes.length) { res = res2; stats = res2.stats || {}; }
    }
    closeCache(cache);

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
    // the automatic second pass can strip the text layer too — the label must follow the
    // stats that were actually shipped, not just the user's policy
    const invisible = !!(stats.textStripped || pol.stripText || pol.stripAnnots || pol.stripBookmarks || pol.stripAttachments);
    // honest ordering: a stripped text layer beats everything, then a pixel-level re-encode
    const kind = (invisible && stats.textStripped) ? 'invisible'
      : stats.imagesLossy ? (preset.bitExact ? 'near' : 'lossy')
      : 'lossless';
    if (kind === 'near') friendly.push('near-lossless · gentle high-q raster re-encode, no resampling');

    const out = result(f, res.bytes, {
      type: 'pdf', kind, notes: (friendly.length ? friendly : ['structural rebuild']).concat(notes)
    });
    const gotPct = (1 - out.bytes.length / f.size) * 100;
    if (preset.target > 0 && gotPct < preset.target - 2) out.notes.push('target not reachable without visible damage');
    return out;
  }

  function closeCache(cache) {
    for (const dec of cache.values()) { try { dec.close && dec.close(); } catch (e) {} }
    cache.clear();
  }

  /* encode one PDF image at one ladder rung; q === 0 means lossless only */
  async function encodePdfImage(job, level, cache, o) {
    try {
      if (level.q) needCanvas();
      if (job.kind === 'jpeg') {
        const clean = JPEGCodec.stripLossless(job.bytes);
        const src = clean && clean.bytes.length < job.bytes.length ? clean.bytes : job.bytes;
        if (!level.q) {
          return src.length < job.streamLen ? { bytes: src, width: job.width, height: job.height, filter: 'DCTDecode', lossless: true } : null;
        }
        let dec = cache.get(job.objNum);
        if (!dec) {
          dec = await Imaging.decode(src, 'image/jpeg');
          cache.set(job.objNum, dec);
        }
        const dim = level.dim || o.maxDim || 0;
        const scale = dim && Math.max(dec.width, dec.height) > dim ? dim / Math.max(dec.width, dec.height) : 1;
        const w = Math.max(1, Math.round(dec.width * scale));
        const h = Math.max(1, Math.round(dec.height * scale));
        const canvas = Imaging.resample(dec.bmp, w, h);
        const encoded = await Imaging.encode(canvas, 'image/jpeg', level.q);
        if (encoded.length >= src.length * 0.95) {
          // re-encoding would not win: keep the original scan, metadata-free
          return src.length < job.streamLen ? { bytes: src, width: job.width, height: job.height, filter: 'DCTDecode', lossless: true } : null;
        }
        return { bytes: encoded, width: w, height: h, filter: 'DCTDecode' };
      }
      if (job.kind === 'raw') {
        const ch = job.colorSpace === 'DeviceGray' ? 1 : job.colorSpace === 'DeviceRGB' ? 3 : 0;
        // whatever we emit from filtered samples must declare the same predictor
        const parms = { predictor: 15, colors: ch || 1, bpc: job.bpc, columns: job.width };
        const samples = await PDFFilters.decode(job.rawStream, job.filters, job.decodeParms);
        if (!samples) return null;
        // a source that already compresses below ~2 % of its raw size is not improvable by
        // re-filtering — skipping keeps big vector-heavy PDFs fast
        if (!level.q && job.rawStream.length < samples.length * 0.02 && samples.length > 4e6) return null;
        const lkey = 'lossless:' + job.objNum;
        let lossless = cache.get(lkey);
        if (lossless === undefined) {
          lossless = await PNGCodec.compressSamples(samples, job.width, job.height, ch || 1, job.bpc);
          cache.set(lkey, lossless);
        }
        if (!level.q || job.bpc !== 8 || !ch || job.hasSMask) {
          // filtered samples need the matching PNG predictor in /DecodeParms,
          // and they are bit-exact, so they must be flagged lossless
          return lossless && lossless.length < job.streamLen
            ? { bytes: lossless, width: job.width, height: job.height, filter: 'FlateDecode', decodeParms: parms, lossless: true } : null;
        }
        const rgba = toRGBA(samples, job.width, job.height, ch);
        const canvas = Imaging.makeCanvas(job.width, job.height);
        canvas.getContext('2d').putImageData(new ImageData(rgba, job.width, job.height), 0, 0);
        const dim = level.dim || o.maxDim || 0;
        const scale = dim && Math.max(job.width, job.height) > dim ? dim / Math.max(job.width, job.height) : 1;
        const w = Math.max(1, Math.round(job.width * scale));
        const h = Math.max(1, Math.round(job.height * scale));
        const small = Imaging.resample(canvas, w, h);
        const encoded = await Imaging.encode(small, 'image/jpeg', level.q);
        if (lossless && lossless.length <= encoded.length) {
          return lossless.length < job.streamLen
            ? { bytes: lossless, width: job.width, height: job.height, filter: 'FlateDecode', decodeParms: parms, lossless: true } : null;
        }
        return { bytes: encoded, width: w, height: h, filter: 'DCTDecode', colorSpace: { t: 'name', v: 'DeviceRGB', raw: 'DeviceRGB' } };
      }
    } catch (e) {
      if (e && e.code === 'NO_CANVAS') throw e;     // let the worker ask the page to do this file
      return null;
    }
    return null;
  }

  function toRGBA(samples, w, h, ch) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, s = 0, d = 0; i < w * h; i++) {
      if (ch === 3) { out[d++] = samples[s++]; out[d++] = samples[s++]; out[d++] = samples[s++]; out[d++] = 255; }
      else { const g = samples[s++]; out[d++] = g; out[d++] = g; out[d++] = g; out[d++] = 255; }
    }
    return out;
  }

  /* ══════════ ZIP containers: DOCX · PPTX · XLSX · EPUB · ODT ══════════ */
  const RASTER = /\.(png|jpe?g)$/i;

  async function processZip(f, bytes, preset, o, report) {
    const entries = await ZipCodec.list(bytes);
    if (!entries) return result(f, bytes, { type: 'archive', kind: 'lossless', notes: ['ZIP64 or unsupported — copied'] });
    const notes = [];
    const out = [];
    let i = 0, rasters = 0, lossy = 0, losslessSaved = 0, rebalanced = false;
    for (const e of entries) {
      i++;
      if (i % 4 === 0) report && report(`entry ${i}/${entries.length}`);
      if (e.name.endsWith('/')) { out.push({ name: e.name, data: new Uint8Array(0), store: true }); continue; }
      let data = await ZipCodec.readEntry(e);
      if (!data) { out.push({ name: e.name, data: null, store: true }); continue; }

      if (RASTER.test(e.name) && data.length > 1024) {
        const kind = /\.png$/i.test(e.name) ? 'png' : 'jpeg';
        const ll = await losslessImage(data, kind);
        if (ll.bytes.length < data.length) {
          const saved = data.length - ll.bytes.length;
          losslessSaved += saved;
          if (kind === 'png' && !rebalanced) { rebalanced = true; notes.push('PNG predictors re-optimised inside the archive'); }
        }
        data = ll.bytes;
        if (kind === 'jpeg' && preset.target >= 25) {
          needCanvas();
          try {
            const dec = await Imaging.decode(data, 'image/jpeg');
            const dim = preset.id === 'extreme' ? 900 : preset.target >= 75 ? 1600 : preset.target >= 50 ? 2200 : 0;
            const scale = dim && Math.max(dec.width, dec.height) > dim ? dim / Math.max(dec.width, dec.height) : 1;
            const w = Math.max(1, Math.round(dec.width * scale)), h = Math.max(1, Math.round(dec.height * scale));
            const canvas = scale < 1 ? Imaging.resample(dec.bmp, w, h) : dec.bmp;
            const q = preset.id === 'extreme' ? 0.40 : preset.target >= 90 ? 0.45 : preset.target >= 75 ? 0.62 : preset.target >= 50 ? 0.75 : 0.85;
            const enc = await Imaging.encode(canvas, 'image/jpeg', q);
            rasters++;
            if (enc.length < data.length * 0.9) { data = enc; lossy++; }
            dec.close && dec.close();
          } catch (err) { /* keep lossless */ }
        }
      }
      // XML parts compress best when nothing else changes → just rebuild maximally
      out.push({ name: e.name, data, mode: e.extAttr >>> 0 });
    }
    const rebuilt = await ZipCodec.write(out);
    notes.push(`${entries.length} entries re-packed`);
    if (lossy) notes.push(`${lossy} embedded image${lossy > 1 ? 's' : ''} re-encoded`);
    const useBytes = rebuilt.length < bytes.length ? rebuilt : bytes;
    if (useBytes === bytes) notes.push('already tightly packed — nothing safe left to remove');
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
    // a gzip container only makes sense for payloads big enough to gain from it,
    // and never silently turns a 2 KB page into an unopenable blob
    const worthGzip = bytesOut.length >= 65536 && (1 - bytesOut.length / f.size) * 100 < preset.target;
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    let preset = PRESETS.find(p => p.id === opts.preset) || PRESETS[3];
    const o = opts.options || {};
    // Lossless chases 5 %; when the user insists on bit-exact only, drop the target
    if (preset.bitExact && o.losslessStrict) preset = Object.assign({}, preset, { target: 0 });
    const report = opts.onProgress;
    const kind = Util.sniff(bytes, file.name);
    const f = { name: file.name, size: bytes.length };

    const textual = /^(svg|json|html|htm|css|js|mjs|xml|txt|csv|md)$/i.test(ext(f.name)) || kind === 'svg';
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
      case 'zip': {
        const z = await processZip(f, bytes, preset, o, report);
        return z;
      }
      case 'heic': {
        const gz = await gzip(bytes);
        return gz.length < bytes.length * 0.95
          ? result(f, gz, { type: 'other', kind: 'lossless', outName: f.name + '.gz', notes: ['HEIC cannot be re-encoded in a browser — gzip container offered'] })
          : result(f, bytes, { type: 'other', kind: 'lossless', notes: ['HEIC/HEIF is not decodable in the browser — kept untouched'] });
      }
      default: {
        if (ext(f.name) === 'tif' || ext(f.name) === 'tiff') {
          return result(f, bytes, { type: 'other', kind: 'lossless', notes: ['TIFF is not decodable in the browser — convert to PNG/JPG first'] });
        }
        if (['json', 'html', 'htm', 'css', 'js', 'mjs', 'xml', 'svg', 'txt', 'csv', 'md'].includes(ext(file.name))) {
          return processText(f, bytes, 'text', preset, o);
        }
        // unknown / already-compressed: offer a gzip container
        const gz = await gzip(bytes);
        if (gz.length < bytes.length * 0.95) {
          return result(f, gz, { type: 'other', kind: 'lossless', outName: file.name + '.gz', notes: ['gzip container (format unknown)'] });
        }
        return result(f, bytes, { type: 'other', kind: 'lossless', notes: ['no safe reduction available'] });
      }
    }
  }

  return { compress, PRESETS, LADDER, EXTREME_RUNGS, ladderFor, gzip, needCanvas, encodePdfImage, closeCache, processImage, processPDF, processZip, processText, minifyCSS, minifyJS, minifyHTML, minifyXML, SVG_MIN };
})();
