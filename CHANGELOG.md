# Changelog — ArtViSiON · Tools

## 6.0.0 — ArtViSiON: soft pastel theme, the real mark, and a simpler UI

Asked for: *"all simple and easy user friendly UI/UX design update and soft and pastel match colors
update for ArtViSiON theme and unnecessary unused file remove"*.

### 1 · The brand is ArtViSiON, and the mark is your artwork

* Every surface is renamed: page title, header lock-up, hub heading, reader, 404 pages, PWA manifest,
  operator strings inside the PDF/DOCX writers, the download names (`artvision-compressed.zip`) and the
  watermark default. Nothing says the old name any more.
* **The logo is `uploads/AV_Logo_001.png` — your file, byte for byte**, now at
  `assets/artvision-logo.png`. It is drawn in the header (inlined once, 6.7 KB, no extra request) and
  every icon — 192, 512, maskable, apple-touch, 32, 16, the favicon and the social card — is derived
  from that one file by `python3 assets/make_icons.py`. **Nothing was redrawn or recoloured.**
* The old vector mark (and its gradient symbol) is deleted from the page.

### 2 · Soft pastel palette, three calm themes

| token | before | after |
|---|---|---|
| accent | `#D75A5A` (hard red) | `#E08D7B` **soft coral** |
| light theme page | `#EEF0F2` (cool grey) | `#F8F4EF` **warm cream** |
| dark theme page | `#373A3E` (cold slate) | `#262220` **warm charcoal** |
| borders | cool greys | warm sand (`#EADFD3` / `#453E39`) |
| corners | 2 px | **12 px**, one consistent radius |
| shadows | hard black | soft warm, low-spread |

The full pastel family is now part of the theme (`--sage`, `--lilac`, `--sky`, `--butter`) for AI,
status and category accents, so nothing is ever a saturated red block. Sliders, chips, selects and the
drop-zone were re-drawn to match, and `color-scheme` is set per theme so native selects, scrollbars and
date pickers follow instead of fighting it.

### 3 · Simpler, friendlier UI/UX

* **Light is the default** (it was dark), and the order is now Light → Dark → Warm. Dark stays one tap
  away for anyone who prefers it — it is just no longer the first impression.
* The hub heading says what to do: **"Pick a tool"** instead of repeating the brand, with the honest
  one-liner *"108 tools · everything runs here · nothing is uploaded"*.
* Bigger tap targets, one 12 px radius everywhere, softer focus ring, more breathing room between
  cards, and the whole page keeps the pastel wash instead of a red glow.
* The reader (`reader.html`) is repainted with the same tokens — and a real bug was fixed there: it had
  **two** `[data-theme="light"]` blocks, so the light theme was silently the dark palette.

### 4 · Unused files removed

| removed | why |
|---|---|
| `pwa/` (9 files) | a shadow copy of the root icons/manifest/sw that nothing referenced; the root files are what the app and GitHub Pages actually serve |
| `assets/readon-mark.svg`, `assets/readon-mark-original.png` | the previous brand mark, no longer drawn anywhere |
| `assets/make_icons.js` | it rendered the old vector mark; replaced by `assets/make_icons.py`, which derives every icon from your artwork |
| `uploads/` | the upload is now the shipped asset (`assets/artvision-logo.png`), not a duplicate |
| studio screenshots & the leftover QA output dirs | already gone in 5.2.0 |

The archive is now **103 members · 3.8 MB**, page bundle **722 KB**.

Proof: the whole gate was re-run on this build — engine 29/29 · tools 121/121 · UI 8/8 · UX 21/21 ·
devices 6/6 · PWA 10/10 · root layout 10/10 · image 24/24 · lossless 20/20 · validations 135/135 ·
**ALL CHECKS PASSED**. Screenshots regenerated in the new palette.

## 5.2.0 — Design studio removed; the compressor carries the release

Asked for plainly: *"remove Design studio"*. It is out — not hidden behind a flag, out: the module,
the screen, its styles, its icons, its two gates, its screenshots and every mention are gone, and the
build is back to the size it was before it existed (**730.6 KB**).

What that means, concretely:

* **108 tools again** — `Popular` is Compress once more; the hub renders **108 cards**, and
  `Tools.list.length` is 108 in the shipped build.
* `compress/src/studio.js` deleted; `build.js` no longer bundles it; the `#studio` route is gone from
  `app.js`; the screen, its seven SVG icons and its CSS block are gone from the template and stylesheet.
* `qa/studio_test.js` and `qa/studio_perf_test.js` deleted, `qa/run.sh` no longer runs them,
  `make_zip.py` no longer ships them, `qa/shots.js` no longer takes their screenshots.
* `TOOLS.md`, `README.md` and the page metadata are back to **108** everywhere.

**Nothing else was touched.** The engine, the seven presets (Lossless → Extreme), the 108 tools, the
enhance/upscale pipeline, the Cancel button and live timer, the original-artwork logo, the offline
PWA, the layouts and the whole gate are exactly as they were in 4.3.0.

The round-5 work is kept in this changelog for the record (`5.1.0`, `5.0.0` below) — the code it
described is no longer in the tree.

## 5.1.0 — the studio, with no waiting in it

Reported: *"100 % workable and faster designing platform… designer ko kisi bhi kaam ke liye wait
na karna pade"*. So the Studio was put on a stopwatch and every place it made a designer wait was
removed. Nothing about the feature set changed — the same clicks, the same templates, the same
exports — but they now land inside a single frame.

