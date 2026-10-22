/* ══════════════════════════════════════════════════════════════
   app.js — ReadOn · Compress front-end
   ══════════════════════════════════════════════════════════════ */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const store = {
    get(k, d) { try { const v = localStorage.getItem('readon.compress.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('readon.compress.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  const state = {
    preset: store.get('preset', 'p50'),
    options: Object.assign(
      { pdfText: 'auto', pdfAnnots: 'auto', pdfBookmarks: 'auto', pdfAttachments: 'auto', maxDim: 0, allowWebp: false },
      store.get('options', {})
    ),
    items: [],
    running: false,
    seq: 0,
    compare: null
  };

  /* ── theme ─────────────────────────────────────────── */
  const THEMES = ['dark', 'light', 'sepia'];
  const THEME_LABEL = { dark: 'Dark', light: 'Light', sepia: 'Sepia' };
  const THEME_ICON = { dark: '#i-moon', light: '#i-sun', sepia: '#i-sun' };
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $('#themeLbl').textContent = THEME_LABEL[t];
    $('#themeIco').firstElementChild.setAttribute('href', THEME_ICON[t]);
    store.set('theme', t);
  }
  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'dark';
    applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
  });
  applyTheme(store.get('theme', 'dark'));

  /* ── presets ───────────────────────────────────────── */
  function renderPresets() {
    const box = $('#presets');
    box.innerHTML = '';
    for (const p of Compressor.PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.dataset.id = p.id;
      b.setAttribute('aria-pressed', String(p.id === state.preset));
      b.innerHTML = `<span class="zap">${p.target ? '−' + p.target + '%' : '0%'}</span><b>${p.id === 'lossless' ? 'Lossless' : p.label}</b><span>${p.hint}</span>`;
      b.addEventListener('click', () => {
        state.preset = p.id;
        store.set('preset', p.id);
        renderPresets();
        $('#presetHint').textContent = p.hint.toLowerCase();
        markStale();
      });
      box.appendChild(b);
    }
    const cur = Compressor.PRESETS.find(p => p.id === state.preset);
    $('#presetHint').textContent = cur ? cur.hint.toLowerCase() : '';
  }
  renderPresets();

  /* ── advanced controls ─────────────────────────────── */
  function syncControls() {
    $$('.seg[data-opt]').forEach(seg => {
      const key = seg.dataset.opt;
      const numeric = seg.dataset.num === '1';
      const val = state.options[key];
      $$('button', seg).forEach(b => {
        const bv = numeric ? Number(b.dataset.v) : b.dataset.v;
        b.setAttribute('aria-pressed', String(bv === val));
      });
    });
    $$('.switch[data-flag]').forEach(sw => {
      sw.setAttribute('aria-pressed', String(!!state.options[sw.dataset.flag]));
    });
  }
  $$('.seg[data-opt]').forEach(seg => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !seg.contains(b)) return;
      const key = seg.dataset.opt;
      state.options[key] = seg.dataset.num === '1' ? Number(b.dataset.v) : b.dataset.v;
      store.set('options', state.options);
      syncControls();
      markStale();
    });
  });
  $$('.switch[data-flag]').forEach(sw => {
    sw.addEventListener('click', () => {
      state.options[sw.dataset.flag] = !state.options[sw.dataset.flag];
      store.set('options', state.options);
      syncControls();
      markStale();
    });
  });
  syncControls();
  if (window.matchMedia('(max-width: 640px)').matches) $('#adv').open = false;


  /* ── device profile ────────────────────────────────── */
  const ua = navigator.userAgent || '';
  const caps = {
    mobile: /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua) || matchMedia('(pointer:coarse)').matches,
    cores: navigator.hardwareConcurrency || 4,
    mem: navigator.deviceMemory || 4,
    streams: typeof CompressionStream !== 'undefined',
    offscreen: typeof OffscreenCanvas !== 'undefined',
    worker: typeof Worker !== 'undefined',
    saveData: !!(navigator.connection && navigator.connection.saveData)
  };
  const LOW = caps.mobile || caps.mem <= 2 || caps.cores <= 2;
  const POOL_SIZE = Math.max(1, Math.min(LOW ? 2 : 4, (caps.cores || 2) - 1, caps.mem >= 8 ? 4 : 2));
  caps.pool = POOL_SIZE;

  function capsLine() {
    const bits = [];
    bits.push(caps.streams ? 'native deflate' : 'JS codec fallback');
    if (!caps.worker) bits.push('main thread');
    else if (caps.offscreen) bits.push(`${POOL_SIZE} worker${POOL_SIZE > 1 ? 's' : ''}`);
    else bits.push('worker + main-thread raster');
    if (caps.mobile) bits.push('mobile profile');
    return bits.join(' · ');
  }

  /* ── worker pool ───────────────────────────────────── */
  const Pool = (() => {
    const source = document.getElementById('worker-src');
    let url = null, workers = [], seq = 0, pending = new Map(), booted = false, broken = false;

    function workerSourceURL() {
      if (url) return url;
      const code = source ? source.textContent : '';
      url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      return url;
    }

    function spawn() {
      const w = new Worker(workerSourceURL());
      w.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.type === 'ready') return;
        const p = pending.get(m.id);
        if (!p) return;
        if (m.type === 'progress') { p.onProgress && p.onProgress(m.label, m.steps); return; }
        pending.delete(m.id);
        if (m.type === 'done') p.resolve(m.res);
        else if (m.type === 'needmain') { const e = new Error('NO_CANVAS'); e.code = 'NO_CANVAS'; p.reject(e); }
        else p.reject(new Error(m.message || 'worker error'));
      };
      w.onerror = (e) => {
        broken = true;
        for (const [, p] of pending) p.reject(new Error('worker crashed: ' + (e.message || 'unknown')));
        pending.clear();
      };
      return w;
    }

    function init() {
      if (booted || broken || !caps.worker) return booted;
      try {
        workers = Array.from({ length: POOL_SIZE }, spawn);
        booted = workers.length > 0;
      } catch (e) { broken = true; booted = false; }
      return booted;
    }

    const live = () => (booted && !broken ? workers.filter(w => w) : []);

    function run(file, preset, options, onProgress) {
      if (!init()) return Promise.reject(Object.assign(new Error('no worker'), { code: 'NO_WORKER' }));
      const list = live();
      if (!list.length) return Promise.reject(Object.assign(new Error('no worker'), { code: 'NO_WORKER' }));
      const id = 'j' + (++seq);
      const w = list[seq % list.length];
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        const payload = { cmd: 'compress', id, file, preset, options };
        try { w.postMessage(payload); } catch (e) { pending.delete(id); reject(Object.assign(new Error('spawn'), { code: 'NO_WORKER' })); }
      });
    }

    function stop() {
      for (const [, p] of pending) p.reject(Object.assign(new Error('stopped'), { code: 'STOPPED' }));
      pending.clear();
      for (const w of workers) { try { w.terminate(); } catch (e) {} }
      workers = []; booted = false;
      if (url) { URL.revokeObjectURL(url); url = null; }
    }

    /* run a whole tool in a worker; the caller falls back to the main thread on NO_WORKER */
    function runTool(toolId, files, opts) {
      if (!init()) return Promise.reject(Object.assign(new Error('no worker'), { code: 'NO_WORKER' }));
      const list = live();
      if (!list.length) return Promise.reject(Object.assign(new Error('no worker'), { code: 'NO_WORKER' }));
      const id = 't' + (++seq);
      const w = list[seq % list.length];
      /* copies, so the picked files stay usable for a retry after a failure */
      const payloadFiles = files.map((f) => ({ name: f.name, type: f.type, bytes: f.bytes.slice() }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { w.postMessage({ cmd: 'tool', id, toolId, files: payloadFiles, opts }, payloadFiles.map((f) => f.bytes.buffer)); }
        catch (e) { pending.delete(id); reject(Object.assign(new Error('spawn'), { code: 'NO_WORKER' })); }
      });
    }

    return { run, runTool, stop, init, get ok() { return booted && !broken; } };
  })();

  /* ── toast ─────────────────────────────────────────── */
  let toastT;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on'), 2600);
  }

  /* ── helpers ───────────────────────────────────────── */
  const fmt = (n) => Util.fmtBytes(n);
  const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
  const KIND_LABEL = {
    pdf: 'PDF', jpeg: 'JPG', jpg: 'JPG', png: 'PNG', webp: 'WEBP', svg: 'SVG', gif: 'GIF',
    bmp: 'BMP', zip: 'ZIP', docx: 'DOCX', pptx: 'PPTX', xlsx: 'XLSX', epub: 'EPUB',
    json: 'JSON', html: 'HTML', css: 'CSS', js: 'JS', txt: 'TXT', csv: 'CSV', xml: 'XML'
  };
  const kindLabel = (name) => {
    const e = extOf(name);
    return KIND_LABEL[e] || (e || 'FILE').slice(0, 4).toUpperCase();
  };

  const inFrame = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function download(bytes, name, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    // iOS Safari and sandboxed iframes silently ignore the download attribute on blobs
    if (isiOS || inFrame) {
      const w = window.open(url, '_blank');
      if (!w) toast('download blocked here — open this page in its own tab, then press save again');
      else toast('saved ' + name + ' — if nothing arrived, check the new tab');
    } else {
      toast('saved ' + name);
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* a preview frame (sandbox="allow-scripts") cannot start a download — say so up front */
  function frameNotice() {
    if (!inFrame) return;
    const bar = $('#frameBar');
    if (!bar) return;
    bar.hidden = false;
    const link = bar.querySelector('a');
    if (link) link.href = location.href;
  }
  const mimeFor = (name) => ({
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', svg: 'image/svg+xml', gz: 'application/gzip', zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    json: 'application/json', txt: 'text/plain', html: 'text/html', css: 'text/css', js: 'text/javascript'
  }[extOf(name)] || 'application/octet-stream');

  /* ── intake ────────────────────────────────────────── */
  function addFiles(fileList) {
    const incoming = [...fileList];
    if (!incoming.length) return;
    for (const f of incoming) {
      state.items.push({
        id: 'f' + (++state.seq), file: f, name: f.name, size: f.size,
        status: 'idle', pct: 0, res: null, err: null, stale: false
      });
    }
    $('#queue').hidden = false;
    render();
    runQueue();
  }

  const dz = $('#dz'), input = $('#fileInput');
  dz.addEventListener('click', (e) => { if (!e.target.closest('button') || e.target.closest('#browse')) input.click(); });
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); });
    document.addEventListener(ev, (e) => e.preventDefault());
  });
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); input.click(); }
    if (e.key === 'Escape') closeCompare();
  });

  /* ── queue engine ──────────────────────────────────── */
  const lanes = () => Math.max(1, Pool.ok ? POOL_SIZE : 1);

  async function runQueue() {
    if (state.running) return;
    state.running = true;
    const stopBtn = $('#stop');
    if (stopBtn) stopBtn.hidden = false;
    const active = new Set();
    const start = (item) => {
      const p = processItem(item).finally(() => active.delete(p));
      active.add(p);
    };
    for (;;) {
      const next = state.items.find(i => i.status === 'idle');
      if (!next && active.size === 0) break;
      if (!next) { await Promise.race(active); continue; }
      while (active.size >= lanes() && state.items.some(i => i.status === 'idle')) await Promise.race(active);
      start(next);
      if (!Pool.ok) await Promise.all([...active]);     // single lane: stay sequential
    }
    await Promise.all([...active]);
    state.running = false;
    if (stopBtn) stopBtn.hidden = true;
    renderTotals();
    if (state.items.some(i => i.status === 'idle')) runQueue();   // items queued during the run
  }

  async function processItem(item) {
    item.status = 'run';
    item.pct = 6;
    item.err = null;
    item.res = null;
    renderRow(item.id);
    let ticks = 0;
    const bump = () => { ticks++; item.pct = Math.min(93, 10 + ticks * 7); updateBar(item); };

    const presetDef = Compressor.PRESETS.find(p => p.id === state.preset) || Compressor.PRESETS[3];
    const opts = state.options;

    try {
      let res = null;
      // 1st choice: a worker (off the UI thread, several files in parallel)
      if (!item.noWorker) {
        try {
          res = await Pool.run(item.file, presetDef.id, opts, () => bump());
        } catch (e) {
          if (e && e.code === 'NO_CANVAS') {
            item.noWorker = true;                 // this device's workers cannot raster → do it here
          } else if (e && e.code === 'STOPPED') {
            item.status = 'idle'; item.pct = 0; renderRow(item.id); return;
          } else if (e && e.code === 'NO_WORKER') {
            item.noWorker = true;
            caps.worker = false;
          } else throw e;
        }
      }
      // 2nd choice: this thread
      if (!res) {
        res = await Compressor.compress(item.file, {
          preset: presetDef.id, options: opts, onProgress: () => bump()
        });
      }
      item.res = res;
      item.status = 'done';
      item.pct = 100;
    } catch (err) {
      console.error(err);
      item.status = 'error';
      item.err = (err && err.message) || 'failed';
      item.pct = 100;
    }
    renderRow(item.id);
    renderTotals();
  }

  function markStale() {
    if (!state.items.some(i => i.status === 'done')) return;
    state.items.forEach(i => { if (i.status === 'done') i.stale = true; });
    render();
    $('#rerun').hidden = false;
  }

  $('#rerun').addEventListener('click', () => {
    state.items.forEach(i => { i.status = 'idle'; i.res = null; i.stale = false; i.pct = 0; });
    $('#rerun').hidden = true;
    render();
    runQueue();
  });
  $('#stop').addEventListener('click', () => {
    Pool.stop();
    state.running = false;
    state.items.forEach(i => { if (i.status === 'run' || i.status === 'idle') { i.status = 'idle'; i.pct = 0; } });
    render();
    toast('stopped — press re-run to continue');
  });
  $('#clear').addEventListener('click', () => {
    if (state.running) return toast('wait for the current batch');
    state.items = [];
    $('#rows').innerHTML = '';
    $('#queue').hidden = true;
    $('#foot').hidden = true;
    $('#rerun').hidden = true;
    $('#qSum').textContent = '';
    renderTotals();
  });

  /* ── rendering ─────────────────────────────────────── */
  function render() {
    const rows = $('#rows');
    rows.innerHTML = '';
    for (const item of state.items) rows.appendChild(rowEl(item));
    renderTotals();
  }

  function shell(item) {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.id = item.id;
    el.innerHTML = `
      <div class="kind">${kindLabel(item.name)}</div>
      <div class="nm"><div class="n1"></div><div class="n2"></div></div>
      <div class="size"></div>
      <div class="saved"></div>
      <div class="acts"></div>
      <div class="bar"><i></i></div>`;
    return el;
  }

  function rowEl(item) {
    const el = shell(item);
    paintRow(el, item);
    return el;
  }

  function renderRow(id) {
    const el = $(`.row[data-id="${id}"]`);
    const item = state.items.find(i => i.id === id);
    if (!el || !item) return;
    paintRow(el, item);
  }

  function paintRow(el, item) {
    el.classList.toggle('done', item.status === 'done' || item.status === 'error');
    $('.n1', el).textContent = item.name;
    const n2 = $('.n2', el);
    n2.innerHTML = '';
    const size = $('.size', el);
    const saved = $('.saved', el);
    const acts = $('.acts', el);
    acts.innerHTML = '';
    size.innerHTML = `<s>${fmt(item.size)}</s><b>${item.res ? fmt(item.res.bytes.length) : '—'}</b>`;

    if (item.status === 'idle') {
      n2.innerHTML = `<em>queued</em>`;
      saved.textContent = '—';
    } else if (item.status === 'run') {
      n2.innerHTML = `<span class="spin"></span><em>working…</em>`;
      saved.innerHTML = `<span class="num">${item.pct}%</span>`;
    } else if (item.status === 'error') {
      n2.innerHTML = `<span class="badge err">error</span><em>${item.err}</em>`;
      saved.className = 'saved err';
      saved.textContent = 'FAILED';
    } else if (item.res) {
      const r = item.res;
      const pctv = Math.round(r.saved * 1000) / 10;
      const same = r.bytes.length >= item.size;
      const BADGE = {
        lossless: '<span class="badge ll">lossless</span>',
        near: '<span class="badge near">near-lossless</span>',
        invisible: '<span class="badge invis">invisible-only</span>',
        lossy: '<span class="badge lossy">re-encoded</span>'
      };
      const badge = same ? '<span class="badge same">unchanged</span>' : (BADGE[r.kind] || BADGE.lossy);
      n2.innerHTML = badge;
      if (r.psnr != null && isFinite(r.psnr)) {
        const q = document.createElement('em');
        q.textContent = `PSNR ${r.psnr.toFixed(1)} dB · SSIM ${(r.ssim * 100).toFixed(1)}%`;
        n2.appendChild(q);
      }
      for (const note of (r.notes || []).slice(0, 3)) {
        const e = document.createElement('em');
        e.textContent = note;
        n2.appendChild(e);
      }
      if (item.stale) {
        const e = document.createElement('em');
        e.textContent = 'preset changed — re-run';
        n2.appendChild(e);
      }
      saved.className = 'saved ' + (pctv >= 50 ? '' : pctv >= 20 ? 'mid' : 'low');
      saved.innerHTML = `${pctv > 0 ? '−' : ''}${Math.abs(pctv)}%<small>${pctv > 0 ? 'smaller' : pctv < 0 ? 'bigger' : 'no change'}</small>`;

      const dl = document.createElement('button');
      dl.className = 'btn sm solid';
      dl.innerHTML = '<svg><use href="#i-down"/></svg>Save';
      dl.addEventListener('click', () => download(item.res.bytes, item.res.outName, mimeFor(item.res.outName)));
      acts.appendChild(dl);

      const isImg = /^image\//.test(item.file.type || '') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(item.name);
      const canCompare = isImg && !r.lossless && r.bytes.length < item.size;
      if (canCompare) {
        const cmp = document.createElement('button');
        cmp.className = 'btn sm';
        cmp.innerHTML = '<svg><use href="#i-eye"/></svg>Compare';
        cmp.addEventListener('click', () => openCompare(item));
        acts.appendChild(cmp);
      } else if (extOf(item.res.outName) === 'pdf') {
        const pv = document.createElement('button');
        pv.className = 'btn sm';
        pv.innerHTML = '<svg><use href="#i-eye"/></svg>Preview';
        pv.addEventListener('click', () => {
          const url = URL.createObjectURL(new Blob([r.bytes], { type: 'application/pdf' }));
          window.open(url, '_blank', 'noopener');
        });
        acts.appendChild(pv);
      }
    }
    updateBar(item, el);
    renderTotals();
  }

  function updateBar(item, el) {
    const row = el || $(`.row[data-id="${item.id}"]`);
    if (!row) return;
    const i = $('.bar i', row);
    if (i) i.style.width = (item.status === 'idle' ? 0 : item.pct) + '%';
  }

  function renderTotals() {
    const done = state.items.filter(i => i.status === 'done' && i.res);
    const totalIn = state.items.reduce((a, i) => a + i.size, 0);
    const totalOut = done.reduce((a, i) => a + i.res.bytes.length, 0);
    const pending = state.items.filter(i => i.status === 'idle' || i.status === 'run').length;
    const n = state.items.length;
    $('#qTitle').textContent = `Queue · ${n} file${n === 1 ? '' : 's'}`;
    $('#qSum').textContent = done.length
      ? `${done.length}/${n} compressed${pending ? ` · ${pending} pending` : ''}`
      : pending ? 'working…' : 'ready';

    const foot = $('#foot');
    if (!done.length) { foot.hidden = true; return; }
    foot.hidden = false;
    const inDone = done.reduce((a, i) => a + i.size, 0);
    const savedBytes = inDone - totalOut;
    const pct = inDone ? (savedBytes / inDone) * 100 : 0;
    $('#totalSaved').textContent = (pct >= 0 ? '−' : '+') + Math.abs(pct).toFixed(1) + '%';
    $('#totalAbs').textContent = fmt(Math.abs(savedBytes));
    const byKind = (k) => done.filter(d => d.res.kind === k).length;
    $('#totalMeta').innerHTML = `<b>${fmt(inDone)}</b> in → <b>${fmt(totalOut)}</b> out · ${byKind('lossless')} lossless`
      + `${byKind('near') ? ` · ${byKind('near')} visually lossless` : ''} · ${byKind('invisible')} invisible-only · ${byKind('lossy')} re-encoded`;
    $('#dlAll').disabled = !done.length;
  }

  $('#dlAll').addEventListener('click', async () => {
    const done = state.items.filter(i => i.status === 'done' && i.res);
    if (!done.length) return;
    const used = new Set();
    const entries = done.map(i => {
      let name = i.res.outName.replace(/[\/\\]/g, '_');
      let k = 1;
      while (used.has(name)) name = name.replace(/(\.[^.]*)?$/, `-${k++}$1`);
      used.add(name);
      return { name, data: i.res.bytes };
    });
    toast('packing zip…');
    const zip = await ZipCodec.write(entries);
    download(zip, 'readon-compressed.zip', 'application/zip');
    toast('zip ready');
  });

  /* ── compare modal ─────────────────────────────────── */
  async function openCompare(item) {
    const modal = $('#cmpModal');
    modal.classList.add('on');
    modal.setAttribute('aria-hidden', 'false');
    $('#cmpTitle').textContent = item.name;
    const facts = $('#cmpFacts');
    facts.innerHTML = '';
    const add = (b, s) => { const d = document.createElement('div'); d.innerHTML = `<b>${b}</b><span>${s}</span>`; facts.appendChild(d); };
    add(fmt(item.size), 'original');
    add(fmt(item.res.bytes.length), 'compressed');
    add((item.res.saved * 100).toFixed(1) + '%', 'reduced');
    if (item.res.psnr != null) add(item.res.psnr.toFixed(1) + ' dB', 'PSNR');
    if (item.res.ssim != null) add((item.res.ssim * 100).toFixed(1) + '%', 'SSIM');

    $('#cmpDl').onclick = () => download(item.res.bytes, item.res.outName, mimeFor(item.res.outName));

    const srcA = new Blob([await item.file.arrayBuffer()], { type: item.file.type || 'image/jpeg' });
    const srcB = new Blob([item.res.bytes], { type: mimeFor(item.res.outName) });
    const [ia, ib] = await Promise.all([loadImg(srcA), loadImg(srcB)]);
    const A = $('#cmpA'), B = $('#cmpB');
    const W = Math.min(920, ia.naturalWidth || ia.width);
    const ratio = (ia.naturalHeight || ia.height) / (ia.naturalWidth || ia.width);
    A.width = W; A.height = Math.round(W * ratio);
    B.width = W; B.height = A.height;
    for (const [cv, im] of [[A, ia], [B, ib]]) {
      const g = cv.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(im, 0, 0, cv.width, cv.height);
    }
    $('#cmpAfter').style.width = '50%';
    $('#cmpHandle').style.left = '50%';
    wireSlider();
    state.compare = item;
  }

  function loadImg(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); res(im); };
      im.onerror = rej;
      im.src = url;
    });
  }

  function wireSlider() {
    const box = $('#cmpBox'), after = $('#cmpAfter'), handle = $('#cmpHandle');
    let drag = false;
    const move = (clientX) => {
      const r = box.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      after.style.width = (p * 100) + '%';
      handle.style.left = (p * 100) + '%';
    };
    box.addEventListener('pointerdown', (e) => { drag = true; box.setPointerCapture(e.pointerId); move(e.clientX); });
    box.addEventListener('pointermove', (e) => { if (drag) move(e.clientX); });
    box.addEventListener('pointerup', () => { drag = false; });
    box.addEventListener('pointercancel', () => { drag = false; });
  }

  function closeCompare() {
    const m = $('#cmpModal');
    m.classList.remove('on');
    m.setAttribute('aria-hidden', 'true');
    state.compare = null;
  }
  $('#cmpClose').addEventListener('click', closeCompare);
  $('#cmpModal').addEventListener('click', (e) => { if (e.target.id === 'cmpModal') closeCompare(); });


  /* ══════════════ tool hub ══════════════ */
  const hub = { tool: null, files: [], results: [] };

  /* plain-language errors — a dead end is a bug, so every failure explains itself */
  function friendlyError(err) {
    const raw = String((err && err.message) || err || 'unknown error');
    if (/choose a file/i.test(raw)) return 'Choose a file first — drop one above, then press Run.';
    if (/password/i.test(raw)) return raw;                       // already written for humans
    if (/out of memory|allocation failed/i.test(raw)) return 'This file is too large for this device — try a smaller one or close other tabs.';
    if (/unsupported|not a |invalid pdf|corrupt|damaged/i.test(raw)) return raw + ' — the file may be damaged or use a format this tool does not handle.';
    return raw.replace(/^Error:\s*/, '');
  }

  function renderError(msg) {
    const box = $('#toolResults');
    if (!box) return;
    box.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'tout terr';
    el.innerHTML = `<svg class="terr-i"><use href="#i-x"/></svg>
      <span class="nm">Could not finish — ${msg}</span>
      <button class="btn sm" type="button" id="toolRetry">Try again</button>`;
    box.appendChild(el);
    const retry = $('#toolRetry', box);
    if (retry) retry.addEventListener('click', () => $('#tRun').click());
  }

  let lastSoft = 0;
  function softError(msg) {
    const t = Date.now();
    if (t - lastSoft < 1200) return;
    lastSoft = t;
    try { toast(msg); } catch (e) { /* toast is best effort */ }
  }

  /* one bad file must never break the page: catch everything, keep the UI alive */
  function acceptOk(tool, file) {
    const a = (tool && tool.accept || '').toLowerCase();
    if (!a) return true;
    const ext = '.' + String(file.name || '').split('.').pop().toLowerCase();
    const mime = String(file.type || '').toLowerCase();
    return a.split(',').map((x) => x.trim()).filter(Boolean).some((p) => {
      if (p === '*' || p === '*/*') return true;
      if (p.startsWith('.')) return ext === p;
      if (p.endsWith('/*')) return mime.startsWith(p.slice(0, -1));
      return mime === p || ext === p;
    });
  }

  function toolIcon(id) { return `<svg><use href="#${id}"/></svg>`; }

  function renderHub() {
    const wrap = $('#toolGrid');
    if (!wrap) return;
    const groups = Tools.groups();
    wrap.innerHTML = groups.map((g) => `
      <div class="tgroup" data-group="${g}">
        <div class="tgroup-h"><b>${g}</b><span class="line"></span><span class="cap">${Tools.list.filter(t => t.group === g).length}${Tools.list.filter(t => t.group === g).length === 1 ? ' tool' : ' tools'}</span></div>
        <div class="tgrid">
          ${Tools.list.filter(t => t.group === g).map((t) => `
            <button class="tcard${t.id === 'compress' ? ' feature' : ''}" type="button" data-tool="${t.id}" data-search="${(t.title + ' ' + t.blurb + ' ' + (t.tags || '')).toLowerCase()}">
              <span class="ti">${toolIcon(t.icon)}</span>
              <b>${t.title}</b>
              <em>${t.blurb}</em>
            </button>`).join('')}
        </div>
      </div>`).join('');
    const n = Tools.list.length;
    const cnt = $('#hubCount');
    if (cnt) cnt.textContent = `${n} working tools · every byte stays in this tab`;
    $$('.tcard', wrap).forEach((card) => card.addEventListener('click', () => openTool(card.dataset.tool)));
  }

  const search = $('#toolSearch');
  if (search) {
    let qFrame = 0;
    search.addEventListener('input', () => {
      if (qFrame) return;
      qFrame = requestAnimationFrame(() => {
      qFrame = 0;
      const q = search.value.trim().toLowerCase();
      $$('.tgroup').forEach((g) => {
        let shown = 0;
        $$('.tcard', g).forEach((c) => {
          const hit = !q || c.dataset.search.includes(q);
          c.style.display = hit ? '' : 'none';
          if (hit) shown++;
        });
        g.style.display = shown ? '' : 'none';
      });
      });
    });
  }

  function openTool(id) {
    const tool = Tools.get(id);
    if (!tool) return;
    hub.tool = tool;
    $$('.tcard').forEach((c) => c.classList.toggle('on', c.dataset.tool === id));
    const work = $('#work');
    const pane = $('#toolPane');
    if (id === 'compress') {
      $('#hub').hidden = false;
      work.hidden = false;
      pane.hidden = true;
      work.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    $('#hub').hidden = true;
    work.hidden = true;
    pane.hidden = false;
    $('#foot').hidden = true;
    $('#toolTitle').textContent = tool.title;
    $('#toolBlurb').textContent = tool.blurb;
    $('#toolIco').innerHTML = `<use href="#${tool.icon}"/>`;
    hub.files = [];
    hub.results = [];
    renderToolOpts(tool);
    $('#toolResults').innerHTML = '';
    $('#toolNote').textContent = '';
    $('#toolPreview').hidden = true;
    $('#toolPicked').innerHTML = '';
    const isText = tool.kind === 'text';
    $('#toolText').hidden = !isText;
    $('#toolFiles').hidden = isText;
    if (!isText) {
      const inp = $('#tInput');
      inp.multiple = tool.multiple !== false;
      inp.accept = tool.accept || '';
      $('#tdzTitle').textContent = tool.multiple === false ? 'Drop a file here' : 'Drop files here';
      const fmtList = tool.accept && tool.accept.startsWith('image') ? 'PNG, JPG, WEBP, GIF, BMP'
        : tool.accept ? tool.accept.replace(/^[^.]*\.?/, '').split(/[,.]/).filter((x) => x && x.length < 8).map((x) => x.toUpperCase()).slice(0, 5).join(', ') : '';
      $('#tdzSub').textContent = fmtList ? `${fmtList} · or click to browse · files never leave this tab` : 'or click to browse · files never leave this tab';
    } else {
      $('#tOut').value = '';
    }
    $('#tState').textContent = 'ready';
    pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderToolOpts(tool) {
    const box = $('#toolOpts');
    box.innerHTML = '';
    for (const o of tool.options || []) {
      const el = document.createElement('label');
      el.className = 'opt';
      if (o.type === 'select') {
        el.innerHTML = `<span class="lbl">${o.label}</span><select data-opt="${o.key}">${o.values.map(([v, l]) => `<option value="${v}"${v === o.def ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
      } else if (o.type === 'toggle') {
        el.innerHTML = `<span class="lbl">${o.label}</span><button class="switch" type="button" data-toggle="${o.key}" aria-pressed="${o.def ? 'true' : 'false'}"></button>`;
      } else if (o.type === 'range') {
        el.innerHTML = `<span class="lbl">${o.label} <span class="val" data-val="${o.key}">${o.def}${o.suffix || ''}</span></span><input type="range" data-opt="${o.key}" min="${o.min}" max="${o.max}" value="${o.def}">`;
      } else if (o.type === 'number') {
        el.innerHTML = `<span class="lbl">${o.label}</span><input type="number" data-opt="${o.key}" min="${o.min || 0}" max="${o.max || 100000}" value="${o.def}">`;
      } else {
        // autocomplete off: a field labelled “Password” must never invite the password manager
        el.innerHTML = `<span class="lbl">${o.label}</span><input type="text" data-opt="${o.key}" name="ro-opt-${o.key}" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${String(o.placeholder || '').replace(/"/g, '&quot;')}" value="${String(o.def == null ? '' : o.def).replace(/"/g, '&quot;')}">`;
      }
      box.appendChild(el);
    }
    $$('[data-opt]', box).forEach((inp) => {
      const o = (tool.options || []).find((x) => x.key === inp.dataset.opt);
      const upd = () => {
        if (o.suffix) { const v = $(`[data-val="${o.key}"]`, box); if (v) v.textContent = inp.value + o.suffix; }
      };
      inp.addEventListener('input', upd);
      upd();
    });
    $$('[data-toggle]', box).forEach((btn) => btn.addEventListener('click', () => {
      btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    }));
  }

  function readOpts() {
    const out = {};
    for (const o of (hub.tool && hub.tool.options) || []) {
      const el = $(`[data-opt="${o.key}"]`);
      if (el) out[o.key] = el.value;
      const tg = $(`[data-toggle="${o.key}"]`);
      if (tg) out[o.key] = tg.getAttribute('aria-pressed') === 'true';
    }
    return out;
  }

  /* file picking for the generic tools */
  const tInput = $('#tInput');
  const tdz = $('#tdz');
  if (tdz && tInput) {
    tdz.addEventListener('click', (e) => { if (e.target.closest('.btn')) return; tInput.click(); });
    tdz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tInput.click(); } });
    $('#tbrowse').addEventListener('click', (e) => { e.stopPropagation(); tInput.click(); });
    const takeFiles = async (list) => {
      const tool = hub.tool || {};
      const cap = tool.multiple === false ? 1 : 50;
      const skipped = [];
      hub.files = [];
      for (const f of list) {
        if (hub.files.length >= cap) { skipped.push(f.name); continue; }
        if (!acceptOk(tool, f)) { skipped.push(f.name); continue; }
        try { hub.files.push({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }); }
        catch (e) { skipped.push(f.name); }
      }
      $('#toolPicked').innerHTML = hub.files.map((f) => `<div class="tout"><span class="nm">${f.name}</span><span class="meta">${fmt(f.bytes.length)}</span></div>`).join('');
      $('#toolResults').innerHTML = '';
      $('#toolNote').textContent = '';
      const tdzTitle = $('#tdzTitle');
      if (tdzTitle) tdzTitle.textContent = hub.files.length
        ? (tool.multiple === false ? 'Drop another file to replace' : 'Drop more files to add')
        : (tool.multiple === false ? 'Drop a file here' : 'Drop files here');
      if (hub.files.length) {
        $('#tState').textContent = `${hub.files.length} file${hub.files.length > 1 ? 's' : ''} ready · press Run`;
      } else {
        $('#tState').textContent = 'no file yet';
      }
      if (skipped.length) {
        const want = (tool.accept || '').replace(/[^.,\w/*-]/g, '').split(',').filter((x) => x.startsWith('.')).map((x) => x.slice(1).toUpperCase()).join(', ');
        toast(`${skipped.length} file${skipped.length > 1 ? 's' : ''} skipped — this tool takes${want ? ' ' + want : ' another type'}`);
      }
    };
    tInput.addEventListener('change', async () => {
      const files = [...tInput.files];
      tInput.value = '';
      if (!files.length) return;
      await takeFiles(files);
    });
    ['dragenter', 'dragover'].forEach((ev) => tdz.addEventListener(ev, (e) => { e.preventDefault(); tdz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => tdz.addEventListener(ev, (e) => { e.preventDefault(); tdz.classList.remove('over'); }));
    tdz.addEventListener('drop', async (e) => {
      const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
      if (!files.length) return;
      await takeFiles(files);
    });
  }

  /* a long job needs to look alive: elapsed seconds, and a way out */
  let runTimer = null, runAbort = false;
  function startRunClock(stateEl) {
    const t0 = Date.now();
    runAbort = false;
    const cancel = $('#tCancel');
    if (cancel) cancel.hidden = false;
    const tick = () => {
      const s = (Date.now() - t0) / 1000;
      stateEl.textContent = `working… ${s.toFixed(1)}s`;
    };
    tick();
    runTimer = setInterval(tick, 100);
    return () => {
      clearInterval(runTimer); runTimer = null;
      if (cancel) cancel.hidden = true;
      return (Date.now() - t0) / 1000;
    };
  }

  const tCancel = $('#tCancel');
  if (tCancel) tCancel.addEventListener('click', () => {
    runAbort = true;
    try { Pool.stop(); } catch (e) { /* already gone */ }
    try { Pool.init(); } catch (e) { /* will report on the next run */ }
    clearInterval(runTimer); runTimer = null;
    tCancel.hidden = true;
    $('#tState').textContent = 'cancelled';
    $('#toolNote').textContent = 'Stopped. Nothing was changed — run it again whenever you like.';
  });

  const tRun = $('#tRun');
  if (tRun) tRun.addEventListener('click', async () => {
    const tool = hub.tool;
    if (!tool) return;
    const opts = readOpts();
    const stateEl = $('#tState');
    let stopClock = null;
    try {
      tRun.disabled = true;
      stopClock = startRunClock(stateEl);
      let res;
      if (tool.kind === 'text') {
        res = await tool.run($('#tIn').value, opts);
        $('#tOut').value = res.text != null ? res.text : '';
      } else {
        if (!hub.files.length) throw new Error('choose a file first');
        res = null;
        if (caps.offscreen && Pool.ok) {
          try { res = await Pool.runTool(tool.id, hub.files, opts); }
          catch (e) { if (e && e.code !== 'NO_WORKER' && e.code !== 'NO_CANVAS') throw e; res = null; }
        }
        if (!res) res = await tool.run(hub.files, opts);
        if (runAbort) return;
        renderResults(res);
      }
      const filesRes = res && res.files && res.files.length;
      $('#toolNote').textContent = filesRes ? (res.note || '') : (res && res.note) || '';
      $('#toolPreview').hidden = !(res && res.preview);
      if (res && res.preview) $('#toolPreview').textContent = res.preview;
      const secs = stopClock ? stopClock() : 0;
      if (!runAbort) stateEl.textContent = secs > 0.6 ? `done in ${secs.toFixed(1)}s` : 'done';
    } catch (err) {
      if (runAbort) {                       /* the user pressed Cancel: not an error */
        stateEl.textContent = 'cancelled';
        $('#toolResults').innerHTML = '';
        $('#toolNote').textContent = 'Stopped. Nothing was changed — run it again whenever you like.';
        return;
      }
      stateEl.textContent = 'error';
      const msg = friendlyError(err);
      $('#toolNote').textContent = '';
      if (tool.kind !== 'text') renderError(msg);
      else $('#toolNote').textContent = msg;
      softError(msg);
    } finally {
      if (stopClock) stopClock();
      tRun.disabled = false;
    }
  });

  function renderResults(res) {
    const box = $('#toolResults');
    const files = (res && res.files) || [];
    if (!files.length) { renderError('the tool returned nothing — try another file'); return; }
    box.innerHTML = files.map((f, i) => `
      <div class="tout">
        <span class="nm">${f.name}</span>
        <span class="meta">${fmt(f.bytes.length)}${f.note ? ' · ' + f.note : ''}</span>
        <button class="btn sm solid" type="button" data-dl="${i}"><svg><use href="#i-down"/></svg>Save</button>
      </div>`).join('');
    $$('[data-dl]', box).forEach((btn) => btn.addEventListener('click', () => {
      const f = files[+btn.dataset.dl];
      saveBytes(f.bytes, f.name);
    }));
    if (files.length > 1) {
      const all = document.createElement('button');
      all.className = 'btn';
      all.type = 'button';
      all.innerHTML = '<svg><use href="#i-zip"/></svg>Save all as .zip';
      all.addEventListener('click', async () => {
        try {
          const z = await ZipCodec.write(files.map((f) => ({ name: f.name, data: f.bytes })));
          saveBytes(z, 'readon-tools.zip');
        } catch (e) { toast('packing failed: ' + e.message); }
      });
      box.appendChild(all);
    }
  }

  function saveBytes(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  const tCopy = $('#tCopy');
  if (tCopy) tCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#tOut').value); toast('copied'); }
    catch (e) { $('#tOut').select(); toast('press ⌘/Ctrl + C'); }
  });
  const tDownload = $('#tDownload');
  if (tDownload) tDownload.addEventListener('click', () => {
    const txt = $('#tOut').value;
    if (txt) saveBytes(new TextEncoder().encode(txt), (hub.tool ? hub.tool.id : 'output') + '.txt');
  });
  const tClear = $('#tClear');
  if (tClear) tClear.addEventListener('click', () => { $('#tIn').value = ''; $('#tOut').value = ''; });
  const tSample = $('#tSample');
  if (tSample) tSample.addEventListener('click', () => { $('#tIn').value = SAMPLE[hub.tool.id] || SAMPLE.default; });
  const tReset = $('#tReset');
  if (tReset) tReset.addEventListener('click', () => {
    hub.files = []; hub.results = [];
    $('#toolPicked').innerHTML = ''; $('#toolResults').innerHTML = ''; $('#toolNote').textContent = '';
    $('#toolPreview').hidden = true; $('#tOut').value = ''; $('#tState').textContent = 'ready';
  });
  const tBack = $('#toolBack');
  if (tBack) tBack.addEventListener('click', () => {
    $('#toolPane').hidden = true;
    $('#hub').hidden = false;
    $('#work').hidden = false;
    $$('.tcard').forEach((c) => c.classList.remove('on'));
    hub.tool = null;
    renderTotals();
  });

  const SAMPLE = {
    default: 'Hello from ReadOn — paste anything here.',
    'json-format': '{"site":"ReadOn","tools":50,"local":true,"items":[1,2,3]}',
    'csv-json': 'name,role,size\nphotos.pdf,compressed,51 KB\nphoto1.jpg,webp,18 KB',
    'md-html': '# ReadOn\n\n**Fast**, private, *local* tools.\n\n- compress\n- upscale\n- merge',
    'count': 'ReadOn Compress runs every tool inside your browser tab. Nothing is uploaded, ever.',
    'color': '#D75A5A',
    'time': '2026-10-22T09:00:00Z',
    'lorem': '',
    'uuid': ''
  };

  window.addEventListener('error', (e) => softError('Something went wrong in this tab — press Run again, the rest of the app still works'));
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && e.reason.message) || 'unknown';
    softError('Something went wrong: ' + msg);
  });

  /* the reader ships next to the app; resolve the link for both locations
     (/index.html and /compress/index.html) so it never points at someone else's site */
  const readerLink = $('#readerLink');
  if (readerLink) {
    const inSub = /\/compress\/[^/]*$/.test(location.pathname);
    readerLink.href = inSub ? '../reader.html' : 'reader.html';
  }

  renderHub();
  // the totals bar belongs to the compress workspace only
  const footWatch = setInterval(() => {
    const foot = $('#foot');
    const workHidden = $('#work') && $('#work').hidden;
    if (foot && workHidden && !foot.hidden) { foot.hidden = true; }
    if (workHidden) clearInterval(footWatch);
  }, 400);
  setTimeout(() => clearInterval(footWatch), 3000);

  /* ── boot ──────────────────────────────────────────── */
  renderTotals();
  const capEl = $('#caps');
  if (capEl) capEl.textContent = capsLine();
  try { Pool.init(); } catch (e) { caps.worker = false; }
  // offline shell — skipped in automated browsers so test runs never hit a stale cache
  const automated = typeof navigator !== 'undefined' && navigator.webdriver;
  if (!automated && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    // the same bundle ships at / (index.html) and /compress/ — try the local copy first
    (async () => {
      for (const p of ['sw.js', '../sw.js']) {
        try { await navigator.serviceWorker.register(p, { scope: './' }); return; } catch (e) { /* next */ }
      }
    })();
  }
  frameNotice();
})();
