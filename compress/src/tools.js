/* ══════════════════════════════════════════════════════════════
   tools.js — the ReadOn tool registry

   Every entry here is a real, working operation: no placeholders,
   no redirects, no "coming soon".  Each tool declares its inputs,
   its options and a run() that returns real bytes or real text.
   ══════════════════════════════════════════════════════════════ */

const Tools = (() => {
  const list = [];
  const add = (t) => { list.push(t); return t; };
  const readBytes = async (f) => new Uint8Array(await f.arrayBuffer());
  const mimeOf = (name) => ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif'
  }[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream');
  const extOf = (name) => String(name).split('.').pop().toLowerCase();
  const stem = (name) => String(name).replace(/\.[^.]+$/, '');

  /* A heavy stage on a 12 MP photo takes ~1 s. Yielding between stages lets the browser
     paint (the "working…" state, the spinner, scroll) so the page never looks frozen. */
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));

  const toImageData = async (file) => {
    const dec = await Imaging.decode(file.bytes, mimeOf(file.name));
    const c = Imaging.resample(dec.bmp, dec.width, dec.height);   // real canvas, area-capped
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, c.width, c.height);
    dec.close && dec.close();
    return data;
  };

  const IMG_OUT = {
    jpeg: ['image/jpeg', 'jpg'], png: ['image/png', 'png'], webp: ['image/webp', 'webp']
  };

  async function encodeImage(img, format, quality) {
    const [mime, ext] = IMG_OUT[format] || IMG_OUT.jpeg;
    const bytes = await ImageOps.encode(img, mime, quality);
    return { bytes, ext, mime };
  }

  /* ── small raster helpers used by the extra image tools ──────────── */
  function cropData(img, x, y, w, h) {
    const out = new ImageData(w, h);
    for (let row = 0; row < h; row++) {
      const sy = Math.min(img.height - 1, Math.max(0, y + row));
      for (let col = 0; col < w; col++) {
        const sx = Math.min(img.width - 1, Math.max(0, x + col));
        const sp = (sy * img.width + sx) * 4, dp = (row * w + col) * 4;
        out.data[dp] = img.data[sp]; out.data[dp + 1] = img.data[sp + 1];
        out.data[dp + 2] = img.data[sp + 2]; out.data[dp + 3] = img.data[sp + 3];
      }
    }
    return out;
  }

  function borderData(img, pad, color) {
    const c = ImageOps.canvas(img.width + pad * 2, img.height + pad * 2);
    const ctx = ImageOps.ctx2d(c);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
    const tmp = ImageOps.canvas(img.width, img.height);
    ImageOps.ctx2d(tmp).putImageData(img, 0, 0);
    ctx.drawImage(tmp, pad, pad);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  function diffData(a, b) {
    const w = a.width, h = a.height;
    const bb = (b.width === w && b.height === h) ? b : ImageOps.resampleLanczos(b, w, h);
    const out = new ImageData(w, h);
    let changed = 0, total = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const d0 = Math.abs(a.data[i] - bb.data[i]);
      const d1 = Math.abs(a.data[i + 1] - bb.data[i + 1]);
      const d2 = Math.abs(a.data[i + 2] - bb.data[i + 2]);
      const m = Math.max(d0, d1, d2);
      total++;
      if (m > 6) changed++;
      const v = Math.min(255, m * 4);
      out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255;
    }
    return { img: out, changedPct: (changed / total) * 100 };
  }

  function palette(img, count = 8) {
    const buckets = new Map();
    const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 40000)));
    for (let y = 0; y < img.height; y += step) {
      for (let x = 0; x < img.width; x += step) {
        const p = (y * img.width + x) * 4;
        const a = img.data[p + 3];
        if (a < 200) continue;
        const r = img.data[p] & 0xF0, g = img.data[p + 1] & 0xF0, b = img.data[p + 2] & 0xF0;
        const k = (r << 16) | (g << 8) | b;
        buckets.set(k, (buckets.get(k) || 0) + 1);
      }
    }
    const sorted = [...buckets.entries()].sort((x, y) => y[1] - x[1]).slice(0, count);
    const sum = sorted.reduce((acc, [, n]) => acc + n, 0) || 1;
    return sorted.map(([k, n]) => `#${k.toString(16).padStart(6, '0')}  ${((n / sum) * 100).toFixed(1)}%`);
  }

  /* ── image tools ─────────────────────────────────────────────────── */
  add({
    id: 'compress', group: 'Popular', icon: 'i-down', kind: 'compress',
    title: 'Compress', blurb: 'PDF, JPG, PNG, WebP, Office, text — 7 targets',
    tags: 'shrink reduce smaller size pdf jpg png docx pptx xlsx epub zip'
  });

  add({
    id: 'enhance', group: 'Image', icon: 'i-spark', kind: 'files',
    title: 'Enhance image', blurb: 'Denoise, auto white balance, levels, detail',
    accept: 'image/*', multiple: false, tags: 'improve quality contrast sharpen bright photo clean noise',
    options: [
      { key: 'level', label: 'Strength', type: 'select', values: [['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']], def: 'medium' },
      { key: 'denoise', label: 'Remove noise', type: 'toggle', def: true },
      { key: 'wb', label: 'Auto white balance', type: 'toggle', def: true },
      { key: 'levels', label: 'Auto levels', type: 'toggle', def: true },
      { key: 'format', label: 'Output', type: 'select', values: [['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP']], def: 'jpeg' }
    ],
    async run(files, o) {
      const f = files[0];
      const strength = { light: 0.45, medium: 1, strong: 1.6 }[o.level] ?? 1;
      let img = await toImageData(f);
      const before = ImageOps.clipped(img);
      await yieldNow();
      if (o.denoise) { img = ImageOps.denoise(img, 0.35 * strength); await yieldNow(); }
      if (o.wb) { img = ImageOps.autoWhiteBalance(img, 0.85); await yieldNow(); }
      if (o.levels) img = ImageOps.autoLevels(img);
      img = ImageOps.contrastSat(img, 1 + 0.06 * strength, 1 + 0.08 * strength);
      await yieldNow();
      img = ImageOps.detailBoost(img, 0.45 * strength);
      await yieldNow();
      const after = ImageOps.clipped(img);
      const lost = Math.round(after.black * 1000) / 10 + Math.round(after.white * 1000) / 10;
      const gain = Math.round((after.black + after.white - before.black - before.white) * 1000) / 10;
      const enc = await encodeImage(img, o.format, 0.94);
      const steps = [o.denoise ? 'denoise' : null, o.wb ? 'white balance' : null, o.levels ? 'auto levels' : null,
        `detail +${Math.round(45 * strength)}%`].filter(Boolean).join(' · ');
      return { files: [{ name: `${stem(f.name)}-enhanced.${enc.ext}`, bytes: enc.bytes,
        note: `${img.width}×${img.height} · ${o.level} · ${steps}${gain > 1.5 ? ' · clipped ' + lost + '%' : ' · no clipping'}` }] };
    }
  });

  add({
    id: 'upscale', group: 'Image', icon: 'i-zoom', kind: 'files',
    title: 'Upscale image', blurb: '×2/×3/×4 progressive Lanczos + detail recovery',
    accept: 'image/*', multiple: false, tags: 'bigger enlarge resize 2x 4x resolution hd upscale',
    options: [
      { key: 'factor', label: 'Scale', type: 'select', values: [['2', '×2'], ['3', '×3'], ['4', '×4']], def: '2' },
      { key: 'cap', label: 'Max long edge', type: 'number', def: 4096, min: 512, max: 8192 },
      { key: 'detail', label: 'Detail recovery', type: 'range', min: 0, max: 100, def: 45, suffix: '%' },
      { key: 'format', label: 'Output', type: 'select', values: [['jpeg', 'JPEG (small)'], ['png', 'PNG (lossless)'], ['webp', 'WebP']], def: 'jpeg' }
    ],
    async run(files, o) {
      const f = files[0];
      const img = await toImageData(f);
      const factor = Math.max(1, Number(o.factor) || 2);
      const cap = Math.max(512, Number(o.cap) || 4096);
      const long = Math.max(img.width, img.height) * factor;
      const scale = Math.min(factor, cap / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      /* at most 2× per pass: a single 4× Lanczos kernel rings badly on edges */
      let big = ImageOps.resampleSteps(img, w, h, 2);
      await yieldNow();
      if (Number(o.detail) > 0) { big = ImageOps.detailBoost(big, Number(o.detail) / 100); await yieldNow(); }
      const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
      const enc = await encodeImage(big, o.format, 0.95);
      const passes = scale > 2 ? '2 progressive passes' : 'Lanczos-3';
      return { files: [{ name: `${stem(f.name)}-${w}x${h}.${enc.ext}`, bytes: enc.bytes,
        note: `${img.width}×${img.height} → ${w}×${h} (${passes}${Number(o.detail) ? ' · detail +' + o.detail + '%' : ''})${long > cap ? ' · capped at ' + cap + ' px' : ''}` }] };
    }
  });

  add({
    id: 'resize', group: 'Image', icon: 'i-resize', kind: 'files',
    title: 'Resize image', blurb: 'Exact pixels or percentage, high quality',
    accept: 'image/*', multiple: false, tags: 'scale dimensions pixels percent smaller',
    options: [
      { key: 'mode', label: 'Mode', type: 'select', values: [['pct', 'percent'], ['px', 'pixels']], def: 'pct' },
      { key: 'pct', label: 'Percent', type: 'range', min: 5, max: 100, def: 50, suffix: '%' },
      { key: 'w', label: 'Width (px)', type: 'number', def: 1200, min: 8, max: 10000 },
      { key: 'format', label: 'Output', type: 'select', values: [['keep', 'keep format'], ['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP']], def: 'keep' }
    ],
    async run(files, o) {
      const f = files[0];
      const img = await toImageData(f);
      const scale = o.mode === 'pct' ? o.pct / 100 : Math.min(1, o.w / img.width);
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const out = scale >= 1 ? img : ImageOps.resampleLanczos(img, w, h);
      const fmt = o.format === 'keep' ? (['png', 'jpeg', 'webp'].includes(extOf(f.name)) ? extOf(f.name) : 'jpeg') : o.format;
      const enc = await encodeImage(out, fmt === 'jpg' ? 'jpeg' : fmt, 0.92);
      return { files: [{ name: `${stem(f.name)}-${w}x${h}.${enc.ext}`, bytes: enc.bytes, note: `${img.width}×${img.height} → ${w}×${h}` }] };
    }
  });

  add({
    id: 'convert', group: 'Image', icon: 'i-swap', kind: 'files',
    title: 'Convert image', blurb: 'PNG ↔ JPG ↔ WebP ↔ BMP ↔ GIF → PNG',
    accept: 'image/*', multiple: true, tags: 'convert png jpg webp format change',
    options: [
      { key: 'format', label: 'To', type: 'select', values: [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']], def: 'png' },
      { key: 'quality', label: 'Quality', type: 'range', min: 50, max: 100, def: 92, suffix: '%' }
    ],
    async run(files, o) {
      const out = [];
      for (const f of files) {
        const img = await toImageData(f);
        const enc = await encodeImage(img, o.format, o.quality / 100);
        out.push({ name: `${stem(f.name)}.${enc.ext}`, bytes: enc.bytes, note: `${f.name} → ${enc.ext.toUpperCase()} ${img.width}×${img.height}` });
      }
      return { files: out };
    }
  });

  add({
    id: 'grayscale', group: 'Image', icon: 'i-mono', kind: 'files',
    title: 'Black & white', blurb: 'Perceptually weighted luminance',
    accept: 'image/*', multiple: true, tags: 'gray grayscale desaturate mono bw',
    options: [{ key: 'format', label: 'Output', type: 'select', values: [['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP']], def: 'jpeg' }],
    async run(files, o) {
      const out = [];
      for (const f of files) {
        const img = ImageOps.grayscale(await toImageData(f));
        const enc = await encodeImage(img, o.format, 0.92);
        out.push({ name: `${stem(f.name)}-gray.${enc.ext}`, bytes: enc.bytes, note: 'luminance 0.2126R + 0.7152G + 0.0722B' });
      }
      return { files: out };
    }
  });

  add({
    id: 'rotate', group: 'Image', icon: 'i-rotate', kind: 'files',
    title: 'Rotate & flip', blurb: '90° / 180° / 270° plus mirror',
    accept: 'image/*', multiple: true, tags: 'rotate flip mirror turn sideways',
    options: [
      { key: 'deg', label: 'Rotate', type: 'select', values: [['0', 'none'], ['90', '90°'], ['180', '180°'], ['270', '270°']], def: '90' },
      { key: 'flip', label: 'Flip', type: 'select', values: [['none', 'none'], ['h', 'horizontal'], ['v', 'vertical']], def: 'none' }
    ],
    async run(files, o) {
      const out = [];
      for (const f of files) {
        let img = await toImageData(f);
        img = ImageOps.rotate(img, +o.deg || 0);
        if (o.flip !== 'none') img = ImageOps.flip(img, o.flip);
        const fmt = ['png', 'jpeg', 'webp'].includes(extOf(f.name)) ? extOf(f.name) : 'jpeg';
        const enc = await encodeImage(img, fmt === 'jpg' ? 'jpeg' : fmt, 0.94);
        out.push({ name: `${stem(f.name)}-rot.${enc.ext}`, bytes: enc.bytes, note: `${o.deg}° ${o.flip === 'none' ? '' : 'flip ' + o.flip}`.trim() });
      }
      return { files: out };
    }
  });

  add({
    id: 'watermark', group: 'Image', icon: 'i-drop', kind: 'files',
    title: 'Watermark image', blurb: 'Text stamp, single or tiled',
    accept: 'image/*', multiple: true, tags: 'watermark logo text copyright protect',
    options: [
      { key: 'text', label: 'Text', type: 'text', def: 'ReadOn' },
      { key: 'opacity', label: 'Opacity', type: 'range', min: 5, max: 100, def: 35, suffix: '%' },
      { key: 'tile', label: 'Tile it', type: 'toggle', def: false },
      { key: 'format', label: 'Output', type: 'select', values: [['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP']], def: 'jpeg' }
    ],
    async run(files, o) {
      const out = [];
      for (const f of files) {
        const img = ImageOps.watermark(await toImageData(f), { text: o.text, opacity: o.opacity / 100, tile: o.tile });
        const enc = await encodeImage(img, o.format, 0.92);
        out.push({ name: `${stem(f.name)}-wm.${enc.ext}`, bytes: enc.bytes, note: `“${o.text}” · ${o.opacity}% · ${o.tile ? 'tiled' : 'corner'}` });
      }
      return { files: out };
    }
  });

  add({
    id: 'favicon', group: 'Image', icon: 'i-grid', kind: 'files',
    title: 'Favicon pack', blurb: '16 → 512 px PNG + .ico-ready set (zip)',
    accept: 'image/*', multiple: false, tags: 'favicon ico icon site pwa apple touch',
    async run(files) {
      const f = files[0];
      const img = await toImageData(f);
      const sizes = [16, 32, 48, 64, 128, 180, 192, 512];
      const entries = [];
      for (const s of sizes) {
        const r = ImageOps.resampleLanczos(img, s, s);
        const bytes = await ImageOps.encode(r, 'image/png', 1);
        entries.push({ name: `icon-${s}.png`, data: bytes });
      }
      const ico = await buildIco(img, [16, 32, 48]);
      entries.push({ name: 'favicon.ico', data: ico });
      const zip = await ZipCodec.write(entries);
      return { files: [{ name: 'favicon-pack.zip', bytes: zip, note: `${sizes.length} PNG + a real multi-size .ico` }] };
    }
  });

  async function buildIco(img, sizes) {
    const pngs = [];
    for (const s of sizes) pngs.push({ s, bytes: await ImageOps.encode(ImageOps.resampleLanczos(img, s, s), 'image/png', 1) });
    const header = new Uint8Array(6 + 16 * pngs.length);
    const dv = new DataView(header.buffer);
    dv.setUint16(2, 1, true);
    dv.setUint16(4, pngs.length, true);
    let offset = header.length;
    pngs.forEach((p, i) => {
      const o = 6 + i * 16;
      header[o] = p.s >= 256 ? 0 : p.s;
      header[o + 1] = p.s >= 256 ? 0 : p.s;
      header[o + 2] = 0; header[o + 3] = 0;
      dv.setUint16(o + 4, 1, true);
      dv.setUint16(o + 6, 32, true);
      dv.setUint32(o + 8, p.bytes.length, true);
      dv.setUint32(o + 12, offset, true);
      offset += p.bytes.length;
    });
    return Util.concat([header, ...pngs.map((p) => p.bytes)]);
  }

  add({
    id: 'strip', group: 'Image', icon: 'i-broom', kind: 'files',
    title: 'Remove photo metadata', blurb: 'EXIF, GPS, camera, thumbnails — pixels kept',
    accept: 'image/*', multiple: true, tags: 'exif gps privacy metadata strip clean',
    async run(files) {
      const out = [];
      for (const f of files) {
        const img = await toImageData(f);
        const fmt = ['png', 'jpeg', 'webp'].includes(extOf(f.name)) ? extOf(f.name) : 'jpeg';
        const enc = await encodeImage(img, fmt === 'jpg' ? 'jpeg' : fmt, 0.95);
        out.push({ name: `${stem(f.name)}-clean.${enc.ext}`, bytes: enc.bytes, note: 're-encoded from pixels — every EXIF/GPS block is gone' });
      }
      return { files: out };
    }
  });

  add({
    id: 'img2pdf', group: 'Image', icon: 'i-pdf', kind: 'files',
    title: 'Image → PDF', blurb: 'One page per image, A4/Letter/fit, JPEG kept as-is',
    accept: 'image/*', multiple: true, tags: 'jpg to pdf png to pdf photo document scan',
    options: [
      { key: 'pageSize', label: 'Page', type: 'select', values: [['a4', 'A4'], ['letter', 'Letter'], ['image', 'fit image']], def: 'a4' },
      { key: 'margin', label: 'Margin', type: 'number', def: 24, min: 0, max: 96 }
    ],
    async run(files, o) {
      const items = [];
      for (const f of files) {
        const img = await toImageData(f);
        const enc = extOf(f.name) === 'jpeg' || extOf(f.name) === 'jpg'
          ? { bytes: f.bytes, type: 'image/jpeg' }
          : { bytes: await ImageOps.encode(img, 'image/jpeg', 0.92) };
        items.push({ bytes: enc.bytes, width: img.width, height: img.height });
      }
      const r = await PDFEdit.imagesToPdf(items, { pageSize: o.pageSize, margin: o.margin });
      return { files: [{ name: 'images.pdf', bytes: r.bytes, note: `${r.pages} page${r.pages > 1 ? 's' : ''} · ${o.pageSize.toUpperCase()} · ${o.margin} pt margin` }] };
    }
  });

  add({
    id: 'svg2png', group: 'Image', icon: 'i-swap', kind: 'files',
    title: 'SVG → PNG', blurb: 'Rasterise at any size with transparency',
    accept: '.svg,image/svg+xml', multiple: true, tags: 'svg png raster convert logo',
    options: [{ key: 'size', label: 'Width (px)', type: 'number', def: 1024, min: 16, max: 4096 }],
    async run(files, o) {
      const out = [];
      for (const f of files) {
        const blob = new Blob([f.bytes], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        try {
          const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
          const ratio = im.naturalHeight / im.naturalWidth || 1;
          const w = o.size, h = Math.max(1, Math.round(w * ratio));
          const c = ImageOps.canvas(w, h);
          const ctx = ImageOps.ctx2d(c);
          ctx.drawImage(im, 0, 0, w, h);
          const bytes = c.convertToBlob ? new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()) : await new Promise((r) => c.toBlob(async (b) => r(new Uint8Array(await b.arrayBuffer())), 'image/png'));
          out.push({ name: `${stem(f.name)}-${w}.png`, bytes, note: `${w}×${h} · transparent background kept` });
        } finally { URL.revokeObjectURL(url); }
      }
      return { files: out };
    }
  });


  add({
    id: 'crop', group: 'Image', icon: 'i-cut', kind: 'files',
    title: 'Crop image', blurb: 'Centre crop to a ratio, or trim margins',
    accept: 'image/*', multiple: true, tags: 'crop trim cut frame ratio square',
    options: [
      { key: 'mode', label: 'Crop to', type: 'select', values: [['1:1', 'square 1:1'], ['4:5', 'portrait 4:5'], ['16:9', 'wide 16:9'], ['3:2', 'photo 3:2'], ['pct', 'percent'], ['trim', 'trim margin']], def: '1:1' },
      { key: 'pct', label: 'Percent kept', type: 'range', min: 10, max: 100, def: 70, suffix: '%' },
      { key: 'margin', label: 'Margin', type: 'range', min: 0, max: 40, def: 6, suffix: '%' },
      { key: 'format', label: 'Output', type: 'select', values: [['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP']], def: 'jpeg' }
    ],
    async run(files, o) {
      const out = [];
      for (const f of files) {
        const img = await toImageData(f);
        let w = img.width, h = img.height, x = 0, y = 0;
        if (o.mode === 'pct') { w = Math.round(img.width * o.pct / 100); h = Math.round(img.height * o.pct / 100); x = (img.width - w) >> 1; y = (img.height - h) >> 1; }
        else if (o.mode === 'trim') { x = Math.round(img.width * o.margin / 100); y = Math.round(img.height * o.margin / 100); w = img.width - x * 2; h = img.height - y * 2; }
        else {
          const [rw, rh] = o.mode.split(':').map(Number);
          const target = rw / rh, cur = img.width / img.height;
          if (cur > target) { w = Math.round(img.height * target); h = img.height; }
          else { w = img.width; h = Math.round(img.width / target); }
          x = (img.width - w) >> 1; y = (img.height - h) >> 1;
        }
        const enc = await encodeImage(cropData(img, x, y, Math.max(1, w), Math.max(1, h)), o.format, 0.93);
        out.push({ name: `${stem(f.name)}-crop.${enc.ext}`, bytes: enc.bytes, note: `${img.width}×${img.height} → ${w}×${h} (${o.mode === 'pct' || o.mode === 'trim' ? o.mode : o.mode + ' ratio'})` });
      }
      return { files: out };
    }
  });

  add({
    id: 'frame', group: 'Image', icon: 'i-grid', kind: 'files',
    title: 'Frame & pad image', blurb: 'Solid border or breathing space',
    accept: 'image/*', multiple: true, tags: 'border frame padding matte background',
    options: [
      { key: 'pad', label: 'Padding', type: 'range', min: 0, max: 20, def: 4, suffix: '%' },
      { key: 'color', label: 'Colour', type: 'text', def: '#F4F0EA' },
      { key: 'format', label: 'Output', type: 'select', values: [['jpeg', 'JPEG'], ['png', 'PNG']], def: 'jpeg' }
    ],
    async run(files, o) {
      const out = [];
      for (const f of files) {
        const img = await toImageData(f);
        const pad = Math.max(0, Math.round(Math.max(img.width, img.height) * (o.pad / 100)));
        const enc = await encodeImage(borderData(img, pad, o.color || '#000'), o.format, 0.93);
        out.push({ name: `${stem(f.name)}-framed.${enc.ext}`, bytes: enc.bytes, note: `${pad}px border in ${o.color}` });
      }
      return { files: out };
    }
  });

  add({
    id: 'diff', group: 'Image', icon: 'i-eye', kind: 'files',
    title: 'Compare two images', blurb: 'Pixel difference map + % changed',
    accept: 'image/*', multiple: true, tags: 'compare diff difference spot check before after',
    async run(files) {
      if (files.length < 2) throw new Error('choose two images');
      const a = await toImageData(files[0]);
      const b = await toImageData(files[1]);
      const { img, changedPct } = diffData(a, b);
      const enc = await encodeImage(img, 'png', 1);
      const same = changedPct < 0.01;
      return { files: [{ name: 'difference.png', bytes: enc.bytes, note: same ? 'identical within 6/255 per channel' : `${changedPct.toFixed(2)}% of pixels differ by more than 6/255` }] };
    }
  });

  add({
    id: 'palette', group: 'Image', icon: 'i-drop', kind: 'files',
    title: 'Colour palette', blurb: 'The dominant colours, with percentages',
    accept: 'image/*', multiple: false, tags: 'palette colors dominant extract design',
    options: [{ key: 'n', label: 'Colours', type: 'range', min: 3, max: 16, def: 8 }],
    async run(files, o) {
      const img = await toImageData(files[0]);
      const rows = palette(img, +o.n || 8);
      const text = `dominant colours in ${files[0].name} (${img.width}×${img.height})\n\n` + rows.join('\n');
      return { files: [{ name: `${stem(files[0].name)}-palette.txt`, bytes: Util.utf8(text), note: `${rows.length} colours` }], preview: text };
    }
  });

  /* ── PDF tools ───────────────────────────────────────────────────── */
  add({
    id: 'pdf-merge', group: 'PDF', icon: 'i-merge', kind: 'files',
    title: 'Merge PDF', blurb: 'Combine files in one clean document',
    accept: 'application/pdf,.pdf', multiple: true, tags: 'merge combine join pdf',
    async run(files) {
      const r = await PDFEdit.merge(files);
      return { files: [{ name: 'merged.pdf', bytes: r.bytes, note: `${files.length} files → ${r.pages} pages` }] };
    }
  });

  add({
    id: 'pdf-split', group: 'PDF', icon: 'i-split', kind: 'files',
    title: 'Split PDF', blurb: 'Every page as its own PDF, packed in a zip',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'split separate pages break apart pdf',
    async run(files) {
      const parts = await PDFEdit.splitEvery(files[0].bytes);
      const zip = await ZipCodec.write(parts.map((p) => ({ name: p.name, data: p.bytes })));
      return { files: [{ name: 'split-pages.zip', bytes: zip, note: `${parts.length} single-page PDFs` }] };
    }
  });

  add({
    id: 'pdf-extract', group: 'PDF', icon: 'i-cut', kind: 'files',
    title: 'Extract pages', blurb: 'Keep only the pages you list, e.g. 1-3,7',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'extract select pages keep range pdf',
    options: [{ key: 'pages', label: 'Pages', type: 'text', def: '1-3' }],
    async run(files, o) {
      const r = await PDFEdit.select(files[0].bytes, parseRanges(o.pages));
      return { files: [{ name: `${stem(files[0].name)}-pages.pdf`, bytes: r.bytes, note: `${o.pages} → ${r.pages} pages` }] };
    }
  });

  add({
    id: 'pdf-delete', group: 'PDF', icon: 'i-x', kind: 'files',
    title: 'Delete pages', blurb: 'Remove pages without touching the rest',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'delete remove pages pdf',
    options: [{ key: 'pages', label: 'Remove', type: 'text', def: '2' }],
    async run(files, o) {
      const info = await PDFEdit.info(files[0].bytes);
      const drop = new Set(parseRanges(o.pages));
      const keep = [];
      for (let i = 1; i <= info.pages; i++) if (!drop.has(i)) keep.push(i);
      if (!keep.length) throw new Error('that would delete every page');
      const r = await PDFEdit.select(files[0].bytes, keep);
      return { files: [{ name: `${stem(files[0].name)}-deleted.pdf`, bytes: r.bytes, note: `${info.pages} → ${r.pages} pages` }] };
    }
  });

  add({
    id: 'pdf-rotate', group: 'PDF', icon: 'i-rotate', kind: 'files',
    title: 'Rotate PDF', blurb: 'Turn every page by 90°, 180° or 270°',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'rotate turn landscape portrait pdf',
    options: [{ key: 'deg', label: 'Rotate', type: 'select', values: [['90', '90° clockwise'], ['180', '180°'], ['270', '270°']], def: '90' }],
    async run(files, o) {
      const r = await PDFEdit.rotate(files[0].bytes, +o.deg);
      return { files: [{ name: `${stem(files[0].name)}-rotated.pdf`, bytes: r.bytes, note: `${r.pages} pages · ${o.deg}°` }] };
    }
  });

  add({
    id: 'pdf-numbers', group: 'PDF', icon: 'i-hash', kind: 'files',
    title: 'Page numbers', blurb: 'Real text stamps, four positions',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'page numbers pagination footer pdf',
    options: [
      { key: 'pos', label: 'Position', type: 'select', values: [['bc', 'bottom centre'], ['br', 'bottom right'], ['bl', 'bottom left'], ['tr', 'top right']], def: 'bc' },
      { key: 'size', label: 'Size', type: 'number', def: 11, min: 6, max: 24 },
      { key: 'style', label: 'Format', type: 'select', values: [['n', '1'], ['n-of-m', '1 / 12'], ['page-n', 'Page 1']], def: 'n-of-m' }
    ],
    async run(files, o) {
      const r = await PDFEdit.stamp(files[0].bytes, {
        pos: o.pos, size: o.size, mode: 'number',
        perPage: (i, n) => (o.style === 'n-of-m' ? `${i} / ${n}` : o.style === 'page-n' ? `Page ${i}` : String(i))
      });
      return { files: [{ name: `${stem(files[0].name)}-numbered.pdf`, bytes: r.bytes, note: `${r.pages} pages stamped at the ${o.pos === 'bc' ? 'bottom centre' : o.pos === 'br' ? 'bottom right' : o.pos === 'bl' ? 'bottom left' : 'top right'}` }] };
    }
  });

  add({
    id: 'pdf-watermark', group: 'PDF', icon: 'i-drop', kind: 'files',
    title: 'Watermark PDF', blurb: 'Diagonal text with real transparency',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'watermark stamp draft confidential pdf',
    options: [
      { key: 'text', label: 'Text', type: 'text', def: 'CONFIDENTIAL' },
      { key: 'opacity', label: 'Opacity', type: 'range', min: 5, max: 60, def: 18, suffix: '%' }
    ],
    async run(files, o) {
      const r = await PDFEdit.stamp(files[0].bytes, { text: o.text, mode: 'watermark', opacity: o.opacity / 100, color: [0.55, 0.55, 0.55] });
      return { files: [{ name: `${stem(files[0].name)}-watermark.pdf`, bytes: r.bytes, note: `“${o.text}” at ${o.opacity}% on ${r.pages} pages` }] };
    }
  });

  add({
    id: 'pdf-info', group: 'PDF', icon: 'i-tag', kind: 'files',
    title: 'PDF metadata', blurb: 'Write title, author, subject, keywords',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'metadata title author properties pdf',
    options: [
      { key: 'title', label: 'Title', type: 'text', def: '' },
      { key: 'author', label: 'Author', type: 'text', def: '' },
      { key: 'subject', label: 'Subject', type: 'text', def: '' },
      { key: 'keywords', label: 'Keywords', type: 'text', def: '' }
    ],
    async run(files, o) {
      const doc = await PDFEdit.parse(files[0].bytes);
      const r = await PDFEdit.compose(doc.pages().map((p) => ({ doc, num: p.num })), { info: o });
      return { files: [{ name: `${stem(files[0].name)}-meta.pdf`, bytes: r.bytes, note: 'document information dictionary rewritten' }] };
    }
  });

  add({
    id: 'pdf-docx', group: 'PDF', icon: 'i-doc', kind: 'files',
    title: 'PDF → Word', blurb: 'Real .docx from the embedded text layer',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'word docx convert pdf to word editable',
    async run(files) {
      const r = await PDFEdit.toDocx(files[0].bytes, stem(files[0].name));
      return {
        files: [{ name: `${stem(files[0].name)}.docx`, bytes: r.bytes,
          note: `${r.pages} pages · ${r.chars} characters · opens in Word, Pages, Google Docs` }]
      };
    }
  });

  add({
    id: 'pdf-text', group: 'PDF', icon: 'i-doc', kind: 'files',
    title: 'PDF → text', blurb: 'Pull the embedded text layer out',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'text extract copy content pdf txt',
    async run(files) {
      const pages = await PDFEdit.extractText(files[0].bytes);
      const body = pages.map((t, i) => `──────── page ${i + 1} ────────\n${t}`).join('\n\n');
      const chars = pages.join('').replace(/\s/g, '').length;
      return {
        files: [{ name: `${stem(files[0].name)}.txt`, bytes: Util.utf8(body + '\n'), note: `${pages.length} pages · ${chars} characters` }],
        preview: body.slice(0, 4000)
      };
    }
  });

  add({
    id: 'pdf-images', group: 'PDF', icon: 'i-image', kind: 'files',
    title: 'Extract PDF images', blurb: 'Every embedded JPEG, at original quality',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'extract images photos jpeg pdf',
    async run(files) {
      const imgs = await PDFEdit.extractJpegs(files[0].bytes);
      if (!imgs.length) throw new Error('no embedded JPEG images in this PDF (vector pages have nothing to extract)');
      const zip = await ZipCodec.write(imgs.map((i) => ({ name: i.name, data: i.bytes })));
      return { files: [{ name: 'pdf-images.zip', bytes: zip, note: `${imgs.length} JPEG${imgs.length > 1 ? 's' : ''}, untouched quality` }] };
    }
  });


  add({
    id: 'pdf-reverse', group: 'PDF', icon: 'i-sort', kind: 'files',
    title: 'Reverse page order', blurb: 'Last page first, structure kept',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'reverse order backwards pages flip pdf',
    async run(files) {
      const r = await PDFEdit.reverse(files[0].bytes);
      return { files: [{ name: `${stem(files[0].name)}-reversed.pdf`, bytes: r.bytes, note: `${r.pages} pages in reverse` }] };
    }
  });

  add({
    id: 'pdf-crop', group: 'PDF', icon: 'i-cut', kind: 'files',
    title: 'Crop PDF margins', blurb: 'Real /CropBox insets in points',
    accept: 'application/pdf,.pdf', multiple: false, tags: 'crop margins trim whitespace borders pdf',
    options: [
      { key: 'all', label: 'All sides (pt)', type: 'number', def: 18, min: 0, max: 200 },
      { key: 'top', label: 'Top only', type: 'number', def: 0, min: 0, max: 300 }
    ],
    async run(files, o) {
      const a = +o.all || 0, t = +o.top || 0;
      const r = await PDFEdit.crop(files[0].bytes, { left: a, right: a, bottom: a, top: a + t });
      return { files: [{ name: `${stem(files[0].name)}-cropped.pdf`, bytes: r.bytes, note: `${a} pt on each side${t ? `, ${t} pt extra at the top` : ''} · ${r.pages} pages` }] };
    }
  });

  add({
    id: 'pdf-interleave', group: 'PDF', icon: 'i-merge', kind: 'files',
    title: 'Interleave two PDFs', blurb: 'Alternate pages: A1, B1, A2, B2…',
    accept: 'application/pdf,.pdf', multiple: true, tags: 'interleave alternate merge odd even scans pdf',
    async run(files) {
      if (files.length < 2) throw new Error('choose two PDFs');
      const a = await PDFEdit.parse(files[0].bytes);
      const b = await PDFEdit.parse(files[1].bytes);
      const pa = a.pages(), pb = b.pages();
      const plan = [];
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if (pa[i]) plan.push({ doc: a, num: pa[i].num });
        if (pb[i]) plan.push({ doc: b, num: pb[i].num });
      }
      const r = await PDFEdit.compose(plan, {});
      return { files: [{ name: 'interleaved.pdf', bytes: r.bytes, note: `${pa.length} + ${pb.length} pages → ${r.pages} interleaved` }] };
    }
  });

  /* ── Office / archives ───────────────────────────────────────────── */
  add({
    id: 'docx-text', group: 'Documents', icon: 'i-doc', kind: 'files',
    title: 'DOCX → text', blurb: 'Paragraphs, tables and lists as plain text',
    accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', multiple: false, tags: 'word docx text extract convert',
    async run(files) {
      const text = await docxText(files[0].bytes);
      return { files: [{ name: `${stem(files[0].name)}.txt`, bytes: Util.utf8(text), note: `${text.split('\n').filter(Boolean).length} paragraphs` }], preview: text.slice(0, 4000) };
    }
  });

  add({
    id: 'txt-pdf', group: 'Documents', icon: 'i-doc', kind: 'files',
    title: 'Text → PDF', blurb: 'TXT / MD laid out with real typography',
    accept: '.txt,.md,.markdown,.log,.csv,text/plain,text/markdown', multiple: true, tags: 'text txt markdown md word pad to pdf convert',
    options: [
      { key: 'size', label: 'Font size', type: 'range', min: 8, max: 16, def: 10, suffix: 'pt' },
      { key: 'mono', label: 'Font', type: 'select', values: [['0', 'Helvetica'], ['1', 'Courier']], def: '0' }
    ],
    async run(files, o) {
      const out = [];
      for (const f of files) {
        const text = new TextDecoder().decode(f.bytes);
        const r = await PDFEdit.textToPdf(text, {
          size: parseInt(o.size, 10) || 10, mono: o.mono === '1', title: stem(f.name)
        });
        out.push({ name: `${stem(f.name)}.pdf`, bytes: r.bytes, note: `${r.pages} pages · A4 · ${text.split(/\r?\n/).length} lines` });
      }
      return { files: out };
    }
  });

  add({
    id: 'csv-pdf', group: 'Documents', icon: 'i-table', kind: 'files',
    title: 'CSV → PDF', blurb: 'Ruled table, header on every page',
    accept: '.csv,text/csv', multiple: false, tags: 'csv excel table to pdf convert print',
    async run(files) {
      const text = new TextDecoder().decode(files[0].bytes);
      const r = await PDFEdit.csvToPdf(text);
      return { files: [{ name: `${stem(files[0].name)}.pdf`, bytes: r.bytes, note: `${r.rows} rows × ${r.cols} columns · ${r.pages} pages` }] };
    }
  });

  add({
    id: 'docx-pdf', group: 'Documents', icon: 'i-doc', kind: 'files',
    title: 'Word → PDF', blurb: 'DOCX paragraphs, tables and lists',
    accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', multiple: true, tags: 'word docx to pdf convert document',
    async run(files) {
      const out = [];
      for (const f of files) {
        const text = await docxText(f.bytes);
        const r = await PDFEdit.textToPdf(text, { size: 10.5, title: stem(f.name) });
        out.push({ name: `${stem(f.name)}.pdf`, bytes: r.bytes, note: `${r.pages} pages · ${text.length} characters laid out` });
      }
      return { files: out };
    }
  });

  add({
    id: 'docx-html', group: 'Documents', icon: 'i-code', kind: 'files',
    title: 'DOCX → HTML', blurb: 'Headings, paragraphs, bold/italic, lists',
    accept: '.docx', multiple: false, tags: 'word docx html web convert',
    async run(files) {
      const html = await docxHtml(files[0].bytes);
      return { files: [{ name: `${stem(files[0].name)}.html`, bytes: Util.utf8(html), note: 'semantic HTML, no external assets' }], preview: html.slice(0, 4000) };
    }
  });

  add({
    id: 'xlsx-csv', group: 'Documents', icon: 'i-table', kind: 'files',
    title: 'XLSX → CSV', blurb: 'First worksheet, values as text',
    accept: '.xlsx', multiple: false, tags: 'excel xlsx csv spreadsheet convert',
    async run(files) {
      const csv = await xlsxCsv(files[0].bytes);
      return { files: [{ name: `${stem(files[0].name)}.csv`, bytes: Util.utf8(csv), note: `${csv.split('\n').length - 1} rows` }], preview: csv.slice(0, 2000) };
    }
  });

  add({
    id: 'zip-unpack', group: 'Documents', icon: 'i-zip', kind: 'files',
    title: 'Unpack archive', blurb: 'ZIP (and Office files) → individual files',
    accept: '.zip,.docx,.pptx,.xlsx,.epub,.odt,application/zip', multiple: false, tags: 'unzip extract archive zip files',
    async run(files) {
      const entries = await ZipCodec.list(files[0].bytes);
      if (!entries) throw new Error('not a ZIP archive');
      const out = [];
      for (const e of entries) {
        if (e.name.endsWith('/')) continue;
        const data = await ZipCodec.readEntry(e);
        if (data) out.push({ name: e.name.split('/').pop(), bytes: data, note: `${(data.length / 1024).toFixed(1)} KB` });
      }
      return { files: out, note: `${out.length} files unpacked` };
    }
  });

  add({
    id: 'zip-pack', group: 'Documents', icon: 'i-zip', kind: 'files',
    title: 'Create ZIP', blurb: 'Pack anything, deflated, with CRCs',
    accept: '', multiple: true, tags: 'zip pack archive compress bundle',
    async run(files) {
      const zip = await ZipCodec.write(files.map((f) => ({ name: f.name, data: f.bytes })));
      return { files: [{ name: 'archive.zip', bytes: zip, note: `${files.length} files` }] };
    }
  });


  add({
    id: 'pptx-text', group: 'Documents', icon: 'i-doc', kind: 'files',
    title: 'PPTX → text', blurb: 'Every slide, every text box',
    accept: '.pptx', multiple: false, tags: 'powerpoint pptx slides text extract convert',
    async run(files) {
      const entries = await ZipCodec.list(files[0].bytes);
      if (!entries) throw new Error('not a PPTX file');
      const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
        .sort((a, b) => (+a.name.match(/(\d+)/)[1]) - (+b.name.match(/(\d+)/)[1]));
      if (!slides.length) throw new Error('no slides inside');
      const out = [];
      for (const s of slides) {
        const xml = new TextDecoder().decode(await ZipCodec.readEntry(s));
        const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1])
          .join('\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
        out.push(`──────── slide ${s.name.match(/(\d+)/)[1]} ────────\n${text}`);
      }
      const body = out.join('\n\n');
      return { files: [{ name: `${stem(files[0].name)}.txt`, bytes: Util.utf8(body + '\n'), note: `${slides.length} slides` }], preview: body.slice(0, 4000) };
    }
  });

  add({
    id: 'csv-xlsx', group: 'Documents', icon: 'i-table', kind: 'files',
    title: 'CSV → XLSX', blurb: 'Real Excel workbook, inline strings',
    accept: '.csv,.tsv,text/csv,text/plain', multiple: false, tags: 'csv excel xlsx spreadsheet convert',
    async run(files) {
      const text = new TextDecoder().decode(files[0].bytes);
      const delim = files[0].name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
      const rows = TextOps.parseCsv(text, delim);
      const cell = (v, ref) => {
        const t = v == null ? '' : String(v);
        if (t === '') return '';
        if (/^-?\d+(\.\d+)?$/.test(t)) return `<c r="${ref}"><v>${t}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t></is></c>`;
      };
      const colName = (i) => { let s = '', n = i + 1; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
      const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => cell(c, colName(ci) + (ri + 1))).join('')}</row>`).join('');
      const files2 = [
        { name: '[Content_Types].xml', data: Util.utf8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
        { name: '_rels/.rels', data: Util.utf8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
        { name: 'xl/workbook.xml', data: Util.utf8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>') },
        { name: 'xl/_rels/workbook.xml.rels', data: Util.utf8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
        { name: 'xl/worksheets/sheet1.xml', data: Util.utf8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`) }
      ];
      const zip = await ZipCodec.write(files2);
      return { files: [{ name: `${stem(files[0].name)}.xlsx`, bytes: zip, note: `${rows.length} rows × ${rows[0] ? rows[0].length : 0} columns` }] };
    }
  });

  /* ── text tools ──────────────────────────────────────────────────── */
  const tx = (t) => add(Object.assign({ kind: 'text', group: 'Text & code', multiple: false }, t));

  tx({ id: 'json-format', icon: 'i-code', title: 'JSON formatter', blurb: 'Pretty-print with 2-space indent', tags: 'json pretty print format beautify',
    async run(s, o) { return { text: TextOps.jsonFormat(s, 2) }; } });
  tx({ id: 'json-minify', icon: 'i-code', title: 'JSON minify', blurb: 'Strip every byte that is not data', tags: 'json minify compact',
    async run(s) { return { text: TextOps.jsonMinify(s) }; } });
  tx({ id: 'json-csv', icon: 'i-table', title: 'JSON → CSV', blurb: 'Arrays of objects to a spreadsheet', tags: 'json csv convert table',
    async run(s) { return { text: TextOps.jsonToCsv(s) }; } });
  tx({ id: 'csv-json', icon: 'i-table', title: 'CSV → JSON', blurb: 'Header row becomes the keys', tags: 'csv json convert table',
    async run(s) { return { text: TextOps.csvToJson(s) }; } });
  tx({ id: 'csv-tsv', icon: 'i-table', title: 'CSV → TSV', blurb: 'Comma to tab, quotes handled', tags: 'csv tsv tab delimiter',
    async run(s) { return { text: TextOps.csvToTsv(s) }; } });
  tx({ id: 'json-keys', icon: 'i-code', title: 'JSON key list', blurb: 'Every path in a JSON document', tags: 'json keys schema paths',
    async run(s) { return { text: TextOps.jsonKeys(s) }; } });
  tx({ id: 'css-min', icon: 'i-code', title: 'Minify CSS', blurb: 'Comments, whitespace, last semicolon', tags: 'css minify compress',
    async run(s) { return { text: Compressor.minifyCSS(s) }; } });
  tx({ id: 'js-min', icon: 'i-code', title: 'Minify JS', blurb: 'String-safe comment and space stripper', tags: 'javascript js minify',
    async run(s) { return { text: Compressor.minifyJS(s) }; } });
  tx({ id: 'html-min', icon: 'i-code', title: 'Minify HTML', blurb: 'Comments and inter-tag space', tags: 'html minify',
    async run(s) { return { text: Compressor.minifyHTML(s) }; } });
  tx({ id: 'svg-min', icon: 'i-code', title: 'Minify SVG', blurb: 'Metadata, comments, precision', tags: 'svg minify icons',
    async run(s) { return { text: Compressor.SVG_MIN(s) }; } });
  tx({ id: 'xml-min', icon: 'i-code', title: 'Minify XML', blurb: 'Comments and whitespace only', tags: 'xml minify',
    async run(s) { return { text: Compressor.minifyXML(s) }; } });
  tx({ id: 'md-html', icon: 'i-code', title: 'Markdown → HTML', blurb: 'Headings, lists, code, links, quotes', tags: 'markdown md html convert',
    async run(s) { return { text: TextOps.mdToHtml(s) }; } });
  tx({ id: 'html-text', icon: 'i-doc', title: 'HTML → text', blurb: 'Readable text, tags removed', tags: 'html text strip tags',
    async run(s) { return { text: TextOps.htmlToText(s) }; } });
  tx({ id: 'b64-enc', icon: 'i-lock', title: 'Base64 encode', blurb: 'UTF-8 safe', tags: 'base64 encode btoa',
    async run(s) { return { text: TextOps.b64encode(s) }; } });
  tx({ id: 'b64-dec', icon: 'i-lock', title: 'Base64 decode', blurb: 'Handles padding and url-safe', tags: 'base64 decode atob',
    async run(s) { return { text: TextOps.b64decode(s) }; } });
  tx({ id: 'url-enc', icon: 'i-link', title: 'URL encode', blurb: 'encodeURIComponent', tags: 'url encode percent',
    async run(s) { return { text: TextOps.urlEncode(s) }; } });
  tx({ id: 'url-dec', icon: 'i-link', title: 'URL decode', blurb: 'Safely reverses percent escapes', tags: 'url decode percent',
    async run(s) { return { text: TextOps.urlDecode(s) }; } });
  tx({ id: 'hex', icon: 'i-code', title: 'Text ↔ hex', blurb: 'UTF-8 bytes as hex', tags: 'hex bytes encode',
    async run(s) { return { text: /^[0-9a-f\s]+$/i.test(s.trim()) && s.replace(/\s/g, '').length % 2 === 0 ? TextOps.hexDecode(s) : TextOps.hexEncode(s) }; } });
  tx({ id: 'sha256', icon: 'i-lock', title: 'SHA-256 hash', blurb: 'Real WebCrypto digest', tags: 'hash sha256 checksum',
    async run(s) { return { text: await TextOps.hash(s, 'SHA-256') }; } });
  tx({ id: 'sha512', icon: 'i-lock', title: 'SHA-512 hash', blurb: 'Real WebCrypto digest', tags: 'hash sha512 checksum',
    async run(s) { return { text: await TextOps.hash(s, 'SHA-512') }; } });
  tx({ id: 'uuid', icon: 'i-hash', title: 'UUID generator', blurb: 'RFC 4122 v4, crypto random', tags: 'uuid guid random id',
    async run() { return { text: Array.from({ length: 5 }, () => TextOps.uuid()).join('\n') }; } });
  tx({ id: 'count', icon: 'i-doc', title: 'Word counter', blurb: 'Words, lines, sentences, reading time', tags: 'count words characters lines',
    async run(s) { return { text: TextOps.stats(s).map(([k, v]) => String(k).padEnd(26) + v).join('\n') }; } });
  tx({ id: 'case', icon: 'i-case', title: 'Change case', blurb: 'UPPER, lower, Title, camel, snake, kebab', tags: 'case upper lower title camel snake',
    options: [{ key: 'mode', label: 'Case', type: 'select', values: [['upper', 'UPPER'], ['lower', 'lower'], ['title', 'Title Case'], ['sentence', 'Sentence case'], ['camel', 'camelCase'], ['snake', 'snake_case'], ['kebab', 'kebab-case'], ['constant', 'CONSTANT_CASE']], def: 'title' }],
    async run(s, o) { return { text: TextOps.caseConvert(s, o.mode) }; } });
  tx({ id: 'sort', icon: 'i-sort', title: 'Sort lines', blurb: 'Natural order, numbers aware', tags: 'sort lines order alphabetical',
    options: [{ key: 'dir', label: 'Order', type: 'select', values: [['asc', 'A → Z'], ['desc', 'Z → A']], def: 'asc' }],
    async run(s, o) { return { text: TextOps.sortLines(s, o.dir) }; } });
  tx({ id: 'dedupe', icon: 'i-sort', title: 'Remove duplicate lines', blurb: 'First occurrence wins', tags: 'dedupe unique duplicates lines',
    async run(s) { return { text: TextOps.dedupeLines(s) }; } });
  tx({ id: 'trim', icon: 'i-broom', title: 'Clean whitespace', blurb: 'Trailing spaces, blank-line runs', tags: 'trim whitespace blank lines clean',
    async run(s) { return { text: TextOps.trimLines(s) }; } });
  tx({ id: 'slug', icon: 'i-link', title: 'Slugify', blurb: 'URL-safe hyphenated slug', tags: 'slug url seo friendly',
    async run(s) { return { text: TextOps.slugify(s) }; } });
  tx({ id: 'lorem', icon: 'i-doc', title: 'Lorem ipsum', blurb: 'Deterministic filler paragraphs', tags: 'lorem ipsum dummy placeholder text',
    options: [{ key: 'p', label: 'Paragraphs', type: 'number', def: 3, min: 1, max: 20 }],
    async run(s, o) { return { text: TextOps.lorem(+o.p || 3, 5) }; } });
  tx({ id: 'time', icon: 'i-clock', title: 'Timestamp', blurb: 'Unix ↔ ISO ↔ local, with relative', tags: 'timestamp unix epoch date time convert',
    options: [{ key: 'v', label: 'Input', type: 'text', def: '' }],
    async run(s, o) { return { text: TextOps.timestamp((o.v || s || String(Date.now())).trim()) }; } });
  tx({ id: 'color', icon: 'i-drop', title: 'Colour converter', blurb: 'HEX ↔ RGB ↔ HSL + contrast', tags: 'color hex rgb hsl contrast',
    options: [{ key: 'v', label: 'Colour', type: 'text', def: '#D75A5A' }],
    async run(s, o) { return { text: TextOps.colorConvert((o.v || s).trim()) }; } });
  tx({ id: 'escape-html', icon: 'i-code', title: 'Escape HTML', blurb: 'Entities in, entities out', tags: 'html escape entities encode',
    options: [{ key: 'dir', label: 'Direction', type: 'select', values: [['esc', 'escape'], ['unesc', 'unescape']], def: 'esc' }],
    async run(s, o) { return { text: o.dir === 'esc' ? TextOps.escapeHtml(s) : TextOps.unescapeHtml(s) }; } });
  tx({ id: 'rot13', icon: 'i-lock', title: 'ROT13', blurb: 'Classic letter rotation', tags: 'rot13 cipher obfuscate',
    async run(s) { return { text: TextOps.rot13(s) }; } });
  tx({ id: 'reverse', icon: 'i-sort', title: 'Reverse text', blurb: 'Grapheme-safe reversal', tags: 'reverse backwards mirror text',
    async run(s) { return { text: TextOps.reverse(s) }; } });


  /* ── extra text utilities ────────────────────────────────────────── */
  const extraText = (s) => {
    const joined = s.replace(/\r/g, '').replace(/\n{2,}/g, '\u0000').replace(/\n/g, ' ').replace(/\u0000/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    const numbered = s.split('\n').map((l, i) => `${String(i + 1).padStart(String(s.split('\n').length).length, ' ')}. ${l}`);
    const unnumbered = s.split('\n').map((l) => l.replace(/^\s*\d+[.):\t]\s*/, '').replace(/^\s*[•·\-]\s+/, ''));
    return { joined, numbered: numbered.join('\n'), unnumbered: unnumbered.join('\n') };
  };

  function extractBits(s, what) {
    const RE = {
      email: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g,
      url: /https?:\/\/[^\s<>"')]+/g,
      number: /(?<![\w.])-?\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?(?![\w])/g,
      ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
      hashtag: /#[\p{L}\d_]+/gu,
      mention: /@[\w.]+/g
    };
    const hits = [...new Set(s.match(RE[what] || RE.email) || [])];
    return hits.length ? hits.join('\n') : `no ${what} found`;
  }

  function frequency(s) {
    const words = s.toLowerCase().match(/[\p{L}\p{N}'’-]{2,}/gu) || [];
    const stop = new Set('the and for with that this from are was were have has had not but you your our their its his her they them then than into out over under about after before when where which while also just very can could should would will shall may might must been being does did doing'.split(' '));
    const map = new Map();
    for (const w of words) { if (stop.has(w)) continue; map.set(w, (map.get(w) || 0) + 1); }
    const top = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    const width = top.length ? String(top[0][1]).length : 1;
    return `words: ${words.length} · unique: ${map.size}\n\n` + top.map(([w, n]) => `${String(n).padStart(width)}  ${w}`).join('\n');
  }

  function password(len = 20, sets = 'all') {
    const A = {
      lower: 'abcdefghijkmnopqrstuvwxyz',
      upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
      digit: '23456789',
      symbol: '!@#$%^&*-_=+?'
    };
    const pool = sets === 'simple' ? A.lower + A.digit : A.lower + A.upper + A.digit + A.symbol;
    const out = [];
    for (let k = 0; k < 5; k++) {
      const bytes = new Uint8Array(len);
      (self.crypto || { getRandomValues: (b) => b.forEach((_, i) => (b[i] = (Math.random() * 256) | 0)) }).getRandomValues(bytes);
      let pw = '';
      for (let i = 0; i < len; i++) pw += pool[bytes[i] % pool.length];
      out.push(pw);
    }
    const bits = Math.round(len * Math.log2(pool.length));
    return out.join('\n') + `\n\n${len} chars · ${pool.length}-symbol alphabet · ≈${bits} bits of entropy`;
  }

  function jsonToYaml(v, indent = 0) {
    const pad = ' '.repeat(indent);
    const scalar = (x) => {
      if (x === null || x === undefined) return 'null';
      if (typeof x === 'string') return /^[\w./-]+$/.test(x) ? x : JSON.stringify(x);
      return String(x);
    };
    if (Array.isArray(v)) {
      if (!v.length) return `${pad}[]`;
      return v.map((item) => {
        if (item && typeof item === 'object') return `${pad}-\n${jsonToYaml(item, indent + 2)}`;
        return `${pad}- ${scalar(item)}`;
      }).join('\n');
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) return `${pad}{}`;
      return keys.map((k) => {
        const val = v[k];
        if (val && typeof val === 'object') return `${pad}${k}:\n${jsonToYaml(val, indent + 2)}`;
        return `${pad}${k}: ${scalar(val)}`;
      }).join('\n');
    }
    return pad + scalar(v);
  }

  function pickColumns(csv, spec) {
    const rows = TextOps.parseCsv(csv);
    if (!rows.length) return 'empty CSV';
    const head = rows[0];
    const idx = spec.split(/[,\s]+/).filter(Boolean).map((c) => {
      const n = +c;
      if (Number.isFinite(n) && String(n) === c) return n - 1;
      const i = head.findIndex((h) => h.trim().toLowerCase() === c.trim().toLowerCase());
      return i;
    }).filter((i) => i >= 0 && i < head.length);
    if (!idx.length) return 'no matching columns — head row is: ' + head.join(', ');
    const esc = (t) => (/[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t);
    return rows.map((r) => idx.map((i) => esc(r[i] == null ? '' : r[i])).join(',')).join('\n');
  }

  tx({ id: 'join-lines', icon: 'i-sort', title: 'Join / unwrap lines', blurb: 'Reflow hard-wrapped text', tags: 'join lines unwrap reflow paragraphs',
    options: [{ key: 'mode', label: 'Do', type: 'select', values: [['join', 'join lines'], ['number', 'add line numbers'], ['unnumber', 'strip numbers/bullets']], def: 'join' }],
    async run(s, o) {
      const r = extraText(s);
      return { text: o.mode === 'number' ? r.numbered : o.mode === 'unnumber' ? r.unnumbered : r.joined };
    } });
  tx({ id: 'extract', icon: 'i-cut', title: 'Extract bits', blurb: 'Emails, URLs, numbers, IPs, hashtags', tags: 'extract emails urls numbers regex',
    options: [{ key: 'what', label: 'Extract', type: 'select', values: [['email', 'e-mail'], ['url', 'URLs'], ['number', 'numbers'], ['ipv4', 'IPv4'], ['hashtag', 'hashtags'], ['mention', 'mentions']], def: 'email' }],
    async run(s, o) { return { text: extractBits(s, o.what) }; } });
  tx({ id: 'freq', icon: 'i-table', title: 'Word frequency', blurb: 'Top 40 words, stop-words ignored', tags: 'frequency word count top words',
    async run(s) { return { text: frequency(s) }; } });
  tx({ id: 'replace', icon: 'i-swap', title: 'Find & replace', blurb: 'Plain text or regular expression', tags: 'replace find regex substitute',
    options: [
      { key: 'find', label: 'Find', type: 'text', def: '' },
      { key: 'with', label: 'Replace with', type: 'text', def: '' },
      { key: 'regex', label: 'Regex', type: 'toggle', def: false }
    ],
    async run(s, o) {
      if (!o.find) return { text: s };
      if (!o.regex) return { text: s.split(o.find).join(o.with || '') };
      try { return { text: s.replace(new RegExp(o.find, 'g'), o.with || '') }; }
      catch (e) { return { text: 'bad regex: ' + e.message }; }
    } });
  tx({ id: 'password', icon: 'i-lock', title: 'Password generator', blurb: 'Crypto-random, five at a time', tags: 'password generate random secure',
    options: [
      { key: 'len', label: 'Length', type: 'range', min: 8, max: 64, def: 20 },
      { key: 'set', label: 'Alphabet', type: 'select', values: [['all', 'letters + digits + symbols'], ['simple', 'letters + digits']], def: 'all' }
    ],
    async run(s, o) { return { text: password(+o.len || 20, o.set) }; } });
  tx({ id: 'json-yaml', icon: 'i-code', title: 'JSON → YAML', blurb: 'Nested objects and arrays', tags: 'json yaml convert config',
    async run(s) {
      const p = TextOps.jsonFormat(s, 0);
      try { return { text: jsonToYaml(JSON.parse(s)) }; } catch (e) { return { text: p.startsWith('INVALID') ? p : 'INVALID JSON' }; }
    } });
  tx({ id: 'csv-pick', icon: 'i-table', title: 'Pick CSV columns', blurb: 'Keep or reorder by name or index', tags: 'csv columns select reorder table',
    options: [{ key: 'cols', label: 'Columns', type: 'text', def: '1,3' }],
    async run(s, o) { return { text: pickColumns(s, o.cols || '1') }; } });


  /* ── 24 more working utilities ───────────────────────────────────── */
  const UNITS = {
    length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 },
    mass: { kg: 1, g: 0.001, mg: 1e-6, t: 1000, lb: 0.45359237, oz: 0.028349523125, st: 6.35029318 },
    data: { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 },
    time: { s: 1, min: 60, h: 3600, d: 86400, wk: 604800, yr: 31557600 }
  };
  const TEMP = ['c', 'f', 'k'];
  const toC = (v, u) => (u === 'c' ? v : u === 'f' ? (v - 32) * 5 / 9 : v - 273.15);
  const fromC = (c, u) => (u === 'c' ? c : u === 'f' ? c * 9 / 5 + 32 : c + 273.15);

  const MORSE = { a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.' };
  const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
  const NATO = { a: 'Alfa', b: 'Bravo', c: 'Charlie', d: 'Delta', e: 'Echo', f: 'Foxtrot', g: 'Golf', h: 'Hotel', i: 'India', j: 'Juliett', k: 'Kilo', l: 'Lima', m: 'Mike', n: 'November', o: 'Oscar', p: 'Papa', q: 'Quebec', r: 'Romeo', s: 'Sierra', t: 'Tango', u: 'Uniform', v: 'Victor', w: 'Whiskey', x: 'Xray', y: 'Yankee', z: 'Zulu' };
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base32(bytes) {
    let bits = 0, value = 0, out = '';
    for (const b of bytes) {
      value = (value << 8) | b; bits += 8;
      while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    while (out.length % 8) out += '=';
    return out;
  }
  function base32decode(str) {
    const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
      const idx = B32.indexOf(ch);
      if (idx < 0) throw new Error('not base32: ' + ch);
      value = (value << 5) | idx; bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }

  function romanToNum(r) {
    const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let n = 0;
    const s = String(r).toUpperCase().replace(/\s+/g, '');
    for (let i = 0; i < s.length; i++) {
      const v = map[s[i]];
      if (!v) throw new Error('not a roman numeral: ' + r);
      n += v < (map[s[i + 1]] || 0) ? -v : v;
    }
    return n;
  }
  function numToRoman(n) {
    if (!(n > 0 && n < 4000)) throw new Error('roman numerals cover 1–3999');
    const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = '';
    for (const [v, sym] of table) while (n >= v) { out += sym; n -= v; }
    return out;
  }

  function ipToInt(ip) {
    const parts = String(ip).trim().split('.');
    if (parts.length !== 4) throw new Error('not an IPv4 address');
    return parts.reduce((a, p) => {
      const n = +p;
      if (!(n >= 0 && n <= 255) || String(n) !== p.trim()) throw new Error('bad octet: ' + p);
      return (a << 8) | n;
    }, 0) >>> 0;
  }
  const intToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

  function subnet(cidr) {
    const m = String(cidr).trim().match(/^([\d.]+)\/(\d{1,2})$/);
    if (!m) throw new Error('use 192.168.1.10/24');
    const bits = +m[2];
    if (bits > 32) throw new Error('prefix must be 0–32');
    const ip = ipToInt(m[1]);
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    const network = (ip & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const usable = bits >= 31 ? Math.pow(2, 32 - bits) : Math.pow(2, 32 - bits) - 2;
    return [
      ['address', intToIp(ip)],
      ['prefix', '/' + bits],
      ['subnet mask', intToIp(mask)],
      ['network', intToIp(network)],
      ['broadcast', intToIp(broadcast)],
      ['first host', intToIp(bits >= 31 ? network : network + 1)],
      ['last host', intToIp(bits >= 31 ? broadcast : broadcast - 1)],
      ['usable hosts', usable.toLocaleString('en-US')],
      ['wildcard', intToIp(~mask >>> 0)],
      ['class', ip >>> 24 < 128 ? 'A' : ip >>> 24 < 192 ? 'B' : ip >>> 24 < 224 ? 'C' : ip >>> 24 < 240 ? 'D (multicast)' : 'E (reserved)'],
      ['private', /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(intToIp(ip)) ? 'yes (RFC 1918 / loopback)' : 'no']
    ].map(([k, v]) => String(k).padEnd(14) + v).join('\n');
  }

  function lineDiff(aText, bText) {
    const a = aText.split('\n'), b = bText.split('\n');
    if (a.length > 800 || b.length > 800) return 'too long for an in-browser diff (max 800 lines each)';
    const n = a.length, m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push('  ' + a[i]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { out.push('- ' + a[i]); i++; }
      else { out.push('+ ' + b[j]); j++; }
    }
    while (i < n) out.push('- ' + a[i++]);
    while (j < m) out.push('+ ' + b[j++]);
    return out.join('\n');
  }

  tx({ id: 'unaccent', icon: 'i-case', title: 'Remove accents', blurb: 'Unicode → plain ASCII letters', tags: 'accent diacritics normalize ascii',
    async run(s) { return { text: s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '') }; } });
  tx({ id: 'invisible', icon: 'i-broom', title: 'Strip invisible characters', blurb: 'Zero-width, BOM, soft hyphen, control', tags: 'zero width bom clean invisible unicode',
    async run(s) { return { text: s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') }; } });
  tx({ id: 'caesar', icon: 'i-lock', title: 'Caesar cipher', blurb: 'Shift letters by any amount', tags: 'caesar cipher shift rot encrypt',
    options: [{ key: 'shift', label: 'Shift', type: 'range', min: 1, max: 25, def: 3 }],
    async run(s, o) {
      const k = ((+o.shift || 0) % 26 + 26) % 26;
      return { text: s.replace(/[a-z]/gi, (c) => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + k) % 26) + base);
      }) };
    } });
  tx({ id: 'rot47', icon: 'i-lock', title: 'ROT47', blurb: 'Printable-ASCII rotation', tags: 'rot47 ascii cipher',
    async run(s) { return { text: s.replace(/[!-~]/g, (c) => String.fromCharCode(33 + ((c.charCodeAt(0) - 33 + 47) % 94))) }; } });
  tx({ id: 'morse', icon: 'i-code', title: 'Morse code', blurb: 'Letters, digits, word breaks', tags: 'morse code telegraph encode',
    options: [{ key: 'mode', label: 'Mode', type: 'select', values: [['enc', 'text → morse'], ['dec', 'morse → text']], def: 'enc' }],
    async run(s, o) {
      if (o.mode === 'dec') {
        return { text: s.trim().split(/\s*\/\s*|\s{3,}/).map((w) => w.trim().split(/\s+/).map((c) => MORSE_REV[c] || '?').join('')).join(' ') };
      }
      const enc = [...s.toLowerCase()].map((c) => (c === ' ' ? '/' : c === '\n' ? '/' : MORSE[c] || '')).filter(Boolean).join(' ');
      return { text: enc };
    } });
  tx({ id: 'nato', icon: 'i-code', title: 'NATO alphabet', blurb: 'Spell it out on the phone', tags: 'nato phonetic alphabet spell',
    async run(s) { return { text: [...s.toLowerCase()].map((c) => (c === ' ' ? '/' : NATO[c] || c.toUpperCase())).join(' ') }; } });
  tx({ id: 'binary', icon: 'i-code', title: 'Text ↔ binary', blurb: 'UTF-8 bytes as 0/1 groups', tags: 'binary bits bytes encode',
    options: [{ key: 'mode', label: 'Mode', type: 'select', values: [['enc', 'text → binary'], ['dec', 'binary → text']], def: 'enc' }],
    async run(s, o) {
      if (o.mode === 'dec') {
        const bits = s.replace(/[^01]/g, '');
        const u8 = new Uint8Array(Math.floor(bits.length / 8));
        for (let i = 0; i < u8.length; i++) u8[i] = parseInt(bits.substr(i * 8, 8), 2);
        return { text: new TextDecoder().decode(u8) };
      }
      return { text: [...new TextEncoder().encode(s)].map((b) => b.toString(2).padStart(8, '0')).join(' ') };
    } });
  tx({ id: 'base32', icon: 'i-lock', title: 'Base32', blurb: 'RFC 4648 encode or decode', tags: 'base32 rfc4648 encode decode',
    options: [{ key: 'mode', label: 'Mode', type: 'select', values: [['enc', 'encode'], ['dec', 'decode']], def: 'enc' }],
    async run(s, o) {
      try {
        if (o.mode === 'dec') return { text: new TextDecoder().decode(base32decode(s)) };
        return { text: base32(new TextEncoder().encode(s)) };
      } catch (e) { return { text: e.message }; }
    } });
  tx({ id: 'jwt', icon: 'i-lock', title: 'JWT decoder', blurb: 'Header + claims, expiry shown', tags: 'jwt token decode claims auth',
    async run(s) {
      const parts = s.trim().split('.');
      if (parts.length < 2) return { text: 'not a JWT — expected three dot-separated parts' };
      const b64 = (t) => TextOps.b64decode(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4));
      const head = TextOps.jsonFormat(b64(parts[0]), 2);
      const body = TextOps.jsonFormat(b64(parts[1]), 2);
      let when = '';
      try {
        const claims = JSON.parse(b64(parts[1]));
        const now = Date.now() / 1000;
        for (const [k, label] of [['iat', 'issued'], ['nbf', 'not before'], ['exp', 'expires']]) {
          if (claims[k]) when += `${label.padEnd(12)}${new Date(claims[k] * 1000).toISOString()} (${claims[k] < now ? 'past' : 'future'})\n`;
        }
      } catch (e) { /* claims are not JSON */ }
      return { text: `header\n${head}\n\nclaims\n${body}${when ? '\n\n' + when : ''}\nsignature verified: no — this tool only decodes` };
    } });
  tx({ id: 'totp', icon: 'i-clock', title: 'TOTP codes', blurb: 'RFC 6238 from a base32 secret', tags: 'totp otp 2fa authenticator code',
    options: [
      { key: 'secret', label: 'Base32 secret', type: 'text', def: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
      { key: 't', label: 'Unix time (0 = now)', type: 'number', def: 0, min: 0, max: 9999999999 },
      { key: 'digits', label: 'Digits', type: 'select', values: [['6', '6'], ['8', '8']], def: '6' }
    ],
    async run(s, o) {
      const secret = new Uint8Array(base32decode(o.secret || s));
      const key = await self.crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
      const base = o.t && +o.t > 0 ? +o.t : Math.floor(Date.now() / 1000);
      const out = [];
      for (let step = -1; step <= 2; step++) {
        const t = Math.floor(base / 30) + step;
        const buf = new ArrayBuffer(8);
        new DataView(buf).setUint32(4, t);
        const mac = new Uint8Array(await self.crypto.subtle.sign('HMAC', key, buf));
        const off = mac[19] & 15;
        const bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
        const code = String(bin % Math.pow(10, +o.digits || 6)).padStart(+o.digits || 6, '0');
        out.push(`${code}   ${step === 0 ? 'now' : step < 0 ? 'previous window' : '+' + step + ' window'} (step ${t})`);
      }
      return { text: out.join('\n') };
    } });
  tx({ id: 'bases', icon: 'i-hash', title: 'Number bases', blurb: 'bin / oct / dec / hex, any direction', tags: 'binary octal decimal hex convert number base',
    options: [
      { key: 'from', label: 'From base', type: 'select', values: [['auto', 'detect'], ['2', '2'], ['8', '8'], ['10', '10'], ['16', '16']], def: 'auto' }
    ],
    async run(s, o) {
      let t = s.trim().replace(/[\s_]/g, '');
      let base = +o.from || 0;
      if (!base || o.from === 'auto') {
        if (/^0x/i.test(t)) { base = 16; t = t.slice(2); }
        else if (/^0b/i.test(t)) { base = 2; t = t.slice(2); }
        else if (/^0o/i.test(t)) { base = 8; t = t.slice(2); }
        else if (/^[01]+$/.test(t)) base = 2;
        else if (/^[0-9]+$/.test(t)) base = 10;
        else if (/^[0-9a-f]+$/i.test(t)) base = 16;
        else return { text: 'cannot detect the base — type 0x…, 0b…, or choose one' };
      }
      const n = parseInt(t, base);
      if (!Number.isFinite(n)) return { text: 'not a valid number in base ' + base };
      return { text: [
        ['input', `${t} (base ${base})`],
        ['binary', n.toString(2)],
        ['octal', n.toString(8)],
        ['decimal', String(n)],
        ['hex', n.toString(16).toUpperCase()],
        ['bytes (BE)', Buffer32(n)],
        ['unicode', n >= 32 && n <= 0x10FFFF ? String.fromCodePoint(n) : '—']
      ].map(([k, v]) => String(k).padEnd(12) + v).join('\n') };
    } });
  function Buffer32(n) {
    const b = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    return b.map((x) => x.toString(16).padStart(2, '0')).join(' ') + '  (' + ((n >>> 24 & 128) ? 'negative in int32' : 'unsigned') + ')';
  }
  tx({ id: 'roman', icon: 'i-case', title: 'Roman numerals', blurb: '1–3999, both directions', tags: 'roman numerals convert',
    async run(s) {
      const t = s.trim();
      try {
        if (/^[IVXLCDMivxlcdm\s]+$/.test(t) && /[IVXLCDM]/i.test(t)) {
          const n = romanToNum(t);
          if (n < 1 || n > 3999) return { text: `${t.toUpperCase()} = ${n} — outside the classic 1–3999 range (non-standard numeral)` };
          return { text: `${t.toUpperCase()} = ${n}` };
        }
        return { text: `${t} = ${numToRoman(+t)}` };
      } catch (e) { return { text: e.message }; }
    } });
  tx({ id: 'subnet', icon: 'i-link', title: 'IPv4 subnet', blurb: 'Mask, network, broadcast, host range', tags: 'subnet cidr ip network mask calculator',
    options: [{ key: 'cidr', label: 'CIDR', type: 'text', def: '192.168.1.10/24' }],
    async run(s, o) {
      try { return { text: subnet((o.cidr || s).trim()) }; } catch (e) { return { text: e.message }; }
    } });
  tx({ id: 'diff-text', icon: 'i-sort', title: 'Diff two texts', blurb: 'Line diff — left is “a”, right is “b”', tags: 'diff compare text changes',
    options: [{ key: 'b', label: 'Compare with', type: 'text', def: '' }],
    async run(s, o) { return { text: lineDiff(s.replace(/\r/g, ''), String(o.b || '').replace(/\\n/g, '\n').replace(/\r/g, '')) }; } });
  tx({ id: 'eol', icon: 'i-sort', title: 'Line endings', blurb: 'LF ⇄ CRLF ⇄ CR', tags: 'line endings crlf lf newline windows unix',
    options: [{ key: 'to', label: 'Convert to', type: 'select', values: [['lf', 'LF (unix)'], ['crlf', 'CRLF (windows)'], ['cr', 'CR (classic mac)']], def: 'lf' }],
    async run(s, o) {
      const unix = s.replace(/\r\n?/g, '\n');
      const out = o.to === 'crlf' ? unix.replace(/\n/g, '\r\n') : o.to === 'cr' ? unix.replace(/\n/g, '\r') : unix;
      return { text: out };
    } });
  tx({ id: 'tabs', icon: 'i-sort', title: 'Tabs ↔ spaces', blurb: 'Re-indent by N spaces', tags: 'tabs spaces indent code',
    options: [
      { key: 'n', label: 'Spaces', type: 'number', def: 4, min: 1, max: 12 },
      { key: 'dir', label: 'Direction', type: 'select', values: [['to-space', 'tabs → spaces'], ['to-tab', 'spaces → tabs']], def: 'to-space' }
    ],
    async run(s, o) {
      const n = Math.max(1, +o.n || 4);
      if (o.dir === 'to-tab') return { text: s.replace(new RegExp(' '.repeat(n), 'g'), '\t') };
      return { text: s.replace(/\t/g, ' '.repeat(n)) };
    } });
  tx({ id: 'sort-words', icon: 'i-sort', title: 'Sort words', blurb: 'Alphabetise the words in place', tags: 'sort words alphabetical',
    async run(s) {
      const words = s.trim().split(/\s+/).filter(Boolean);
      words.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      return { text: words.join(' ') };
    } });
  tx({ id: 'date-diff', icon: 'i-clock', title: 'Date difference', blurb: 'Days, weeks, working days', tags: 'date difference days between',
    options: [
      { key: 'a', label: 'From (YYYY-MM-DD)', type: 'text', def: '2026-01-01' },
      { key: 'b', label: 'To', type: 'text', def: '2026-01-31' }
    ],
    async run(s, o) {
      const a = new Date((o.a || '').trim() + 'T00:00:00Z'), b = new Date((o.b || '').trim() + 'T00:00:00Z');
      if (isNaN(a) || isNaN(b)) return { text: 'use YYYY-MM-DD' };
      const days = Math.round((b - a) / 86400000);
      let work = 0;
      const dir = Math.sign(days);
      for (let d = 0; d !== days; d += dir || 1) {
        const day = new Date(a.getTime() + d * 86400000).getUTCDay();
        if (day !== 0 && day !== 6) work += dir;
        if (!dir) break;
      }
      return { text: [
        ['from', a.toISOString().slice(0, 10)],
        ['to', b.toISOString().slice(0, 10)],
        ['days', days],
        ['weeks', (days / 7).toFixed(2)],
        ['working days', work],
        ['calendar days incl.', Math.abs(days) + 1],
        ['months ≈', (days / 30.4375).toFixed(2)],
        ['years ≈', (days / 365.25).toFixed(3)]
      ].map(([k, v]) => String(k).padEnd(18) + v).join('\n') };
    } });
  tx({ id: 'age', icon: 'i-clock', title: 'Age calculator', blurb: 'Years, months, days, next birthday', tags: 'age birthday calculate date',
    options: [{ key: 'birth', label: 'Birth date', type: 'text', def: '2000-01-01' }],
    async run(s, o) {
      const b = new Date((o.birth || s).trim() + 'T00:00:00Z');
      if (isNaN(b)) return { text: 'use YYYY-MM-DD' };
      const now = new Date();
      let y = now.getUTCFullYear() - b.getUTCFullYear();
      let mo = now.getUTCMonth() - b.getUTCMonth();
      let d = now.getUTCDate() - b.getUTCDate();
      if (d < 0) { mo--; d += new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate(); }
      if (mo < 0) { y--; mo += 12; }
      const next = new Date(Date.UTC(now.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()));
      if (next < now) next.setUTCFullYear(next.getUTCFullYear() + 1);
      const days = Math.ceil((next - now) / 86400000);
      return { text: [
        ['birth date', b.toISOString().slice(0, 10)],
        ['age', `${y} years ${mo} months ${d} days`],
        ['total days', Math.floor((now - b) / 86400000)],
        ['next birthday', `${next.toISOString().slice(0, 10)} (${days} days)`],
        ['day of week born', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][b.getUTCDay()]]
      ].map(([k, v]) => String(k).padEnd(18) + v).join('\n') };
    } });
  tx({ id: 'unit', icon: 'i-swap', title: 'Unit converter', blurb: 'Length, mass, data, time, temperature', tags: 'unit convert length weight data temperature',
    options: [
      { key: 'value', label: 'Value', type: 'text', def: '1' },
      { key: 'from', label: 'From', type: 'text', def: 'km' },
      { key: 'to', label: 'To', type: 'text', def: 'mi' }
    ],
    async run(s, o) {
      const v = Number((o.value || s).toString().trim());
      const from = String(o.from || '').trim().toLowerCase();
      const to = String(o.to || '').trim().toLowerCase();
      if (!Number.isFinite(v)) return { text: 'value must be a number' };
      if (TEMP.includes(from) && TEMP.includes(to)) return { text: `${v}°${from.toUpperCase()} = ${fromC(toC(v, from), to).toFixed(4).replace(/\.0+$/, '')}°${to.toUpperCase()}` };
      for (const [kind, table] of Object.entries(UNITS)) {
        const keys = Object.keys(table).map((k) => k.toLowerCase());
        const f = keys.indexOf(from), t = keys.indexOf(to);
        if (f >= 0 && t >= 0) {
          const base = v * table[Object.keys(table)[f]];
          return { text: `${v} ${from} = ${(base / table[Object.keys(table)[t]]).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${to}\n(${kind} conversion)` };
        }
      }
      return { text: `unknown unit pair ${from} → ${to}\nlength: ${Object.keys(UNITS.length).join(' ')}\nmass: ${Object.keys(UNITS.mass).join(' ')}\ndata: ${Object.keys(UNITS.data).join(' ')}\ntime: ${Object.keys(UNITS.time).join(' ')}\ntemperature: c f k` };
    } });
  tx({ id: 'percent', icon: 'i-hash', title: 'Percentage', blurb: 'Of, increase, decrease, change', tags: 'percent percentage increase decrease change calculator',
    options: [
      { key: 'a', label: 'A', type: 'text', def: '10' },
      { key: 'b', label: 'B', type: 'text', def: '250' }
    ],
    async run(s, o) {
      const a = Number(o.a), b = Number(o.b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return { text: 'A and B must be numbers' };
      return { text: [
        [`${a}% of ${b}`, (a / 100 * b).toLocaleString('en-US', { maximumFractionDigits: 4 })],
        [`${b} increased by ${a}%`, (b * (1 + a / 100)).toLocaleString('en-US', { maximumFractionDigits: 4 })],
        [`${b} decreased by ${a}%`, (b * (1 - a / 100)).toLocaleString('en-US', { maximumFractionDigits: 4 })],
        [`change ${a} → ${b}`, (b === 0 ? '—' : (((b - a) / a) * 100).toFixed(2) + '%')],
        [`${a} is what % of ${b}`, (b === 0 ? '—' : ((a / b) * 100).toFixed(2) + '%')]
      ].map(([k, v]) => k.padEnd(26) + v).join('\n') };
    } });
  tx({ id: 'emi', icon: 'i-table', title: 'Loan EMI', blurb: 'Monthly payment, interest, total', tags: 'emi loan mortgage interest payment calculator',
    options: [
      { key: 'p', label: 'Principal', type: 'number', def: 500000, min: 1, max: 1e12 },
      { key: 'rate', label: 'Annual %', type: 'number', def: 9, min: 0, max: 60 },
      { key: 'months', label: 'Months', type: 'number', def: 60, min: 1, max: 600 }
    ],
    async run(s, o) {
      const P = +o.p, R = (+o.rate || 0) / 1200, N = Math.max(1, +o.months || 1);
      const emi = R === 0 ? P / N : (P * R * Math.pow(1 + R, N)) / (Math.pow(1 + R, N) - 1);
      const total = emi * N;
      const fmt2 = (x) => x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
      return { text: [
        ['principal', fmt2(P)],
        ['rate', (R * 1200).toFixed(2) + '% p.a.'],
        ['months', N],
        ['monthly EMI', fmt2(emi)],
        ['total payable', fmt2(total)],
        ['total interest', fmt2(total - P)],
        ['interest share', (((total - P) / total) * 100).toFixed(1) + '%']
      ].map(([k, v]) => String(k).padEnd(16) + v).join('\n') };
    } });
  tx({ id: 'bmi', icon: 'i-hash', title: 'BMI & BMR', blurb: 'Body mass index and daily energy', tags: 'bmi bmr calories health weight',
    options: [
      { key: 'kg', label: 'Weight (kg)', type: 'number', def: 70, min: 20, max: 400 },
      { key: 'cm', label: 'Height (cm)', type: 'number', def: 175, min: 80, max: 260 },
      { key: 'age', label: 'Age', type: 'number', def: 30, min: 2, max: 120 },
      { key: 'sex', label: 'Sex', type: 'select', values: [['m', 'male'], ['f', 'female']], def: 'm' }
    ],
    async run(s, o) {
      const kg = +o.kg, cm = +o.cm, age = +o.age;
      const m = cm / 100;
      const bmi = kg / (m * m);
      const cat = bmi < 18.5 ? 'underweight' : bmi < 25 ? 'healthy range' : bmi < 30 ? 'overweight' : 'obese';
      const bmr = 10 * kg + 6.25 * cm - 5 * age + (o.sex === 'f' ? -161 : 5);
      return { text: [
        ['BMI', bmi.toFixed(1) + ' — ' + cat],
        ['healthy weight for that height', `${(18.5 * m * m).toFixed(1)} – ${(24.9 * m * m).toFixed(1)} kg`],
        ['BMR (Mifflin–St Jeor)', Math.round(bmr) + ' kcal/day at rest'],
        ['sedentary', Math.round(bmr * 1.2) + ' kcal'],
        ['moderate (3–5×/wk)', Math.round(bmr * 1.55) + ' kcal'],
        ['athlete (6–7×/wk)', Math.round(bmr * 1.725) + ' kcal']
      ].map(([k, v]) => String(k).padEnd(30) + v).join('\n') };
    } });
  tx({ id: 'wcag', icon: 'i-eye', title: 'Contrast check', blurb: 'WCAG AA / AAA ratio for two colours', tags: 'contrast wcag accessibility color ratio',
    options: [
      { key: 'fg', label: 'Text colour', type: 'text', def: '#171B1E' },
      { key: 'bg', label: 'Background', type: 'text', def: '#F4F0EA' }
    ],
    async run(s, o) {
      const rgb = (hex) => {
        const t = String(hex).trim().replace('#', '');
        const full = t.length === 3 ? [...t].map((c) => c + c).join('') : t;
        if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error('use #rrggbb');
        return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
      };
      try {
        const lum = (c) => c.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
          .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
        const l1 = lum(rgb(o.fg)), l2 = lum(rgb(o.bg));
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        return { text: [
          ['contrast ratio', ratio.toFixed(2) + ':1'],
          ['AA normal text (4.5)', ratio >= 4.5 ? 'pass' : 'fail'],
          ['AA large text (3.0)', ratio >= 3 ? 'pass' : 'fail'],
          ['AAA normal (7.0)', ratio >= 7 ? 'pass' : 'fail'],
          ['AAA large (4.5)', ratio >= 4.5 ? 'pass' : 'fail'],
          ['UI component (3.0)', ratio >= 3 ? 'pass' : 'fail']
        ].map(([k, v]) => String(k).padEnd(24) + v).join('\n') };
      } catch (e) { return { text: e.message }; }
    } });

  /* ── helpers ─────────────────────────────────────────────────────── */
  function parseRanges(str) {
    const out = [];
    for (const part of String(str || '').split(/[,\s]+/)) {
      if (!part) continue;
      const m = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (m) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i); }
      else if (/^\d+$/.test(part)) out.push(+part);
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }

  async function docxText(bytes) {
    const entries = await ZipCodec.list(bytes);
    if (!entries) throw new Error('not a DOCX file');
    const doc = entries.find((e) => e.name === 'word/document.xml');
    if (!doc) throw new Error('no word/document.xml inside');
    const xml = new TextDecoder().decode(await ZipCodec.readEntry(doc));
    return xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/\t+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async function docxHtml(bytes) {
    const entries = await ZipCodec.list(bytes);
    if (!entries) throw new Error('not a DOCX file');
    const doc = entries.find((e) => e.name === 'word/document.xml');
    if (!doc) throw new Error('no word/document.xml inside');
    let xml = new TextDecoder().decode(await ZipCodec.readEntry(doc));
    xml = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (para) => {
      const style = (para.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
      let text = para
        .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (m, t) => t)
        .replace(/<w:tab\/>/g, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      const bold = /<w:b\/>|<w:b /.test(para);
      if (!text.trim()) return '';
      const h = style.match(/Heading(\d)/i);
      if (h) return `<h${h[1]}>${text.trim()}</h${h[1]}>`;
      if (/ListParagraph/i.test(style)) return `<li>${text.trim()}</li>`;
      return bold && text.trim().length < 80 ? `<p><strong>${text.trim()}</strong></p>` : `<p>${text.trim()}</p>`;
    });
    return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${'Document'}</title></head>\n<body>\n${xml}\n</body></html>\n`;
  }

  async function xlsxCsv(bytes) {
    const entries = await ZipCodec.list(bytes);
    if (!entries) throw new Error('not an XLSX file');
    const sheet = entries.find((e) => /^xl\/worksheets\/sheet1\.xml$/.test(e.name));
    if (!sheet) throw new Error('no worksheet inside');
    const sharedE = entries.find((e) => e.name === 'xl/sharedStrings.xml');
    const shared = [];
    if (sharedE) {
      const sx = new TextDecoder().decode(await ZipCodec.readEntry(sharedE));
      for (const m of sx.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
        shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
      }
    }
    const xml = new TextDecoder().decode(await ZipCodec.readEntry(sheet));
    const rows = [];
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cm[1];
        const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1] || '';
        const col = ref ? [...ref].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1 : cells.length;
        const type = (attrs.match(/t="([^"]+)"/) || [])[1];
        const v = (cm[2].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const isv = (cm[2].match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
        let val = type === 's' && v != null ? (shared[+v] || '') : type === 'inlineStr' && isv != null ? isv : v != null ? v : '';
        val = String(val).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        while (cells.length < col) cells.push('');
        cells[col] = val;
      }
      rows.push(cells);
    }
    const esc = (t) => (/[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t);
    return rows.map((r) => r.map(esc).join(',')).join('\n');
  }


  add({
    id: 'pdf-unlock', group: 'PDF', icon: 'i-lock-open', kind: 'files',
    title: 'Unlock PDF', blurb: 'Remove the password, locally',
    accept: 'application/pdf,.pdf', multiple: true, tags: 'unlock password protect remove decrypt security',
    options: [{ key: 'password', label: 'Password', type: 'text', def: '', placeholder: 'leave empty if it only blocks editing' }],
    async run(files, o) {
      const out = [];
      for (const f of files) {
        try {
          const r = await PDFEdit.unlock(f.bytes, o.password || '');
          out.push({ name: `${stem(f.name)}-unlocked.pdf`, bytes: r.bytes,
            note: r.unchanged ? `${r.pages} pages · was not protected — copy kept` : `${r.pages} pages · encryption removed, no password needed` });
        } catch (e) {
          out.push({ name: `${stem(f.name)}-locked.txt`, bytes: Util.utf8(`${f.name}\n\n${e.message}`), note: e.message });
        }
      }
      return { files: out };
    }
  });

  add({
    id: 'pdf-protect', group: 'PDF', icon: 'i-lock', kind: 'files',
    title: 'Protect PDF', blurb: 'AES-256 password encryption',
    accept: 'application/pdf,.pdf', multiple: true, tags: 'protect password encrypt secure lock aes256',
    options: [
      { key: 'password', label: 'Password', type: 'text', def: '', placeholder: 'required' },
      { key: 'perms', label: 'Allow', type: 'select', values: [['-3904', 'Printing + copying'], ['-3392', 'Printing only'], ['-1852', 'Everything except editing'], ['-4', 'Everything']], def: '-3904' }
    ],
    async run(files, o) {
      if (!o.password) throw new Error('type a password in the options first');
      const out = [];
      for (const f of files) {
        try {
          const perms = parseInt(o.perms, 10);
          const r = await PDFEdit.protect(f.bytes, { password: o.password, perms });
          out.push({ name: `${stem(f.name)}-protected.pdf`, bytes: r.bytes,
            note: `${r.pages} pages · AES-256 (R6) · ${(r.size / 1024).toFixed(0)} KB` });
        } catch (e) {
          out.push({ name: `${stem(f.name)}-error.txt`, bytes: Util.utf8(`${f.name}\n\n${e.message}`), note: e.message });
        }
      }
      return { files: out };
    }
  });

  add({
    id: 'pdf-repair', group: 'PDF', icon: 'i-fix', kind: 'files',
    title: 'Repair PDF', blurb: 'Rebuild xref, drop junk after EOF',
    accept: 'application/pdf,.pdf', multiple: true, tags: 'repair fix corrupt broken damage xref rebuild',
    async run(files) {
      const out = [];
      for (const f of files) {
        try {
          const r = await PDFEdit.repair(f.bytes);
          out.push({ name: `${stem(f.name)}-repaired.pdf`, bytes: r.bytes,
            note: r.bytes.length <= f.bytes.length
              ? `${r.pages} pages · rebuilt clean, ${Util.pct(r.bytes.length, f.bytes.length)}% smaller`
              : `${r.pages} pages · rebuilt clean (${Util.pct(r.bytes.length, f.bytes.length)}% larger — the original was already tight)` });
        } catch (e) {
          out.push({ name: `${stem(f.name)}-unreadable.txt`, bytes: Util.utf8(`Could not repair ${f.name}\n\n${e.message}\n\nA PDF with no readable catalog or an encryption dictionary cannot be rebuilt without the password.`), note: 'unreadable' });
        }
      }
      return { files: out };
    }
  });

  add({
    id: 'img-b64', group: 'Image', icon: 'i-b64', kind: 'files',
    title: 'Image → Base64', blurb: 'Data URI for CSS or HTML',
    accept: 'image/*', multiple: true, tags: 'base64 data uri inline embed css html',
    options: [{ key: 'wrap', label: 'Line width', type: 'select', values: [['80', '80 chars'], ['0', 'single line'], ['64', '64 chars']], def: '80' }],
    async run(files, o) {
      const out = [];
      for (const f of files) {
        let bin = '';
        for (let i = 0; i < f.bytes.length; i += 8192) bin += String.fromCharCode.apply(null, f.bytes.subarray(i, i + 8192));
        const b64 = btoa(bin);
        const mime = mimeOf(f.name);
        const width = parseInt(o.wrap, 10) || 0;
        const body = width ? b64.replace(new RegExp(`(.{${width}})`, 'g'), '$1\n').trim() : b64;
        const text = `/* ${f.name} — ${f.bytes.length} bytes → ${b64.length} base64 chars */\n`
          + `/* CSS:  background-image: url("data:${mime};base64,…");  */\n`
          + `data:${mime};base64,${body}\n`;
        out.push({ name: `${stem(f.name)}.base64.txt`, bytes: Util.utf8(text),
          note: `${mime} · ${(b64.length / 1024).toFixed(1)} KB base64` });
      }
      return { files: out };
    }
  });

  /* ── option defaults live with the tool, not with the DOM ──────────
     Every run() used to depend on the caller filling in option values. Any path that
     omitted one (a direct call, a test, a UI whose option node was missing) fed
     `undefined` into the maths and produced a black image. Now a missing option always
     falls back to its declared default, so a tool behaves the same however it is called. */
  for (const t of list) {
    if (typeof t.run !== 'function') continue;
    const run = t.run;
    const defs = {};
    for (const o of t.options || []) defs[o.key] = o.def;
    t.run = function (input, opts) {
      const merged = Object.assign({}, defs);
      if (opts) for (const k of Object.keys(opts)) {
        if (opts[k] !== undefined && opts[k] !== null) merged[k] = opts[k];
      }
      return run.call(t, input, merged);
    };
  }

  return {
    list,
    get: (id) => list.find((t) => t.id === id),
    groups: () => [...new Set(list.map((t) => t.group))],
    parseRanges, docxText, docxHtml, xlsxCsv
  };
})();