### Measured before → after (same machine, same build, `qa/studio_perf_test.js`)

| Action | before | after |
|---|---|---|
| Open the Studio | 218 ms | **~170 ms** (panel chrome first, thumbnails fill in during idle) |
| Switch template (handler work) | ~108 ms | **5–10 ms** |
| Select a block | 63 ms | **≤ 12 ms** |
| Change a colour | 100 ms | **≤ 8 ms** |
| Add a block | 125 ms | **≤ 10 ms** |
| Duplicate a block | — | **≤ 8 ms** |
| Canvas size change | — | **≤ 6 ms** |
| Drag frame (renderer cost) | 17.7 ms mean, 50 ms worst | **0.10 ms mean, 0.3 ms worst** |
| Drag frame gap | mean 17.7 / max 50 ms | **median 16.7 ms** (one vsync), max 33 ms |
| 40-block poster, still dragging | — | **median 16.7 ms**, renderer 0.12 ms/frame |
| Full-size photo dragging | — | **median 16.7 ms**, renderer 0.18 ms/frame |
| Export PNG / JPG / PDF | 203 / 121 / 146 ms | 200–430 / 130–200 / 150–200 ms (2400 px long edge) |

### What was actually slow, and what fixed it

1. **Every click re-rendered the whole scene.** Text was re-measured word by word with
   `measureText` on every frame. Now: line breaking is memoised per block/style/width, and the
   finished scene is rendered **once** into an offscreen bitmap that is blitted when needed.
2. **Every pointer move during a drag was a full redraw.** Now the still scene is painted once
   (without the block being dragged) onto the bottom canvas, and the moving block is drawn on the
   overlay — state updates on every event, the canvas paints at most once per animation frame.
3. **Releasing the mouse re-rendered the scene.** It no longer does: the frame on screen is already
   correct, so only the selection box is redrawn (the cached still-layer is updated with a single
   blit).
4. **Every panel update rebuilt the whole panel**, which re-decoded the eight template thumbnails
   (≈90 ms of image decoding for a colour change). The panel is now built once, thumbnails are
   rendered during idle time, and later updates only toggle class names on the existing chips.
5. **The selection overlay was cleared in full for a 2-pixel box.** It now clears only the old and
   new selection rectangles.
6. **Typing re-rendered everything on every keystroke.** The block being edited is drawn live on the
   overlay, so a keystroke costs a single small draw.
7. **Autosave could land in the middle of a drag.** It is now skipped while a block is being dragged
   or typed, runs in `requestIdleCallback`, only writes when something actually changed, and a
   *saved* indicator in the top bar says so.
8. **A 12 MP photo was stored as a 6 MB base64 string**, which made every undo snapshot and every
   autosave heavy. Photos are now stored at a 1600 px long edge (visually identical at every canvas
   size the studio offers).
9. **Canvas backing stores were re-allocated on every template switch** and could reach 15 MP. They
   are only resized when the size really changes, and are capped at 3.2 MP (the export is still
   full resolution — a 2400 px long edge).

### Also new in this pass (nothing to wait for, nothing to hunt for)

* **Ctrl/⌘+S** exports a PNG immediately — no menu.
* **Undo / Redo buttons grey out** when there is nothing to undo or redo (they were always lit).
* A quiet **saved** indicator in the top bar confirms each autosave.

Proof: **`qa/studio_perf_test.js` — 27 checks**, and the functional gate grew to **31 checks**
(`qa/studio_test.js`), both green. The perf gate compares every frame against an idle-page control
sample taken on the same machine, so a stutter has to be the app's fault to fail.

## 5.0.0 — ReadOn Studio: a whole design, by clicking

Reported: *"Click click se puri designing ho jaye"*. So the app grew a second half: **ReadOn Studio**,
a design editor that opens on a finished template and never asks anyone to start from a blank page.

**The path is three clicks, and it is the same on a phone.**
`Design studio` card → click one of eight template thumbnails → `Export` → `PNG` / `JPG` / `PDF`.
Everything after that is optional: click a block to select it, drag it to move it, grab a corner to
resize it, double-click text to type, click a colour swatch to recolour it.

* **8 templates**, all real designs, all rendered live as thumbnails (no grey placeholders):
  Quote 1080², Sale poster 1240×1754, Story 1080×1920, Visiting card 1050×600, YouTube thumb 1280×720,
  Flyer A4, Certificate 1754×1240, and a starter-filled A4 for anything else.
* **Everything is clickable, nothing is hidden in a menu**: templates, heading / sub-line / body text,
  photo, box, circle, line, eight canvas sizes, 16 colours, gradient or flat background. Selecting a
  block reveals only the controls that make sense for it (font, size, bold, UPPER, alignment, colour
  for text; fill + corner radius for shapes; fill / fit / round corners for photos).
* **Snapping** to the canvas centre, edges and other blocks with pink guide lines, so it looks
  deliberate without any skill.
* **Undo / redo** (60 steps, `Ctrl+Z` / `Ctrl+Shift+Z`), **autosave** to `localStorage` — the design is
  still there after a reload or a closed tab.
* **Export** renders at print-worthy size (the long edge is 2400 px), fills white so JPG never goes
  black, and PDF export is one real page the exact shape of the design
  (`PDFEdit.imagesToPdf({ pageSize: 'image', margin: 0 })` → 1272.75 × 1800 pt for A4).

### Three real bugs found while building it (all fixed)

