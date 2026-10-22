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
