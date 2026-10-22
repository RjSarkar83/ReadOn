#!/usr/bin/env node
/* Bundles the sources into one self-contained index.html (no CDN, no build step needed).
   The compression engine is also bundled a second time as a Web-Worker payload, embedded
   in the page as an inert <script type="text/plain"> block. */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const lib = ['codec-js.js', 'util.js', 'crypto.js', 'filters.js', 'font.js', 'png.js', 'jpeg.js', 'zip.js', 'pdf.js', 'pdfedit.js', 'imaging.js', 'imageops.js', 'textops.js'];
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const libs = lib.map(f => read('src/lib/' + f));
const engine = read('src/engine.js');
const css = read('src/app.css');

const tools = read('src/tools.js');
const pageJs = [...libs, engine, tools, read('src/app.js')].join('\n\n');
const workerJs = [...libs, engine, tools, read('src/worker.boot.js')].join('\n\n')
  // a literal </script> inside the inert block would close it early
  .replace(/<\/script/gi, '<\\/script');

const html = read('src/index.template.html')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => pageJs)
  .replace('/*__WORKER__*/', () => workerJs);

const out = path.join(root, 'index.html');
fs.writeFileSync(out, html);
const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`built ${out} — ${kb} KB (page ${(pageJs.length / 1024).toFixed(0)} KB + worker ${(workerJs.length / 1024).toFixed(0)} KB)`);