1. **Every autosave fired a junk download.** The local function `save()` (localStorage) and the
   download helper `save(bytes, name, mime)` had the same name, so the later declaration won:
   each autosave called the downloader with no arguments and the browser saved a 9-byte
   `undefined.txt`. Renamed to `persist()` — the comment in the source now warns about it.
2. **Half-painted canvas on every Retina screen.** `drawScene()` set the transform to `scale` and
   silently threw away the device-pixel-ratio scale that `draw()` had just applied, so the design
   filled only the top-left quarter at 2× DPI. Now `scale × dpr`.
3. **Nothing could be dragged.** The selection overlay canvas sat on top of the design canvas and
   swallowed every pointer event, so click-to-select worked but drag and resize never started.
   The overlay is now `pointer-events:none`.

### Layout, per device

Desktop/tablet: controls on the left (templates first, then Add, canvas size, colours, selected
block), canvas centred on the stage. Phone (≤ 900 px): the panel becomes a scrolling sheet under the
canvas with the templates in a swipeable row, the top bar collapses to icon buttons, and the canvas
always fits the screen — verified at 390 × 844 with **0 px** horizontal overflow and a tap-only
design exported successfully.

Proof: **`qa/studio_test.js` — 28 checks**, all clicks and drags on the shipped UI, every artifact
re-opened with Pillow / `pdfinfo`:

```
28/28 studio checks passed
PASS  all 8 templates render a real design  — 8/8
PASS  dragging moves the block              — 70,40 → 158,90
PASS  the corner handle resizes the block   — 864×302 → 977×378
PASS  PNG export downloads and is not blank — 1697×2400 · 568 KB · std 57.28
PASS  JPG is smaller than the PNG           — 157 KB < 568 KB
PASS  PDF export is one valid page          — 1 page · 147 KB
PASS  template → export → format is 3 clicks to a real file — 3 clicks · 1350×2400
PASS  390 px phone: a tap-only design exports — 2400×1371 · 104 KB
```

The tool inventory is now **109** (Popular: Compress + Design studio). `TOOLS.md` carries the
per-tool proof for the 108 file/text tools exactly as before — the Studio is not a file tool, it has
its own gate.

## 4.3.0 — the image engine, fixed at the root

Reported: *"tools thik se kaam nahi kar raha hai jaise upscale, enhance"*. Both complaints were real,
and both had the same root cause plus a second one hiding behind it.

### Bug 1 — any tool whose options were not filled in produced a black image

`Enhance` and `Upscale` read their settings straight from the DOM. Called without every option
(an automated run, a keyboard user who never touched a slider, a fallback path) the value was
`undefined`, `for (let i = 0; i < undefined; i++)` never executed, and the encoder was handed an
untouched buffer — a **1200×900 pure black JPEG**. Adds a guard in the registry itself: every
`run()` now starts from the option defaults declared with the tool, whatever the caller passes.
Proof: `qa/image_test.js` measures mean/σ/unique colours on every artefact and fails on a flat image.

### Bug 2 — the heavy work ran on the UI thread

A 12 MP photo froze the tab for **≈1 s per stage** (2.7 s of dead page for one Enhance). The tool
registry is now bundled into the worker payload and a new `cmd:'tool'` message runs *any* file tool
off-thread; the page only falls back to the main thread when a tool needs the DOM (SVG rasterising,
`<img>` decoding). Measured on a 12 MP photo: longest frozen frame **993 ms → 24 ms**.

### Enhance is now a real enhancement pipeline

denoise (edge-preserving, LUT-accelerated bilateral) → grey-world **auto white balance** →
auto levels → contrast/saturation → **two-scale detail recovery with clamped haloes**. Strength
selector (Light / Medium / Strong) replaces the three raw sliders, three toggles are exposed, and the
output note reports whether the frame clipped at all.

### Upscale is now a real resampler

`resampleSteps()` upsamples in **progressive ≤2× passes** (a single 4× Lanczos kernel rings on
edges), then recovers detail with the clamped unsharp mask. Default output is JPEG (a ×2 PNG of a
small photo was 5 MB); PNG/WebP remain available. Benchmarked against ground truth — a half-size
copy scaled back to the original scores **43.7 dB PSNR** — and the halo limiter never pushes a
12 MP frame over 5 % clipped pixels.

### UI

* Live **"working… 2.4 s"** counter and a **Cancel** button (stop is honest: nothing is changed).
* `done in 2.7 s` instead of a bare `done`, so speed is visible.
* The drop zone switches to *"Drop another file to replace"* once a file is picked.
* No duplicated note under the result row.

### Tests

`qa/image_test.js` — **24 checks** at pixel level through the real UI (worker path included):
dimensions per tool, non-blank output, true grey for grayscale, rotate/crop/frame/resize contracts,
watermark diff, EXIF stripping, a 12 MP budget, and a frame-gap budget so a freeze would fail the gate.

## 4.2.0 — the new ReadOn mark, everywhere

The supplied artwork is now the brand **exactly as delivered** — the original PNG, not a redraw
(the leaves stay black on light backgrounds, as in the file), with the alpha channel preserved:

| Where | What changed |
|---|---|
| App header | the old generic download glyph is replaced by the mark (`#i-logo` in the SVG sprite), 36 × 26 px, leaves inherit the theme text colour so it reads on dark *and* light |
| Reader landing | same mark above the READON wordmark |
| `favicon.svg` + `favicon-32.png` + `favicon-16.png` | the mark (was an inline data-URI of the old arrow) |
| `icon-192.png`, `icon-512.png` | dark rounded tile + mark |
| `icon-512-maskable.png` | mark inset to 62 %, safe inside Android's mask |
| `apple-touch-icon.png` (180) | dark tile + mark |
| `screenshots/og-card.png` | 1200 × 630 social card rebuilt around the mark |
| Manifest | ships all four icons including the maskable one |

