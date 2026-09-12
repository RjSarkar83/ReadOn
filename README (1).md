# ReadOn · Explain Your Document

A minimal, single-file document reader that turns any **PDF, Word (.docx) or PowerPoint (.pptx)**
into a book you can flip through, listen to, translate and analyze — right in the browser.
No server, no build step, no account. Open `index.html` and drop a file in.

➤ **ADVERTiSiNG – BRANDiNG** | **CREATiVE – DESiGNiNG** ➤

## Live demo (free hosting)

Because it is one static file, it runs anywhere:

- **GitHub Pages** — push this repo, then *Settings → Pages → Deploy from branch `main` (root)*.
  Your app goes live at `https://<username>.github.io/<repo>/`.
- Or just double-click `index.html` on your machine.

## Features

- **Book experience** — real double-page spread, 3D paper turn (lift, sheen, settle) with a
  two-stage paper sound; single-page mode, zoom, fit page/width, thumbnail rail, corner peel.
- **Listen** — reads any page aloud in **31 languages** with regional accents
  (Hindi · India is the default voice). Auto-translates the page to your reading language first.
  Continuous reading across pages, speed / pitch / volume, pause / resume.
- **Karaoke highlight** — the exact word being spoken glows on the page; when the voice reads a
  translation (e.g. Hindi over an English PDF), the matching original sentence is highlighted instead.
- **Translate** — free engines (Google, MyMemory) out of the box; optionally plug a
  **Claude API key** (Settings → AI provider) for richer translation + AI analysis. Key stays in your browser.
  One-click **Save .txt** export of the translation.
- **Analyze** — Quick Explain / Full Analysis (overview, key points, takeaway).
  Works offline with a built-in extractive engine when no key is set.
- **Ambience** — generative Indian ambient score (tanpura drone, bansuri, bells, tabla) and
  page-turn sound, both toggleable.
- **Navigate like a book** — Contents drawer (real headings from Word/PowerPoint, PDF outline),
  per-document **bookmarks** that persist between sessions, and **Find in document**
  (`Ctrl/⌘+F`) with result snippets, jump-to-match and red highlight overlays —
  line-level on Word pages, exact word-level on PDF and PowerPoint pages.
- **Book typography** — Word documents are set with justified lines like a printed book.
- **Formats** — PDF (real rendering + text extraction), DOCX (headings, lists, tables re-laid out
  as book pages), PPTX (slides rebuilt as clean editorial pages).
- **Themes** — dark / light / **sepia paper** / system. **Fullscreen** with auto-hiding chrome.
- **Keyboard-first** — press `?` in the app for all shortcuts.

## Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| `→` / `←` | next / previous | `R` | read page aloud |
| `Home` / `End` | first / last | `Shift+R` | auto-turn |
| `+` `−` `0` | zoom in / out / reset | `P` | pause voice |
| `W` | spread / single | `T` `V` `A` `S` | panels |
| `M` | ambient music | `D` | theme |
| `F` | fullscreen | `G` | thumbnails |
| `Ctrl/⌘+F` | find in document | `B` | bookmark page |
| `?` | help | `Esc` | close / exit |

## Repository layout

```
index.html          ← the whole app (open this)
tests/test.js       ← jsdom + real-canvas smoke test
shots/              ← screenshots from the headless-Chrome visual pass
```

## Run the tests

```bash
npm i jsdom jszip canvas mammoth   # one-time
NODE_PATH=$(pwd)/node_modules node tests/test.js
# → 29 passed, 0 failed
```

## Notes

- Voice output uses your browser’s speech synthesis; installed voices vary by OS.
- Translation/analysis call public web services; the Claude key is optional and stored only
  in `localStorage`.
- Old `.doc` / `.ppt` files are not supported — save them as `.docx` / `.pptx` first.

## License

MIT — see [LICENSE](LICENSE).
