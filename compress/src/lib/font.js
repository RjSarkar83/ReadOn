/* ══════════════════════════════════════════════════════════════
   font.js — TrueType / OpenType trimmer for embedded PDF fonts

   A PDF that was produced by Word, Pages or LaTeX embeds the font
   with every table the foundry shipped: hinting bytecode, device
   metrics, bitmap strikes, a digital signature.  None of that is
   used by a PDF renderer, which rasterises outlines itself — so
   dropping those tables is bit-exact for the *outlines* (the glyphs,
   their metrics and their cmap are untouched) and typically buys
   10–40 % of the font payload.

   Dropped:  fpgm prep cvt  hdmx VDMX LTSH gasp DSIG PCLT FFTM
             EBDT EBLC EBSC bdat bloc meta
   Kept:     glyf loca cmap head hhea hmtx maxp name OS/2 post
             CFF  CFF2 VORG kern GPOS GSUB SVG  (anything not listed)
   ══════════════════════════════════════════════════════════════ */

const FontCodec = (() => {
  /* tables a renderer never reads: hinting programs, device metrics,
     bitmap strikes, signatures, foundry metadata */
  const DROP = new Set([
    'fpgm', 'prep', 'cvt ', 'hdmx', 'VDMX', 'LTSH', 'gasp', 'DSIG',
    'PCLT', 'FFTM', 'EBDT', 'EBLC', 'EBSC', 'bdat', 'bloc', 'meta'
  ]);

  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  const SFNT = new Set([0x00010000, 0x4f54544f /*OTTO*/, 0x74727565 /*true*/, 0x74746366 /*ttcf*/]);

  function tableList(bytes) {
    if (!bytes || bytes.length < 320) return null;
    const v = u32(bytes, 0);
    if (!SFNT.has(v)) return null;
    if (v === 0x74746366) return null;           // font collections: leave alone
    const n = u16(bytes, 4);
    if (!n || n > 512) return null;
    if (12 + n * 16 > bytes.length) return null;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = 12 + i * 16;
      const t = tag(bytes, p);
      const off = u32(bytes, p + 8), len = u32(bytes, p + 12);
      if (off + len > bytes.length || off < 12) return null;
      out.push({ tag: t, off, len, sum: bytes.subarray(p + 4, p + 8) });
    }
    return out;
  }

  /** @returns {{bytes: Uint8Array, dropped: string[]}|null} null when nothing to do */
  function optimize(bytes) {
    const tables = tableList(bytes);
    if (!tables) return null;
    const kept = tables.filter((t) => !DROP.has(t.tag));
    if (kept.length === tables.length) return null;
    // a font without these cannot be rendered — refuse rather than corrupt
    for (const need of ['cmap', 'head', 'hhea', 'hmtx', 'maxp']) {
      if (!kept.some((t) => t.tag === need)) return null;
    }
    if (!kept.some((t) => t.tag === 'glyf' || t.tag === 'CFF ' || t.tag === 'CFF2')) return null;

    const n = kept.length;
    let searchRange = 1;
    while (searchRange * 2 <= n) searchRange *= 2;
    searchRange *= 16;
    const entrySelector = Math.log2(searchRange / 16) | 0;
    let size = 12 + n * 16;
    const placed = kept.map((t) => {
      const off = size;
      size += (t.len + 3) & ~3;
      return { ...t, newOff: off };
    });
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, u32(bytes, 0));
    dv.setUint16(4, n);
    dv.setUint16(6, searchRange);
    dv.setUint16(8, entrySelector);
    dv.setUint16(10, n * 16 - searchRange);
    placed.forEach((t, i) => {
      const p = 12 + i * 16;
      out[p] = t.tag.charCodeAt(0); out[p + 1] = t.tag.charCodeAt(1);
      out[p + 2] = t.tag.charCodeAt(2); out[p + 3] = t.tag.charCodeAt(3);
      out.set(t.sum, p + 4);
      dv.setUint32(p + 8, t.newOff);
      dv.setUint32(p + 12, t.len);
      out.set(bytes.subarray(t.off, t.off + t.len), t.newOff);
    });
    return { bytes: out, dropped: tables.filter((t) => DROP.has(t.tag)).map((t) => t.tag.trim()) };
  }

  return { optimize, DROP, tableList };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { FontCodec };
