const { chromium, devices } = require('playwright');
const http=require('http'), fs=require('fs'), path=require('path');
const ROOT = path.join(__dirname, '..');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
  let u=decodeURIComponent(req.url.split('?')[0]);
  if(u.endsWith('/')) u+='index.html';
  const f=path.join(ROOT,u);
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('nf');}
  res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});
const FILES=['photos.pdf','photo1.jpg','report.docx','text.pdf'].map(f=>path.join(__dirname,'fixtures',f));

const results = [];
async function scenario(browser, name, {init, viewport, ua, preset='p50'}={}) {
  const ctx = await browser.newContext({ viewport: viewport||{width:1400,height:1000}, userAgent: ua });
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errs.push(m.text());});
  if (init) await p.addInitScript(init);
  await p.goto(`http://127.0.0.1:${PORT}/compress/`);
  await p.waitForTimeout(300);
  const caps = await p.textContent('#caps');
  await p.click(`.preset[data-id="${preset}"]`);
  const t0=Date.now();
  await p.setInputFiles('#fileInput', FILES);
  await p.waitForFunction(()=>{const r=[...document.querySelectorAll('.row')];return r.length===4&&r.every(x=>x.classList.contains('done')||x.querySelector('.badge.err'));},null,{timeout:240000});
  const ms=Date.now()-t0;
  const rows=await p.evaluate(()=>[...document.querySelectorAll('.row')].map(r=>({t:r.innerText.replace(/\n/g,' '), err:!!r.querySelector('.badge.err')})));
  console.log(`\n[${name}]  ${ms} ms   caps: ${caps}`);
  rows.forEach(r=>console.log('   ', r.t));
  const failed = rows.filter(r => r.err);
  const ok = rows.length === 4 && failed.length === 0 && errs.length === 0;
  results.push({ name, ok, ms, caps });
  if (errs.length) console.log('   JS ERRORS:', errs.join(' | '));
  console.log(`   ${ok ? 'PASS' : 'FAIL'}`);
  await ctx.close();
  return ms;
}

const PORT = 8092 + Math.floor(Math.random() * 200);
server.listen(PORT, async ()=>{
  const b=await chromium.launch({args:['--no-sandbox']});
  await scenario(b, 'normal (native + worker)');
  await scenario(b, 'no CompressionStream → JS codec', {init: () => {
    try { delete window.CompressionStream; delete window.DecompressionStream; } catch(e){}
    window.CompressionStream = undefined; window.DecompressionStream = undefined;
  }});
  await scenario(b, 'no Worker → main thread', {init: () => { window.Worker = undefined; }});
  await scenario(b, 'no native streams + no worker', {init: () => {
    window.CompressionStream = undefined; window.DecompressionStream = undefined; window.Worker = undefined;
  }});
  await scenario(b, 'no OffscreenCanvas in worker → canvas fallback', {init: () => {
    // workers inherit this initScript; removing OffscreenCanvas forces NO_CANVAS → page fallback
    window.OffscreenCanvas = undefined;
  }});
  await scenario(b, 'iPhone 13 (touch, mobile profile)', {
    ...devices['iPhone 13'], preset:'extreme'
  });
  await b.close(); server.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} device scenarios passed`);
  if (bad.length) process.exitCode = 1;
});
