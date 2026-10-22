/* ══════════════════════════════════════════════════════════════
   zip.js — minimal ZIP reader / writer (OFFICE containers)
   Entries are re-deflated at maximum level and stored when that
   is smaller. Entry payloads are byte-identical after unpacking,
   so DOCX / PPTX / XLSX / EPUB / ODT stay valid.
   ══════════════════════════════════════════════════════════════ */

const ZipCodec = (() => {
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  function findEOCD(b) {
    const min = Math.max(0, b.length - 66000);
    for (let i = b.length - 22; i >= min; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
    }
    return -1;
  }

  async function list(bytes) {
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null;
    const eocd = findEOCD(bytes);
    if (eocd < 0) return null;
    const count = u16(bytes, eocd + 10);
    let p = u32(bytes, eocd + 16);
    if (p === 0xFFFFFFFF || count === 0xFFFF) return null; // ZIP64: skip
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) break;
      const flags = u16(bytes, p + 8);
      const method = u16(bytes, p + 10);
      const crc = u32(bytes, p + 16);
      const csize = u32(bytes, p + 20);
      const usize = u32(bytes, p + 24);
      const nlen = u16(bytes, p + 28), elen = u16(bytes, p + 30), clen = u16(bytes, p + 32);
      const mode = u16(bytes, p + 38);
      const lho = u32(bytes, p + 42);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
      const extra = bytes.subarray(p + 46 + nlen, p + 46 + nlen + elen);
      entries.push({ name, flags, method, crc, csize, usize, lho, mode, extra, extAttr: u32(bytes, p + 38) });
      p += 46 + nlen + elen + clen;
    }
    for (const e of entries) {
      if (e.lho + 30 > bytes.length) { e.data = null; continue; }
      const nlen = u16(bytes, e.lho + 26), elen = u16(bytes, e.lho + 28);
      const start = e.lho + 30 + nlen + elen;
      e.data = bytes.subarray(start, start + e.csize);
      e.localExtra = bytes.subarray(e.lho + 30 + nlen, start);
    }
    return entries;
  }

  async function readEntry(e) {
    if (!e.data) return null;
    if (e.method === 0) return e.data;
    if (e.method === 8) {
      try {
        return await Util.inflateRaw(e.data);
      } catch (err) { return null; }
    }
    return null; // unsupported method (bzip2, lzma, …): leave untouched
  }

  const dosTime = () => {
    const d = new Date();
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
  };

  // entries: [{name, data, store?, mode?}]  -> Uint8Array
  async function write(entries) {
    const { time, date } = dosTime();
    const locals = [], centrals = [];
    let offset = 0;
    for (const e of entries) {
      const nameBytes = Util.utf8(e.name);
      const data = e.data || new Uint8Array(0);
      let payload = data, method = 0;
      if (!e.store && data.length > 64) {
        const z = await Util.deflateRaw(data);
        if (z.length < data.length) { payload = z; method = 8; }
      }
      const crc = Util.crc32(data);
      const flags = /[^\x00-\x7F]/.test(e.name) ? 0x0800 : 0;
      const lh = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, method === 8 ? 20 : 10, true);
      dv.setUint16(6, flags, true);
      dv.setUint16(8, method, true);
      dv.setUint16(10, time, true);
      dv.setUint16(12, date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, payload.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      const local = Util.concat([lh, payload]);
      locals.push(local);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, method === 8 ? 20 : 10, true);
      cv.setUint16(8, flags, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, payload.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(38, e.mode || 0x20, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      centrals.push(cd);
      offset += local.length;
    }
    const central = Util.concat(centrals);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, central.length, true);
    ev.setUint32(16, offset, true);
    return Util.concat([...locals, central, eocd]);
  }

  const isOffice = (name) => /\.(docx|docm|pptx|pptm|xlsx|xlsm|epub|odt|ods|odp|zip|vsdx|key|numbers|pages)$/i.test(name);

  async function recompress(bytes) {
    const entries = await list(bytes);
    if (!entries) return null;
    const out = [];
    let textGain = 0, skipped = 0;
    for (const e of entries) {
      if (e.name.endsWith('/')) { out.push({ name: e.name, data: new Uint8Array(0), store: true }); continue; }
      const data = await readEntry(e);
      if (!data) { skipped++; out.push({ name: e.name, data: null, store: true }); continue; }
      out.push({ name: e.name, data, mode: e.extAttr >>> 0 });
    }
    if (skipped) {
      // some entries could not be decoded: fall back to copying the archive
      return { bytes, gain: 0, skipped, note: 'archive uses a codec this browser cannot re-encode' };
    }
    // XML payloads compress best; images inside are already compressed
    const result = await write(out);
    return {
      bytes: result.length < bytes.length ? result : bytes,
      gain: Util.pct(result.length, bytes.length),
      entries: entries.length,
      method: 're-deflate'
    };
  }

  return { list, readEntry, write, recompress, isOffice };
})();
