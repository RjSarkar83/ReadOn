# Compression engineering — specification

ReadOn · Compress is not a wrapper around a quality slider. It is a small, purpose-built
document/image optimiser that runs entirely in the browser. This document describes the
algorithms, the order in which they are applied, the quality gates, and how the claims were
verified.

---

## 1 · Architecture

```
File → sniff (magic bytes, not extension)
        │
        ├── pdf  → PDFEngine (parse → transforms → rebuild → verify)
        ├── png  → PNGCodec  (chunk strip → unfilter → refilter → deflate)
        ├── jpeg → JPEGCodec (segment strip, scan copied verbatim)
        ├── zip  → ZipCodec  (Office/EPUB: unpack → optimise → repack)
        ├── svg/json/html/css/js/xml/txt → minifiers (+ optional gzip)
        └── png/jpeg/webp/gif/bmp → Imaging (decode → resample → encode)
        │
        └── Compressor.preset ladder → quality gate → verified bytes
```

All modules are plain ES2020 in a single scope; no WASM, no network, no third-party code. Every
platform feature is optional and probed at start-up:

| Feature | Used for | If missing |
|---|---|---|
| `CompressionStream` / `DecompressionStream` | DEFLATE in/out | `lib/codec-js.js` — a complete JS LZ77 + Huffman inflate (stored/fixed/dynamic blocks, zlib and raw) and deflate (fixed-Huffman, hash-chain, level 4, zlib wrapper + adler32) plus `gzip()` |
| `Worker` + `Blob` URL | parallelism | the same engine runs on the main thread, one file at a time |
| `OffscreenCanvas` in a worker | raster decode/encode off-thread | raster work is proxied to a main-thread `<canvas>` |
| Canvas 2D / `createImageBitmap` | raster work at all | file is returned untouched with a plain-language note (`NO_CANVAS`) |
| `navigator.hardwareConcurrency`, `deviceMemory`, `connection.saveData` | pool size, mobile caps | defaults to 1 worker, conservative rungs |

---

## 2 · PDF engine

### 2.1 Parsing
A deliberately tolerant scanner, not a strict parser, because real files are messy:

* Lexes `N G obj … endobj` top-level objects by byte offset; later definitions win
  (incremental updates).
* Stream extents from `/Length` when it points at `endstream`, otherwise by scanning for the
  `endstream` keyword and trimming exactly one EOL. Both paths are byte-exact.
* Expands **object streams** (`/Type /ObjStm`) and **cross-reference streams**, so PDF 1.5+
  files are fully understood without an xref parser.
* Parses a full PDF value grammar: dictionaries (order preserved), arrays, names with `#xx`
  escapes, literal strings with escapes and nesting, hex strings, numbers, indirect refs
  (`N G R` lookahead), booleans, null.
* Page tree walk with inherited `/Resources`, `Kids` arrays, cycle guard, 64-level depth cap.
* Detects `/Encrypt` and refuses to touch encrypted content.

### 2.2 Transform pipeline (one parse, cheapest → strongest)

The whole optimiser runs **inside a single parse**: structural work first, then a serialisation
to measure the result, then — only if the target is still missed — a budgeted raster ladder that
re-uses the same parsed document. This is why a 2 MB / 6 000-object PDF finishes in seconds
instead of the 40 s a naive per-rung re-parse needed.

1. **Metadata / junk** — `/Metadata`, `/PieceInfo`, `/LastModified`, `/MarkInfo`,
   `/OutputIntents`, `/Perms`, page `/Thumb` thumbnails, unattached `/Annots` (opt-in),
   `/Outlines` and `/StructTreeRoot` (opt-in), `/EmbeddedFiles` and `/AF` (opt-in).
2. **Stream re-encode** — every decodable stream (`Flate`, `LZW`, `ASCIIHex`, `ASCII85`,
   `RunLength`, with PNG/TIFF predictors) is decoded and re-deflated; the smaller of
   re-encode vs. original is kept. Predictor parameters are dropped when the new payload
   is unfiltered.
