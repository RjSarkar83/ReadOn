const { chromium } = require('playwright');
const http=require('http'), fs=require('fs'), path=require('path');
const ROOT = path.join(__dirname, '..');
const types={'.html':'text/html','.js':'text/javascript','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
  let u=decodeURIComponent(req.url.split('?')[0]); if(u.endsWith('/'))u+='index.html';
  const f=path.join(ROOT,u);
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});
const FILES=['text.pdf','photos.pdf','scan.pdf','text_objstm.pdf','photos_objstm.pdf','scan_qdf.pdf','diagram.pdf',
 'photo1.jpg','noise.png','diagram.png','report.docx','deck.pptx','data.xlsx',
 'real/arxiv.pdf','real/irs1040.pdf','real/textbook.pdf'].map(f=>path.join(__dirname,'fixtures',f));

async function run(browser,label,{noWorker=false,cores=8,preset='p50'}={}) {
  const ctx=await browser.newContext({viewport:{width:1400,height:1000}});
  const p=await ctx.newPage();
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.addInitScript(({noWorker,cores})=>{
    Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>cores});
    Object.defineProperty(navigator,'deviceMemory',{get:()=>8});
    if(noWorker) window.Worker=undefined;
  },{noWorker,cores});
  await p.goto(`http://127.0.0.1:${PORT}/compress/`);
  await p.waitForTimeout(200);
  await p.click(`.preset[data-id="${preset}"]`);
  const t0=Date.now();
  await p.setInputFiles('#fileInput',FILES);
  await p.waitForFunction(()=>{const r=[...document.querySelectorAll('.row')];return r.length===16&&r.every(x=>x.classList.contains('done'));},null,{timeout:600000});
  const ms=Date.now()-t0;
  // main-thread jank probe: how often did timers slip during the run?
  const totals=await p.evaluate(()=>({saved:document.querySelector('#totalSaved').textContent, caps:document.querySelector('#caps').textContent}));
  console.log(`${label.padEnd(34)} ${String(ms).padStart(6)} ms   ${totals.saved.padStart(7)}   [${totals.caps}]`);
  if(errs.length) console.log('  errors:',errs.join(' | '));
  await ctx.close();
  return ms;
}
const PORT = 8092 + Math.floor(Math.random() * 200);
server.listen(PORT, async ()=>{
  const b=await chromium.launch({args:['--no-sandbox']});
  const a=await run(b,'16 files · main thread only',{noWorker:true});
  const c=await run(b,'16 files · worker pool (4 lanes)',{cores:8});
  const d=await run(b,'16 files · worker pool, Extreme',{cores:8,preset:'extreme'});
  const e=await run(b,'16 files · main thread, Extreme',{noWorker:true,preset:'extreme'});
  console.log(`\nspeed-up (50%): ${(a/c).toFixed(1)}×   (extreme): ${(e/d).toFixed(1)}×`);
  await b.close(); server.close();
});
