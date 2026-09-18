const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");
const puppeteer = require("puppeteer");
const pm = require("pixelmatch");
const pixelmatch = pm.default || pm;
const {PNG} = require("pngjs");

const root = path.resolve(process.argv[2] || "portecriativo-final");
const auditDir = path.join(root,"audit");
fs.mkdirSync(auditDir,{recursive:true});
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const server = spawn(process.execPath,["server.js","4173"],{
  cwd:root,
  stdio:["ignore",fs.openSync(path.join(auditDir,"server.log"),"w"),fs.openSync(path.join(auditDir,"server.err.log"),"w")]
});

async function waitServer(){
  for(let i=0;i<80;i++){
    try{const r=await fetch("http://127.0.0.1:4173/");if(r.ok)return;}
    catch{}
    await sleep(250);
  }
  throw new Error("local server did not start");
}

async function preparePage(page, offline){
  await page.evaluateOnNewDocument(()=>{
    let seed=123456789;
    Math.random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
  });
  const requests=[], failed=[], consoleErrors=[], pageErrors=[];
  page.on("requestfailed",r=>failed.push({url:r.url(),error:r.failure()?.errorText||""}));
  page.on("console",m=>{if(m.type()==="error")consoleErrors.push(m.text())});
  page.on("pageerror",e=>pageErrors.push(String(e)));
  if(offline){
    await page.setRequestInterception(true);
    page.on("request",req=>{
      const u=req.url();
      requests.push(u);
      if(u.startsWith("http://127.0.0.1:4173")||u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("about:")){
        req.continue();
      }else{
        req.abort("blockedbyclient");
      }
    });
  }else{
    page.on("request",r=>requests.push(r.url()));
  }
  return {requests,failed,consoleErrors,pageErrors};
}

async function clickEntrance(page){
  await page.evaluate(()=>{
    const nodes=[...document.querySelectorAll("button,a,[role=button],div,p")];
    const e=nodes.find(x=>(x.textContent||"").trim().toUpperCase()==="ENTRAR NA EXPERIÊNCIA");
    if(e && typeof e.click==="function") e.click();
  }).catch(()=>{});
  await sleep(1100);
}

async function settle(page){
  await page.evaluate(async()=>{
    try{if(document.fonts?.ready)await document.fonts.ready}catch{}
    for(const v of document.querySelectorAll("video")){
      try{v.pause();v.currentTime=0}catch{}
    }
  }).catch(()=>{});
  await page.addStyleTag({content:"html{scroll-behavior:auto!important}*{caret-color:transparent!important}"}).catch(()=>{});
}

async function loadAll(page){
  await page.evaluate(async()=>{
    const max=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight);
    const step=Math.max(450,innerHeight*.72);
    for(let y=0;y<max;y+=step){
      scrollTo(0,y);
      await new Promise(r=>setTimeout(r,55));
    }
    scrollTo(0,0);
  }).catch(()=>{});
  await sleep(900);
}

async function facts(page){
  return await page.evaluate(()=>({
    title:document.title,
    bodyWidth:document.body.scrollWidth,
    docWidth:document.documentElement.scrollWidth,
    height:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight),
    canvases:document.querySelectorAll("canvas").length,
    videos:document.querySelectorAll("video").length,
    images:document.images.length,
    forms:document.querySelectorAll("form").length,
    links:document.querySelectorAll("a").length,
    textLength:(document.body.innerText||"").length,
    platformBadgeText:(document.body.innerText||"").includes("Create a free website with Framer")
  }));
}

function diffPng(aPath,bPath,diffPath){
  const a=PNG.sync.read(fs.readFileSync(aPath));
  const b=PNG.sync.read(fs.readFileSync(bPath));
  const w=Math.max(a.width,b.width),h=Math.max(a.height,b.height);
  const aa=new PNG({width:w,height:h}), bb=new PNG({width:w,height:h}), dd=new PNG({width:w,height:h});
  aa.data.fill(255);bb.data.fill(255);
  PNG.bitblt(a,aa,0,0,a.width,a.height,0,0);
  PNG.bitblt(b,bb,0,0,b.width,b.height,0,0);
  const n=pixelmatch(aa.data,bb.data,dd.data,w,h,{threshold:.12,includeAA:false});
  fs.writeFileSync(diffPath,PNG.sync.write(dd));
  return {source:[a.width,a.height],local:[b.width,b.height],mismatched:n,total:w*h,ratio:n/(w*h)};
}

