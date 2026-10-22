/* ══════════════════════════════════════════════════════════════
   crypto.js — the PDF security stack, written from the spec

   Everything the PDF standard needs to open a protected file and to
   write a properly protected one:

     • MD5  (RFC 1321)                — key derivation for R2–R4
     • RC4  (40 / 128 bit)            — V1, V2
     • AES  (128 / 256, CBC, no pad)  — V4 (AESV2), V5 (AESV3)
     • Algorithm 2   — file key from a user password      (R2–R4)
     • Algorithm 2.A — password hash                      (R6)
     • Algorithm 2.B — the iterated hash of ISO 32000-2  (R6)
     • Algorithm 8/9/10 — /U /O /UE /OE /Perms            (R6)

   SHA-256/384/512 come from WebCrypto (async), because Algorithm 2.B
   runs up to 64 rounds of it and a JS implementation would be slower
   than the platform's.
   ══════════════════════════════════════════════════════════════ */

const PDFCrypto = (() => {
  const PAD = new Uint8Array([
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
  ]);

  const latin1 = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xFF; return b; };
  const toStr = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
  const utf8 = (s) => new TextEncoder().encode(s);
  const cat = (...arrs) => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };

  /* ── MD5 (RFC 1321) ─────────────────────────────────────────── */
  const MD5_K = new Int32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ]);
  const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

  function md5(input) {
    const len = input.length;
    const withOne = cat(input, new Uint8Array([0x80]));
    const padLen = (56 - ((len + 1) % 64) + 64) % 64;
    const msg = cat(withOne, new Uint8Array(padLen), new Uint8Array(8));
    const bits = len * 8;
    const dv = new DataView(msg.buffer);
    dv.setUint32(msg.length - 8, bits >>> 0, true);
    dv.setUint32(msg.length - 4, Math.floor(bits / 4294967296), true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let off = 0; off < msg.length; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + MD5_K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setInt32(0, a0, true); odv.setInt32(4, b0, true);
    odv.setInt32(8, c0, true); odv.setInt32(12, d0, true);
    return out;
  }

  /* ── RC4 ────────────────────────────────────────────────────── */
  function rc4(key, data) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 0xFF;
      const t = S[i]; S[i] = S[j]; S[j] = t;
    }
    const out = new Uint8Array(data.length);
    let i = 0; j = 0;
    for (let k = 0; k < data.length; k++) {
      i = (i + 1) & 0xFF;
      j = (j + S[i]) & 0xFF;
      const t = S[i]; S[i] = S[j]; S[j] = t;
      out[k] = data[k] ^ S[(S[i] + S[j]) & 0xFF];
    }
    return out;
  }

  /* ── AES (128 / 256) ────────────────────────────────────────── */
  const SBOX = new Uint8Array(256), INV_SBOX = new Uint8Array(256);
  (() => {
    const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xFF;
    let p = 1, q = 1;
    do {
      p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1B : 0)) & 0xFF;
      q = (q ^ (q << 1)) & 0xFF;
      q = (q ^ (q << 2)) & 0xFF;
      q = (q ^ (q << 4)) & 0xFF;
      if (q & 0x80) q ^= 0x09;
      const x = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4);
      SBOX[p] = (x ^ 0x63) & 0xFF;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  })();
  const xtime = (x) => ((x << 1) ^ (x & 0x80 ? 0x1B : 0)) & 0xFF;
  const mul = (a, b) => {
    let r = 0;
    while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; }
    return r;
  };

  function expandKey(key) {
    const Nk = key.length >> 2, Nr = Nk + 6;
    const w = new Uint8Array(16 * (Nr + 1));
    w.set(key);
    let rcon = 1;
    for (let i = Nk; i < 4 * (Nr + 1); i++) {
      let t = w.slice((i - 1) * 4, i * 4);
      if (i % Nk === 0) {
        t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]);
        rcon = xtime(rcon);
      } else if (Nk > 6 && i % Nk === 4) {
        t = new Uint8Array([SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]]);
      }
      for (let k = 0; k < 4; k++) w[i * 4 + k] = w[(i - Nk) * 4 + k] ^ t[k];
    }
    return { w, Nr };
  }

  function encryptBlock(st, ks) {
    const { w, Nr } = ks;
    for (let i = 0; i < 16; i++) st[i] ^= w[i];
    for (let r = 1; r <= Nr; r++) {
      for (let i = 0; i < 16; i++) st[i] = SBOX[st[i]];
      // ShiftRows (column-major state)
      let t = st[1]; st[1] = st[5]; st[5] = st[9]; st[9] = st[13]; st[13] = t;
      t = st[2]; st[2] = st[10]; st[10] = t; t = st[6]; st[6] = st[14]; st[14] = t;
      t = st[15]; st[15] = st[11]; st[11] = st[7]; st[7] = st[3]; st[3] = t;
      if (r !== Nr) {
        for (let c = 0; c < 16; c += 4) {
          const a0 = st[c], a1 = st[c + 1], a2 = st[c + 2], a3 = st[c + 3];
          st[c] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
          st[c + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
          st[c + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
          st[c + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
        }
      }
      for (let i = 0; i < 16; i++) st[i] ^= w[r * 16 + i];
    }
    return st;
  }

  function decryptBlock(st, ks) {
    const { w, Nr } = ks;
    for (let i = 0; i < 16; i++) st[i] ^= w[Nr * 16 + i];
    for (let r = Nr - 1; r >= 0; r--) {
      let t = st[13]; st[13] = st[9]; st[9] = st[5]; st[5] = st[1]; st[1] = t;
      t = st[2]; st[2] = st[10]; st[10] = t; t = st[6]; st[6] = st[14]; st[14] = t;
      t = st[3]; st[3] = st[7]; st[7] = st[11]; st[11] = st[15]; st[15] = t;
      for (let i = 0; i < 16; i++) st[i] = INV_SBOX[st[i]];
      for (let i = 0; i < 16; i++) st[i] ^= w[r * 16 + i];
      if (r !== 0) {
        for (let c = 0; c < 16; c += 4) {
          const a0 = st[c], a1 = st[c + 1], a2 = st[c + 2], a3 = st[c + 3];
          st[c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
          st[c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
          st[c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
          st[c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
        }
      }
    }
    return st;
  }

  function cbc(key, iv, data, encrypt) {
    const ks = expandKey(key);
    const n = Math.ceil(data.length / 16) * 16;
    const buf = new Uint8Array(n);
    buf.set(data);
    let prev = iv.slice();
    const out = new Uint8Array(n);
    for (let off = 0; off < n; off += 16) {
      const block = buf.slice(off, off + 16);
      if (encrypt) {
        for (let i = 0; i < 16; i++) block[i] ^= prev[i];
        const enc = encryptBlock(block, ks);
        out.set(enc, off);
        prev = enc;
      } else {
        const dec = decryptBlock(block.slice(), ks);
        for (let i = 0; i < 16; i++) dec[i] ^= prev[i];
        out.set(dec, off);
        prev = block;
      }
    }
    return out;                       // caller trims to the real length
  }

  /* PKCS#7 (RFC 5652) framing — what every PDF writer uses for AES streams */
  function pkcs7Pad(data) {
    const pad = 16 - (data.length % 16);
    const out = new Uint8Array(data.length + pad);
    out.set(data); out.fill(pad, data.length);
    return out;
  }
  function pkcs7Unpad(d) {
    const n = d.length;
    if (!n) return d;
    const p = d[n - 1];
    if (p >= 1 && p <= 16 && p <= n) {
      let ok = true;
      for (let i = n - p; i < n; i++) if (d[i] !== p) { ok = false; break; }
      if (ok) return d.subarray(0, n - p);
    }
    let e = n;                                  // tolerate zero-padded producers
    while (e > 0 && d[e - 1] === 0) e--;
    return d.subarray(0, e);
  }

  const aesCbcDecrypt = (key, data) => cbc(key, data.slice(0, 16), data.slice(16), false);
  const aesCbcEncrypt = (key, iv, data) => cat(iv, cbc(key, iv, data, true).subarray(0, Math.ceil(data.length / 16) * 16));
  const aesEcbEncryptBlock = (key, block) => encryptBlock(block.slice(), expandKey(key));

  /* ── WebCrypto hashes ───────────────────────────────────────── */
  async function digest(alg, data) {
    const buf = await crypto.subtle.digest(alg, data);
    return new Uint8Array(buf);
  }

  /* Algorithm 2.B — the R6 password hash (ISO 32000-2, 7.6.4.3.4) */
  async function hash2B(password, salt, udata) {
    let K = await digest('SHA-256', cat(password, salt, udata));
    let round = 0;
    let E = null;
    for (;;) {
      const K1 = new Uint8Array((password.length + K.length + udata.length) * 64);
      const unit = cat(password, K, udata);
      for (let i = 0; i < 64; i++) K1.set(unit, i * unit.length);
      const key = K.slice(0, 16), iv = K.slice(16, 32);
      E = cbc(key, iv, K1, true);
      let sum = 0;
      for (let i = 0; i < 16; i++) sum += E[i];
      const mod = sum % 3;
      K = await digest(mod === 0 ? 'SHA-256' : mod === 1 ? 'SHA-384' : 'SHA-512', E);
      round++;
      if (round >= 64 && E[E.length - 1] <= round - 32) break;
      if (round > 200) break;         // hard stop; the spec's own bound is much lower
    }
    return K.slice(0, 32);
  }

  /* ── Algorithm 2 — file key for R2–R4 ───────────────────────── */
  function fileKeyR4({ password, O, P, id, R, keyLen, encryptMetadata }) {
    const pwLen = Math.min(32, password.length);
    const pw = cat(latin1(password).subarray(0, pwLen), PAD.subarray(0, 32 - pwLen));
    const pArr = new Uint8Array(4);
    new DataView(pArr.buffer).setInt32(0, P | 0, true);
    const ob = typeof O === 'string' ? latin1(O) : (O || new Uint8Array(0));
    let input = cat(pw, ob, pArr, id);
    if (R >= 4 && !encryptMetadata) input = cat(input, new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]));
    let h = md5(input);
    if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, keyLen));
    return h.subarray(0, keyLen);
  }

  /* Algorithm 5 — /O value from owner password (R2–R4) */
  function computeO({ ownerPw, userPw, R, keyLen }) {
    const opw = cat(latin1(ownerPw).subarray(0, 32), PAD.subarray(0, Math.max(0, 32 - (ownerPw || '').length)));
    let h = md5(opw);
    if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
    const key = h.subarray(0, keyLen);
    const upw = cat(latin1(userPw || '').subarray(0, 32), PAD.subarray(0, Math.max(0, 32 - (userPw || '').length)));
    let O = rc4(key, upw);
    if (R >= 3) for (let i = 1; i <= 19; i++) {
      const k2 = new Uint8Array(key.length);
      for (let j = 0; j < key.length; j++) k2[j] = key[j] ^ i;
      O = rc4(k2, O);
    }
    return O;
  }

  /* Algorithm 4 — /U value (R2–R4) */
  function computeU({ fileKey, id, R }) {
    if (R === 2) return rc4(fileKey, PAD.slice());
    let x = rc4(fileKey, md5(cat(PAD, id)));
    for (let i = 1; i <= 19; i++) {
      const k2 = new Uint8Array(fileKey.length);
      for (let j = 0; j < fileKey.length; j++) k2[j] = fileKey[j] ^ i;
      x = rc4(k2, x);
    }
    const out = new Uint8Array(32);
    out.set(x, 0);
    for (let i = 16; i < 32; i++) out[i] = 0;   // arbitrary padding
    return out;
  }

  /* per-object key for RC4 / AESV2 */
  function objectKey(fileKey, num, gen, aes) {
    const n = fileKey.length;
    const extra = new Uint8Array([num & 0xFF, (num >> 8) & 0xFF, (num >> 16) & 0xFF, gen & 0xFF, (gen >> 8) & 0xFF]);
    const base = cat(fileKey, extra, aes ? new Uint8Array([0x73, 0x41, 0x6C, 0x54]) : new Uint8Array(0));
    const h = md5(base);
    return h.subarray(0, Math.min(n + 5, 16));
  }

  /* ── AES-256 R6: hash / U / O / UE / OE / Perms ─────────────── */
  async function r6Hash(password, salt, udata) {
    return hash2B(utf8(password.length > 127 ? password.slice(0, 127) : password), salt, udata || new Uint8Array(0));
  }

  async function buildR6({ userPw, ownerPw, perms, encryptMetadata = true }) {
    const fileKey = crypto.getRandomValues(new Uint8Array(32));
    const vsalt = crypto.getRandomValues(new Uint8Array(8));
    const ksalt = crypto.getRandomValues(new Uint8Array(8));
    const ovsalt = crypto.getRandomValues(new Uint8Array(8));
    const oksalt = crypto.getRandomValues(new Uint8Array(8));

    const uHash = await r6Hash(userPw, vsalt);
    const U = cat(uHash, vsalt, ksalt);                                  // 48 bytes
    const ueKey = await r6Hash(userPw, ksalt);
    const ZERO = new Uint8Array(16);
    const UE = cbc(ueKey, ZERO, fileKey, true);          // 32 bytes, zero IV, no padding

    const oHash = await r6Hash(ownerPw || userPw, ovsalt, U);
    const O = cat(oHash, ovsalt, oksalt);
    const oeKey = await r6Hash(ownerPw || userPw, oksalt, U);
    const OE = cbc(oeKey, ZERO, fileKey, true);

    const permsRaw = new Uint8Array(16);
    const pdv = new DataView(permsRaw.buffer);
    pdv.setInt32(0, perms | 0, true);
    pdv.setUint32(4, 0xFFFFFFFF, true);
    permsRaw[8] = encryptMetadata ? 0x54 : 0x46;   // 'T' / 'F'
    permsRaw[9] = 0x61; permsRaw[10] = 0x64; permsRaw[11] = 0x62;  // 'a','d','b'
    const rnd = crypto.getRandomValues(new Uint8Array(4));
    permsRaw.set(rnd, 12);
    const PERMS = aesEcbEncryptBlock(fileKey, permsRaw);

    return { fileKey, U, UE, O, OE, PERMS };
  }

  /* tries the user password (and the owner password) against an /Encrypt dict */
  async function openR6(enc, userPw) {
    const U = enc.U || new Uint8Array(48);
    const O = enc.O || new Uint8Array(48);
    const UE = enc.UE, OE = enc.OE;
    if (!UE || !OE) return null;
    const pw = userPw || '';
    // user password path
    const uHash = await r6Hash(pw, U.slice(32, 40));
    let ok = true;
    for (let i = 0; i < 32; i++) if (uHash[i] !== U[i]) { ok = false; break; }
    if (ok) {
      const key = await r6Hash(pw, U.slice(40, 48));
      return cbc(key, new Uint8Array(16), UE, false).subarray(0, 32);
    }
    // owner password path (owner key is derived with the 48-byte /U as udata)
    const oHash = await r6Hash(pw, O.slice(32, 40), U);
    ok = true;
    for (let i = 0; i < 32; i++) if (oHash[i] !== O[i]) { ok = false; break; }
    if (ok) {
      const key = await r6Hash(pw, O.slice(40, 48), U);
      return cbc(key, new Uint8Array(16), OE, false).subarray(0, 32);
    }
    return null;
  }


  /* ══════════════════════════════════════════════════════════════
     PDF level: open a protected document / protect a new one
     ══════════════════════════════════════════════════════════════ */

  /* one string or stream, with the per-object key the standard prescribes */
  function decryptBytes(crypt, data, num, gen) {
    if (!crypt || !data) return data;
    if (crypt.kind === 'aesv3') {
      // 16-byte IV + ciphertext, zero padded to a block boundary
      if (data.length <= 16) return new Uint8Array(0);
      return pkcs7Unpad(aesCbcDecrypt(crypt.key, data));
    }
    const key = objectKey(crypt.key, num, gen, crypt.kind === 'aesv2');
    if (crypt.kind === 'rc4') return rc4(key, data);
    if (data.length <= 16) return new Uint8Array(0);
    return pkcs7Unpad(aesCbcDecrypt(key, data));
  }

  function encryptBytes(crypt, data, num, gen) {
    if (!crypt || !data) return data;
    if (crypt.kind === 'aesv3') {
      const iv = crypto.getRandomValues(new Uint8Array(16));
      return aesCbcEncrypt(crypt.key, iv, pkcs7Pad(data));
    }
    const key = objectKey(crypt.key, num, gen, crypt.kind === 'aesv2');
    if (crypt.kind === 'rc4') return rc4(key, data);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    return aesCbcEncrypt(key, iv, pkcs7Pad(data));
  }

  /* the PDF value shapes used by the parser: {t:'dict', v:{key:{t:'name'|'str'|'num'|...}}} */
  const get = (d, k) => {
    if (!d) return null;
    if (d.t !== 'dict' || !d.v) return null;
    const val = Object.prototype.hasOwnProperty.call(d.v, k) ? d.v[k] : (d.v instanceof Map ? d.v.get(k) : undefined);
    return val === undefined ? null : val;
  };
  const nameOf = (v) => (v && v.t === 'name' ? v.v : null);
  /* a PDF string value → real bytes: literal strings may carry escapes,
     hex strings are <A1B2…> and must be decoded, not read as ASCII */
  function valueBytes(v) {
    if (!v) return new Uint8Array(0);
    const raw = String(v.raw != null ? v.raw : '');
    if (v.t === 'hex') {
      const h = raw.replace(/[<>\s]/g, '');
      const out = new Uint8Array(h.length >> 1);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16) || 0;
      return out;
    }
    if (v.t === 'str') {
      const body = raw.replace(/^\(/, '').replace(/\)$/, '');
      const out = [];
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '\\' && i + 1 < body.length) {
          const n = body[i + 1];
          const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }[n];
          if (esc != null) { out.push(esc); i++; continue; }
          if (n >= '0' && n <= '7') {
            let oct = '';
            let k = i + 1;
            while (k < body.length && oct.length < 3 && body[k] >= '0' && body[k] <= '7') oct += body[k++];
            out.push(parseInt(oct, 8) & 0xFF); i = k - 1; continue;
          }
          continue;
        }
        out.push(c.charCodeAt(0) & 0xFF);
      }
      return new Uint8Array(out);
    }
    return latin1(raw);
  }
  const rawOf = (v) => toStr(valueBytes(v));

  /* read /Encrypt, work out the scheme and verify the password */
  async function prepareDecrypt(enc, id, password) {
    const V = (get(enc, 'V') || {}).v || 0;
    const R = (get(enc, 'R') || {}).v || 0;
    const P = (get(enc, 'P') || {}).v || 0;
    const Ob = valueBytes(get(enc, 'O'));
    const Ub = valueBytes(get(enc, 'U'));
    const emv = get(enc, 'EncryptMetadata');
    const encryptMetadata = !(emv && emv.v === false);

    if (V >= 5) {
      const E6 = {
        U: valueBytes(get(enc, 'U')), O: valueBytes(get(enc, 'O')),
        UE: valueBytes(get(enc, 'UE')), OE: valueBytes(get(enc, 'OE'))
      };
      const key = await openR6(E6, password || '');
      if (!key) return { ok: false, reason: 'password' };
      return { ok: true, crypt: { kind: 'aesv3', key: key.slice(0, 32) }, R, V };
    }

    const lengthBits = ((get(enc, 'Length') || {}).v) || (V === 1 ? 40 : 128);
    const keyLen = Math.max(5, Math.min(16, Math.round(lengthBits / 8)));
    const fileKey = fileKeyR4({ password: password || '', O: Ob, P, id, R, keyLen, encryptMetadata });

    let ok;
    if (R === 2) ok = toStr(rc4(fileKey, PAD).slice(0, 32)) === toStr(Ub.slice(0, 32));
    else ok = toStr(computeU({ fileKey, id, R }).slice(0, 16)) === toStr(Ub.slice(0, 16));
    if (!ok) return { ok: false, reason: 'password' };

    const stmF = nameOf(get(enc, 'StmF')) || 'Identity';
    let isAes = false;
    if (stmF === 'StdCF') {
      const cfm = nameOf(get(get(get(enc, 'CF'), 'StdCF'), 'CFM'));
      isAes = cfm === 'AESV2' || cfm === 'AESV3';
    }
    return { ok: true, crypt: { kind: isAes ? 'aesv2' : 'rc4', key: fileKey }, R, V };
  }

  /* build an /Encrypt dictionary for a brand-new AES-256 (R6) document */
  async function buildProtect(userPw, ownerPw, perms, id) {
    const r = await buildR6({ userPw, ownerPw: ownerPw || userPw, perms, encryptMetadata: true });
    const hex = (b) => b.length ? b : new Uint8Array(0);
    return {
      crypt: { kind: 'aesv3', key: r.fileKey },
      dict: { U: r.U, UE: r.UE, O: r.O, OE: r.OE, PERMS: r.PERMS, P: perms },
      id
    };
  }

  return {
    PAD, md5, rc4, cbc, pkcs7Pad, pkcs7Unpad, aesCbcDecrypt, aesCbcEncrypt, aesEcbEncryptBlock, digest,
    fileKeyR4, computeO, computeU, objectKey, hash2B, buildR6, openR6, r6Hash,
    latin1, toStr, utf8, cat, valueBytes,
    decryptBytes, encryptBytes, prepareDecrypt, buildProtect
  };

})();
