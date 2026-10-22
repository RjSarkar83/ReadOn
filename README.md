# ReadOn · Tools

**108 working tools in one static page.** The compressor is still the centre of it — a
production-grade, **100 % client-side shrinker** for PDF, JPG, PNG, WebP, GIF, BMP, SVG, DOCX,
PPTX, XLSX, EPUB/ODT, ZIP, JSON, HTML, CSS, JS, XML, TXT/CSV — and around it now sits a
[ilovepdf](https://www.ilovepdf.com/)-style tool grid in ReadOn's own material language:
merge/split/rotate/number/watermark PDFs, **enhance** and **upscale** images, convert, favicon
packs, DOCX/PPTX→text, XLSX↔CSV, PDF merging/splitting, and 64 text, code, crypto and
calculator utilities.

Six size targets — **10 % · 25 % · 50 % · 75 % · 90 % · Extreme** — plus **Lossless**, which is
bit-exact *and* now actually shrinks text-heavy files (font table trimming + exact content-stream
compaction, typically 5–23 %). Nothing is uploaded: every byte is processed inside the browser tab. It runs on phones,
tablets and desktops, in old Safari and in stripped-down webviews, and it is installable / works
offline (PWA).

```
├── index.html                     ← ReadOn home page (+ one Compress button)
├── compress/
│   ├── index.html                 ← the whole app: one self-contained file, no CDN, no build step
│   ├── build.js                   ← optional: re-bundles src/ → index.html (page + inline worker)
│   ├── manifest.webmanifest       ← PWA manifest
│   ├── icon-192.png / icon-512.png
│   └── src/
│       ├── index.template.html
│       ├── app.css                ← ReadOn tokens, dark / light / sepia
│       ├── app.js                 ← queue, presets, compare slider, zip export, worker pool
│       ├── engine.js              ← preset ladder, format dispatch, fidelity gates
│       ├── tools.js               ← the 60-tool registry (every tool is real code)
│       ├── worker.boot.js         ← Web Worker entry (same engine, background thread)
│       └── lib/
│           ├── codec-js.js        ← pure-JS DEFLATE/INFLATE + gzip (fallback when no native streams)
│           ├── util.js            ← bytes, CRC32, Compression Streams, format sniffing
│           ├── filters.js         ← PDF codecs: Flate+predictors, LZW, AHx, A85, RunLength
│           ├── pdf.js             ← PDF object engine + two writers (xref & object streams)
│           ├── pdfedit.js         ← merge · split · extract · rotate · stamp · extract text/JPEG
│           ├── font.js            ← TrueType/OpenType table trimmer (hinting, device metrics)
│           ├── imageops.js        ← Lanczos-3, unsharp, auto-levels, rotate, watermark, ICO
│           ├── textops.js         ← JSON/CSV/base64/hash/markdown/… primitives
│           ├── png.js             ← lossless PNG re-compressor
│           ├── jpeg.js            ← lossless JPEG re-container
│           ├── zip.js             ← ZIP/Office reader + writer
│           └── imaging.js         ← raster decode/resample/encode + PSNR/SSIM
├── pwa/sw.js                      ← service worker (cache-first shell, offline)
├── qa/                            ← automated quality gate (see §5)
├── screenshots/                   ← the shipped build, dark / light / phone / compare
├── benchmark.csv                  ← 72 measured runs
├── COMPRESSION.md                 ← engineering specification
└── CHANGELOG.md                   ← what was fixed in this build
```

---

## 1 · Deploy on GitHub Pages

Everything in this zip is already in the layout GitHub Pages expects — **`index.html` sits at the
repo root and opens the compressor directly**. Nothing to click, nothing to hunt for.

```
/  (repo root)
├── index.html              ← the compressor (copy of compress/index.html, byte-identical)
├── compress/               ← the same app, so /compress/ also works
├── sw.js                   ← offline shell (root scope)
├── manifest.webmanifest    ← installable PWA (start_url ./index.html)
├── icon-192.png, icon-512.png
├── readon-home.html        ← your original ReadOn home page, untouched
├── .nojekyll               ← required, or Pages skips files starting with "_"
├── README.md · COMPRESSION.md · CHANGELOG.md · TOOLS.md · benchmark.csv
└── qa/                     ← the 10-stage test suite (not needed to run the app)
```

1. Unzip into the repo, commit, push.
2. Settings → Pages → *Deploy from a branch* → `main` / `/ (root)`.
3. Live at **`https://<user>.github.io/ReadOn/`** — and **`/ReadOn/compress/`** serves the same build.

**Keeping your old home page as the front door?** Rename it back:

```bash
mv readon-home.html index.html      # ReadOn home page at /
# the compressor then lives at /compress/ only — both files still work
```

`make_zip.py` re-syncs `index.html`, `sw.js`, the manifest and the icons from `compress/` on every
packaging run, so the root copy can never drift from the tested build.

### The three things that used to break the deploy

| Symptom | Cause | Fixed |
|---|---|---|
| *"compress nahi ho raha"* — page loads, nothing happens | an old landing-page `index.html` at the root, with the app buried in `/compress/` | root `index.html` **is** the app; `qa/root_test.js` now proves it end to end |
| Save button does nothing | downloads are blocked inside a sandboxed preview frame / iOS in-app browser | an explicit banner detects the frame and offers *Open in its own tab*; iOS falls back to opening the blob in a new tab; every save shows a toast |
| App works online, dies offline | the service worker was registered at `../sw.js` only, so a root install had no worker | `sw.js` is scope-relative and ships at the root **and** in `compress/`; `qa/pwa_test.js` verifies both |

## 2 · What the presets really do

| Preset | Target | What the engine will trade |
|---|---|---|
| **Lossless** | **≥5 %** | Bit-exact first: font hinting/device tables trimmed, **exact** content-stream compaction, lossless re-pack of Flate images, metadata, dead objects, duplicate streams, better Deflate/PNG predictors, JPEG re-container, Office re-pack. If that still misses 5 %, one *near-lossless* re-encode is allowed (SSIM ≥ 98 %, PSNR ≥ 40 dB, no resampling) and labelled as such — switch **Lossless stays bit-exact** on to forbid it |
| **10 %** | −10 % | above + very high quality raster (`q97–q95`, no resampling) |
| **25 %** | −25 % | above + PDF background text layer & its fonts, `q94–q90`, JPEG inside Office |
| **50 %** | −50 % | above + annotations/attachments, `q86–q76`, long edge ≤ 2600 px |
| **75 %** | −75 % | above + bookmarks/structure tree, `q70–q60`, long edge ≤ 1800 px |
| **90 %** | −90 % | everything, `q52–q34`, long edge ≤ 1050 px |
| **Extreme** | −95 % | everything + WebP preference, `q30–q18`, long edge ≤ 800 px, SSIM floor 0.68 |

**Extreme** is the "web / social" rung: it keeps climbing past 90 % — WebP is tried first, the
long edge is capped at 800 px, and a hard **SSIM floor of 0.68** stops the ladder before the
picture falls apart (a noisy photo ends up ≈ −93 % at SSIM 73 %, not a smear at 55 %). PDFs stop
at `q0.30 / 900 px` because 72-dpi page images below ~600 px are unreadable.

Presets are **targets, not instructions**: every file starts with the lossless pass and the
engine climbs one quality ladder, stopping at the *first* rung that lands under your target. If
the target cannot be reached without visible damage, it says so and keeps the better file.

Every result is labelled with its real fidelity:

* **lossless** — nothing changed but the container (pixels byte-identical)
* **near-lossless** — Lossless preset could not reach 5 % bit-exactly, so it took a *gentle* re-encode that stayed above **98 % SSIM / 40 dB PSNR** with **no resampling**; the measured score is printed next to the file
* **invisible-only** — only non-visual content was removed (background text layer, annotations, bookmarks)
* **re-encoded** — raster data was recompressed; PSNR / SSIM are shown

### Measured (see `benchmark.csv`, 72 runs)

| File | Lossless | 10 % | 25 % | 50 % | 75 % | 90 % | Extreme |
|---|---|---|---|---|---|---|---|
| `text.pdf` (12 pp text) | **17.5 %** | 17.5 % | 56 %\* | 56 %\* | 56 %\* | 56 %\* | 56 %\* |
| `photos.pdf` (6 plates) | **20.0 %** | 20.0 % | 39 %† | 56 %† | 76 %† | 92 %† | 93 %† |
| `scan.pdf` (3 scanned pp) | **20.0 %** | 20.0 % | 41 %† | 64 %† | 77 %† | 90 %† | 96 %† |
| `diagram.pdf` | **17.6 %** | 17.6 % | 18 %\* | 18 %\* | 18 %\* | 18 %\* | 18 %\* |
| `photo1.jpg` (392 KB) | **18.5 %**§ | 18.5 %§ | 25 %† | 56 %† | 76 %† | 92 %† | 95 %† |
| `noise.png` (2.4 MB) | **14.3 %** | 14.3 % | 65 %† | 65 %† | 77 %† | 92 %† | 93 %† |
| `diagram.png` | 2.0 % | 2.0 % | 2 % | 2 % | 2 % | 2 % | 58 %† |
| `report.docx` (364 KB) | 0.0 % | 0.0 % | 53 %† | 64 %† | 70 %† | 74 %† | 82 %† |
| `deck.pptx` (236 KB) | 0.0 % | 0.0 % | 49 %† | 60 %† | 65 %† | 69 %† |

\* invisible-only · † re-encoded (JPEG quality shown in the app) · § near-lossless at the Lossless
preset (PSNR 52.8 dB, SSIM 99.9 %, no resampling). The Lossless preset now clears 5 % on every PDF
and photo in the corpus; the honest remaining gaps are already-optimal containers — `diagram.png`
(2 %, nothing left to remove), and DOCX/PPTX/XLSX (0 %, the ZIP members are already Deflate-tight). Photo quality on
`photo1.jpg`: 10 % → PSNR 45.0 dB, 25 % → 43.7 dB, 50 % → 40.5 dB, 75 % → 36.6 dB, 90 % → 31.0 dB.
Extreme on the 16-file corpus: **−74.1 % total**, worst case `noise.png` **SSIM 72.8 %** (floor is
0.68), `photo1.jpg` → WebP 900×675 at **SSIM 99.7 %**, `photos.pdf` −93.3 %, `scan.pdf` −96.4 %, `report.docx` −82 %.

Real-world PDFs: arXiv paper (2.11 MB, 15 pp, vector + figures) **−23.2 % lossless** / −32.8 % at
50 %; IRS 1040 form **−15.8 % lossless** / −23.5 % at 50 %; a `qpdf` textbook sample **−6.9 %
lossless**. Every one of those is out of the box at the Lossless preset now, all pixel-identical
(verified page by page with poppler at 110 dpi, `qa/lossless_verify.py`, 20/20 outputs).

Typical speed: a 2 MB, 6 000-object PDF ≈ 1.1–4 s; a 1 MB PDF under 1 s; photos < 1 s; the
2.4 MB pure-noise PNG at Extreme is the worst case at ≈ 5 s. The UI never blocks: work runs in a
pool of Web Workers, the queue advances in parallel lanes, and **Stop** is always live.

---

## 2 · Brand

The ReadOn mark (two paper leaves, a gold ribbon and a red down-arrow) lives in
**`assets/readon-mark.svg`**. `node assets/make_icons.js` renders every size from it —
`favicon.svg`, `favicon-16/32.png`, `apple-touch-icon.png`, `icon-192/512.png`,
`icon-512-maskable.png` and the social card — and syncs the copies used by `/`, `/compress/` and
`/pwa/`, so the icon in the tab, in the header and on the home screen is always the same artwork.

## 2a · Two apps in one repo

| Page | What it is |
|---|---|
| `reader.html` | the **ReadOn reader** — PDF, Word and PowerPoint opened as a book, read aloud in 22 languages, translated and analysed. Its engines (pdf.js, mammoth, JSZip, jsPDF) are **bundled in `vendor/`**, so it works with the CDN blocked or fully offline; the CDN is only a fallback. |
| `index.html` (`compress/`) | the **108 tools** + the 7-level compressor. |

Both link to each other with relative paths, so `/Reader/` and `/ReadOn/` both work and nothing points
at another person's site. `qa/ux_test.js` clicks the Reader link from both locations, opens a real PDF
in it and comes back.

## 2b · The tool grid (108 tools — see `TOOLS.md` for the per-tool proof)

Everything below runs on the same engine in the same tab. No upload, no API, no "coming soon".

| Group | Count | Tools |
|---|---|---|
| **Popular** | 1 | Compress (7 targets) |
| **Image** | 16 | Enhance · Upscale (Lanczos-3 ×2/×3/×4) · Resize · Crop (ratio / percent / trim) · Frame & pad · Convert · Black & white · Rotate & flip · Watermark (single/tiled) · Favicon pack (16→512 px + real .ico) · Compare two images (difference map) · Colour palette · Remove metadata · Image → PDF · Image → Base64 (data URI) · SVG → PNG |
| **PDF** | 17 | Merge · Split · Extract pages (`1-3,7`) · Delete pages · Reverse page order · Rotate · Crop margins (`/CropBox`) · Interleave two PDFs · Page numbers · Watermark · Metadata · PDF → text · PDF → Word (real .docx) · Repair PDF (rebuild xref) · Extract PDF images · **Unlock PDF** (all 5 encryption schemes) · **Protect PDF** (AES-256, R6) |
| **Documents** | 10 | DOCX → text · DOCX → HTML · PPTX → text · XLSX → CSV · CSV → XLSX (real workbook) · Unpack archive · Create ZIP · **Text → PDF** · **CSV → PDF** · **Word → PDF** |
| **Text & code** | 64 | JSON format/minify/→CSV/→YAML/keys · CSV → JSON/TSV, pick columns · Minify CSS/JS/HTML/SVG/XML · Markdown → HTML · HTML → text · Base64 · Base32 · URL · hex · binary · SHA-256/512 · UUID · JWT decoder · TOTP (RFC 6238) · Word counter · Word frequency · Change case · Sort lines/words · Dedupe · Join lines · Find & replace · Extract e-mails/URLs/numbers/IPs · Clean whitespace · Slugify · Lorem · Timestamp · Date difference · Age · Colour · Contrast (WCAG) · Unit converter · Percentage · Loan EMI · BMI & BMR · Number bases · Roman numerals · IPv4 subnet · Diff two texts · Line endings · Tabs ↔ spaces · Morse · NATO · Caesar · ROT13/ROT47 · Reverse · Un-accent · Strip invisible characters · Password generator |

**Enhance** is a real image pipeline: robust auto-levels (0.5 % clipped) → contrast →
saturation → unsharp mask, all per-channel on the actual pixels. **Upscale** is a separable
Lanczos-3 resampler with an anti-ringing normaliser plus optional sharpening — not a canvas
`drawImage` stretch. Every image tool works in the worker-free main thread path as well, so a
phone without `OffscreenCanvas` gets the same output.

**PDF editing** is structural, never a raster round-trip: pages are re-parented into a fresh page
tree, objects are imported with renamed references, and the result is re-parsed and checked with
`qpdf --check` in the gate (0 warnings on every fixture).

---

## 3 · Guarantees

* **Nothing leaves the tab** — no network calls at runtime, no external fonts, no telemetry.
* **Lossless means verified** — and lossless is now *substantial*: embedded TrueType/OpenType fonts
  are trimmed of hinting programs, device metrics, bitmap strikes and signatures (`glyf`/`loca`/
  `cmap`/`hmtx` untouched), and content streams are compacted **exactly** (`000.500000` → `.5`).
  Measured: arXiv −23.2 %, IRS 1040 −15.8 %, textbook −6.9 %, `text.pdf` −17.5 %.
  In the automated gate every lossless PDF is rasterised
  (poppler) and compared channel-by-channel with the source; PNG/JPEG outputs are compared
  pixel-by-pixel; Office payloads are compared byte-by-byte.
* **Every rebuilt PDF is re-parsed by the engine** before it is offered (catalog present, page
  count unchanged), and independently by `qpdf --check` — 0 warnings on all fixtures.
* **Lossy results are audited** (PSNR + global SSIM on the row and in the compare view).
* **Transparency is never destroyed** — alpha images are never flattened to JPEG.
* **Never bigger** — if the rebuild would grow a file, the original bytes are returned.
* **No hard requirements** — no native `CompressionStream`? A built-in JS DEFLATE takes over.
  No `Worker`? The same engine runs on the main thread. No `OffscreenCanvas`? Raster work is
  handed back to the page. No Canvas at all? Bytes are returned untouched, never an error.
* Encrypted PDFs, truncated PDFs, ZIP64 archives, animated GIFs, HEIC/TIFF are detected and
  passed through untouched with a plain-language reason.

---

## 4 · UI

Same material language as ReadOn: Montserrat, charcoal `#373A3E` / light / sepia, `#D75A5A`
accent, hairline borders, 8 pt uppercase micro-labels.

* Drag & drop, click-to-browse, ⌘/Ctrl + V paste, ⌘/Ctrl + O — unlimited batch.
* Live queue with per-file badge, PSNR · SSIM, and exactly what was done in plain English.
* **Compare** slider (before/after wipe) for any re-encoded raster; **Preview** for PDFs.
* **Download all (.zip)** — packed in the browser by the included ZIP writer.
* *Engineering controls*: disable text-layer removal, annotations, bookmarks/attachments,
  allow WebP, set a pixel cap. Preset, options and theme persist in `localStorage`.

---

## 5 · Quality gate

```bash
./qa/run.sh            # everything  (≈ 20 min, 7 presets, 10 stages)
./qa/run.sh --quick    # one preset  (≈ 2 min)
```

| Step | What it does |
|---|---|
| `qa/make_fixtures.py` | regenerates the corpus: PDFs (text/photo/scan/vector), qpdf variants (object streams, linearised, QDF), encrypted + truncated PDFs, JPEG/PNG/GIF, DOCX/PPTX/XLSX, JSON/SVG/HTML/CSS/JS/TXT |
| `qa/pdf_engine_test.js` | 29 engine-level checks (parse, text strip, refusals, PNG/JPEG/ZIP round-trips, JS-codec DEFLATE/gzip round-trips) |
| `qa/browser_test.js` | drives the shipped app in Chromium: 16 files × 7 presets (incl. Extreme), downloads every artifact, validates text formats in-page |
| `qa/ui_test.js` | 8 interaction/race checks (mid-run drops, stale re-run, clear, theme, options) |
| `qa/compat_test.js` | 6 device/capability profiles: native, no `CompressionStream`, no `Worker`, neither, no `OffscreenCanvas`, iPhone 13 @ Extreme — every file must finish, zero JS errors |
| `qa/pwa_test.js` | 10 install/offline checks: service worker activates, shell cached, manifest parses, app reloads with the network cut |
| `qa/root_test.js` | 10 GitHub-Pages layout checks: `/` serves the compressor, root-scope worker, 108 cards, a real compress **and a real download** from the root URL, zero 404s |
| `qa/validate.py` | independent verification: `qpdf --check`, page counts, pixel-identity for lossless, zip CRCs, payload equality |
| `qa/lossless_check.js` + `qa/lossless_verify.py` | Lossless-proof gate: runs the real preset on 20 files, re-renders every output with poppler (PDF @110 dpi) / Pillow and demands **0 differing pixels**, SSIM ≥ 98 % + PSNR ≥ 40 dB for `near-lossless`, byte-identical Office payloads |
| `qa/bench.js` | rewrites `benchmark.csv` |
| `qa/perf_test.js` | times 16 files on the main thread vs. the worker pool (speed proof) |
| `qa/ux_test.js` | 16 friendliness checks: no dead ends, plain-language errors, retry, wrong-type handling, search, option reset, and Pixel 5 / iPhone 12 layout, tap-target and sticky-Run behaviour |
| `qa/tools_test.js` | clicks **all 108 tools** like a user, saves every artefact and validates it independently: `pdfinfo` + `qpdf --check` (0 warnings) for PDFs, Pillow for images, zipfile CRCs for archives, exact output for text tools |

Latest run: **29/29 engine · 109/109 tool checks · 8/8 UI · 6/6 device profiles · 10/10 PWA · 10/10 root layout · 20/20 lossless proof · 135/135 artifact validations · 0 console errors** (10 stages).

---

## 6 · Rebuilding the bundle

`compress/index.html` is the deliverable; `compress/src/` is the readable source.

```bash
cd compress && node build.js     # ≈ 278 KB, single file, no dependencies
```

`build.js` emits **one** HTML file containing two copies of the engine: the page (with UI) and an
inert `<script type="text/plain" id="worker-src">` block. At runtime the worker block is turned
into a Blob URL and spawned 1–4 times (by `navigator.hardwareConcurrency` / `deviceMemory`), so
files compress in parallel with no extra network request and no separate worker file.

---

## 6b · Adding a tool

A tool is one object in `compress/src/tools.js` — the grid, the options UI, the run button, the
save buttons and the zip-all button come for free:

```js
add({
  id: 'grayscale', group: 'Image', icon: 'i-mono', kind: 'files',
  title: 'Black & white', blurb: 'Perceptually weighted luminance',
  accept: 'image/*', multiple: true,
  options: [{ key: 'format', label: 'Output', type: 'select',
              values: [['jpeg','JPEG'],['png','PNG']], def: 'jpeg' }],
  async run(files, o) {
    const out = [];
    for (const f of files) {
      const img = ImageOps.grayscale(await toImageData(f));
      out.push({ name: f.name, bytes: await ImageOps.encode(img, 'image/jpeg', 0.92) });
    }
    return { files: out };
  }
});
```

`kind: 'files'` gives you the drop zone; `kind: 'text'` gives you the two-pane input/output
editor. A tool id that matches a fixture in `qa/tools_test.js` is validated automatically. Return `{ files: [...] }` or `{ text: '…' }` — everything else is handled.

---

## 7 · All devices, all speeds

| | What happens |
|---|---|
| **Codec** | Native `CompressionStream` when available (`Util.HAS_NATIVE`), else the built-in JS LZ77 + Huffman DEFLATE/INFLATE in `codec-js.js` — same byte format, ~40 % slower, zero dependencies |
| **Threads** | 1–4 Web Workers (`POOL_SIZE` from cores + memory, capped on mobile / `saveData`); any file can be routed back to the main thread (`NO_WORKER`, `NO_CANVAS`, per-file fallback) |
| **Canvas** | `OffscreenCanvas` in the worker; if absent, raster work is proxied to a main-thread canvas; images above 16 Mpx are handled by `createImageBitmap(blob, {resizeWidth})` so no giant intermediate bitmap is ever allocated |
| **Layout** | Safe-area insets (`viewport-fit=cover`), `@media (pointer: coarse)` enlarges every hit target, queue and compare slider are touch-draggable |
| **Offline / install** | `manifest.webmanifest` + service worker → add to home screen, works with no network |
| **Measured speed** | 16 files: main thread → worker pool **1.3–1.4×** faster (≈19.3 s → 14.1 s on a loaded CI box, ≈10.8 s → 8.4 s idle); Extreme **1.5–1.6×**. PDF stream re-encode is parallel (`mapLimit 12`), sub-900 B streams are skipped on big documents, and a 2 MB arXiv PDF optimises in 1.14 s (parse 0.35 s) |
