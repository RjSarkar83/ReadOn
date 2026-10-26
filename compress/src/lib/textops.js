/* ══════════════════════════════════════════════════════════════
   textops.js — text, data and code utilities (pure functions)

   No network, no libraries: every helper below is a real
   implementation that runs on the string you paste.
   ══════════════════════════════════════════════════════════════ */

const TextOps = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();

  /* ── JSON ────────────────────────────────────────────────────────── */
  const jsonParse = (s) => { try { return { ok: true, value: JSON.parse(s) }; } catch (e) { return { ok: false, error: e.message }; } };
  const jsonFormat = (s, indent = 2) => { const p = jsonParse(s); return p.ok ? JSON.stringify(p.value, null, indent) : 'INVALID JSON: ' + p.error; };
  const jsonMinify = (s) => { const p = jsonParse(s); return p.ok ? JSON.stringify(p.value) : 'INVALID JSON: ' + p.error; };
  const jsonKeys = (s) => {
    const p = jsonParse(s); if (!p.ok) return 'INVALID JSON: ' + p.error;
    const out = [];
    const walk = (v, path) => {
      if (Array.isArray(v)) { v.slice(0, 3).forEach((x, i) => walk(x, path + '[]')); return; }
      if (v && typeof v === 'object') { for (const k of Object.keys(v)) { out.push(path ? path + '.' + k : k); walk(v[k], path ? path + '.' + k : k); } }
    };
    walk(p.value, '');
    return [...new Set(out)].join('\n');
  };

  const flat = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : v == null ? '' : String(v));
  function jsonToCsv(s) {
    const p = jsonParse(s); if (!p.ok) return 'INVALID JSON: ' + p.error;
    let rows = p.value;
    if (!Array.isArray(rows)) rows = [rows];
    const cols = [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : ['value'])))];
    const esc = (x) => { const t = flat(x); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r && typeof r === 'object' ? r[c] : r)).join(','))].join('\n');
  }

  function parseCsv(text, delim = ',') {
    const src = String(text || '').replace(/^\uFEFF/, '');
    if (delim === ',' && !src.includes(',') && src.includes(';')) delim = ';';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) {
        if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c === '\r') { /* skip */ }
      else cell += c;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''));
  }

  function csvToJson(text, delim = ',') {
    const rows = parseCsv(text, delim);
    if (!rows.length) return '[]';
    const head = rows[0].map((h, i) => h.trim() || 'column' + (i + 1));
    const out = rows.slice(1).map((r) => { const o = {}; head.forEach((h, i) => { const v = r[i] != null ? r[i] : ''; o[h] = v !== '' && !isNaN(v) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v; }); return o; });
    return JSON.stringify(out, null, 2);
  }
  const csvToTsv = (text) => parseCsv(text).map((r) => r.join('\t')).join('\n');
  const tsvToCsv = (text) => parseCsv(text, '\t').map((r) => r.map((c) => (/[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(',')).join('\n');

  /* ── base64 / url / hex ──────────────────────────────────────────── */
  function b64encode(s) { const b = enc.encode(s); let bin = ''; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]); return btoa(bin); }
  function b64decode(s) {
    try {
      const bin = atob(s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return dec.decode(u8);
    } catch (e) { return 'NOT VALID BASE64'; }
  }
  const urlEncode = (s) => encodeURIComponent(s);
  const urlDecode = (s) => { try { return decodeURIComponent(s); } catch (e) { return 'NOT VALID URL ENCODING'; } };
  const hexEncode = (s) => [...enc.encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const hexDecode = (s) => {
    const h = s.replace(/[^0-9a-f]/gi, '');
    if (h.length % 2) return 'ODD NUMBER OF HEX DIGITS';
    const u8 = new Uint8Array(h.length / 2);
    for (let i = 0; i < u8.length; i++) u8[i] = parseInt(h.substr(i * 2, 2), 16);
    return dec.decode(u8);
  };

  /* ── hashing (WebCrypto + pure-JS SHA-256 fallback) ─────────────── */
  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  function sha256Bytes(bytes) {
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    const len = bytes.length;
    const padLen = (56 - ((len + 1) % 64) + 64) % 64;
    const msg = new Uint8Array(len + 1 + padLen + 8);
    msg.set(bytes, 0); msg[len] = 0x80;
    const dv = new DataView(msg.buffer);
    dv.setUint32(msg.length - 8, Math.floor((len * 8) / 4294967296), false);
    dv.setUint32(msg.length - 4, (len * 8) >>> 0, false);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const W = new Uint32Array(64);
    for (let off = 0; off < msg.length; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA256_K[i] + W[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => odv.setUint32(i * 4, v, false));
    return out;
  }

  async function hash(text, alg = 'SHA-256') {
    const raw = text instanceof Uint8Array ? text : enc.encode(String(text));
    if (self.crypto && self.crypto.subtle) {
      const buf = await self.crypto.subtle.digest(alg, raw);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    if (alg === 'SHA-256') return [...sha256Bytes(raw)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return 'this browser has no WebCrypto for ' + alg + ' (needs https or localhost)';
  }

  function uuid() {
    if (self.crypto && self.crypto.randomUUID) return self.crypto.randomUUID();
    const b = new Uint8Array(16);
    (self.crypto || {}).getRandomValues ? self.crypto.getRandomValues(b) : b.forEach((_, i) => (b[i] = (Math.random() * 256) | 0));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
  }

  /* ── text shaping ────────────────────────────────────────────────── */
  const words = (s) => {
    const t = String(s || '').trim();
    if (!t) return [];
    try { return t.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []; }
    catch (e) { return t.split(/\s+/); }
  };
  const identTokens = (s) => String(s || '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/[\s_\-./\\]+/)
    .filter(Boolean);

  function stats(s) {
    const str = String(s || '');
    const w = words(str);
    const readStr = w.length === 0 ? '0 min' : w.length < 110 ? '< 1 min' : Math.round(w.length / 220) + ' min';
    return [
      ['characters', [...str].length],
      ['characters (no spaces)', [...str.replace(/\s/g, '')].length],
      ['words', w.length],
      ['lines', str ? str.split(/\r\n|\r|\n/).length : 0],
      ['sentences', str.trim() ? (str.match(/[.!?।؟]+(\s|$)/g) || [1]).length : 0],
      ['paragraphs', str.split(/\n\s*\n/).filter((p) => p.trim()).length],
      ['bytes (utf-8)', enc.encode(str).length],
      ['reading time', readStr]
    ];
  }

  const CASES = {
    upper: (s) => s.toUpperCase(),
    lower: (s) => s.toLowerCase(),
    title: (s) => s.toLowerCase().replace(/(?:^|[\s\-/("'])(\S)/g, (m) => m.toUpperCase()),
    sentence: (s) => s.toLowerCase().replace(/(^\s*\S|[.!?।]\s+\S)/g, (m) => m.toUpperCase()),
    camel: (s) => identTokens(s).map((t, i) => (i ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t.toLowerCase())).join(''),
    pascal: (s) => identTokens(s).map((t) => t[0].toUpperCase() + t.slice(1).toLowerCase()).join(''),
    snake: (s) => identTokens(s).join('_').toLowerCase(),
    kebab: (s) => identTokens(s).join('-').toLowerCase(),
    constant: (s) => identTokens(s).join('_').toUpperCase()
  };
  const caseConvert = (s, mode) => (CASES[mode] || CASES.lower)(String(s || ''));

  const sortLines = (s, dir = 'asc') => s.split('\n').sort((a, b) => (dir === 'desc' ? -1 : 1) * a.localeCompare(b, undefined, { numeric: true })).join('\n');
  const dedupeLines = (s, ci = true) => {
    const seen = new Set(), out = [];
    for (const line of s.split('\n')) {
      const k = ci ? line.trim().toLowerCase() : line;
      if (seen.has(k)) continue;
      seen.add(k); out.push(line);
    }
    return out.join('\n');
  };
  const trimLines = (s) => s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).filter((l, i, a) => !(l.trim() === '' && (a[i - 1] || '').trim() === '')).join('\n').trim();
  const reverse = (s) => [...s].reverse().join('');
  const rot13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 90 : 122) >= c.charCodeAt(0) + 13 ? c.charCodeAt(0) + 13 : c.charCodeAt(0) - 13));

  function slugify(s) {
    return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }

  const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ');
  function lorem(paragraphs = 3, sentences = 5) {
    const out = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let p = 0; p < paragraphs; p++) {
      const s = [];
      for (let i = 0; i < sentences; i++) {
        const n = 6 + Math.floor(rnd() * 10);
        const w = Array.from({ length: n }, () => LOREM[Math.floor(rnd() * LOREM.length)]);
        s.push(w[0][0].toUpperCase() + w[0].slice(1) + ' ' + w.slice(1).join(' ') + '.');
      }
      out.push(s.join(' '));
    }
    return out.join('\n\n');
  }

  /* ── markdown → html (headings, ul/ol lists, tables, code, emphasis, links) ── */
  function mdToHtml(md) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inCode = false, listTag = '', inQuote = false, tableRows = [];
    const closeOpen = () => {
      if (listTag) { out.push(`</${listTag}>`); listTag = ''; }
      if (inQuote) { out.push('</blockquote>'); inQuote = false; }
      if (tableRows.length) {
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(tableRows[0]);
        const startBody = tableRows[1] && /^[\s|:-]+$/.test(tableRows[1]) ? 2 : 1;
        out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
        for (let i = startBody; i < tableRows.length; i++) {
          out.push('<tr>' + cells(tableRows[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
        }
        out.push('</tbody></table>');
        tableRows = [];
      }
    };
    for (const raw of lines) {
      if (/^```/.test(raw)) { closeOpen(); inCode = !inCode; out.push(inCode ? '<pre><code>' : '</code></pre>'); continue; }
      if (inCode) { out.push(esc(raw)); continue; }
      if (/^\s*$/.test(raw)) { closeOpen(); continue; }
      if (/^\|.+\|\s*$/.test(raw.trim())) {
        if (listTag) { out.push(`</${listTag}>`); listTag = ''; }
        if (inQuote) { out.push('</blockquote>'); inQuote = false; }
        tableRows.push(raw);
        continue;
      } else if (tableRows.length) closeOpen();
      const h = raw.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeOpen(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
      if (/^\s*[-*+]\s+/.test(raw)) {
        if (listTag && listTag !== 'ul') { out.push(`</${listTag}>`); listTag = ''; }
        if (!listTag) { out.push('<ul>'); listTag = 'ul'; }
        out.push('<li>' + inline(raw.replace(/^\s*[-*+]\s+/, '')) + '</li>'); continue;
      }
      if (/^\s*\d+\.\s+/.test(raw)) {
        if (listTag && listTag !== 'ol') { out.push(`</${listTag}>`); listTag = ''; }
        if (!listTag) { out.push('<ol>'); listTag = 'ol'; }
        out.push('<li>' + inline(raw.replace(/^\s*\d+\.\s+/, '')) + '</li>'); continue;
      }
      if (/^>\s?/.test(raw)) { if (listTag) { out.push(`</${listTag}>`); listTag = ''; } if (!inQuote) { out.push('<blockquote>'); inQuote = true; } out.push('<p>' + inline(raw.replace(/^>\s?/, '')) + '</p>'); continue; }
      if (/^(-{3,}|\*{3,})$/.test(raw.trim())) { closeOpen(); out.push('<hr>'); continue; }
      closeOpen();
      out.push('<p>' + inline(raw) + '</p>');
    }
    closeOpen();
    if (inCode) out.push('</code></pre>');
    return out.join('\n');
  }

  function unescapeEntities(s) {
    return String(s || '')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return _; } })
      .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return _; } })
      .replace(/&(amp|lt|gt|quot|apos|#39|nbsp|ndash|mdash|copy|reg|hellip);/gi, (m, g) => ({
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ', ndash: '–', mdash: '—', copy: '©', reg: '®', hellip: '…'
      })[g.toLowerCase()] || m);
  }

  function htmlToText(html) {
    return unescapeEntities(
      String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n')
        .replace(/<td[^>]*>/gi, '\t')
        .replace(/<[^>]+>/g, '')
    ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const unescapeHtml = (s) => unescapeEntities(s);

  /* ── time & numbers ──────────────────────────────────────────────── */
  function timestamp(v) {
    const s = String(v == null ? '' : v).trim();
    const d = (!s || s.toLowerCase() === 'now') ? new Date()
      : /^-?\d+$/.test(s) ? new Date(Number(s.replace(/^-/, '').length <= 10 ? Number(s) * 1000 : Number(s))) : new Date(s);
    if (isNaN(d.getTime())) return 'cannot read that date';
    return [
      ['ISO 8601', d.toISOString()],
      ['UTC', d.toUTCString()],
      ['local', d.toString()],
      ['unix (s)', Math.floor(d.getTime() / 1000)],
      ['unix (ms)', d.getTime()],
      ['relative', (() => { const s2 = Math.round((Date.now() - d.getTime()) / 1000); const a = Math.abs(s2); if (a < 5) return 'just now'; const unit = a < 60 ? 'second' : a < 3600 ? 'minute' : a < 86400 ? 'hour' : a < 2592000 ? 'day' : a < 31536000 ? 'month' : 'year'; const n = Math.round(a / ({ second: 1, minute: 60, hour: 3600, day: 86400, month: 2592000, year: 31536000 })[unit]); return n + ' ' + unit + (n > 1 ? 's' : '') + (s2 >= 0 ? ' ago' : ' from now'); })()]
    ].map(([k, v]) => k.padEnd(12) + v).join('\n');
  }

  const NAMED_COLORS = {
    black: [0, 0, 0], white: [255, 255, 255], red: [239, 68, 68], green: [34, 197, 94],
    blue: [59, 130, 246], yellow: [234, 179, 8], orange: [249, 115, 22], purple: [168, 85, 247],
    pink: [236, 72, 153], cyan: [6, 182, 212], teal: [20, 184, 166], gray: [107, 114, 128], grey: [107, 114, 128]
  };
  function colorConvert(input) {
    const s = String(input || '').trim().toLowerCase();
    let r, g, b, m;
    if (NAMED_COLORS[s]) { [r, g, b] = NAMED_COLORS[s]; }
    else if ((m = s.match(/^#?([0-9a-f]{3,4})$/))) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
    else if ((m = s.match(/^#?([0-9a-f]{6}|[0-9a-f]{8})$/))) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
    else if ((m = s.match(/^rgba?\(([^)]+)\)$/))) { const p = m[1].trim().split(/[,/\s]+/).map(Number); [r, g, b] = p; }
    else if ((m = s.match(/^hsla?\(([^)]+)\)$/))) {
      const p = m[1].trim().split(/[,/\s]+/).map((x) => parseFloat(x));
      const H = (((p[0] || 0) % 360) + 360) % 360 / 360;
      const S = Math.max(0, Math.min(100, p[1] || 0)) / 100;
      const L = Math.max(0, Math.min(100, p[2] || 0)) / 100;
      const hue2rgb = (p2, q2, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p2 + (q2 - p2) * 6 * t; if (t < 1 / 2) return q2; if (t < 2 / 3) return p2 + (q2 - p2) * (2 / 3 - t) * 6; return p2; };
      if (S === 0) r = g = b = Math.round(L * 255);
      else { const q2 = L < 0.5 ? L * (1 + S) : L + S - L * S, p2 = 2 * L - q2; r = Math.round(hue2rgb(p2, q2, H + 1 / 3) * 255); g = Math.round(hue2rgb(p2, q2, H) * 255); b = Math.round(hue2rgb(p2, q2, H - 1 / 3) * 255); }
    } else return 'use #rgb, #rrggbb, rgb(r,g,b) or hsl(h,s%,l%)';
    if ([r, g, b].some((v) => isNaN(v))) return 'use #rgb, #rrggbb, rgb(r,g,b) or hsl(h,s%,l%)';
    r = Math.max(0, Math.min(255, Math.round(r)));
    g = Math.max(0, Math.min(255, Math.round(g)));
    b = Math.max(0, Math.min(255, Math.round(b)));
    const hex = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
    const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
    const l = (mx + mn) / 2, d = mx - mn;
    let h = 0, sat = 0;
    if (d) {
      sat = d / (1 - Math.abs(2 * l - 1));
      h = mx === r / 255 ? ((g - b) / 255 / d) % 6 : mx === g / 255 ? (b - r) / 255 / d + 2 : (r - g) / 255 / d + 4;
      h = Math.round(h * 60); if (h < 0) h += 360;
    }
    const k = 1 - mx;
    const c = k === 1 ? 0 : (1 - r / 255 - k) / (1 - k);
    const mg = k === 1 ? 0 : (1 - g / 255 - k) / (1 - k);
    const y = k === 1 ? 0 : (1 - b / 255 - k) / (1 - k);
    const lin = (v) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const crWhite = 1.05 / (lum + 0.05);
    const crBlack = (lum + 0.05) / 0.05;
    const verdict = (cr) => cr >= 7 ? `${cr.toFixed(2)}:1 (AAA readable)` : cr >= 4.5 ? `${cr.toFixed(2)}:1 (AA readable)` : `${cr.toFixed(2)}:1 (poor contrast)`;
    return [
      ['HEX', hex],
      ['RGB', `rgb(${r}, ${g}, ${b})`],
      ['HSL', `hsl(${h}, ${Math.round(sat * 100)}%, ${Math.round(l * 100)}%)`],
      ['CMYK', `cmyk(${Math.round(c * 100)}%, ${Math.round(mg * 100)}%, ${Math.round(y * 100)}%, ${Math.round(k * 100)}%)`],
      ['luminance', lum.toFixed(4)],
      ['white text on it', verdict(crWhite)],
      ['black text on it', verdict(crBlack)]
    ].map(([k2, v]) => k2.padEnd(18) + v).join('\n');
  }

  return {
    jsonFormat, jsonMinify, jsonToCsv, csvToJson, csvToTsv, tsvToCsv, jsonKeys, parseCsv,
    b64encode, b64decode, urlEncode, urlDecode, hexEncode, hexDecode, hash, uuid,
    stats, caseConvert, sortLines, dedupeLines, trimLines, reverse, rot13, slugify, lorem,
    mdToHtml, htmlToText, escapeHtml, unescapeHtml, timestamp, colorConvert
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { TextOps };