async function inspect(page,url,offline){
  const network=await preparePage(page,offline);
  let status=null,navError=null;
  try{
    const r=await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
    status=r?.status()||null;
    await sleep(1600);
    await clickEntrance(page);
    await settle(page);
    await loadAll(page);
  }catch(e){navError=String(e)}
  return {...network,status,navError,facts:await facts(page).catch(()=>null)};
}

async function interactions(browser){
  const p=await browser.newPage();
  await p.setViewport({width:1440,height:900});
  await p.setRequestInterception(true);
  const external=[];
  p.on("request",req=>{
    const u=req.url();
    if(u.startsWith("http://127.0.0.1:4173")||u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("about:"))req.continue();
    else{external.push(u);req.abort("blockedbyclient")}
  });
  const errors=[];
  p.on("pageerror",e=>errors.push(String(e)));
  p.on("console",m=>{if(m.type()==="error")errors.push(m.text())});
  await p.goto("http://127.0.0.1:4173/",{waitUntil:"domcontentloaded",timeout:60000});
  await sleep(1500);await clickEntrance(p);await sleep(600);

  const before=await p.evaluate(()=>({
    faq:[...document.querySelectorAll("*")].some(e=>(e.textContent||"").trim()==="Como funciona o orçamento?"),
    canvas:document.querySelectorAll("canvas").length,
    video:document.querySelectorAll("video").length,
    form:document.querySelectorAll("form").length
  }));

  const faq=await p.evaluate(()=>{
    const e=[...document.querySelectorAll("*")].find(x=>(x.textContent||"").trim()==="Como funciona o orçamento?");
    if(!e)return {found:false};
    let t=e;
    for(let i=0;i<5&&t;i++,t=t.parentElement){
      const c=getComputedStyle(t);
      if(c.cursor==="pointer"||t.getAttribute("role")==="button"||t.tagName==="BUTTON")break;
    }
    t=t||e;
    const b=t.getBoundingClientRect();
    const before={h:b.height,aria:t.getAttribute("aria-expanded")};
    t.click();
    return {found:true,before};
  });
  await sleep(650);
  if(faq.found){
    faq.after=await p.evaluate(()=>{
      const e=[...document.querySelectorAll("*")].find(x=>(x.textContent||"").trim()==="Como funciona o orçamento?");
      let t=e;
      for(let i=0;i<5&&t;i++,t=t.parentElement){
        const c=getComputedStyle(t);
        if(c.cursor==="pointer"||t.getAttribute("role")==="button"||t.tagName==="BUTTON")break;
      }
      t=t||e;
      const b=t.getBoundingClientRect();
      return {h:b.height,aria:t.getAttribute("aria-expanded")};
    });
  }

  const menu=await p.evaluate(()=>{
    const candidates=[...document.querySelectorAll("a,button,[role=button],div")];
    const e=candidates.find(x=>(x.textContent||"").trim()==="PORTECRIATIVO");
    if(!e)return {found:false};
    const before=document.body.innerText.length;
    e.click();
    return {found:true,before};
  });
  await sleep(500);
  if(menu.found)menu.after=await p.evaluate(()=>document.body.innerText.length);

  const link=await p.$('a[href^="/"],a[href^="#"]');
  let hover={found:false};
  if(link){
    hover={found:true,before:await link.evaluate(e=>({transform:getComputedStyle(e).transform,opacity:getComputedStyle(e).opacity}))};
    await link.hover();await sleep(300);
    hover.after=await link.evaluate(e=>({transform:getComputedStyle(e).transform,opacity:getComputedStyle(e).opacity}));
  }

  let drag={found:false};
  const canvas=await p.$("canvas");
  if(canvas){
    const b=await canvas.boundingBox();
    if(b){
      drag={found:true};
      await p.mouse.move(b.x+b.width*.45,b.y+b.height*.5);
      await p.mouse.down();
      await p.mouse.move(b.x+b.width*.62,b.y+b.height*.58,{steps:8});
      await p.mouse.up();await sleep(350);
      drag.completed=true;
    }
  }
  await p.close();

  const formResponse=await fetch("http://127.0.0.1:4173/offline-form",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({audit:true})
  });
  return {
    before,faq,menu,hover,drag,
    externalRequests:[...new Set(external)],
    errors:[...new Set(errors)],
    offlineForm:{status:formResponse.status,body:await formResponse.text()}
  };
}

