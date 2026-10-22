/* assets/make_icons.js — one source of truth for every icon we ship.
 *
 *   node assets/make_icons.js        (needs playwright + chromium)
 *
 * The mark is vector (assets/readon-mark.svg). Everything else — the PWA icons, the
 * favicons, the maskable icon, the social card — is rendered from that same geometry,
 * so the logo can never drift between the header, the tab and the home screen.
 */
const { chromium } = require('/home/user/qa/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DARK = '#2E3135';           // --s1 of the ReadOn theme
const PAPER = '#F4F0EA';

/* the mark itself: leaves (currentColor), ribbon gradient, red arrow */
const GEOM = (leaf) => `
  <path fill="${leaf}" d="M232 228C212 178 178 152 134 152C84 152 47 186 47 228C47 270 84 304 134 304C178 304 212 278 232 228Z"/>
  <path fill="${leaf}" d="M280 228C300 178 334 152 378 152C428 152 465 186 465 228C465 270 428 304 378 304C334 304 300 278 280 228Z"/>
  <path fill="none" stroke="url(#g)" stroke-width="23" stroke-linecap="round"
        d="M14 264C14 174 63 106 130 106C191 106 230 172 256 234C282 172 321 106 382 106C449 106 498 174 498 264"/>
  <path fill="none" stroke="#FFF3C4" stroke-width="4" stroke-linecap="round" opacity=".45"
        d="M21 246C25 166 70 116 130 116C186 116 222 174 251 228"/>
  <path fill="#EE1111" d="M203 358H309L256 406Z"/>`;

const DEFS = `<defs>
    <linearGradient id="g" x1="10" y1="0" x2="502" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#F7B322"/><stop offset=".13" stop-color="#FFD23F"/>
      <stop offset=".37" stop-color="#E6721D"/><stop offset=".52" stop-color="#A6531C"/>
      <stop offset=".68" stop-color="#D9A518"/><stop offset=".85" stop-color="#FFD21E"/>
      <stop offset="1" stop-color="#EE9420"/>
    </linearGradient>
  </defs>`;

const mark = (leaf) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${DEFS}${GEOM(leaf)}</svg>`;

/* a square icon: mark centred at `scale` of the canvas (0.74 leaves room for the maskable safe area) */
const icon = (size, bg, scale, leaf) => {
  /* always authored in the 512-unit space, only the outer box changes — that keeps the
     mark identical at 16 px and at 512 px */
  const k = scale;
  const tx = (256 - k * 256).toFixed(2);
  const ty = (262 - k * 262).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  ${bg ? `<rect width="512" height="512" rx="112" fill="${bg}"/>` : ''}
  <g transform="matrix(${k} 0 0 ${k} ${tx} ${ty})">${DEFS}${GEOM(leaf)}</g>
</svg>`;
};

const targets = [
  ['assets/readon-mark.svg', mark(PAPER), 512, true],
  ['favicon.svg', icon(64, null, 0.96, PAPER), 64, true],
  ['icon-512.png', icon(512, DARK, 0.78, PAPER), 512, false],
  ['icon-192.png', icon(192, DARK, 0.78, PAPER), 192, false],
  ['icon-512-maskable.png', icon(512, DARK, 0.62, PAPER), 512, false],
  ['apple-touch-icon.png', icon(180, DARK, 0.80, PAPER), 180, false],
  ['favicon-32.png', icon(32, null, 0.96, PAPER), 32, true],
  ['favicon-16.png', icon(16, null, 0.96, PAPER), 16, true],
  ['screenshots/logo.png', icon(512, DARK, 0.78, PAPER), 512, false],
];

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const tmp = [];
  let idx = 0;
  for (const [file, svg, size, transparent] of targets) {
    if (file.endsWith('.svg')) { fs.writeFileSync(path.join(ROOT, file), svg + '\n'); continue; }
    /* Chromium lays out small viewports unreliably, so every PNG is rendered large
       and downscaled — the same trick that keeps 16 px favicons crisp. */
    const big = Math.max(512, size);
    const ctx = await browser.newContext({ viewport: { width: big, height: big }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const scaled = big === size ? svg
      : svg.replace(`viewBox="0 0 ${size} ${size}"`, `viewBox="0 0 ${size} ${size}"`)
           .replace(`width="${size}" height="${size}">`, `width="${big}" height="${big}">`);
    await page.setContent(`<body style="margin:0;background:transparent">${scaled}</body>`);
    await page.waitForTimeout(80);
    const raw = path.join(ROOT, `.icon-raw-${idx++}.png`);
    await page.screenshot({ path: raw, omitBackground: transparent });
    tmp.push([raw, path.join(ROOT, file), size]);
    await ctx.close();
  }

  /* social card — 1200x630, the mark beside the product statement */
  const c = await (await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })).newPage();
  await c.setContent(`<body style="margin:0;width:1200px;height:630px;background:${DARK};
      font-family:Montserrat,system-ui,sans-serif;color:${PAPER};display:flex;align-items:center;gap:64px;padding:0 96px;box-sizing:border-box">
    <div style="width:330px;flex:none">${mark(PAPER).replace('width="512" height="512"', 'width="330" height="330"')}</div>
    <div>
      <div style="font-size:15px;letter-spacing:7px;color:#D75A5A;font-weight:700">READON</div>
      <div style="font-size:76px;font-weight:800;letter-spacing:-1px;line-height:1.02;margin:14px 0 10px">108 tools.<br>One tab.</div>
      <div style="font-size:27px;line-height:1.45;color:#B9BCBF;font-weight:400">Compress, convert, protect and read —<br>100 % on your device. Nothing is uploaded.</div>
      <div style="margin-top:34px;font-size:19px;letter-spacing:3.5px;color:#8C9094">PDF · IMAGE · OFFICE · TEXT</div>
    </div>
  </body>`);
  await c.waitForTimeout(250);
  await c.screenshot({ path: path.join(ROOT, 'screenshots/og-card.png') });
  await browser.close();

  /* the app ships from three places (/ , /compress/ and /pwa/) — keep their icons identical */
  for (const dir of ['compress', 'pwa']) {
    for (const f of ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'favicon.svg',
                     'favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png']) {
      tmp.push([null, path.join(ROOT, dir, f), null, path.join(ROOT, f)]);
    }
  }
  fs.writeFileSync('/tmp/icon-jobs.json', JSON.stringify(tmp));
  console.log('rendered:', tmp.length, 'files');
})();
