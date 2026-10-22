#!/usr/bin/env python3
"""qa/make_fixtures.py — regenerate the test corpus used by the QA suite.

    python3 qa/make_fixtures.py            # → qa/fixtures/*
"""
import os, random, subprocess, json
from PIL import Image, ImageDraw, ImageFilter

random.seed(7)
OUT = os.path.join(os.path.dirname(__file__), 'fixtures')
os.makedirs(OUT, exist_ok=True)


def photo(w, h, path, quality=96):
    im = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(im)
    for i in range(h):
        d.line([(0, i), (w, i)], fill=(120 + random.randint(0, 80), 140 + random.randint(0, 60), 180 + random.randint(0, 50)))
    for _ in range(140):
        x, y = random.randint(0, w), random.randint(0, h)
        s = random.randint(20, 160)
        d.ellipse([x, y, x + s, y + s], fill=(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)))
    im = im.filter(ImageFilter.GaussianBlur(1.2))
    px = im.load()
    for _ in range(w * h // 60):
        x, y = random.randint(0, w - 1), random.randint(0, h - 1)
        px[x, y] = tuple(min(255, max(0, c + random.randint(-12, 12))) for c in px[x, y])
    im.save(path, quality=quality)
    return im


def make_images():
    photo(1600, 1200, f'{OUT}/photo1.jpg')
    photo(1200, 900, f'{OUT}/photo2.jpg')

    im = Image.new('RGB', (1400, 1000), 'white')
    d = ImageDraw.Draw(im)
    for i in range(30):
        d.rounded_rectangle([40 + i * 3, 60 + i * 25, 1300 - i * 3, 140 + i * 25], radius=12, outline=(30, 60, 120), width=3)
    d.text((80, 900), 'Line art / diagram PNG — lossless target', fill=(20, 20, 20))
    im.save(f'{OUT}/diagram.png')

    Image.effect_noise((1200, 900), 42).convert('RGB').save(f'{OUT}/noise.png')

    frames = [Image.new('RGB', (80, 80), (i * 40 % 255, 90, 120)) for i in range(6)]
    frames[0].save(f'{OUT}/anim.gif', save_all=True, append_images=frames[1:], duration=120, loop=0)


def make_pdfs():
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4

    c = canvas.Canvas(f'{OUT}/text.pdf', pagesize=A4)
    c.setTitle('Quarterly Report'); c.setAuthor('R. J. Sarkar'); c.setKeywords('test, pdf')
    for p in range(12):
        c.setFont('Helvetica-Bold', 18)
        c.drawString(60, 780, f'Chapter {p + 1}: Operations Review')
        c.setFont('Helvetica', 10.5)
        y = 750
        for line in range(44):
            c.drawString(60, y, 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor  %d-%d' % (p, line))
            y -= 15.5
        c.showPage()
    c.save()

    c = canvas.Canvas(f'{OUT}/photos.pdf', pagesize=A4)
    for i in range(6):
        c.drawImage(f'{OUT}/photo{i % 2 + 1}.jpg', 40, 300, width=520, height=390)
        c.setFont('Helvetica', 12); c.drawString(40, 270, f'Figure {i + 1} — photographic plate')
        c.showPage()
    c.save()

    big = Image.open(f'{OUT}/photo1.jpg').resize((2480, 3508))
    big.save(f'{OUT}/page_scan.jpg', quality=92)
    c = canvas.Canvas(f'{OUT}/scan.pdf', pagesize=A4)
    for _ in range(3):
        c.drawImage(f'{OUT}/page_scan.jpg', 0, 0, width=595, height=842)
        c.showPage()
    c.save()

    c = canvas.Canvas(f'{OUT}/diagram.pdf', pagesize=A4)
    c.drawImage(f'{OUT}/diagram.png', 30, 300, width=535, height=382)
    c.setFont('Helvetica', 11); c.drawString(30, 280, 'Vector-ish diagram stored as PNG')
    c.showPage(); c.save()

    c = canvas.Canvas(f'{OUT}/lzw.pdf')
    c.setFont('Helvetica', 12); c.drawString(70, 700, 'LZW test')
    c.showPage(); c.save()


def make_office():
    from docx import Document
    from docx.shared import Inches
    from pptx import Presentation
    from pptx.util import Inches as PI
    import openpyxl

    d = Document()
    d.add_heading('Compression Test', 0)
    for i in range(120):
        d.add_paragraph('Paragraph %d — The quick brown fox jumps over the lazy dog. ' % i * 3)
    d.add_picture(f'{OUT}/photo1.jpg', width=Inches(4))
    d.save(f'{OUT}/report.docx')

    p = Presentation()
    for i in range(6):
        s = p.slides.add_slide(p.slide_layouts[1])
        s.shapes.title.text = 'Slide %d' % i
        s.placeholders[1].text = 'Body text for slide %d' % i
    s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = 'Photo'
    s.shapes.add_picture(f'{OUT}/photo2.jpg', PI(1), PI(2), width=PI(6))
    p.save(f'{OUT}/deck.pptx')

    wb = openpyxl.Workbook(); ws = wb.active
    for r in range(4000):
        for col in range(12):
            ws.cell(row=r + 1, column=col + 1, value=(r * col) % 997 if col % 2 else 'row %d col %d' % (r, col))
    wb.save(f'{OUT}/data.xlsx')


def make_text():
    open(f'{OUT}/data.json', 'w').write('{"a":1,   "b":[1,2,3],  "note": "minify me"}\n\n\n')
    open(f'{OUT}/icon.svg', 'w').write(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n  <!-- comment -->\n'
        '  <path d="M2 2 L20 20"   stroke="#d75a5a"  stroke-width="2"/>\n</svg>\n')
    open(f'{OUT}/notes.txt', 'w').write('line one   \n\n\n\nline two  \n' * 400)
    open(f'{OUT}/page.html', 'w').write(
        '<!doctype html>\n<html>\n  <head>\n    <!-- meta -->\n    <title>  A  page  </title>\n  </head>\n'
        '  <body>\n    <h1> Hello </h1>\n\n\n    <p>  text  </p>\n  </body>\n</html>\n')
    open(f'{OUT}/theme.css', 'w').write(
        '/* theme */\n:root {\n  --accent : #D75A5A ;\n}\n\nbody {\n  margin : 0 ;\n  color : #111 ;\n}\n')
    open(f'{OUT}/app.js', 'w').write(
        '// a comment\nconst  greet = ( name ) => {\n  /* block */\n  return  "hi " + name ;\n} ;\n\n'
        'const re = /ab+c/ ;\nconst t = `template ${greet("x")}` ;\nconsole.log(greet("world"), re, t) ;\n')


def make_variants():
    """qpdf-derived structural variants + broken/encrypted edge cases"""
    def run(*args):
        try:
            subprocess.run(args, check=True, capture_output=True)
        except Exception as e:
            print('  ! qpdf unavailable:', e)

    run('qpdf', '--object-streams=generate', f'{OUT}/text.pdf', f'{OUT}/text_objstm.pdf')
    run('qpdf', '--linearize', f'{OUT}/photos.pdf', f'{OUT}/photos_lin.pdf')
    run('qpdf', '--object-streams=generate', f'{OUT}/photos.pdf', f'{OUT}/photos_objstm.pdf')
    run('qpdf', '--qdf', '--object-streams=disable', f'{OUT}/scan.pdf', f'{OUT}/scan_qdf.pdf')
    run('qpdf', '--encrypt', 'user', 'owner', '256', '--', f'{OUT}/scan.pdf', f'{OUT}/encrypted.pdf')
    # one file per encryption scheme, so the Unlock tool is proven against all of them.
    # The wrong-password cases need --allow-weak-crypto on modern qpdf.
    enc = [
        (['--allow-weak-crypto', '--encrypt', 'user1', 'owner1', '40', '--'], 'enc_rc4_40.pdf'),
        (['--allow-weak-crypto', '--encrypt', 'user1', 'owner1', '128', '--'], 'enc_rc4_128.pdf'),
        (['--allow-weak-crypto', '--encrypt', 'user1', 'owner1', '128', '--use-aes=y', '--'], 'enc_aes128.pdf'),
        (['--encrypt', 'user1', 'owner1', '256', '--'], 'enc_aes256.pdf'),
    ]
    for args, name in enc:
        run('qpdf', *args, f'{OUT}/text.pdf', f'{OUT}/{name}')
    # permissions only: empty user password, owner password set (dashed args, no mixing)
    run('qpdf', '--encrypt', '--user-password=', '--owner-password=owner1', '--bits=256', '--',
        f'{OUT}/text.pdf', f'{OUT}/enc_owner_only.pdf')

    with open(f'{OUT}/photos.pdf', 'rb') as f:
        data = f.read(5000)
    open(f'{OUT}/broken.pdf', 'wb').write(data)

    # damaged but recoverable: valid objects, a wrong startxref and junk after %%EOF
    raw = open(f'{OUT}/text.pdf', 'rb').read()
    i = raw.rfind(b'startxref')
    open(f'{OUT}/damaged.pdf', 'wb').write(
        raw[:i] + b'startxref\n999999\n%%EOF\nGARBAGE-AFTER-EOF-' + b'x' * 200)


if __name__ == '__main__':
    make_images()
    make_pdfs()
    make_office()
    make_text()
    make_variants()
    files = sorted(os.listdir(OUT))
    print(f'{len(files)} fixtures → {OUT}')
    for f in files:
        print(f'  {f:22s} {os.path.getsize(os.path.join(OUT, f)) / 1024:10.1f} KB')