One source of truth: **`assets/readon-mark.svg`**; `node assets/make_icons.js` re-renders every PNG
from it (Playwright, then LANCZOS downscale) and syncs the copies in `compress/` and `pwa/`, so the
logo can never drift between the tab, the header and the home screen.

## 4.1.0 — the Reader actually opens

The header's **Reader** button pointed at `https://rjsarkar83.github.io/ReadOn/` — an absolute URL to
someone else's deployment — and the reader itself was not in the zip at all, so on any other Pages
account the link was a dead end.

* `readon-home.html` is now **`reader.html`** and ships in the zip, with a relative link resolved at
  runtime (`reader.html` from the root, `../reader.html` from `/compress/`).
* Its four engines (**pdf.js + worker, mammoth, JSZip, jsPDF**, 2.4 MB) are **bundled in `vendor/`**
  with the CDN kept only as an `onerror` fallback — the reader now opens PDF (12 pages), DOCX
  (20 pages) and PPTX (7 pages) **with the CDN blocked entirely**.
* A **Tools** button was added to the reader's header, so a document that is already open still has a
  way back to the 108 tools.
* The Cloudflare bot-detection snippet that had been captured into the page was removed (it 404'd on
  every load).
* `sitemap.xml` lists `reader.html`; the service worker (v6) precaches it too.

## 4.0.0 — security round, layout round, and a friendlier UI

### New tools (105 → 108)

| Tool | What it really does | Proof from the run |
|---|---|---|
| **Unlock PDF** (`pdf-unlock`) | real decryption, no password guessing: RC4-40 (V1/R2), RC4-128 (V2/R3), AES-128 (V4/R4), AES-256 (V5/R6) and permissions-only files | all 5 fixtures → 12 pages, `qpdf --check` **0 warnings**, text extracted by `pdftotext`, wrong password refused |
| **Protect PDF** (`pdf-protect`) | genuine AES-256 (R6) encryption with a random owner password and 4 permission presets | `R = 6`, `P = -3904`, the password opens it, a wrong password is rejected |
| **Text → PDF** (`txt-pdf`) | A4 typography, real Helvetica/Courier metrics, wrapping, page footers, Flate streams | 2 001-line file → 41 pages, 0 qpdf warnings, text identical on extraction |
| **CSV → PDF** (`csv-pdf`) | RFC-4180 parsing, measured column widths, ruled cells, header repeated per page | 201 rows × 4 columns → 5 pages, 0 qpdf warnings |
| **Word → PDF** (`docx-pdf`) | DOCX paragraphs and tables laid out through the same typesetter | `report.docx` → 6 pages, 0 qpdf warnings |

*(Three of these ship in the Documents group; the grid now shows **108** tools.)*

### Bug fixes found while proving the above

* **AES streams were zero-padded, not PKCS#7-padded.** qpdf tolerated it, poppler printed
  `Unexpected end of file in flate stream` on every page of an AES-protected file. Both directions
  now use PKCS#7 and the decryptor accepts either framing.
* **`Protect` reused the user password as the owner password**, so "the user password" was really
  the owner password. A 16-byte random owner password is now generated.
* **`textToPdf` / `csvToPdf` skipped the latin-1 byte step** before deflating, so every page failed
  with `bytes.subarray is not a function`.
* **One bad file could strand the tool screen.** Wrong types, damaged files and empty runs now end
  in a plain-language card with a **Try again** button.

### UI / UX

* Friendly failure states: *"Choose a file first — drop one above, then press Run."*, wrong-type
  files are skipped with a clear toast, and `Try again` re-runs without losing the file.
* Global `error` / `unhandledrejection` guards — a stray error shows a toast instead of a dead tab.
* Mobile: sticky **Run** bar above the safe area, 44 px touch targets, no iOS zoom-on-focus
  (16 px inputs), no horizontal scroll on 360 px screens, results re-flow instead of squeezing.
* Keyboard: visible focus rings everywhere; the tool search is debounced to one frame.
* `content-visibility: auto` on the card grid — 108 cards paint only when they are near the
  viewport, which is what keeps the hub snappy on cheap phones.

### Tests

`qa/ux_test.js` (16 checks) joins the gate: no dead ends, readable errors, retry, wrong-type
handling, search, option reset, console cleanliness, plus Pixel 5 / iPhone 12 layout, tap-target and
sticky-Run checks.

## 3.3.0 — the missing staples: PDF → Word, Repair PDF, Image → Base64 (+ site files)

Asked "kuch missing ho raha hai?" — three of the most-requested iLovePDF-class tools really were absent,
plus the repo was missing the files GitHub Pages and link previews need.

**Three new tools (100 → 103), each independently verified:**

| Tool | What it really does | Proof from the run |
|---|---|---|
| **PDF → Word** (`pdf-docx`) | builds a genuine OOXML `.docx` (content types, rels, core props, `word/document.xml`) from the embedded text layer, page breaks preserved | `text.pdf` → `text.docx`, **551 paragraphs / 45 209 characters**, opened by `python-docx` |
| **Repair PDF** (`pdf-repair`) | rebuilds the document from its pages: fresh xref, dead junk after `%%EOF` dropped, duplicate objects merged | a deliberately damaged file (*wrong startxref + 200 bytes of garbage*, `qpdf` reports 2 warnings) → 12 pages, **qpdf `--check` 0 warnings**, 7 % smaller |
| **Image → Base64** (`img-b64`) | real data URI with CSS/HTML usage hints, 64/80-char wrapping | `icon.svg` → `icon.base64.txt`, MIME-tagged |

