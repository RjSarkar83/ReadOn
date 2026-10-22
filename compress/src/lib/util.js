/* ══════════════════════════════════════════════════════════════
   util.js — byte/stream helpers, codec wrappers, formatting
   ══════════════════════════════════════════════════════════════ */

const Util = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder('latin1');

  function latin1(bytes) {
    // bytes -> string, 1 char per byte (chunked to avoid arg limits)
    let out = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return out;
  }
  function unlatin1(str) {
    const u8 = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i) & 0xff;
    return u8;
  }
  function utf8(str) { return enc.encode(str); }

  function concat(list) {
    let n = 0;
    for (const b of list) n += b.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
  }

  const HAS_NATIVE = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

  async function pipe(bytes, stream) {
    const blob = new Blob([bytes]);
    const ab = await new Response(blob.stream().pipeThrough(stream)).arrayBuffer();
    return new Uint8Array(ab);
  }

  /* native Compression Streams when the device has them, real JS codecs when not */
  async function inflate(bytes) {
    if (HAS_NATIVE) {
      try { return await pipe(bytes, new DecompressionStream('deflate')); } catch (e) { /* fall back */ }
    }
    return JSCodec.inflate(bytes);
  }
  async function inflateRaw(bytes) {
    if (HAS_NATIVE) {
      try { return await pipe(bytes, new DecompressionStream('deflate-raw')); } catch (e) { /* fall back */ }
    }
    return JSCodec.inflate(bytes);
  }
  async function deflate(bytes) {
    if (HAS_NATIVE) {
      try { return await pipe(bytes, new CompressionStream('deflate')); } catch (e) { /* fall back */ }
    }
    return JSCodec.deflate(bytes);
  }
  async function deflateRaw(bytes) {
    if (HAS_NATIVE) {
      try { return await pipe(bytes, new CompressionStream('deflate-raw')); } catch (e) { /* fall back */ }
    }
    const z = JSCodec.deflate(bytes);                       // zlib container
    return z.length > 6 ? z.subarray(2, z.length - 4) : z;  // strip header/adler
  }

  // safe variants used inside parsers (never throw)
  async function tryInflate(bytes) {
    try { return await inflate(bytes); } catch (e) {
      try { return await inflateRaw(bytes); } catch (e2) { return null; }
    }
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, seed = 0) {
    let c = (seed ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function fmtBytes(n) {
    if (!isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB'];
    let i = -1, v = n;
    do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + u[i];
  }
  const bytesToHex = (b) => { let h = ''; for (let i = 0; i < b.length; i++) h += (b[i] < 16 ? '0' : '') + b[i].toString(16); return h; };
  const pct = (a, b) => (b > 0 ? Math.round((1 - a / b) * 1000) / 10 : 0);

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function sniff(bytes, name = '') {
    const b = bytes;
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
    if (b.length > 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
    if (b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 5 || b[2] === 7)) return 'zip';
    if (b.length > 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'heic';
    const head = latin1(b.subarray(0, 512)).trim().toLowerCase();
    if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) {
      if (ext === 'svg' || head.includes('<svg')) return 'svg';
    }
    if (ext === 'svg') return 'svg';
    return 'unknown';
  }

  return { HAS_NATIVE, latin1, unlatin1, utf8, concat, pipe, inflate, inflateRaw, deflate, deflateRaw, tryInflate,
           crc32, fmtBytes, pct, clamp, sniff, bytesToHex };
})();
