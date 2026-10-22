/* ══════════════════════════════════════════════════════════════
   jpeg.js — LOSSLESS JPEG re-container (metadata strip)
   Removes EXIF / XMP / IPTC / comment / thumbnail blocks and
   trailing padding; the compressed scan data is copied untouched
   so every pixel decodes identically.
   ══════════════════════════════════════════════════════════════ */

const JPEGCodec = (() => {
  /* APP markers that can be dropped without changing how the image looks.
     APP1 (Exif → orientation/colour) and APP2 (ICC colour profile) are kept
     unless the payload proves it is only XMP / multi-picture metadata. */
  const DROP_APP = new Set([0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xFE]);
  const KEEP_APP0 = 0xE0;
  const startsWith = (bytes, at, ascii) => {
    for (let i = 0; i < ascii.length; i++) if (bytes[at + i] !== ascii.charCodeAt(i)) return false;
    return true;
  };
  const XMP = 'http://ns.adobe.com/xap/1.0/';
  const MPF = 'MPF\0';

  function info(bytes) {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    const out = { segments: [], width: 0, height: 0, subsampling: '', progressive: false };
    let p = 2;
    while (p + 4 <= bytes.length) {
      if (bytes[p] !== 0xFF) { p++; continue; }
      let m = bytes[p + 1];
      while (m === 0xFF && p + 2 < bytes.length) { p++; m = bytes[p + 1]; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
      if (m === 0xD9) break;
      const len = (bytes[p + 2] << 8) | bytes[p + 3];
      out.segments.push({ marker: m, start: p, len: len + 2 });
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        out.height = (bytes[p + 5] << 8) | bytes[p + 6];
        out.width = (bytes[p + 7] << 8) | bytes[p + 8];
        out.progressive = m === 0xC2 || m === 0xC6 || m === 0xCA;
      }
      if (m === 0xDA) { out.scanStart = p; break; }
      p += len + 2;
    }
    const eoi = lastIndexOfEOI(bytes);
    out.eoi = eoi;
    return out;
  }

  function lastIndexOfEOI(b) {
    for (let i = b.length - 2; i >= 0; i--) {
      if (b[i] === 0xFF && b[i + 1] === 0xD9) return i;
    }
    return -1;
  }

  function stripLossless(bytes) {
    const inf = info(bytes);
    if (!inf || inf.scanStart == null || inf.eoi < 0) return null;
    const parts = [new Uint8Array([0xFF, 0xD8])];
    let saved = 0, dropped = [];
    for (const s of inf.segments) {
      if (s.marker === 0xDA) break;
      const segBytes = bytes.subarray(s.start, s.start + s.len);
      const pay = s.start + 4;
      const drop = DROP_APP.has(s.marker)
        || (s.marker === 0xE1 && startsWith(bytes, pay, XMP))
        || (s.marker === 0xE2 && startsWith(bytes, pay, MPF));
      if (drop) {
        saved += s.len;
        dropped.push(s.marker === 0xFE ? 'COM' : 'APP' + (s.marker - 0xE0));
        continue;
      }
      parts.push(segBytes);
    }
    // scan data through EOI, verbatim
    const tail = bytes.subarray(inf.scanStart, inf.eoi + 2);
    parts.push(tail);
    const out = Util.concat(parts);
    const trailing = bytes.length - (inf.eoi + 2);
    return {
      bytes: out.length < bytes.length ? out : bytes,
      gain: Util.pct(out.length, bytes.length),
      saved, trailing, dropped: [...new Set(dropped)],
      width: inf.width, height: inf.height, progressive: inf.progressive
    };
  }

  return { stripLossless, info };
})();