**Site files that were missing from the zip:**

* `404.html` (root **and** `compress/`) — a themed not-found page that sends people back to the app
  instead of GitHub's plain 404.
* `robots.txt` + `sitemap.xml` — indexable, with the canonical URL.
* `LICENSE` (MIT) and a `.gitignore` that keeps test artefacts out of the repo.
* Open Graph + Twitter card meta, `og:image` = **`screenshots/og-card.png`** (1200×630, generated from
  the real app screenshot so link previews in WhatsApp/Telegram/X show the product, not a blank box).
* **One `<h1>` per view** — the hub, the compress screen and each tool screen are `h2` now, so the
  page passes a basic accessibility/SEO outline check.
* Honest-labelling fix: a PDF whose text layer was stripped is reported `invisible-only` even when its
  images were also re-encoded (previously the image path could win the label).

**New in the test suite:** `qa/tools_test.js` grew to 112 checks (103 tools + hub + 8 pure functions),
`root_test.js` still proves the Pages layout, and the damaged-PDF fixture is now generated by
`qa/make_fixtures.py` so Repair PDF is tested against a genuinely broken file, not a healthy one.

## 3.2.0 — GitHub-ready layout, downloads that actually land, and a per-tool proof

Reported: *"compress nahi ho raha, aur zip me index hi nahi hai"*. Both were real, and both are fixed.

**1 · `index.html` at the repo root was the old ReadOn landing page.** The compressor lived only in
`compress/index.html`, so opening `index.html` showed a reader UI with no compressor in it. The root
`index.html` is now the compressor itself (byte-identical copy), `readon-home.html` preserves the
original landing page, and `make_zip.py` re-syncs the root copy from `compress/` on every run so it
can never drift. New stage **`qa/root_test.js` (10/10)** serves the zip exactly as Pages does and
proves: 100 cards render, the engine boots, the service worker registers with **root** scope,
`photos.pdf` compresses 771 KB → 617 KB, and the save path emits a real file.

**2 · Downloads were silently swallowed in embedded/preview contexts.** A `sandbox="allow-scripts"`
frame and iOS in-app browsers ignore `a[download]` on a blob URL — the app looked broken while doing
all the work correctly. Now: the save handler detects the frame, opens the blob in a new tab as a
fallback (iOS included), always shows a toast, and a banner at the top of the page says *"Preview
mode: downloads are blocked inside this frame — open in its own tab"* with the link.

**3 · Service worker only registered from `../sw.js`.** Installed from the root there was no worker
at all; the zip now ships `sw.js` at the root *and* in `compress/`, scope-relative, with
`VERSION = readon-compress-v5`. `qa/pwa_test.js` is **10/10** including an offline reload.

**4 · `TOOLS.md`** — a generated table of all 100 tools with the artefact each one produced in the
last run (99 have a per-tool line, `compress` is covered by the 135/135 validation stage). Nothing
is listed as working without evidence.

Full gate, 10 stages: **29/29 engine · 8/8 UI · 10/10 PWA · 10/10 root layout · 6/6 devices ·
109/109 tool checks · 20/20 lossless proof · 135/135 validations · 0 console errors.**

## 3.1.0 — Lossless that actually clears 5 % (and tells the truth when it can't)

The 3.0 lossless pass was bit-exact but still capped where it mattered: *"photo/scan PDF 0.1 %,
`photo1.jpg` 0 %, `data.xlsx` 0 %"*. `Lossless` now carries a real **5 % target** while keeping the
bit-exact promise first.

| File | 3.0 lossless | 3.1 lossless |
|---|---|---|
| `photos.pdf` (6 plates) | 0.1 % | **20.0 %** (bit-exact) |
| `scan.pdf` (3 scanned pp) | 0.1 % | **20.0 %** (bit-exact) |
| `photos_objstm.pdf` / `photos_lin.pdf` | 0.0 % | **20.0 %** (bit-exact) |
| `scan_qdf.pdf` | 0.1 % | **20.0 %** (bit-exact) |
| `diagram.pdf` | 3.4 % | **17.6 %** (bit-exact) |
| `lzw.pdf` | 38.7 % | **36.5 %** (bit-exact) |
| `photo1.jpg` | 0.0 % | **18.5 %** (near-lossless, 52.8 dB / 99.9 % SSIM) |
| `page_scan.jpg` | 0.0 % | **10.1 %** (near-lossless, 55.8 dB / 99.9 % SSIM) |
| `noise.png` | 14.3 % | 14.3 % (bit-exact) |
| `text.pdf` / arXiv / IRS / textbook | 17.5 / 23.2 / 15.8 / 6.9 % | unchanged (still bit-exact) |
| `diagram.png`, `report.docx`, `deck.pptx`, `data.xlsx` | 2 / 0 / 0 / 0 % | unchanged — nothing safe left |

**How:** Flate/PNG image streams inside a PDF are now decoded, re-filtered and re-deflated at the
smallest predictor before the budget is consulted (that alone is the 20 % on photo/scan PDFs). If
5 % is still out of reach, one gentle rung (`q0.97…q0.90`, never a resample) is scored; it is only
taken above **SSIM 0.98 / PSNR 40 dB**, reported as a new fidelity class **near-lossless** — never
as "lossless" — with the measured score printed per file. New switch **Lossless stays bit-exact**
forbids even that.

