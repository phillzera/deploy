const fs=require("fs"),path=require("path"),{spawn}=require("child_process");
const puppeteer=require("puppeteer"),pm=require("pixelmatch"),pixelmatch=pm.default||pm,{PNG}=require("pngjs");
const root=path.resolve(process.argv[2]||"portecriativo-final"),out=path.join(root,"audit-cdp");fs.mkdirSync(out,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=spawn(process.execPath,["server.js","4174"],{cwd:root,stdio:["ignore","pipe","pipe"]});
let serverLog=""; server.stdout.on("data",d=>serverLog+=d); server.stderr.on("data",d=>serverLog+=d);

async function waitServer(){for(let i=0;i<120;i++){try{if((await fetch("http://127.0.0.1:4174/")).ok)return}catch{}await sleep(250)}throw Error("local server did not start")}
function allowedLocal(u){return u.startsWith("http://127.0.0.1:4174")||u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("about:")||u.startsWith("devtools:")}
async function attach(page,offline=false){
  const c=await page.createCDPSession(),info={external:[],failed:[],console:[],exceptions:[]};
  await Promise.all([c.send("Page.enable"),c.send("DOM.enable"),c.send("Network.enable"),c.send("Runtime.enable"),c.send("Accessibility.enable")]);
  c.on("Runtime.consoleAPICalled",e=>{if(e.type==="error") info.console.push((e.args||[]).map(a=>a.value||a.description||a.type).join(" "))});
  c.on("Runtime.exceptionThrown",e=>info.exceptions.push(e.exceptionDetails?.text||e.exceptionDetails?.exception?.description||"exception"));
  c.on("Network.loadingFailed",e=>{if(!e.canceled)info.failed.push(e.errorText||"failed")});
  if(offline){
    await c.send("Fetch.enable",{patterns:[{urlPattern:"http://*",requestStage:"Request"},{urlPattern:"https://*",requestStage:"Request"}]});
    c.on("Fetch.requestPaused",async e=>{
      const u=e.request.url;
      try{
        if(allowedLocal(u)) await c.send("Fetch.continueRequest",{requestId:e.requestId});
        else {info.external.push(u);await c.send("Fetch.failRequest",{requestId:e.requestId,errorReason:"BlockedByClient"})}
      }catch{}
    });
  }
  return {c,info};
}
async function ax(c){try{return (await c.send("Accessibility.getFullAXTree")).nodes||[]}catch{return []}}
function axName(n){return typeof n.name?.value==="string"?n.name.value.trim():""}
async function clickAx(c,text){
  const nodes=await ax(c); const exact=text.trim().toUpperCase();
  const matches=nodes.filter(n=>axName(n).toUpperCase()===exact&&n.backendDOMNodeId);
  for(const n of matches){
    try{
      const bm=await c.send("DOM.getBoxModel",{backendNodeId:n.backendDOMNodeId});
      const q=bm.model.border; if(!q||q.length<8)continue;
      const xs=[q[0],q[2],q[4],q[6]],ys=[q[1],q[3],q[5],q[7]],x=xs.reduce((a,b)=>a+b,0)/4,y=ys.reduce((a,b)=>a+b,0)/4;
      if(x<0||y<0)continue;
      await c.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
      await c.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});
      await c.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1});
      return {clicked:true,x,y,role:n.role?.value||null,backendDOMNodeId:n.backendDOMNodeId};
    }catch{}
  }
  return {clicked:false};
}
async function hoverAx(c,text){
  const nodes=await ax(c),exact=text.trim().toUpperCase();
  for(const n of nodes.filter(n=>axName(n).toUpperCase()===exact&&n.backendDOMNodeId)){
    try{const bm=await c.send("DOM.getBoxModel",{backendNodeId:n.backendDOMNodeId});const q=bm.model.border;const x=(q[0]+q[2]+q[4]+q[6])/4,y=(q[1]+q[3]+q[5]+q[7])/4;await c.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});return {hovered:true,x,y}}catch{}
  } return {hovered:false};
}
async function elementCount(c,selector){
  const doc=await c.send("DOM.getDocument",{depth:1,pierce:true}); const r=await c.send("DOM.querySelectorAll",{nodeId:doc.root.nodeId,selector});return (r.nodeIds||[]).length;
}
async function firstBox(c,selector){
  const doc=await c.send("DOM.getDocument",{depth:1,pierce:true});const q=await c.send("DOM.querySelector",{nodeId:doc.root.nodeId,selector});
  if(!q.nodeId)return null;try{const bm=await c.send("DOM.getBoxModel",{nodeId:q.nodeId});const b=bm.model.border;return {nodeId:q.nodeId,x:(b[0]+b[2]+b[4]+b[6])/4,y:(b[1]+b[3]+b[5]+b[7])/4,w:Math.max(b[0],b[2],b[4],b[6])-Math.min(b[0],b[2],b[4],b[6]),h:Math.max(b[1],b[3],b[5],b[7])-Math.min(b[1],b[3],b[5],b[7])}}catch{return null}
}
async function pageMetrics(c){
  const m=await c.send("Page.getLayoutMetrics"),nodes=await ax(c);
  return {height:Math.round(m.cssContentSize?.height||m.contentSize?.height||0),width:Math.round(m.cssContentSize?.width||m.contentSize?.width||0),
    canvas:await elementCount(c,"canvas"),video:await elementCount(c,"video"),img:await elementCount(c,"img"),form:await elementCount(c,"form"),
    badge:nodes.some(n=>axName(n).includes("Create a free website with Framer"))};
}
async function open(page,c,url){
  const r=await page.goto(url,{waitUntil:"domcontentloaded",timeout:90000}); await sleep(2200);
  const entry=await clickAx(c,"ENTRAR NA EXPERIÊNCIA"); if(entry.clicked) await sleep(1200);
  return {status:r?.status()||0,entry};
}
async function scrollToApprox(c,current,target,w,h){
  let delta=target-current;if(Math.abs(delta)<2)return target;
  const step=delta>0?Math.min(1600,delta):Math.max(-1600,delta); let moved=0;
  while(Math.abs(delta-moved)>2){
    const d=delta>0?Math.min(step,delta-moved):Math.max(step,delta-moved);
    await c.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:Math.max(1,w/2),y:Math.max(1,h/2),deltaX:0,deltaY:d});
    moved+=d;await sleep(40);
    if(Math.abs(moved)>=Math.abs(delta))break;
  }
  await sleep(250);return target;
}
async function shot(c,file){
  const s=await c.send("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false});
  fs.writeFileSync(file,Buffer.from(s.data,"base64"));
}
function diff(a,b){
  const A=PNG.sync.read(fs.readFileSync(a)),B=PNG.sync.read(fs.readFileSync(b)); if(A.width!==B.width||A.height!==B.height)return {ratio:1,pixels:null,total:null,sizeMismatch:[A.width,A.height,B.width,B.height]};
  const D=new PNG({width:A.width,height:A.height});const n=pixelmatch(A.data,B.data,D.data,A.width,A.height,{threshold:.13,includeAA:false});
  return {ratio:n/(A.width*A.height),pixels:n,total:A.width*A.height};
}
async function dragFirstCanvas(c){
  const b=await firstBox(c,"canvas"); if(!b||b.w<2||b.h<2)return {found:false,completed:false};
  const x1=b.x-b.w*.18,y1=b.y,x2=b.x+b.w*.18,y2=b.y+b.h*.05;
  try{
    await c.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x1,y:y1});
    await c.send("Input.dispatchMouseEvent",{type:"mousePressed",x:x1,y:y1,button:"left",clickCount:1});
    for(let i=1;i<=8;i++)await c.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x1+(x2-x1)*i/8,y:y1+(y2-y1)*i/8,button:"left",buttons:1});
    await c.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:x2,y:y2,button:"left",clickCount:1});
    return {found:true,completed:true};
  }catch(e){return {found:true,completed:false,error:String(e)}}
}
(async()=>{
  await waitServer();
  const browser=await puppeteer.launch({headless:true,protocolTimeout:600000,args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]});
  const routes=[["home","https://portecriativo.framer.website/","/"],["cases","https://portecriativo.framer.website/cases","/cases"],["volt","https://portecriativo.framer.website/cases/volt","/cases/volt"],["404","https://portecriativo.framer.website/404","/404"]];
  const vps=[["mobile",390,855],["tablet",810,825],["laptop",1200,825],["desktop",1600,825]],results=[];
  for(const [rn,srcurl,locurl] of routes) for(const [vn,w,h] of vps){
    const rec={route:rn,viewport:vn,width:w,height:h,diffs:[]}; let s,l;
    try{
      s=await browser.newPage();l=await browser.newPage();await s.setViewport({width:w,height:h,deviceScaleFactor:1});await l.setViewport({width:w,height:h,deviceScaleFactor:1});
      const S=await attach(s,false),L=await attach(l,true); rec.source=(await open(s,S.c,srcurl));rec.local=(await open(l,L.c,"http://127.0.0.1:4174"+locurl));
      rec.sourceMetrics=await pageMetrics(S.c);rec.localMetrics=await pageMetrics(L.c);
      const fractions=rn==="home"?[0,.25,.5,.75,.96]:[0,.5,.96];let sy=0,ly=0;
      for(let i=0;i<fractions.length;i++){
        const f=fractions[i],st=Math.max(0,(rec.sourceMetrics.height-h)*f),lt=Math.max(0,(rec.localMetrics.height-h)*f);
        sy=await scrollToApprox(S.c,sy,st,w,h);ly=await scrollToApprox(L.c,ly,lt,w,h);
        const a=path.join(out,`${rn}-${vn}-${i}-source.png`),b=path.join(out,`${rn}-${vn}-${i}-local.png`);
        await shot(S.c,a);await shot(L.c,b);rec.diffs.push({fraction:f,...diff(a,b)});
      }
      rec.localRuntimeExternal=[...new Set(L.info.external)];rec.localFailed=[...new Set(L.info.failed)];rec.localConsole=[...new Set(L.info.console)];rec.localExceptions=[...new Set(L.info.exceptions)];
    }catch(e){rec.auditError=String(e?.stack||e)}finally{if(s)await s.close().catch(()=>{});if(l)await l.close().catch(()=>{})}
    results.push(rec); console.log("AUDITED",rn,vn,rec.auditError||"ok");
  }

  const p=await browser.newPage();await p.setViewport({width:1440,height:900});const P=await attach(p,true);let interaction={};
  try{
    interaction.open=await open(p,P.c,"http://127.0.0.1:4174/");
    interaction.hoverLogo=await hoverAx(P.c,"PORTECRIATIVO");
    const before=(await P.c.send("Page.getLayoutMetrics")).cssContentSize?.height||0;
    interaction.faqClick=await clickAx(P.c,"Como funciona o orçamento?");await sleep(500);
    const after=(await P.c.send("Page.getLayoutMetrics")).cssContentSize?.height||0;interaction.faqLayoutDelta=Math.round(after-before);
    interaction.drag=await dragFirstCanvas(P.c);
    interaction.counts={canvas:await elementCount(P.c,"canvas"),video:await elementCount(P.c,"video"),form:await elementCount(P.c,"form")};
    interaction.external=[...new Set(P.info.external)];interaction.exceptions=[...new Set(P.info.exceptions)];interaction.console=[...new Set(P.info.console)];
  }catch(e){interaction.error=String(e?.stack||e)}
  await p.close().catch(()=>{});

  const fr=await fetch("http://127.0.0.1:4174/offline-form",{method:"POST",headers:{"content-type":"application/json"},body:'{"audit":true}'});
  interaction.formEndpoint={status:fr.status,body:await fr.text()};
  await browser.close();server.kill("SIGTERM");

  const valid=results.filter(x=>!x.auditError&&x.diffs?.length),allDiffs=valid.flatMap(x=>x.diffs.map(d=>d.ratio));
  const report={
    generatedAt:new Date().toISOString(),
    allCasesCompleted:results.every(x=>!x.auditError),
    allLocalStatusesOk:results.every(x=>x.local&&x.local.status<400),
    externalRuntimeRequests:results.reduce((n,x)=>n+(x.localRuntimeExternal?.length||0),0)+(interaction.external?.length||0),
    pageExceptions:results.reduce((n,x)=>n+(x.localExceptions?.length||0),0)+(interaction.exceptions?.length||0),
    consoleErrors:results.reduce((n,x)=>n+(x.localConsole?.length||0),0)+(interaction.console?.length||0),
    maxSliceMismatch:allDiffs.length?Math.max(...allDiffs):null,
    avgSliceMismatch:allDiffs.length?allDiffs.reduce((a,b)=>a+b,0)/allDiffs.length:null,
    interaction,results,serverLog
  };
  fs.writeFileSync(path.join(root,"AUDIT-CDP.json"),JSON.stringify(report,null,2));
  console.log("FINAL_AUDIT",JSON.stringify({allCasesCompleted:report.allCasesCompleted,allLocalStatusesOk:report.allLocalStatusesOk,externalRuntimeRequests:report.externalRuntimeRequests,pageExceptions:report.pageExceptions,consoleErrors:report.consoleErrors,maxSliceMismatch:report.maxSliceMismatch,avgSliceMismatch:report.avgSliceMismatch,interaction},null,2));
  if(!report.allCasesCompleted||!report.allLocalStatusesOk||report.externalRuntimeRequests>0||interaction.formEndpoint.status!==200)process.exitCode=2;
})().catch(e=>{console.error(e);try{server.kill("SIGTERM")}catch{};process.exit(1)});