3. **Text-layer removal (opt-in, ≥25 %)** — content streams and Form XObjects are tokenised;
   every `BT … ET` block that actually paints glyphs (`Tj`, `TJ`, `'`, `"`) is deleted while
   paths, images, shading and clipping stay byte-identical. With no glyphs left, `/Font`
   resources are dropped, which makes the embedded font files unreachable — the single
   biggest win on text documents (typically 50–60 % on plain-text PDFs) with **zero page
   change**: the invisible OCR/select layer disappears, the visible page does not.
4. **Image collection** — raster XObjects are decoded lazily and kept for the ladder (§2.3).
5. **Duplicate-stream de-duplication** — streams ≥512 B are hashed (length + CRC32 + a
   normalised dictionary); identical payloads are merged and every reference remapped.
6. **Garbage collection** — reachability from the catalog through parsed values; dead
   objects, orphaned fonts and retired object streams are not written.
7. **Rebuild** — two candidate writers are always produced and the smallest verified one wins:
   * *classic xref* — plain objects + `xref` table + `trailer`;
   * *object streams* — stream-less objects packed into one Flate `ObjStm`, plus an
     `/XRef` stream with `/W [1 4 2]` rows. Object numbers are kept stable; only
     generation-0 dictionary/array objects are packed, so references never break.
8. **Budgeted raster ladder** — if the structural result already meets the target, images are
   never touched (the lossless-first guarantee). Otherwise nine rungs (`q 0.97 → 0.34`,
   long edge `∅ → 3200 → 900 px`) are evaluated against an image byte budget; the first rung
   that lands under the target is applied to all images at once, the document is re-serialised
   and re-verified. The ladder stops early when a rung buys less than 3 % of the file.
9. **Verification** — the engine re-parses its own output and requires a catalog and at least
   as many pages as the input. Failure → original bytes.

### 2.3 Embedded image handling

| Source encoding | Lossless pass | Lossy pass (preset ≥10 %) |
|---|---|---|
| `DCTDecode` (JPEG), incl. `ASCII85`+`DCT` chains | EXIF/XMP/ICC-free re-container, trailing bytes trimmed, scan copied verbatim | decode → optional resample → `canvas.toBlob('image/jpeg', q)` per ladder rung |
| `FlateDecode` / `LZWDecode` raw samples, 8-bit Gray/RGB, no mask | re-filtered with the best of 6 predictor strategies | converted through RGBA → JPEG; **only if smaller than the lossless re-filter** |
| Anything with `/SMask` or `/Mask`, 1/2/4/16-bit, `Indexed`, `ICCBased`, `JPXDecode` | predictor-only (or untouched) | untouched — alpha and exotic colour spaces are never flattened |

When a payload is accepted the dictionary is rewritten consistently: `/Width`, `/Height`,
`/Filter`, `/BitsPerComponent`, `/ColorSpace` and `/Length`. Two hard rules:

* Re-filtered sample planes **must** carry the matching predictor —
  `<< /Predictor 15 /Colors n /Columns w /BitsPerComponent bpc >>` — because the payload starts
  with a filter-type byte per row. Omitting it silently corrupts the colours.
* `/Decode` (sample interpretation, e.g. `[1 0]` on inverted masks) is preserved for lossless
  rewrites and removed only when the samples themselves are replaced by a new encoding.

---

### 2.4 Font payload trimming (lossless)

A font embedded by Word, Pages or LaTeX ships every table the foundry produced. A PDF renderer
only needs the outlines, the metrics, the cmap and (for CFF) the charset — everything else is
hinting advice for a rasteriser that we are not.

| Dropped | Kept |
|---|---|
| `fpgm`, `prep`, `cvt ` (hinting bytecode) · `hdmx`, `VDMX`, `LTSH` (device metrics) · `gasp` · `EBDT`/`EBLC`/`EBSC`/`bdat`/`bloc` (bitmap strikes) · `DSIG` (signature) · `PCLT`, `FFTM`, `meta` | `glyf`, `loca`, `cmap`, `head`, `hhea`, `hmtx`, `maxp`, `name`, `OS/2`, `post`, `CFF `, `CFF2`, `VORG`, `kern`, `GPOS`, `GSUB`, `SVG ` |