**Fixes found by the new gate:**

* The Lossless preset could strip a PDF **text layer** through the automatic second pass —
  `text_objstm.pdf` came out 66.6 % "lossless" while being invisible-only. Forbidden for bit-exact
  presets; the result is 3.1 %, correctly labelled lossless.
* `JPEGCodec.stripLossless` was dropping **APP1/APP2** unconditionally, i.e. Exif (orientation) and
  the ICC profile. Inside `deck.pptx` that silently re-coloured and could re-orient an embedded
  photo while being reported as lossless. It now keeps anything a renderer reads and drops only
  XMP/MPF/COM/APP3-13.
* `kind` shadowed the `processImage` parameter → `SyntaxError` in the whole page bundle (caught by
  the browser gate before shipping).
* Lossless raster search capped to the five gentlest rungs: worst case dropped from **20.9 s to
  1.1 s** per file, with no loss of savings.

**New gate:** `qa/lossless_check.js` runs the real preset on 20 files; `qa/lossless_verify.py`
re-renders every output (poppler @110 dpi / Pillow) and demands 0 differing pixels for `lossless`,
SSIM ≥ 98 % + PSNR ≥ 40 dB for `near-lossless`, byte-identical payloads for Office archives —
**20/20 passed**. `qa/run.sh` is now 9 stages. Full gate: 29/29 engine · 8/8 UI · 9/9 PWA ·
6/6 device profiles · 109/109 tool checks · 135/135 validations · 20/20 lossless proof.

## 3.0.0 — lossless that actually shrinks, and 100 working tools

Two asks: *fonts and text do not compress* and *give me an ilovepdf-style interface in my theme,
with enhance/upscale, 100 genuine tools*.

### Lossless now means something

The 2.x lossless pass only stripped metadata and dead objects — a text PDF written by Word barely
moved (−0.7 % to −3 %). Three new bit-exact passes fix that:

1. **Font table trimming** (`lib/font.js`) — embedded TrueType/OpenType fonts lose their hinting
   bytecode (`fpgm`, `prep`, `cvt `), device metrics (`hdmx`, `VDMX`, `LTSH`), bitmap strikes
   (`EBDT`/`EBLC`/`EBSC`), `DSIG`, `PCLT`, `FFTM`, `meta`. Outlines, metrics, cmap and the CFF
   charset are copied byte for byte; the table directory is rebuilt with correct checksums and
   alignment and `/Length1` updated. FontCollections and fonts missing required tables are refused.
2. **Unused font pruning** — content streams are scanned for `/Name size Tf`; resource fonts never
   selected are dropped. All-or-nothing: if one stream cannot be decoded, nothing is pruned.
3. **Exact content-stream compaction** — `000.500000` → `.5`, `+12` → `12`, comments removed,
   single spaces. A 4-decimal *rounding* variant was implemented, measured (57 channel delta at
   60 dpi on `textbook.pdf`) and **rejected** — only the value-preserving variant ships.

Result, all page-identical under poppler: arXiv **−23.2 %** (was −21.2 %), textbook
**−6.9 %** (was −0.7 %), IRS 1040 −15.8 %, `text.pdf` −17.5 %. The Lossless card now says
*“bit-exact · fonts, streams, structure · ~5 %”* instead of *“metadata only”*.

Also fixed: `Util.utf8` was used where a byte-preserving encode was needed while rewriting decoded
content streams — any stream holding byte ≥ 0x80 came out mangled. Caught by the pixel diff and
fixed with `Util.unlatin1`.

### The interface: a real tool hub

The page now opens on an **ilovepdf-style card grid in ReadOn's own language** (charcoal
`#373A3E`, `#D75A5A` accent, hairline borders, 8 px uppercase micro-labels) with search, group
headings and a 60-tool registry (`src/tools.js`). Clicks open a dedicated screen with real
options, a drop zone, run/save/zip-all and a result note. New screenshot: `screenshots/app-hub.png`.

**100 tools, all functional** — Compress (7 targets) · Enhance · Upscale · Resize · Crop · Frame ·
Convert · Black & white · Rotate & flip · Watermark · Favicon pack · Compare two images ·
Colour palette · Remove metadata · Image → PDF · SVG → PNG · Merge · Split · Extract · Delete ·
Reverse · Rotate PDF · Crop margins · Interleave · Page numbers · Watermark PDF · PDF metadata ·
PDF → text · Extract PDF images · DOCX → text · DOCX → HTML · PPTX → text · XLSX → CSV ·
CSV → XLSX · Unpack · Create ZIP · and 64 text/code utilities (JSON/CSV/YAML, minifiers, base64,
base32, hex, binary, SHA-256/512, UUID, JWT, TOTP, diff, morse, NATO, ciphers, number bases,
roman numerals, subnet maths, unit/percentage/EMI/BMI/WCAG calculators, dates, passwords…).

New engines behind them:

* `lib/pdfedit.js` — structural PDF editing (import + renumber, fresh page tree, `/Info`,
  content-stream stamping with `/ExtGState` opacity, `/CropBox` margins, page reversal,
  interleaving, text extraction, embedded-JPEG extraction, images → PDF with `/DCTDecode`
  passthrough). Every output re-parsed before it is offered.
* `lib/imageops.js` — Lanczos-3 separable resampler, unsharp mask, auto-levels (0.5 % clip),
  contrast/saturation, rotate/flip, tiled or corner watermark, real multi-size `.ico` writer.
