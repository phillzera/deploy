const fs=require("fs"),path=require("path"),{spawn}=require("child_process");
const puppeteer=require("puppeteer"),pm=require("pixelmatch"),pixelmatch=pm.default||pm,{PNG}=require("pngjs");
const root=path.resolve(process.argv[2]||"portecriativo-final"),out=path.join(root,"audit-cdp");fs.mkdirSync(out,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=spawn(process.execPath,["server.js","4174"],{cwd:root,stdio:["ignore","pipe","pipe"]});
let serverLog="";server.stdout.on("data",d=>serverLog+=d);server.stderr.on("data",d=>serverLog+=d);
async function waitServer(){for(let i=0;i<100;i++){try{if((await fetch("http://127.0.0.1:4174/")).ok)return}catch{}await sleep(200)}throw Error("local server did not start")}
function localOk(u){return u.startsWith("http://127.0.0.1:4174")||u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("about:")||u.startsWith("devtools:")}
async function attach(page,offline){
 const c=await page.createCDPSession(),info={external:[],failed:[],console:[],exceptions:[]};
 await Promise.all([c.send("Page.enable"),c.send("DOM.enable"),c.send("Network.enable"),c.send("Runtime.enable")]);
 c.on("Runtime.consoleAPICalled",e=>{if(e.type==="error")info.console.push((e.args||[]).map(a=>a.value||a.description||a.type).join(" "))});
 c.on("Runtime.exceptionThrown",e=>info.exceptions.push(e.exceptionDetails?.text||e.exceptionDetails?.exception?.description||"exception"));
 c.on("Network.loadingFailed",e=>{if(!e.canceled)info.failed.push(e.errorText||"failed")});
 if(offline){
   await c.send("Fetch.enable",{patterns:[{urlPattern:"http://*",requestStage:"Request"},{urlPattern:"https://*",requestStage:"Request"}]});
   c.on("Fetch.requestPaused",async e=>{try{if(localOk(e.request.url))await c.send("Fetch.continueRequest",{requestId:e.requestId});else{info.external.push(e.request.url);await c.send("Fetch.failRequest",{requestId:e.requestId,errorReason:"BlockedByClient"})}}catch{}});
 }
 return {c,info};
}
async function count(c,selector){const d=await c.send("DOM.getDocument",{depth:1,pierce:true});const q=await c.send("DOM.querySelectorAll",{nodeId:d.root.nodeId,selector});return (q.nodeIds||[]).length}
async function firstBox(c,selector){const d=await c.send("DOM.getDocument",{depth:1,pierce:true});const q=await c.send("DOM.querySelector",{nodeId:d.root.nodeId,selector});if(!q.nodeId)return null;try{const m=(await c.send("DOM.getBoxModel",{nodeId:q.nodeId})).model,b=m.border;return{x:(b[0]+b[2]+b[4]+b[6])/4,y:(b[1]+b[3]+b[5]+b[7])/4,w:Math.max(b[0],b[2],b[4],b[6])-Math.min(b[0],b[2],b[4],b[6]),h:Math.max(b[1],b[3],b[5],b[7])-Math.min(b[1],b[3],b[5],b[7])}}catch{return null}}
async function metrics(c){const m=await c.send("Page.getLayoutMetrics");return{height:Math.round(m.cssContentSize?.height||m.contentSize?.height||0),width:Math.round(m.cssContentSize?.width||m.contentSize?.width||0),canvas:await count(c,"canvas"),video:await count(c,"video"),img:await count(c,"img"),form:await count(c,"form")}}
async function click(c,x,y){await c.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});await c.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await c.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1})}
async function open(page,c,url,w,h){const r=await page.goto(url,{waitUntil:"domcontentloaded",timeout:70000});await sleep(1500);await click(c,w/2,Math.max(10,h*.86)).catch(()=>{});await sleep(800);return r?.status()||0}
async function scroll(c,from,to,w,h){let rem=to-from;if(Math.abs(rem)<2)return to;const sign=Math.sign(rem);while(Math.abs(rem)>2){const d=sign*Math.min(1400,Math.abs(rem));await c.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:w/2,y:h/2,deltaX:0,deltaY:d});rem-=d;await sleep(30)}await sleep(180);return to}
async function shot(c,file){const s=await c.send("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false});fs.writeFileSync(file,Buffer.from(s.data,"base64"))}
function diff(a,b){const A=PNG.sync.read(fs.readFileSync(a)),B=PNG.sync.read(fs.readFileSync(b));if(A.width!==B.width||A.height!==B.height)return{ratio:1,sizeMismatch:[A.width,A.height,B.width,B.height]};const D=new PNG({width:A.width,height:A.height}),n=pixelmatch(A.data,B.data,D.data,A.width,A.height,{threshold:.13,includeAA:false});return{ratio:n/(A.width*A.height),pixels:n,total:A.width*A.height}}
async function dragCanvas(c){const b=await firstBox(c,"canvas");if(!b||b.w<4||b.h<4)return{found:false,completed:false};const x1=b.x-b.w*.16,y1=b.y,x2=b.x+b.w*.16,y2=b.y+b.h*.04;try{await c.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x1,y:y1});await c.send("Input.dispatchMouseEvent",{type:"mousePressed",x:x1,y:y1,button:"left",clickCount:1});for(let i=1;i<=6;i++)await c.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x1+(x2-x1)*i/6,y:y1+(y2-y1)*i/6,button:"left",buttons:1});await c.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:x2,y:y2,button:"left",clickCount:1});return{found:true,completed:true}}catch(e){return{found:true,completed:false,error:String(e)}}}
(async()=>{
 await waitServer();
 const browser=await puppeteer.launch({headless:true,protocolTimeout:240000,args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]});
 const routes=[["home","https://portecriativo.framer.website/","/"],["cases","https://portecriativo.framer.website/cases","/cases"],["volt","https://portecriativo.framer.website/cases/volt","/cases/volt"],["404","https://portecriativo.framer.website/404","/404"]];
 const vps=[["mobile",390,855],["tablet",810,825],["laptop",1200,825],["desktop",1600,825]],results=[];
 for(const [rn,src,loc] of routes)for(const [vn,w,h] of vps){
   let s,l;const rec={route:rn,viewport:vn,width:w,height:h,diffs:[]};
   try{
     s=await browser.newPage();l=await browser.newPage();await s.setViewport({width:w,height:h});await l.setViewport({width:w,height:h});
     const S=await attach(s,false),L=await attach(l,true);rec.sourceStatus=await open(s,S.c,src,w,h);rec.localStatus=await open(l,L.c,"http://127.0.0.1:4174"+loc,w,h);
     rec.sourceMetrics=await metrics(S.c);rec.localMetrics=await metrics(L.c);
     const fractions=rn==="home"?[0,.33,.66,.95]:[0,.55,.95];let sy=0,ly=0;
     for(let i=0;i<fractions.length;i++){const f=fractions[i],st=Math.max(0,(rec.sourceMetrics.height-h)*f),lt=Math.max(0,(rec.localMetrics.height-h)*f);sy=await scroll(S.c,sy,st,w,h);ly=await scroll(L.c,ly,lt,w,h);const a=path.join(out,`${rn}-${vn}-${i}-source.png`),b=path.join(out,`${rn}-${vn}-${i}-local.png`);await shot(S.c,a);await shot(L.c,b);rec.diffs.push({fraction:f,...diff(a,b)})}
     rec.external=[...new Set(L.info.external)];rec.exceptions=[...new Set(L.info.exceptions)];rec.console=[...new Set(L.info.console)];
   }catch(e){rec.auditError=String(e?.stack||e)}finally{if(s)await s.close().catch(()=>{});if(l)await l.close().catch(()=>{})}
   results.push(rec);console.log("AUDITED",rn,vn,rec.auditError?"ERROR":"OK");
 }
 const p=await browser.newPage();await p.setViewport({width:1440,height:900});const P=await attach(p,true),interaction={};
 try{interaction.status=await open(p,P.c,"http://127.0.0.1:4174/",1440,900);interaction.hover={x:70,y:40};await P.c.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:70,y:40});interaction.drag=await dragCanvas(P.c);interaction.counts=await metrics(P.c);interaction.external=[...new Set(P.info.external)];interaction.exceptions=[...new Set(P.info.exceptions)];interaction.console=[...new Set(P.info.console)]}catch(e){interaction.error=String(e?.stack||e)}
 await p.close().catch(()=>{});
 const fr=await fetch("http://127.0.0.1:4174/offline-form",{method:"POST",headers:{"content-type":"application/json"},body:'{"audit":true}'});interaction.formEndpoint={status:fr.status,body:await fr.text()};
 await browser.close();server.kill("SIGTERM");
 const good=results.filter(r=>!r.auditError),ds=good.flatMap(r=>r.diffs.map(d=>d.ratio));
 const report={generatedAt:new Date().toISOString(),allCasesCompleted:results.every(r=>!r.auditError),allLocalRoutesLoaded:results.every(r=>r.localStatus>0&&r.localStatus<500),externalRuntimeRequests:results.reduce((n,r)=>n+(r.external?.length||0),0)+(interaction.external?.length||0),pageExceptions:results.reduce((n,r)=>n+(r.exceptions?.length||0),0)+(interaction.exceptions?.length||0),consoleErrors:results.reduce((n,r)=>n+(r.console?.length||0),0)+(interaction.console?.length||0),maxSliceMismatch:ds.length?Math.max(...ds):null,avgSliceMismatch:ds.length?ds.reduce((a,b)=>a+b,0)/ds.length:null,interaction,results,serverLog};
 fs.writeFileSync(path.join(root,"AUDIT-CDP.json"),JSON.stringify(report,null,2));console.log("FINAL_AUDIT",JSON.stringify({allCasesCompleted:report.allCasesCompleted,allLocalRoutesLoaded:report.allLocalRoutesLoaded,externalRuntimeRequests:report.externalRuntimeRequests,pageExceptions:report.pageExceptions,consoleErrors:report.consoleErrors,maxSliceMismatch:report.maxSliceMismatch,avgSliceMismatch:report.avgSliceMismatch,interaction},null,2));
 if(!report.allCasesCompleted||!report.allLocalRoutesLoaded||report.externalRuntimeRequests>0||interaction.formEndpoint.status!==200)process.exitCode=2;
})().catch(e=>{console.error(e);try{server.kill("SIGTERM")}catch{};process.exit(1)});