The table directory is rewritten (checksums copied, `searchRange`/`entrySelector`/`rangeShift`
recomputed, 4-byte alignment kept) and `/Length1` is updated. Safety rules: FontCollections
(`ttcf`), fonts without `glyf`/`CFF `, and fonts missing `cmap`/`head`/`hhea`/`hmtx`/`maxp` are
left untouched; a trim that does not shrink the payload is discarded.

Measured on the gate corpus — **pixel-identical pages** (poppler, 60 dpi, 0 differing channels):

| File | Before | After | Win |
|---|---|---|---|
| arXiv paper (15 pp) | 2.11 MB | 1.62 MB | −23.2 % (10 fonts, 43 KB of font tables) |
| IRS 1040 form | 215 KB | 181 KB | −15.8 % |
| `textbook.pdf` | 142 KB | 132 KB | −6.9 % (6 fonts) |
| `text.pdf` (12 pp) | 11.9 KB | 9.8 KB | −17.5 % |

**Unused fonts.** When a document has ≤300 content streams, every stream is scanned for
`/Name size Tf`; any resource font whose name is never selected is deleted from its `/Font`
dictionary. The pass is all-or-nothing per document: if a single stream could not be decoded or
is larger than 1.5 MB, nothing is pruned (an unread stream could be the only user of a font).

### 2.5 Content-stream compaction (exact)

Numbers are normalised **without changing their value**: `000.500000` → `.5`, `+12` → `12`,
`7.0` → `7`. No rounding, no re-flow — `trimContent()` re-emits the token stream with short
numbers, single spaces and no comments. A 4-decimal *rounding* variant was implemented and
rejected: at 60 dpi it already moved glyph edges by up to 57 channel values on `textbook.pdf`,
which breaks the bit-exact claim. Only the exact variant ships.

### 2.6 The Lossless preset — how it reaches ≥5 %

Lossless carries a real 5 % target now (`target: 5, bitExact: true`). The order of attack:

1. **Structure** — objects re-serialised, dead objects dropped, duplicate streams merged, metadata
   dropped, fonts trimmed / unused fonts pruned, content streams compacted (sections 2.4–2.5).
2. **Images inside the PDF, losslessly** — Flate/PNG image streams are decoded, re-filtered and
   re-deflated at the smallest of the six predictor strategies, then written back as the same
   colours. This is where a photo/scan PDF finds its 20 % (`photos.pdf`, `scan.pdf`).
3. **Only if the 5 % is still missed**: one *gentle* rung of the ladder (`q0.97 … q0.90`, **never a
   resample**) is scored against the original. It is accepted only above **SSIM 0.98 and PSNR
   40 dB**; below that the bit-exact bytes are shipped and the note says so. Accepted re-encodes
   are reported with the fidelity **near-lossless**, never "lossless", and the measured SSIM is
   printed per file.
4. **Never** at this preset: text-layer removal (that is an `invisible-only` result, not lossless),
   annotations/bookmark stripping, or a resampling ceiling. The engineering panel exposes
   **Lossless stays bit-exact**, which forces `target: 0` and forbids step 3 entirely.

Proof is a separate gate (`qa/lossless_check.js` + `qa/lossless_verify.py`): the preset is run on
20 real files in Chromium, every output is written to disk and re-rendered with poppler at 110 dpi
(PDFs) or Pillow (rasters) — **0 differing pixels** for every `lossless` result, ≥ 98 % SSIM and
≥ 40 dB PSNR for every `near-lossless` one, byte-identical payloads for every Office archive.

---

## 3 · Raster engine (PNG · JPEG · WebP · GIF · BMP)

### 3.1 Lossless