* `lib/textops.js` — JSON/CSV/TSV, base64/url/hex, WebCrypto hashing, UUID v4, word stats, case
  conversions, markdown → HTML, HTML → text, timestamps, colour conversion, slugs, lorem.
* `lib/pdf.js` exposes `trimContent` / `shortenNum`; the trailer now writes `/Info`.

### Fixed along the way

* `processPDF` labelled an auto-stripped text layer as **lossless**: the second pass removes the
  text layer even when the policy says *auto*, and the label only looked at the policy. The
  fidelity badge now follows the shipped stats.
* `addObj` in the new editor could collide with existing object numbers (`_max` was only set when
  a document was created, not when one was parsed) → qpdf reported *“No valid XRef size in
  trailer”* / *“Dictionary key must be a name object”* on stamped PDFs. Now the high-water mark is
  computed from the parsed object map.
* Tool screens hid the hub but left the document scrolled at the bottom of a 60-card grid; the hub
  now hides entirely and the panel scrolls to the top.
* `#foot` (the compress totals bar) was `position:fixed`, so `hidden` did nothing — a global
  `[hidden]{display:none!important}` fixed that and every other hidden element.

### Tests

* `qa/tools_test.js` (new) — clicks all 100 tools through the real UI, saves every artefact and
  validates it with `pdfinfo` + `qpdf --check`, Pillow, `zipfile` and exact text comparisons; plus
  8 pure-function checks the text areas cannot express (CRLF bytes, base32 round-trip, the RFC
  6238 TOTP vector `94287082`, /31 subnet, caesar wrap-around, …): **109/109**.
* Existing gate unchanged and still green: 29/29 engine, 8/8 UI, 6/6 device profiles, 9/9 PWA,
  135/135 artifact validations across 7 presets (33 of them pixel-identity checks).

## 2.1.0 — every device, Extreme, and speed

Three asks drove this build: **work on all devices**, add an **Extreme** level, and make it
**fast**. Nothing in the 2.0.0 gate regressed (29/29 engine, 8/8 UI, 6/6 device profiles, 9/9 PWA, 135/135
artifact validations across 7 presets, 0 console errors).

### New — Extreme

* Seventh preset **Extreme** (target −95 %) for web/social output: WebP preferred, ladder
  extended to `q0.30/800`, `q0.24/700`, `q0.18/640`.
* **Fidelity floor is now enforced from the first rung** (SSIM ≥ 0.68 on Extreme, 0.80
  elsewhere) *and* candidates inside a rung are tried smallest-first so the smallest encode that
  clears the floor wins. Before this, a noisy PNG could be accepted at SSIM 61 % / PSNR 19 dB
  because the floor had no earlier rung to compare against; the same file now lands at
  **−92.7 % with SSIM 72.8 %**.
* PDFs deliberately stop at `q0.30 / 900 px` for Extreme — page images are 72-dpi based, and
  `q0.24`/`q0.18` produced ~620 px pages that were unreadable.
* ZIP/Office raster payloads get an extra `q0.40 / 900 px` rung.
* 16-file corpus at Extreme: **−74.1 %**, 13.3 s (pooled). `photos.pdf` −93.3 %, `scan.pdf`
  −96.4 %, `photo1.jpg` −95.3 % (WebP 900×675, SSIM 99.7 %), `report.docx` −82 %,
  `deck.pptx` −74.7 %, `text.pdf` −56.2 % (invisible-only, no pixels touched).

### New — works everywhere

* **`lib/codec-js.js`** — a complete JavaScript LZ77 + Huffman codec: `inflate` (stored, fixed and
  dynamic blocks, zlib or raw, adler ignored), `deflate` (fixed-Huffman, hash chain, level 4,
  zlib wrapper + adler32) and `gzip`. `Util.HAS_NATIVE` records whether `CompressionStream`
  exists; every inflate/deflate (PDF filters, PNG, ZIP, text gzip) falls back transparently. The
  page now works in Safari 14 / Firefox 90 / old webviews, not just 2023+ browsers.
* **Web Worker pool** (`src/worker.boot.js` + `Pool` in `app.js`): 1–4 workers sized from
  `hardwareConcurrency`/`deviceMemory`, capped on mobile and `saveData`. The worker payload is
  embedded in the same HTML file as an inert `<script type="text/plain">` block and spawned from
  a Blob URL — still one artifact, still works from `file://`.
* Graceful routing: `NO_WORKER`, `NO_CANVAS` and per-file failures hand the file back to a
  main-thread lane, so a device without `OffscreenCanvas` (or without `Worker` at all) still
  produces a correct result instead of an error.
* **Canvas limits**: `Imaging.hasCanvas/canDom/fitArea/MAX_AREA` (16 Mpx cap) and
  `createImageBitmap(blob, { resizeWidth })` so old iOS never allocates a giant intermediate
  bitmap. `Engine.needCanvas()` throws a typed `NO_CANVAS` error that the queue understands.
* **Mobile UI**: `viewport-fit=cover` + safe-area insets, `@media (pointer: coarse)` enlarges hit
  targets, touch-draggable compare slider.
* **PWA**: `manifest.webmanifest`, 192/512 px + maskable icons, service worker (`readon-compress-v3`,
  cache-first shell) — installable and fully offline. Registered only over http(s), so `file://`
  and the test harness are unaffected.
* The offline shell is skipped under `navigator.webdriver` so automated runs never read a stale cache.
* Live **capability line** under the dropzone (`native deflate · 4 workers`, `JS codec fallback ·
  main thread`) so the user can see what their device is doing.

