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
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
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

  /* ── hashing (WebCrypto — real SHA) ──────────────────────────────── */
  async function hash(text, alg = 'SHA-256') {
    if (!(self.crypto && self.crypto.subtle)) return 'this browser has no WebCrypto (needs https or localhost)';
    const buf = await self.crypto.subtle.digest(alg, enc.encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
  const words = (s) => (s.trim() ? s.trim().split(/\s+/) : []);
  function stats(s) {
    const w = words(s);
    return [
      ['characters', s.length],
      ['characters (no spaces)', s.replace(/\s/g, '').length],
      ['words', w.length],
      ['lines', s ? s.split(/\n/).length : 0],
      ['sentences', (s.match(/[.!?]+(\s|$)/g) || []).length],
      ['paragraphs', s.split(/\n\s*\n/).filter((p) => p.trim()).length],
      ['bytes (utf-8)', enc.encode(s).length],
      ['reading time', Math.max(1, Math.round(w.length / 220)) + ' min']
    ];
  }

  const CASES = {
    upper: (s) => s.toUpperCase(),
    lower: (s) => s.toLowerCase(),
    title: (s) => s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase()),
    sentence: (s) => s.toLowerCase().replace(/(^\s*\w|[.!?]\s+\w)/g, (m) => m.toUpperCase()),
    camel: (s) => words(s).map((t, i) => (i ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t.toLowerCase())).join(''),
    snake: (s) => words(s).join('_').toLowerCase(),
    kebab: (s) => words(s).join('-').toLowerCase(),
    constant: (s) => words(s).join('_').toUpperCase()
  };
  const caseConvert = (s, mode) => (CASES[mode] || CASES.lower)(s);

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

  /* ── markdown → html (headings, lists, code, emphasis, links) ─────── */
  function mdToHtml(md) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    const lines = md.split('\n');
    const out = [];
    let inCode = false, inList = false, inQuote = false;
    for (const raw of lines) {
      if (/^```/.test(raw)) { inCode = !inCode; out.push(inCode ? '<pre><code>' : '</code></pre>'); continue; }
      if (inCode) { out.push(esc(raw)); continue; }
      if (/^\s*$/.test(raw)) { if (inList) { out.push('</ul>'); inList = false; } if (inQuote) { out.push('</blockquote>'); inQuote = false; } continue; }
      const h = raw.match(/^(#{1,6})\s+(.*)$/);
      if (h) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
      if (/^\s*[-*+]\s+/.test(raw)) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(raw.replace(/^\s*[-*+]\s+/, '')) + '</li>'); continue; }
      if (/^>\s?/.test(raw)) { if (!inQuote) { out.push('<blockquote>'); inQuote = true; } out.push('<p>' + inline(raw.replace(/^>\s?/, '')) + '</p>'); continue; }
      if (/^(-{3,}|\*{3,})$/.test(raw.trim())) { out.push('<hr>'); continue; }
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<p>' + inline(raw) + '</p>');
    }
    if (inList) out.push('</ul>');
    if (inQuote) out.push('</blockquote>');
    if (inCode) out.push('</code></pre>');
    return out.join('\n');
  }

  function htmlToText(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, g) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[g]);

  /* ── time & numbers ──────────────────────────────────────────────── */
  function timestamp(v) {
    const s = String(v).trim();
    const d = /^\d+$/.test(s) ? new Date(Number(s.length <= 10 ? s + '000' : s)) : new Date(s);
    if (isNaN(d.getTime())) return 'cannot read that date';
    return [
      ['ISO 8601', d.toISOString()],
      ['UTC', d.toUTCString()],
      ['local', d.toString()],
      ['unix (s)', Math.floor(d.getTime() / 1000)],
      ['unix (ms)', d.getTime()],
      ['relative', (() => { const s2 = Math.round((Date.now() - d.getTime()) / 1000); const a = Math.abs(s2); const unit = a < 60 ? 'second' : a < 3600 ? 'minute' : a < 86400 ? 'hour' : a < 2592000 ? 'day' : 'month'; const n = Math.round(a / ({ second: 1, minute: 60, hour: 3600, day: 86400, month: 2592000 })[unit]); return n + ' ' + unit + (n > 1 ? 's' : '') + (s2 >= 0 ? ' ago' : ' from now'); })()]
    ].map(([k, v]) => k.padEnd(12) + v).join('\n');
  }

  function colorConvert(input) {
    const s = String(input).trim().toLowerCase();
    let r, g, b;
    let m;
    if ((m = s.match(/^#?([0-9a-f]{3})$/))) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
    else if ((m = s.match(/^#?([0-9a-f]{6})$/))) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
    else if ((m = s.match(/^rgba?\(([^)]+)\)$/))) { const p = m[1].split(/[,/\s]+/).map(Number); [r, g, b] = p; }
    else return 'use #rgb, #rrggbb or rgb(r,g,b)';
    const hex = '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
    const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
    const l = (mx + mn) / 2, d = mx - mn;
    let h = 0, sat = 0;
    if (d) {
      sat = d / (1 - Math.abs(2 * l - 1));
      h = mx === r / 255 ? ((g - b) / 255 / d) % 6 : mx === g / 255 ? (b - r) / 255 / d + 2 : (r - g) / 255 / d + 4;
      h = Math.round(h * 60); if (h < 0) h += 360;
    }
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return [
      ['HEX', hex],
      ['RGB', `rgb(${r}, ${g}, ${b})`],
      ['HSL', `hsl(${h}, ${Math.round(sat * 100)}%, ${Math.round(l * 100)}%)`],
      ['luminance', lum.toFixed(3)],
      ['white text on it', (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? 'readable' : 'poor contrast']
    ].map(([k, v]) => k.padEnd(18) + v).join('\n');
  }

  return {
    jsonFormat, jsonMinify, jsonToCsv, csvToJson, csvToTsv, tsvToCsv, jsonKeys, parseCsv,
    b64encode, b64decode, urlEncode, urlDecode, hexEncode, hexDecode, hash, uuid,
    stats, caseConvert, sortLines, dedupeLines, trimLines, reverse, rot13, slugify, lorem,
    mdToHtml, htmlToText, escapeHtml, unescapeHtml, timestamp, colorConvert
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { TextOps };