(async()=>{
  await waitServer();
  const browser=await puppeteer.launch({
    headless:true,protocolTimeout:180000,
    args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });
  const routes=[
    {name:"home",source:"https://portecriativo.framer.website/",local:"/"},
    {name:"cases",source:"https://portecriativo.framer.website/cases",local:"/cases"},
    {name:"volt",source:"https://portecriativo.framer.website/cases/volt",local:"/cases/volt"}
  ];
  const viewports=[
    {name:"mobile",width:390,height:855},
    {name:"tablet",width:810,height:825},
    {name:"laptop",width:1200,height:825},
    {name:"desktop",width:1600,height:825}
  ];
  const cases=[];

  for(const route of routes){
    for(const vp of viewports){
      const src=await browser.newPage(),loc=await browser.newPage();
      await src.setViewport(vp);await loc.setViewport(vp);
      const s=await inspect(src,route.source,false);
      const l=await inspect(loc,"http://127.0.0.1:4173"+route.local,true);
      const base=route.name+"-"+vp.name;
      const sp=path.join(auditDir,base+"-source.png");
      const lp=path.join(auditDir,base+"-local.png");
      const dp=path.join(auditDir,base+"-diff.png");
      await src.screenshot({path:sp,fullPage:true});
      await loc.screenshot({path:lp,fullPage:true});
      const visual=diffPng(sp,lp,dp);
      if(vp.name!=="desktop"){fs.unlinkSync(sp);fs.unlinkSync(lp)}
      const external=l.requests.filter(u=>
        !u.startsWith("http://127.0.0.1:4173")&&!u.startsWith("data:")&&
        !u.startsWith("blob:")&&!u.startsWith("about:")
      );
      cases.push({route:route.name,viewport:vp,source:s,local:l,
        externalRuntimeRequests:[...new Set(external)],visual});
      await src.close();await loc.close();
    }
  }

  const interaction=await interactions(browser);
  await browser.close();
  server.kill("SIGTERM");

  const summary={
    generatedAt:new Date().toISOString(),
    allLocalStatusesOk:cases.every(x=>x.local.status && x.local.status<400),
    externalRuntimeRequestCount:cases.reduce((n,x)=>n+x.externalRuntimeRequests.length,0)+interaction.externalRequests.length,
    localPageErrorCount:cases.reduce((n,x)=>n+x.local.pageErrors.length,0)+interaction.errors.length,
    localConsoleErrorCount:cases.reduce((n,x)=>n+x.local.consoleErrors.length,0),
    maxVisualMismatch:Math.max(...cases.map(x=>x.visual.ratio)),
    avgVisualMismatch:cases.reduce((n,x)=>n+x.visual.ratio,0)/cases.length,
    interaction,cases
  };
  fs.writeFileSync(path.join(root,"AUDIT-REPORT.json"),JSON.stringify(summary,null,2));
  console.log(JSON.stringify({
    allLocalStatusesOk:summary.allLocalStatusesOk,
    externalRuntimeRequestCount:summary.externalRuntimeRequestCount,
    localPageErrorCount:summary.localPageErrorCount,
    localConsoleErrorCount:summary.localConsoleErrorCount,
    maxVisualMismatch:summary.maxVisualMismatch,
    avgVisualMismatch:summary.avgVisualMismatch,
    interaction:summary.interaction
  },null,2));
  if(!summary.allLocalStatusesOk || interaction.offlineForm.status!==200)process.exitCode=2;
})().catch(e=>{
  console.error(e);
  try{server.kill("SIGTERM")}catch{}
  process.exit(1);
});
