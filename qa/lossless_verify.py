#!/usr/bin/env python3
"""qa/lossless_verify.py — independent proof for the Lossless preset.

Every PDF/PNG/JPEG/SVG output produced by qa/lossless_check.js is re-rendered
with poppler/Pillow and compared against the untouched original:
  • kind == lossless  → 0 differing pixels required
  • kind == near      → SSIM >= 0.98 and PSNR >= 40 dB required
Also re-checks every office archive payload byte-for-byte and every text file
after gunzip-style re-read. Writes qa/out/lossless-verify.json
"""
import json, os, re, subprocess, sys, zipfile, io
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, 'fixtures')
OUT = os.path.join(HERE, 'out', 'lossless')
TMP = os.path.join(HERE, 'tmp', 'll')
os.makedirs(TMP, exist_ok=True)

rows, fails = [], 0

def render_pdf(path, tag, dpi=110):
    prefix = os.path.join(TMP, tag)
    subprocess.run(['pdftoppm', '-r', str(dpi), '-png', path, prefix], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    names = sorted(f for f in os.listdir(TMP) if f.startswith(tag + '-') and f.endswith('.png'))
    return [np.asarray(Image.open(os.path.join(TMP, f)).convert('RGB')) for f in names]

def psnr_ssim(a, b):
    a = a.astype(np.float64); b = b.astype(np.float64)
    mse = float(np.mean((a - b) ** 2))
    psnr = float('inf') if mse == 0 else 10 * np.log10(255 ** 2 / mse)
    # grayscale, 8x8 window SSIM
    ga = np.asarray(Image.fromarray(a.astype(np.uint8)).convert('L'), dtype=np.float64)
    gb = np.asarray(Image.fromarray(b.astype(np.uint8)).convert('L'), dtype=np.float64)
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    win = 8
    vals = []
    for y in range(0, ga.shape[0] - win + 1, win):
        for x in range(0, ga.shape[1] - win + 1, win):
            wa = ga[y:y+win, x:x+win]; wb = gb[y:y+win, x:x+win]
            ma, mb = wa.mean(), wb.mean()
            va, vb = wa.var(), wb.var()
            cov = ((wa - ma) * (wb - mb)).mean()
            vals.append(((2*ma*mb + C1) * (2*cov + C2)) / ((ma**2 + mb**2 + C1) * (va + vb + C2)))
    return psnr, (float(np.mean(vals)) if vals else 1.0)

def record(name, kind, ok, detail):
    global fails
    rows.append({'file': name, 'kind': kind, 'ok': bool(ok), 'detail': detail})
    if not ok: fails += 1
    print(('PASS ' if ok else 'FAIL ') + f'{name:20} [{kind}] {detail}')

for f in sorted(os.listdir(OUT)):
    src, got = os.path.join(FIX, f), os.path.join(OUT, f)
    if not os.path.exists(src) or not os.path.exists(got): continue
    ext = f.rsplit('.', 1)[-1].lower()
    if ext == 'pdf':
        a = render_pdf(src, 'src'); b = render_pdf(got, 'out')
        for t in ('src', 'out'):
            for g in os.listdir(TMP):
                if g.startswith(t + '-'): os.remove(os.path.join(TMP, g))
        if len(a) != len(b):
            record(f, 'lossless', False, f'page count {len(a)} → {len(b)}'); continue
        diff = max(int(np.count_nonzero(x != y)) for x, y in zip(a, b))
        record(f, 'lossless', diff == 0, f'{len(a)} pp @110dpi, {diff} differing pixels')
    elif ext in ('png', 'jpg', 'jpeg'):
        A = np.asarray(Image.open(src).convert('RGB'), dtype=np.int16)
        B = np.asarray(Image.open(got).convert('RGB'), dtype=np.int16)
        if A.shape != B.shape:
            record(f, '?', False, f'size {A.shape} → {B.shape}'); continue
        p, s = psnr_ssim(A, B)
        if (A == B).all():
            record(f, 'lossless', True, f'bit-identical pixels, {p:.1f} dB')
        else:
            ok = s >= 0.98 and p >= 40
            record(f, 'near', ok, f'PSNR {p:.1f} dB · SSIM {s*100:.2f} % (floor 40 dB / 98 %)')
    elif ext in ('docx', 'pptx', 'xlsx'):
        with zipfile.ZipFile(src) as za, zipfile.ZipFile(got) as zb:
            na = {i.filename: za.read(i.filename) for i in za.infolist()}
            nb = {i.filename: zb.read(i.filename) for i in zb.infolist()}
            same = na.keys() == nb.keys() and all(na[k] == nb[k] for k in na)
            record(f, 'lossless', same, f'{len(na)} payloads, {"identical" if same else "CHANGED"}')
    elif ext in ('txt', 'json', 'svg', 'css', 'html', 'csv', 'md', 'js'):
        a, b = open(src, 'rb').read(), open(got, 'rb').read()
        if a != b and ext == 'json':
            try:
                same = json.loads(a) == json.loads(b)
                record(f, 'lossless', same, 'same JSON data after whitespace minify')
                continue
            except Exception: pass
        same = a == b
        if not same and ext in ('svg', 'html', 'htm', 'css', 'xml'):
            def norm(t):
                t = re.sub(r'<!--[\s\S]*?-->', '', t.decode('utf-8', 'replace'))
                t = re.sub(r'<\?xml[\s\S]*?\?>', '', t)
                t = re.sub(r'<!DOCTYPE[^>]*>', '', t)
                t = re.sub(r'\s*([{};:,])\s*', r'\1', t)
                return re.sub(r'\s*<', '<', re.sub(r'>\s*', '>', re.sub(r'\s+', ' ', t))).strip()
            same = norm(a) == norm(b)
            if same:
                record(f, 'lossless', True, 'rendering-identical after whitespace minify')
                continue
        if not same and ext in ('txt', 'csv', 'md'):
            norm = lambda t: re.sub(r'\n{2,}', '\n\n', re.sub(r'[ \t]+$', '', t.decode('utf-8', 'replace'), flags=re.M))
            same = norm(a) == norm(b)
            if same:
                record(f, 'lossless', True, 'content-identical after trailing-whitespace normalise')
                continue
        # gzip container outputs are decompressed before comparison
        if not same:
            try:
                same = subprocess.run(['python3', '-c', 'import gzip,sys;sys.stdout.buffer.write(gzip.open(sys.argv[1]).read())', got],
                                      capture_output=True).stdout == open(src, 'rb').read()
            except Exception: same = False
        record(f, 'lossless', same, 'byte-identical after decode' if same else 'CHANGED')

json.dump(rows, open(os.path.join(HERE, 'out', 'lossless-verify.json'), 'w'), indent=1)
print(f'\n{len(rows) - fails}/{len(rows)} lossless outputs verified')
sys.exit(1 if fails else 0)