* **PNG**: chunk-level parse; `tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME`, `oFFs`, `pCAL`, `sCAL`,
  `sTER`, `dSIG` and private ancillary chunks are dropped (critical chunks and colour
  information — `PLTE`, `tRNS`, `gAMA`, `cHRM`, `sRGB`, `iCCP`, `sBIT`, `bKGD`, `pHYs`,
  APNG control chunks — are kept). Scanlines are un-filtered and re-filtered with all six
  strategies (adaptive "minimum sum of absolute differences", Paeth, Up, Sub, Average, None);
  each candidate is deflated and the smallest wins. APNG and interlaced files are only
  re-deflated, never re-filtered.
* **JPEG**: `APP3…APP13`, `COM` and any trailing garbage after `EOI` are removed; `SOI`,
  frame/quantisation/Huffman tables, `DRI`, `SOS` and the entropy coded data are copied **byte
  for byte** → the decoded image is bit-identical. `APP1`/`APP2` are kept whenever they carry
  something the renderer reads — **Exif** (orientation, colour) and the **ICC profile** — and are
  dropped only when the payload proves it is XMP or an MPF multi-picture index. Stripping those
  without looking (as 3.0 did) silently rotated and colour-shifted photos inside Office files.
* Animated GIFs, CMYK JPEGs and anything without a safe path are returned untouched.

### 3.2 Lossy ladder

Twelve rungs: `q 0.97 → 0.34`, resampling ceilings `∅ → 3200 → 2600 → 2200 → 1800 → 1500 → 1280 → 1050 → 900 px`
on the long edge (never upscaling). **Extreme** appends three more — `q0.30/800`, `q0.24/700`,
`q0.18/640` — and switches WebP on by default. At each rung the engine encodes candidates (PNG
for transparent sources, JPEG, WebP if allowed), sorts them smallest-first, and takes the first
that clears the **fidelity floor** (SSIM ≥ 0.68 on Extreme, 0.80 elsewhere); only if the whole
rung is under the floor does it keep the smallest encode and stop climbing. It then:

* stops at the **first rung that meets the target** (gentlest possible setting), or
* keeps the last rung as the best available, and
* if even the strongest rung is not smaller than the lossless result, keeps the lossless file
  and reports *"no pixel-safe path to the target — kept the untouched encode"*.

---

### 3.3 Enhance & upscale (the image tools)

* **Lanczos-3** separable resampler: precomputed weights per output column/row, support scaled by
  the ratio (so downscaling averages instead of sampling), weight-normalised with a
  nearest-neighbour fallback for degenerate cases. Runs on `ImageData`, so it behaves the same on
  `<canvas>` and `OffscreenCanvas`.
* **Unsharp mask**: 3×3 Gaussian approximation → `out = src + amount·(src − blur)` with a
  threshold, applied to RGB only.
* **Auto-levels**: per-channel histogram, 0.5 % clipped at both ends, LUT applied; a channel whose
  range is under 24 levels is left alone (that is a flat or intentionally tinted image, not a
  bad exposure). Then contrast (around 128) and saturation (around luminance) are applied.

---

## 3b · PDF editing (the ten document tools)

Every operation is a structural rewrite on top of `PDFEngine.Doc`, never a raster round-trip:

```
parse (tolerant scanner) → import objects into a fresh document (renumbered refs)
      → rebuild the page tree (/Kids, /Count, /Parent) → serialise → re-parse to verify
```

| Operation | How |
|---|---|
| merge | pages of N documents imported into one page tree, order preserved |
| split | one document per page, packed with the ZIP writer |
| extract / delete | page selection by index list (`1-3,7` parsed to indices) |
| rotate | `/Rotate = (old + deg) mod 360`, inherited rotations honoured |
| reverse / interleave | page list reordered (or alternating from two documents) before the page tree is written |
| crop margins | a real `/CropBox` inset per page, refused if it would leave less than 24 pt |
| page numbers / watermark | a real content stream appended to `/Contents` per page: `q /GS0 gs BT /F1 … Tf … Tm (text) Tj ET Q`, `/F1` added to the page `/Font` resources, opacity through an `/ExtGState` |
| metadata | a `/Info` dictionary, referenced from the trailer |
| images → PDF | JPEG payloads embedded verbatim with `/DCTDecode`, page box + centred transform |
| extract text | content-stream tokeniser keeps `Tj`/`TJ`/`'`/`"` strings and inserts newlines on `Td`/`TD`/`T*`/`ET` |
| extract images | every `/Subtype /Image` with a `DCTDecode` tail, pre-filters undone |