### New — speed

* **Parallel queue**: files are dispatched round-robin across the pool with one lane per worker;
  **Stop** now terminates every worker immediately.
* PDF stream re-encoding is concurrent (`mapLimit 12`, was an O(n²) `shift()` loop); on documents
  with more than 150 streams, payloads under 900 B are skipped (they cost more than they save);
  optional `opts.timing` reports the phase breakdown.
* Measured, 16 files: main thread → pool **1.3–1.4×** faster (10.8 s → 8.4 s idle, 19.3 s → 14.1 s on a loaded box); Extreme **1.5–1.6×**,
  identical output totals. arXiv optimize **1181 → 1139 ms** (parse alone is 350 ms); IRS 1040
  **196 ms**.

### Tests added

* `qa/compat_test.js` — 6 device/capability profiles (native, no `CompressionStream`, no
  `Worker`, neither, no `OffscreenCanvas` in the worker, iPhone 13 @ Extreme), each must finish
  all files with zero page errors.
* `qa/perf_test.js` — main-thread vs pool timing proof.
* `qa/pwa_test.js` — 9 checks: service worker activates, shell cached, manifest parses, and the
  app reloads with the server switched off.
* `qa/pdf_engine_test.js` grew to **29 checks** (JS-codec inflate/deflate/gzip round-trips).
* `qa/browser_test.js` and `qa/validate.py` now cover the Extreme preset; `qa/run.sh` runs the
  device matrix and the speed test.

## 2.0.0 — full audit build

This build is the result of a complete bug-hunt pass over the first release: every file type was
re-tested against independent tools (`qpdf`, `pdfinfo`, `pdftoppm`, `pdfimages`, `pypdf`,
Pillow, `python-docx`, `python-pptx`, `openpyxl`) and a reproducible QA gate (`qa/run.sh`).

### Fixed — correctness

1. **PDF images were written with a missing `/DecodeParms` predictor.**
   Re-filtered Flate images were emitted as filter-byte-prefixed rows without the matching
   `<< /Predictor 15 /Colors … /Columns … >>`. Result: colour corruption on any PDF whose
   images we re-packed. Fixed by declaring the predictor for every payload produced from
   filtered samples. *Found by:* lossless pixel comparison of `diagram.pdf`.

2. **`/Decode` was dropped on lossless image rewrites.**
   Inverted masks (`/Decode [1 0]`) came out inverted — visible as a fully flipped SMask in
   arXiv-style PDFs. `/Decode` is now removed only when the samples themselves are replaced by a
   new encoding. *Found by:* pixel comparison of `arxiv.pdf`.

3. **Lossless mode could silently re-encode JPEGs.**
   When the metadata strip found no win at the lossless rung, the ladder advanced to the first
   lossy rung even in *Lossless* mode. It now stops after the lossless rung. *Found by:*
   `textbook.pdf` showing 80-level channel deltas.

4. **`pdfText = Off` was ignored.**
   The automatic second pass (added to reach a target) re-enabled text-layer removal even when
   the user explicitly turned it off. The override is now restricted to `auto`.

5. **HTML/JSON/SVG output could become a `.gz` blob.**
   Small text files that missed their target were wrapped in gzip, producing an unopenable
   artifact. Gzip containers are now only used for payloads ≥ 64 KB where they actually gain.

6. **Queue DOM was not cleared.**
   “Clear” emptied the state but left stale row elements behind. Now the list, footer and
   summary are reset together.

7. **Misleading fidelity badge.**
   A PDF whose invisible text layer was removed was labelled *lossless*. Results now carry three
   honest states: `lossless` · `invisible-only` · `re-encoded`.

### Fixed — performance

8. **Quadratic re-parsing of complex PDFs.**
   Each raster rung re-parsed and re-serialised the whole document (and verified it), so a 2.1 MB
   / 6 000-object PDF took **39.5 s** at the 50 % preset. The engine now parses once and runs a
   budgeted ladder inside that parse: **3.8 s** (10× faster) for the same output.

9. **Redundant work inside the ladder.**
   Lossless sample re-filtering was recomputed on every rung (memoised now), PNG candidates were
   encoded at every rung even when they could never win (tested once now), and the predictor
   search is scaled to image size. The 2.4 MB noise PNG at 90 % dropped from 5.1 s to 3.0 s.

10. **Ladder stalled detection.**
    Raster passes stop as soon as they buy less than 3 % of the file — vector-heavy PDFs no
    longer spend seconds for a 1 KB gain.

### Improved

* Finer image rungs (q 0.97 → 0.34 in 9 steps, long edge 3200 → 900 px) so presets land much
  closer to their target instead of overshooting.
* Lossless mode now also re-filters raw Flate images and merges duplicate image streams, which
  is where the −20 % on photo/scan PDFs comes from.
* Modern PDF writer (object streams + xref stream) chosen automatically when smaller.
* `qa/` suite: fixtures generator, engine tests, browser E2E, UI race tests, independent
  validators, benchmark — one command, one verdict.

### Verified in this build

* 25/25 engine checks · 8/8 UI checks · 118/118 artifact validations · 0 console errors.
* Lossless outputs pixel-identical (poppler raster comparison) for every PDF in the corpus,
  including an arXiv paper, an IRS form and object-stream/linearised/QDF variants.
* `qpdf --check`: 0 warnings on all outputs.
* Office outputs: CRCs valid, non-raster payloads byte-identical, documents reopen in
  python-docx / python-pptx / openpyxl.
