/* ══════════════════════════════════════════════════════════════
   worker.boot.js — runs inside the compression Web Worker
   The worker owns the heavy work: parsing, DEFLATE, raster ladders.
   If the worker has no canvas (Safari < 16.4 workers), the page is
   asked to take over that single file instead of failing.
   ══════════════════════════════════════════════════════════════ */

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const post = (data, transfer) => { try { self.postMessage(data, transfer || []); } catch (e) { self.postMessage(data); } };

  if (msg.cmd === 'probe') {
    post({
      id: msg.id, type: 'probe',
      canvas: Imaging.hasCanvas,
      offscreen: Imaging.canOffscreen,
      streams: Util.HAS_NATIVE,
      cores: (self.navigator && self.navigator.hardwareConcurrency) || 1
    });
    return;
  }

  /* ── file tools (images, PDFs, archives) ────────────────────────────
     A 12 MP photo takes seconds of pure pixel maths. Running it here means
     the page never freezes: scrolling, the queue and the spinner keep moving. */
  if (msg.cmd === 'tool') {
    const tool = (typeof Tools !== 'undefined') ? Tools.get(msg.toolId) : null;
    if (!tool) { post({ id: msg.id, type: 'error', message: 'unknown tool' }); return; }
    try {
      const res = await tool.run(msg.files || [], msg.opts || {});
      const files = (res.files || []).map((f) => ({ name: f.name, bytes: f.bytes, note: f.note }));
      const transfer = files.map((f) => f.bytes && f.bytes.buffer).filter(Boolean);
      post({ id: msg.id, type: 'done', res: Object.assign({}, res, { files }) }, transfer);
    } catch (e) {
      /* some operations (SVG rasterising, <img> decoding) need a real DOM: the page
         takes those over rather than showing the user an error */
      const m = String((e && e.message) || e || '');
      if ((e && e.code === 'NO_CANVAS') || /document is not defined|Image is not defined|not defined|createImageBitmap|OffscreenCanvas/i.test(m)) {
        post({ id: msg.id, type: 'needmain' });
      } else {
        post({ id: msg.id, type: 'error', message: m || 'tool failure' });
      }
    }
    return;
  }

  if (msg.cmd !== 'compress') return;

  const { id, file, preset, options } = msg;
  let steps = 0;
  try {
    const res = await Compressor.compress(file, {
      preset,
      options: options || {},
      onProgress: (label) => {
        steps++;
        post({ id, type: 'progress', label: String(label), steps });
      }
    });
    post({ id, type: 'done', res }, [res.bytes.buffer]);
  } catch (e) {
    if (e && e.code === 'NO_CANVAS') post({ id, type: 'needmain' });
    else post({ id, type: 'error', message: (e && e.message) || 'worker failure' });
  }
};

/* let the page know we are alive and ready */
self.postMessage({ type: 'ready' });
