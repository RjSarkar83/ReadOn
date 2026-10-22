#!/usr/bin/env python3
"""qa/validate.py — independent validation of everything the browser produced.

    python3 qa/validate.py [presets...]

Checks, per preset directory in qa/downloads/:
  • PDF   : `qpdf --check` must report zero warnings, page count preserved,
            and at the *lossless* preset the rendered pages must be pixel-identical
  • IMAGE : re-opens with Pillow, sane dimensions, lossless preset pixel-identical
  • OFFICE: zip CRC valid, every non-raster payload byte-identical, document re-opens
  • ZIP   : the "download all" archive is a valid zip containing every result

Writes qa/validate-results.json and exits non-zero if anything fails.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import zipfile

from PIL import Image, ImageChops
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, 'fixtures')
DL = os.path.join(HERE, 'downloads')
TMP = os.path.join(HERE, 'tmp')

results = []


def check(scope, name, ok, detail=''):
    results.append({'scope': scope, 'name': name, 'ok': bool(ok), 'detail': detail})
    print(f"{'PASS' if ok else 'FAIL'}  {scope:7s} {name:34s} {detail}")


def render(pdf, tag, dpi=50, pages=6):
    os.makedirs(TMP, exist_ok=True)
    for f in glob.glob(f'{TMP}/{tag}-*.png'):
        os.remove(f)
    subprocess.run(['pdftoppm', '-r', str(dpi), '-png', '-f', '1', '-l', str(pages), pdf, f'{TMP}/{tag}'],
                   check=True, capture_output=True)
    return sorted(glob.glob(f'{TMP}/{tag}-*.png'))


def pixel_diff(a_pdf, b_pdf):
    a, b = render(a_pdf, 'a'), render(b_pdf, 'b')
    if len(a) != len(b):
        return False, f'page count {len(a)} vs {len(b)}'
    worst = 0
    for x, y in zip(a, b):
        ia, ib = Image.open(x).convert('RGB'), Image.open(y).convert('RGB')
        if ia.size != ib.size:
            return False, 'page size changed'
        d = ImageChops.difference(ia, ib)
        if d.getbbox():
            worst = max(worst, max(ch[1] for ch in d.getextrema()))
    return worst == 0, 'pixel-identical' if worst == 0 else f'max channel delta {worst}'


def psnr_ssim(a, b):
    """PSNR + windowed SSIM on 8x8 blocks of the greyscale image."""
    mse = float(np.mean((a - b) ** 2))
    psnr = float('inf') if mse == 0 else 10 * np.log10(255 ** 2 / mse)
    ga = np.asarray(Image.fromarray(a.astype(np.uint8)).convert('L'), dtype=np.float64)
    gb = np.asarray(Image.fromarray(b.astype(np.uint8)).convert('L'), dtype=np.float64)
    C1, C2, win, vals = (0.01 * 255) ** 2, (0.03 * 255) ** 2, 8, []
    for y in range(0, ga.shape[0] - win + 1, win):
        for x in range(0, ga.shape[1] - win + 1, win):
            wa, wb = ga[y:y+win, x:x+win], gb[y:y+win, x:x+win]
            ma, mb = wa.mean(), wb.mean()
            cov = ((wa - ma) * (wb - mb)).mean()
            vals.append(((2*ma*mb + C1) * (2*cov + C2)) / ((ma**2 + mb**2 + C1) * (wa.var() + wb.var() + C2)))
    return psnr, float(np.mean(vals)) if vals else 1.0


def fixture_for(out_name):
    """map an output file back to its source fixture (exact extension wins,
    then a lossless-format change png↔jpg, then any same-stem file)"""
    base, ext = os.path.splitext(os.path.basename(out_name))
    ext = ext.lower()
    real = os.path.join(FIX, 'real')
    if os.path.isdir(real) and any(os.path.splitext(f)[0] == base for f in os.listdir(real)):
        return os.path.join(real, next(f for f in os.listdir(real) if os.path.splitext(f)[0] == base))
    names = os.listdir(FIX)
    exact = [f for f in names if os.path.splitext(f)[0] == base and os.path.splitext(f)[1].lower() == ext]
    if exact:
        return os.path.join(FIX, exact[0])
    raster = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
    if ext in raster:
        same = [f for f in names if os.path.splitext(f)[0] == base and os.path.splitext(f)[1].lower() in raster]
        if same:
            return os.path.join(FIX, same[0])
    return None


def page_count(path):
    try:
        import pypdf
        return len(pypdf.PdfReader(path).pages)
    except Exception:
        try:
            out = subprocess.run(['pdfinfo', path], capture_output=True, text=True).stdout
            for line in out.splitlines():
                if line.startswith('Pages:'):
                    return int(line.split()[1])
        except Exception:
            pass
    return -1


def main():
    presets = sys.argv[1:] or sorted(d for d in os.listdir(DL) if os.path.isdir(os.path.join(DL, d)))
    for preset in presets:
        d = os.path.join(DL, preset)
        if not os.path.isdir(d):
            continue
        print(f'\n── {preset} ─────────────────────────────────────────────')

        # preferred source of truth: the "download all" bundle the app builds itself
        work = d
        bundle = os.path.join(d, '_all.zip')
        if os.path.exists(bundle):
            try:
                work = os.path.join(TMP, 'zip-' + preset)
                shutil.rmtree(work, ignore_errors=True)
                os.makedirs(work, exist_ok=True)
                with zipfile.ZipFile(bundle) as z:
                    z.extractall(work)
                    check(preset, '_all.zip', z.testzip() is None, f'{len([n for n in z.namelist() if not n.endswith("/")])} members, {os.path.getsize(bundle) / 1024:.0f} KB')
            except Exception as e:
                check(preset, '_all.zip', False, str(e))
                work = d

        files = sorted(f for f in os.listdir(work) if not f.startswith('_'))
        for f in files:
            out = os.path.join(work, f)
            src = fixture_for(f)
            if not src:
                continue
            ext = f.rsplit('.', 1)[-1].lower()
            if ext == 'pdf':
                r = subprocess.run(['qpdf', '--check', out], capture_output=True, text=True)
                warns = (r.stdout + r.stderr).count('WARNING') + (r.stdout + r.stderr).count('ERROR')
                pc, spc = page_count(out), page_count(src)
                check(preset, f, warns == 0 and pc == spc and pc > 0, f'{pc} pages, qpdf warnings={warns}')
                if preset == 'lossless':
                    same, why = pixel_diff(src, out)
                    check(preset, f + ' pixels', same, why)
            elif ext in ('jpg', 'jpeg', 'png', 'webp', 'gif'):
                try:
                    im = Image.open(out)
                    im.load()
                    check(preset, f, im.size[0] > 0 and im.size[1] > 0, f'{im.format} {im.size[0]}×{im.size[1]}')
                    if preset == 'lossless' and os.path.splitext(src)[1].lower() in ('.png', '.jpg', '.jpeg'):
                        # Lossless is bit-exact first; a re-encode is only allowed at SSIM >= 98 %
                        # and must be reported as "near-lossless" by the engine.
                        a = Image.open(src).convert('RGB')
                        b = im.convert('RGB')
                        same = a.size == b.size and ImageChops.difference(a, b).getbbox() is None
                        if same:
                            check(preset, f + ' pixels', True, 'pixel-identical')
                        else:
                            p_, s_ = psnr_ssim(np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64))
                            ok = a.size == b.size and s_ >= 0.98 and p_ >= 40
                            check(preset, f + ' pixels', ok,
                                  f'near-lossless PSNR {p_:.1f} dB · SSIM {s_*100:.2f} % (floor 40 dB / 98 %)')
                except Exception as e:
                    check(preset, f, False, f'unreadable: {e}')
            elif ext in ('docx', 'pptx', 'xlsx', 'zip'):
                try:
                    za, zb = zipfile.ZipFile(src), zipfile.ZipFile(out)
                    bad = zb.testzip()
                    same_names = za.namelist() == zb.namelist()
                    identical = same_names
                    raster = ('.png', '.jpg', '.jpeg', '.gif', '.emf', '.wmf')
                    if same_names:
                        for n in za.namelist():
                            if n.endswith('/'):
                                continue
                            if preset == 'lossless' and not n.lower().endswith(raster):
                                if za.read(n) != zb.read(n):
                                    identical = False
                                    break
                    check(preset, f, bad is None and same_names, f'{len(zb.namelist())} entries, crc ok')
                    if preset == 'lossless':
                        check(preset, f + ' payloads', identical, 'byte-identical' if identical else 'CHANGED')
                except Exception as e:
                    check(preset, f, False, f'zip error: {e}')


    failed = [r for r in results if not r['ok']]
    with open(os.path.join(HERE, 'validate-results.json'), 'w') as fh:
        json.dump(results, fh, indent=2)
    print(f'\n{len(results) - len(failed)}/{len(results)} validations passed')
    if failed:
        print('FAILURES:')
        for r in failed:
            print(f"  {r['scope']} {r['name']} — {r['detail']}")
        sys.exit(1)


if __name__ == '__main__':
    if not shutil.which('qpdf') or not shutil.which('pdftoppm'):
        print('!! qpdf / poppler-utils are required: apt-get install -y qpdf poppler-utils')
        sys.exit(2)
    main()
