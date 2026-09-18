const fs=require("fs"),path=require("path"),{spawn}=require("child_process");
const puppeteer=require("puppeteer"),pm=require("pixelmatch"),pixelmatch=pm.default||pm,{PNG}=require("pngjs");
const root=path.resolve(process.argv[2]||"portecriativo-final"),out=path.join(root,"audit-quick");fs.mkdirSync(out,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=spawn(process.execPath,["server.js","4174"],{cwd:root,stdio:"ignore"});

async function waitServer(){for(let i=0;i<80;i++){try{if((await fetch("http://127.0.0.1:4174/")).ok)return}catch{}await sleep(250)}throw Error("server")}
async function prep(p,offline){
  const info={external:[],errors:[],console:[]};
  p.on("pageerror",e=>info.errors.push(String(e)));
  p.on("console",m=>{if(m.type()==="error")info.console.push(m.text())});
  if(offline){await p.setRequestInterception(true);p.on("request",r=>{const u=r.url();if(u.startsWith("http://127.0.0.1:4174")||u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("about:"))r.continue();else{info.external.push(u);r.abort("blockedbyclient")}})}
  return info;
}
async function enter(p){await p.evaluate(()=>{const e=[...document.querySelectorAll("button,a,[role=button],div,p")].find(x=>(x.textContent||"").trim().toUpperCase()==="ENTRAR NA EXPERIÊNCIA");e?.click()}).catch(()=>{});await sleep(600)}
async function openPage(p,url){const r=await p.goto(url,{waitUntil:"domcontentloaded",timeout:60000});await sleep(1000);await enter(p);await p.evaluate(async()=>{try{if(document.fonts?.ready)await document.fonts.ready}catch{};for(const v of document.querySelectorAll("video")){try{v.pause();v.currentTime=0}catch{}}});return r?.status()}
function diff(a,b){const A=PNG.sync.read(fs.readFileSync(a)),B=PNG.sync.read(fs.readFileSync(b)),w=Math.max(A.width,B.width),h=Math.max(A.height,B.height),AA=new PNG({width:w,height:h}),BB=new PNG({width:w,height:h}),DD=new PNG({width:w,height:h});AA.data.fill(255);BB.data.fill(255);PNG.bitblt(A,AA,0,0,A.width,A.height,0,0);PNG.bitblt(B,BB,0,0,B.width,B.height,0,0);const n=pixelmatch(AA.data,BB.data,DD.data,w,h,{threshold:.12,includeAA:false});return {ratio:n/(w*h),pixels:n,total:w*h}}
async function metrics(p){return p.evaluate(()=>({height:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight),width:document.documentElement.scrollWidth,text:(document.body.innerText||"").length,canvas:document.querySelectorAll("canvas").length,video:document.querySelectorAll("video").length,img:document.images.length,form:document.querySelectorAll("form").length,badge:(document.body.innerText||"").includes("Create a free website with Framer")}))}
(async()=>{
 await waitServer();
 const browser=await puppeteer.launch({headless:true,protocolTimeout:180000,args:["--no-sandbox","--disable-dev-shm-usage"]});
 const routes=[["home","https://portecriativo.framer.website/","/"],["cases","https://portecriativo.framer.website/cases","/cases"],["volt","https://portecriativo.framer.website/cases/volt","/cases/volt"]];
 const vps=[["mobile",390,855],["tablet",810,825],["laptop",1200,825],["desktop",1600,825]];
 const fractions=[0,.25,.5,.75,.96],results=[];
 for(const [rn,srcurl,locurl] of routes)for(const [vn,w,h] of vps){
   const s=await browser.newPage(),l=await browser.newPage();await s.setViewport({width:w,height:h});await l.setViewport({width:w,height:h});
   const si=await prep(s,false),li=await prep(l,true);const ss=await openPage(s,srcurl),ls=await openPage(l,"http://127.0.0.1:4174"+locurl);const sm=await metrics(s),lm=await metrics(l),diffs=[];
   const fsx=rn==="home"?fractions:[0,.5,.96];
   for(const f of fsx){
     const sy=Math.max(0,(sm.height-h)*f),ly=Math.max(0,(lm.height-h)*f);await s.evaluate(y=>scrollTo(0,y),sy);await l.evaluate(y=>scrollTo(0,y),ly);await sleep(220);
     const a=path.join(out,"a.png"),b=path.join(out,"b.png");await s.screenshot({path:a});await l.screenshot({path:b});diffs.push({fraction:f,...diff(a,b)});fs.unlinkSync(a);fs.unlinkSync(b);
   }
   results.push({route:rn,viewport:vn,sourceStatus:ss,localStatus:ls,sourceMetrics:sm,localMetrics:lm,external:[...new Set(li.external)],errors:[...new Set(li.errors)],console:[...new Set(li.console)],diffs});
   await s.close();await l.close();
 }
 const p=await browser.newPage();await p.setViewport({width:1440,height:900});const ni=await prep(p,true);await openPage(p,"http://127.0.0.1:4174/");
 const interaction=await p.evaluate(async()=>{
   const out={canvas:document.querySelectorAll("canvas").length,video:document.querySelectorAll("video").length,form:document.querySelectorAll("form").length};
   const faq=[...document.querySelectorAll("*")].find(e=>(e.textContent||"").trim()==="Como funciona o orçamento?");
   if(faq){let t=faq;for(let i=0;i<6&&t;i++,t=t.parentElement){if(getComputedStyle(t).cursor==="pointer"||t.getAttribute("role")==="button"||t.tagName==="BUTTON")break}t=t||faq;const b=t.getBoundingClientRect().height;t.click();await new Promise(r=>setTimeout(r,400));out.faq={found:true,before:b,after:t.getBoundingClientRect().height,aria:t.getAttribute("aria-expanded")}}else out.faq={found:false};
   const c=document.querySelector("canvas");out.drag={found:!!c};return out;
 });
 let drag=false;const c=await p.$("canvas");if(c){const b=await c.boundingBox();if(b){await p.mouse.move(b.x+b.width*.4,b.y+b.height*.5);await p.mouse.down();await p.mouse.move(b.x+b.width*.65,b.y+b.height*.55,{steps:6});await p.mouse.up();drag=true}}
 interaction.drag.completed=drag;await p.close();
 const fr=await fetch("http://127.0.0.1:4174/offline-form",{method:"POST",headers:{"content-type":"application/json"},body:'{"audit":true}'});
 interaction.formEndpoint={status:fr.status,body:await fr.text()};
 await browser.close();server.kill("SIGTERM");
 const allDiffs=results.flatMap(x=>x.diffs.map(d=>d.ratio)),report={allStatusesOk:results.every(x=>x.localStatus<400),externalRuntimeRequests:results.reduce((n,x)=>n+x.external.length,0)+ni.external.length,pageErrors:results.reduce((n,x)=>n+x.errors.length,0)+ni.errors.length,consoleErrors:results.reduce((n,x)=>n+x.console.length,0)+ni.console.length,maxSliceMismatch:Math.max(...allDiffs),avgSliceMismatch:allDiffs.reduce((a,b)=>a+b,0)/allDiffs.length,interaction,results};
 fs.writeFileSync(path.join(root,"AUDIT-QUICK.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({allStatusesOk:report.allStatusesOk,externalRuntimeRequests:report.externalRuntimeRequests,pageErrors:report.pageErrors,consoleErrors:report.consoleErrors,maxSliceMismatch:report.maxSliceMismatch,avgSliceMismatch:report.avgSliceMismatch,interaction},null,2));
 if(!report.allStatusesOk||interaction.formEndpoint.status!==200)process.exitCode=2;
})().catch(e=>{console.error(e);try{server.kill("SIGTERM")}catch{};process.exit(1)});
