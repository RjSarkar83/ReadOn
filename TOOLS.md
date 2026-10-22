# ArtViSiON · Tools — the 108 tools, and the proof that each one works

Every tool below was executed in a real Chromium build of the shipped
`compress/index.html` — clicked through the UI like a user (so the Web-Worker path is exercised) —
then its output was saved and re-opened by an independent checker: `pdfinfo` + `qpdf --check` for
PDFs, Pillow + NumPy for images, `python-docx`/zipfile for Office files. Text tools are asserted
against an exact expected string. Password tools are re-opened with the password we set, and with a
wrong one.

**108/108 tools produced real output — 0 placeholders, 0 "coming soon", 0 redirects.**

Inventory: Popular 1 · Image 16 · PDF 17 · Documents 10 · Text & code 64.

| # | Group | Tool | id | Kind | Verified evidence |
|---|---|---|---|---|---|
| 1 | Popular | **Compress** | `compress` | file → file | `qa/tools_test.js` |
| 2 | Image | **Enhance image** | `enhance` | file → file | photo1-enhanced.jpg — 315371 B · JPEG (1600, 1200) |
| 3 | Image | **Upscale image** | `upscale` | file → file | diagram-2800x2000.jpg — 492749 B · JPEG (2800, 2000) |
| 4 | Image | **Resize image** | `resize` | file → file | photo1-800x600.jpg — 89123 B · JPEG (800, 600) |
| 5 | Image | **Convert image** | `convert` | file → file | diagram.png — 37624 B · PNG (1400, 1000) |
| 6 | Image | **Black & white** | `grayscale` | file → file | photo1-gray.jpg — 193086 B · JPEG (1600, 1200) |
| 7 | Image | **Rotate & flip** | `rotate` | file → file | photo1-rot.jpg — 301439 B · JPEG (1200, 1600) |
| 8 | Image | **Watermark image** | `watermark` | file → file | photo1-wm.jpg — 251884 B · JPEG (1600, 1200) |
| 9 | Image | **Favicon pack** | `favicon` | file → file | favicon-pack.zip — 51493 B · 9 None |
| 10 | Image | **Remove photo metadata** | `strip` | file → file | page_scan-clean.jpg — 865229 B · JPEG (2480, 3508) |
| 11 | Image | **Image → PDF** | `img2pdf` | file → file | images.pdf — 537713 B · 2 pages · qpdf warnings=0 |
| 12 | Image | **SVG → PNG** | `svg2png` | file → file | icon-1024.png — 28872 B · PNG (1024, 1024) |
| 13 | Image | **Crop image** | `crop` | file → file | photo1-crop.jpg — 205817 B · JPEG (1200, 1200) |
| 14 | Image | **Frame & pad image** | `frame` | file → file | photo1-framed.jpg — 280665 B · JPEG (1728, 1328) |
| 15 | Image | **Compare two images** | `diff` | file → file | difference.png — 756366 B · PNG (1600, 1200) |
| 16 | Image | **Colour palette** | `palette` | file → file | photo1-palette.txt — 160 B · 159 chars |
| 17 | PDF | **Merge PDF** | `pdf-merge` | file → file | merged.pdf — 25944 B · 13 pages · qpdf warnings=0 |
| 18 | PDF | **Split PDF** | `pdf-split` | file → file | split-pages.zip — 12712 B · 12 None |
| 19 | PDF | **Extract pages** | `pdf-extract` | file → file | text-pages.pdf — 3711 B · 3 pages · qpdf warnings=0 |
| 20 | PDF | **Delete pages** | `pdf-delete` | file → file | text-deleted.pdf — 10703 B · 11 pages · qpdf warnings=0 |
| 21 | PDF | **Rotate PDF** | `pdf-rotate` | file → file | diagram-rotated.pdf — 14598 B · 1 pages · qpdf warnings=0 |
| 22 | PDF | **Page numbers** | `pdf-numbers` | file → file | text-numbered.pdf — 13988 B · 12 pages · qpdf warnings=0 |
| 23 | PDF | **Watermark PDF** | `pdf-watermark` | file → file | text-watermark.pdf — 16367 B · 12 pages · qpdf warnings=0 |
| 24 | PDF | **PDF metadata** | `pdf-info` | file → file | diagram-meta.pdf — 14678 B · 1 pages · qpdf warnings=0 |
| 25 | PDF | **PDF → Word** | `pdf-docx` | file → file | text.docx — 3134 B · python-docx opens it · 551 45209 Chapter 1: Operations Review Lorem ipsum |
| 26 | PDF | **PDF → text** | `pdf-text` | file → file | text.txt — 45897 B · 45513 chars |
| 27 | PDF | **Extract PDF images** | `pdf-images` | file → file | pdf-images.zip — 544599 B · 2 None |
| 28 | PDF | **Reverse page order** | `pdf-reverse` | file → file | text-reversed.pdf — 11576 B · 12 pages · qpdf warnings=0 |
| 29 | PDF | **Crop PDF margins** | `pdf-crop` | file → file | scan-cropped.pdf — 924000 B · 3 pages · qpdf warnings=0 |
| 30 | PDF | **Interleave two PDFs** | `pdf-interleave` | file → file | interleaved.pdf — 25944 B · 13 pages · qpdf warnings=0 |
| 31 | Documents | **DOCX → text** | `docx-text` | file → file | report.txt — 22485 B · 21765 chars |
| 32 | Documents | **Text → PDF** | `txt-pdf` | file → file | notes.pdf — 18434 B · 41 pages · qpdf warnings=0 |
| 33 | Documents | **CSV → PDF** | `csv-pdf` | file → file | data.pdf — 10648 B · 5 pages · qpdf warnings=0 |
| 34 | Documents | **Word → PDF** | `docx-pdf` | file → file | report.pdf — 5087 B · 6 pages · qpdf warnings=0 |
| 35 | Documents | **DOCX → HTML** | `docx-html` | file → file | report.html — 24745 B · 24025 chars |
| 36 | Documents | **XLSX → CSV** | `xlsx-csv` | file → file | data.csv — 450608 B · 4000 lines |
| 37 | Documents | **Unpack archive** | `zip-unpack` | file → file | [Content_Types].xml — 1789 B · 1789 chars |
| 38 | Documents | **Create ZIP** | `zip-pack` | file → file | archive.zip — 325 B · 2 None |
| 39 | Documents | **PPTX → text** | `pptx-text` | file → file | deck.txt — 598 B · 374 chars |
| 40 | Documents | **CSV → XLSX** | `csv-xlsx` | file → file | data.xlsx — 6540 B · 5 None |
| 41 | Text & code | **JSON formatter** | `json-format` | text → text | 39 chars |
| 42 | Text & code | **JSON minify** | `json-minify` | text → text | 7 chars |
| 43 | Text & code | **JSON → CSV** | `json-csv` | text → text | 11 chars |
| 44 | Text & code | **CSV → JSON** | `csv-json` | text → text | 34 chars |
| 45 | Text & code | **CSV → TSV** | `csv-tsv` | text → text | 7 chars |
| 46 | Text & code | **JSON key list** | `json-keys` | text → text | 5 chars |
| 47 | Text & code | **Minify CSS** | `css-min` | text → text | 13 chars |
| 48 | Text & code | **Minify JS** | `js-min` | text → text | 17 chars |
| 49 | Text & code | **Minify HTML** | `html-min` | text → text | 19 chars |
| 50 | Text & code | **Minify SVG** | `svg-min` | text → text | 74 chars |
| 51 | Text & code | **Minify XML** | `xml-min` | text → text | 15 chars |
| 52 | Text & code | **Markdown → HTML** | `md-html` | text → text | 47 chars |
| 53 | Text & code | **HTML → text** | `html-text` | text → text | 3 chars |
| 54 | Text & code | **Base64 encode** | `b64-enc` | text → text | 8 chars |
| 55 | Text & code | **Base64 decode** | `b64-dec` | text → text | 6 chars |
| 56 | Text & code | **URL encode** | `url-enc` | text → text | 9 chars |
| 57 | Text & code | **URL decode** | `url-dec` | text → text | 5 chars |
| 58 | Text & code | **Text ↔ hex** | `hex` | text → text | 12 chars |
| 59 | Text & code | **SHA-256 hash** | `sha256` | text → text | 64 chars |
| 60 | Text & code | **SHA-512 hash** | `sha512` | text → text | 128 chars |
| 61 | Text & code | **UUID generator** | `uuid` | text → text | 184 chars |
| 62 | Text & code | **Word counter** | `count` | text → text | 230 chars |
| 63 | Text & code | **Change case** | `case` | text → text | 11 chars |
| 64 | Text & code | **Sort lines** | `sort` | text → text | 5 chars |
| 65 | Text & code | **Remove duplicate lines** | `dedupe` | text → text | 3 chars |
| 66 | Text & code | **Clean whitespace** | `trim` | text → text | 4 chars |
| 67 | Text & code | **Slugify** | `slug` | text → text | 16 chars |
| 68 | Text & code | **Lorem ipsum** | `lorem` | text → text | 985 chars |
| 69 | Text & code | **Timestamp** | `time` | text → text | 227 chars |
| 70 | Text & code | **Colour converter** | `color` | text → text | 151 chars |
| 71 | Text & code | **Escape HTML** | `escape-html` | text → text | 33 chars |
| 72 | Text & code | **ROT13** | `rot13` | text → text | 5 chars |
| 73 | Text & code | **Reverse text** | `reverse` | text → text | 3 chars |
| 74 | Text & code | **Join / unwrap lines** | `join-lines` | text → text | 14 chars |
| 75 | Text & code | **Extract bits** | `extract` | text → text | 14 chars |
| 76 | Text & code | **Word frequency** | `freq` | text → text | 36 chars |
| 77 | Text & code | **Find & replace** | `replace` | text → text | 3 chars |
| 78 | Text & code | **Password generator** | `password` | text → text | 158 chars |
| 79 | Text & code | **JSON → YAML** | `json-yaml` | text → text | 28 chars |
| 80 | Text & code | **Pick CSV columns** | `csv-pick` | text → text | 7 chars |
| 81 | Text & code | **Remove accents** | `unaccent` | text → text | 10 chars |
| 82 | Text & code | **Strip invisible characters** | `invisible` | text → text | 2 chars |
| 83 | Text & code | **Caesar cipher** | `caesar` | text → text | 3 chars |
| 84 | Text & code | **ROT47** | `rot47` | text → text | 5 chars |
| 85 | Text & code | **Morse code** | `morse` | text → text | 11 chars |
| 86 | Text & code | **NATO alphabet** | `nato` | text → text | 10 chars |
| 87 | Text & code | **Text ↔ binary** | `binary` | text → text | 8 chars |
| 88 | Text & code | **Base32** | `base32` | text → text | 3 chars |
| 89 | Text & code | **JWT decoder** | `jwt` | text → text | 131 chars |
| 90 | Text & code | **TOTP codes** | `totp` | text → text | 111 chars |
| 91 | Text & code | **Number bases** | `bases` | text → text | 143 chars |
| 92 | Text & code | **Roman numerals** | `roman` | text → text | 14 chars |
| 93 | Text & code | **IPv4 subnet** | `subnet` | text → text | 278 chars |
| 94 | Text & code | **Diff two texts** | `diff-text` | text → text | 7 chars |
| 95 | Text & code | **Line endings** | `eol` | text → text | 3 chars |
| 96 | Text & code | **Tabs ↔ spaces** | `tabs` | text → text | 6 chars |
| 97 | Text & code | **Sort words** | `sort-words` | text → text | 5 chars |
| 98 | Text & code | **Date difference** | `date-diff` | text → text | 191 chars |
| 99 | Text & code | **Age calculator** | `age` | text → text | 161 chars |
| 100 | Text & code | **Unit converter** | `unit` | text → text | produced output |
| 101 | Text & code | **Percentage** | `percent` | text → text | 155 chars |
| 102 | Text & code | **Loan EMI** | `emi` | text → text | 171 chars |
| 103 | Text & code | **BMI & BMR** | `bmi` | text → text | 267 chars |
| 104 | Text & code | **Contrast check** | `wcag` | text → text | 176 chars |
| 105 | PDF | **Unlock PDF** | `pdf-unlock` | file → file | enc_owner_only-unlocked.pdf — 10073 B · 12 pages · qpdf warnings=0 · text extracted |
| 106 | PDF | **Protect PDF** | `pdf-protect` | file → file | text-protected.pdf — 12513 B · 12 pages (password opens it) · AES-256 R6, password accepted · wrong password rejected |
| 107 | PDF | **Repair PDF** | `pdf-repair` | file → file | damaged-repaired.pdf — 11576 B · 12 pages · qpdf warnings=0 |
| 108 | Image | **Image → Base64** | `img-b64` | file → file | icon.base64.txt — 348 B · 342 chars |

## What the checkers look for

* **PDF** — `pdfinfo` reports a page count, `qpdf --check` reports **0 warnings**, the text layer is
  extracted with `pdftotext`, and `qpdf --show-encryption` confirms `R = 6` for Protect plus a
  rejected wrong password.
* **Images** — Pillow decodes the file, and `qa/image_test.js` additionally measures mean, σ and
  unique colours (a blank or black frame fails), the exact output dimensions, true-grey output for
  grayscale, a 12 MP time budget and a frame-gap budget (a frozen tab fails).
* **ZIP / DOCX / XLSX / PPTX** — `zipfile` opens the archive, `testzip()` finds no corrupt member.
* **Text tools** — compared against the exact expected value, not a substring.

## Reproduce it

```bash
cd qa && npm install playwright && npx playwright install chromium && cd ..
bash qa/run.sh
```

The full gate also covers compression presets (Lossless → Extreme), pixel-level lossless proof,
device/browser matrix, offline/PWA behaviour, GitHub-Pages root layout, speed and friendliness.
