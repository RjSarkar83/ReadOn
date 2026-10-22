#!/usr/bin/env python3
"""Package the shipping tree into readon-compress-github.zip.

    python3 make_zip.py

The archive mirrors the repo layout GitHub Pages expects: drop `index.html`,
`compress/` and `sw.js` at the repo root and the tool is live at /ReadOn/compress/.
Sources, tests and docs are included so the build is reproducible from the zip alone.
"""
import os
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'artvision-tools-github.zip')

FILES = [
    'index.html',
    'reader.html',
    'sw.js',
    '.nojekyll',
    'LICENSE',
    'sitemap.xml',
    'robots.txt',
    '.gitignore',
    '404.html',
    'compress/404.html',
    'README.md',
    'COMPRESSION.md',
    'CHANGELOG.md',
    'TOOLS.md',
    'benchmark.csv',
    'make_zip.py',
    'compress/index.html',
    'compress/sw.js',
    'manifest.webmanifest',
    'icon-192.png',
    'icon-512.png',
    'icon-512-maskable.png',
    'favicon.svg',
    'favicon-32.png',
    'favicon-16.png',
    'apple-touch-icon.png',
    'assets/artvision-logo.png',
    'assets/make_icons.py',
    'compress/build.js',
    'compress/manifest.webmanifest',
    'compress/icon-192.png',
    'compress/icon-512.png',
    'compress/icon-512-maskable.png',
    'compress/favicon.svg',
    'compress/favicon-32.png',
    'compress/favicon-16.png',
    'compress/apple-touch-icon.png',
    'vendor/pdf.min.js',
    'vendor/pdf.worker.min.js',
    'vendor/mammoth.browser.min.js',
    'vendor/jszip.min.js',
    'vendor/jspdf.umd.min.js',
    'qa/run.sh',
    'qa/make_fixtures.py',
    'qa/pdf_engine_test.js',
    'qa/browser_test.js',
    'qa/ui_test.js',
    'qa/compat_test.js',
    'qa/perf_test.js',
    'qa/pwa_test.js',
    'qa/root_test.js',
    'qa/tools_test.js',
    'qa/tool-evidence.json',
    'qa/ux_test.js',
    'qa/image_test.js',
    'qa/shots.js',
    'qa/validate.py',
    'qa/lossless_check.js',
    'qa/lossless_verify.py',
    'qa/bench.js',
    'qa/package.json',
    'qa/package-lock.json',
    'qa/.gitignore',
]
DIRS = ['compress/src', 'screenshots']


def collect():
    seen, out = set(), []
    for f in FILES:
        p = os.path.join(ROOT, f)
        if os.path.isfile(p) and f not in seen:
            seen.add(f)
            out.append(f)
    for d in DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, _dirnames, files in os.walk(base):
            for name in sorted(files):
                rel = os.path.relpath(os.path.join(dirpath, name), ROOT).replace(os.sep, '/')
                if rel not in seen and not rel.endswith('.map'):
                    seen.add(rel)
                    out.append(rel)
    return sorted(out)


def main():
    # the app is shipped twice: repo root (Pages opens straight into it) and compress/
    # reader.html keeps the original ReadOn reading app, untouched
    import shutil
    shutil.copyfile(os.path.join(ROOT, 'compress', 'index.html'), os.path.join(ROOT, 'index.html'))
    for asset in ('sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
                  'icon-512-maskable.png', 'favicon.svg', 'favicon-32.png', 'favicon-16.png',
                  'apple-touch-icon.png', '404.html'):
        shutil.copyfile(os.path.join(ROOT, 'compress', asset), os.path.join(ROOT, asset))
    names = collect()
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in names:
            z.write(os.path.join(ROOT, rel), rel)
    size = os.path.getsize(OUT)
    print(f'built {OUT} — {size / 1024:.1f} KB ({len(names)} members)')
    for rel in names:
        print(f'  {os.path.getsize(os.path.join(ROOT, rel)):>9}  {rel}')


if __name__ == '__main__':
    main()