The gate validates each of these with `pdfinfo` **and** `qpdf --check` (0 warnings).

---

## 4 · Office / archive containers (DOCX · PPTX · XLSX · EPUB · ODT · ZIP)

The archive is parsed from its central directory (local-header data offsets, stored vs.
deflated, CRC-verified). Every entry is decoded, optionally optimised and re-packed:

* **Re-deflate** at maximum level; stored when deflate does not help.
* **Embedded rasters**: `word/media/*`, `ppt/media/*`, `xl/media/*`, `docProps/thumbnail.*`
  get the lossless treatment always, and the preset ladder for JPEG when `target ≥ 25 %`
  (`q 0.85 / 0.75 / 0.62 / 0.45` and long edge 2200/1600 px at the higher presets).
* XML parts are left semantically identical — only the deflate pass changes; the package
  stays schema-valid.
* ZIP64, encrypted or unknown-codec archives are copied untouched.

Verified: unzipped payloads are byte-identical to the source for all non-raster entries, CRCs
valid, and `python-docx` / `python-pptx` / `openpyxl` reopen every output.

---

## 5 · Text and markup

`JSON` → re-serialised minified. `SVG` → comments, XML prolog/doctype and redundant
whitespace removed (attributes untouched). `HTML` → comments and inter-tag whitespace
collapsed. `CSS` → comments and whitespace removed around delimiters. `JS` → a
string/regex/comment-aware whitespace and comment stripper (never rewrites tokens —
deliberately *not* a minifier-mangler). `XML` → comment and whitespace normalisation.
`TXT/CSV/MD` → trailing-space and blank-line normalisation.

If the minified text does not beat the original by 0.5 %, the original is kept. When the
preset target demands more than the minifier delivers, the output is wrapped in **gzip**
(`name.ext.gz`), produced with `CompressionStream('gzip')`.

---

## 6 · Quality and safety gates

| Gate | Rule | Evidence |
|---|---|---|
| Lossless claim | output must decode to the same pixels | `pdftoppm` raster comparison at 40–60 dpi, 0 differing channels, on every lossless artifact in the gate; PNG re-filtering is mathematically invertible |
| PDF validity | engine re-parse: catalog present, page count ≥ input | every build; failures fall back to the original |
| PDF conformance | independent `qpdf --check` | 0 warnings across 19 fixtures incl. arxiv, IRS 1040, object-stream, linearised and QDF files |
| Office validity | CRC + payload equality, reopen with python-docx/pptx/openpyxl | all fixtures pass |
| Lossy audit | PSNR and global SSIM printed per file | see `benchmark.csv` |
| Never bigger | rebuild used only if strictly smaller | all presets |
| Refusals | encrypted / broken / ZIP64 / animated GIF → untouched + reason | edge-case suite |

---

## 6b · What "lossless / invisible-only / re-encoded" means

Every result carries its true fidelity, and the UI shows it:

| Label | Meaning | How it is proven |
|---|---|---|
| **lossless** | only the container changed | pixel-identical raster comparison (PDF/PNG/JPEG), byte-identical Office payloads |
| **near-lossless** | Lossless preset missed 5 % bit-exactly and took one gentle high-quality re-encode (no resampling) | SSIM ≥ 98 % **and** PSNR ≥ 40 dB against the original, measured independently; score printed in the UI |
| **invisible-only** | the invisible background text layer, its fonts, annotations or bookmarks were removed; the visible page is untouched | raster comparison still identical, text extraction (`pdftotext`) returns nothing |
| **re-encoded** | raster data was recompressed or resampled | PSNR + global SSIM measured against the original and printed per file |

## 6c · Threading model

```
main thread ── Pool (1–4 workers)  ──┐
   │  queue → lanes (parallel)       │  worker: libs + engine + worker.boot
   │                                 │  messages: probe | compress | needmain | ready
   └─ fallback lane (main thread) ───┘
```

* `build.js` embeds the worker payload as `<script type="text/plain" id="worker-src">`; the page
  turns that text into a Blob URL — one artifact, no second file, works from `file://`.
* A worker that answers `needmain` (no `OffscreenCanvas`), or that cannot spawn at all, hands the
  file to a main-thread lane, so a result is always produced.
* **Stop** terminates every worker and aborts the queue; nothing is left running.
* Measured on the 16-file corpus: main thread → pool **1.3–1.4×** (10.8 s → 8.4 s idle, 19.3 s →
  14.1 s on a loaded runner); Extreme **1.5–1.6×**. Scaling is per-file, so a single huge PDF gains little — that is expected.

---

## 7 · Known limits

* **Encrypted PDFs** cannot be rewritten (content is ciphered); remove the password first.
* **JPX/JPEG-2000** images and **16-bit** samples are not re-encoded — only re-deflated.
* **Colour-managed (ICC) images** keep their profile; we do not convert colour spaces.
* **Linearisation** ("fast web view") is not preserved — the rebuild is a normal
  cross-reference file.
* **Incremental updates** are collapsed into a single clean revision (usually a big win).
* **ZIP64** (>4 GB) archives are passed through.
* **Extreme** cannot invent detail: a 72-dpi PDF page image below ~600 px is unreadable, so the
  PDF ladder explicitly stops at `q0.30 / 900 px` (no `q0.24 / q0.18` rungs for PDFs).
* PDF work inside one file is inherently sequential (parse → transform → serialise); the worker
  pool parallelises *across* files, not inside one. A 2 MB / 6 000-object arXiv PDF optimises in
  ~1.14 s (parse 0.35 s, streams 0.51 s), a 1 MB scan-PDF under 0.2 s.
* Devices with a hard 16 Mpx canvas limit are handled by resizing at decode time
  (`createImageBitmap(blob, { resizeWidth })`) instead of allocating a giant bitmap.

---

## 8b · Tool coverage

`qa/tools_test.js` drives the shipped UI: it opens every one of the 103 cards, feeds a fixture,
presses **Run**, saves the artefact and validates it independently —

* PDFs → `pdfinfo` page count **and** `qpdf --check` (must be 0 warnings)
* images → Pillow decode, sane dimensions
* archives → every CRC checked with `zipfile`
* text tools → exact expected output (`b64`, `sha256`, slug, case, sort, dedupe, markdown, …)

Latest: **112/112** — 103 tools + the hub + 8 pure-function checks (CRLF bytes, base32
round-trip, RFC 6238 TOTP vector, /31 subnet, caesar wrap-around, YAML nesting…), 0 console errors.

---

## 8 · Test corpus used for this build

* Synthetic: 12-page text PDF, 6-page photo PDF, 3-page scanned PDF (single 2480×3508 JPEG
  per page), diagram PDF, the same documents re-muxed by `qpdf` (object streams, linearised,
  QDF), truncated PDF, 256-bit AES encrypted PDF, LZW-encoded PDF.
* Desktop Office: `report.docx` (122 paragraphs + photo), `deck.pptx` (7 slides + photo),
  `data.xlsx` (48 000 cells). Plus `data.json`, `icon.svg`, `notes.txt`, animated GIF.
* Real world: `arxiv.org` research paper (2.11 MB, vector art, SMask images, object
  streams), `css4.pub` textbook sample, IRS 1040 form (AcroForm), W3C `dummy.pdf`.

Every output was re-opened with an independent tool (`qpdf`, `pdfinfo`, `pdftoppm`,
`pdfimages`, `pypdf`, `Pillow`, `python-docx`, `python-pptx`, `openpyxl`).
