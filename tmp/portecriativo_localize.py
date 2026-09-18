#!/usr/bin/env python3
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlparse, urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed
import re, sys, html, hashlib, mimetypes, json, shutil

root = Path(sys.argv[1]).resolve()
if not (root / "index.html").exists():
    raise SystemExit("index.html not found")

text_ext = {".html",".mjs",".js",".css",".json",".svg",".txt"}
resource_hosts = {
    "framerusercontent.com",
    "fonts.gstatic.com",
    "unpkg.com",
    "esm.sh",
    "images.unsplash.com",
    "app.framerstatic.com",
}
url_rx = re.compile(r"""https?://[^\s\x60"'<>\\)]+""")

def text_files():
    return [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in text_ext]

# First normalize the folders already emitted by the exporter.
assets = root / "assets"
assets.mkdir(exist_ok=True)
for old, new in [("js","js"),("images","images"),("media","data")]:
    src = root / old
    dst = assets / new
    if src.exists() and src != dst:
        if dst.exists():
            for f in src.iterdir():
                target = dst / f.name
                if not target.exists():
                    shutil.move(str(f), str(target))
            shutil.rmtree(src, ignore_errors=True)
        else:
            shutil.move(str(src), str(dst))

# Update root-relative references for the moved folders.
for p in text_files():
    s = p.read_text("utf-8", errors="ignore")
    ns = s.replace('"/js/', '"/assets/js/').replace("'/js/", "'/assets/js/")
    ns = ns.replace('"/images/', '"/assets/images/').replace("'/images/", "'/assets/images/")
    ns = ns.replace('"/media/', '"/assets/data/').replace("'/media/", "'/assets/data/")
    if ns != s:
        p.write_text(ns, "utf-8")

# Normalize generated file names while preserving imports by globally replacing basenames.
def rename_group(directory, kind, preferred):
    d = root / directory
    if not d.exists(): return {}
    files = sorted([p for p in d.iterdir() if p.is_file()])
    mapping = {}
    used = set()
    seq = 1
    for p in files:
        lower = p.name.lower()
        name = None
        for token, semantic in preferred:
            if token in lower and semantic not in used:
                name = semantic + p.suffix.lower()
                break
        if name is None:
            while True:
                name = f"{kind}-{seq:03d}{p.suffix.lower()}"
                seq += 1
                if name not in used: break
        used.add(name)
        mapping[p.name] = name
    # Replace references before renaming.
    for tp in text_files():
        s = tp.read_text("utf-8", errors="ignore")
        ns = s
        for old, new in mapping.items():
            ns = ns.replace(old, new)
        if ns != s:
            tp.write_text(ns, "utf-8")
    for old, new in mapping.items():
        p = d / old
        q = d / new
        if p.exists() and p != q:
            p.rename(q)
    return mapping

js_map = rename_group("assets/js","module",[
    ("script_main","site-runtime"),("react.","react-runtime"),("motion.","motion-runtime"),
    ("three.module","three-runtime"),("video.","video-runtime"),("shared-lib","shared-runtime"),
    ("framer-font","font-runtime"),("framer.","ui-runtime"),("rolldown-runtime","module-loader"),
    ("init.mjs","runtime-init"),
])
img_map = rename_group("assets/images","image",[])

# Find still-external concrete resources after the exporter pass.
raw_urls = set()
for p in text_files():
    s = p.read_text("utf-8", errors="ignore")
    raw_urls.update(url_rx.findall(s))

def clean_raw(raw):
    raw = raw.rstrip(".,;]}\\\\")
    return raw

candidates = {}
for raw in sorted(raw_urls):
    raw = clean_raw(raw)
    decoded = html.unescape(raw)
    try:
        u = urlparse(decoded)
    except Exception:
        continue
    if u.hostname in resource_hosts:
        candidates[raw] = decoded

localized = root / "assets" / "localized"
for sub in ["images","videos","fonts","modules","data"]:
    (localized / sub).mkdir(parents=True, exist_ok=True)

content_ext = {
    "image/png":".png","image/jpeg":".jpg","image/webp":".webp","image/svg+xml":".svg",
    "image/gif":".gif","font/woff2":".woff2","font/woff":".woff",
    "video/mp4":".mp4","video/webm":".webm","application/javascript":".mjs",
    "text/javascript":".mjs","application/json":".json","text/css":".css",
}

def guess_category(url, ctype, ext):
    ul = url.lower()
    if ext in {".mp4",".webm",".mov"} or ctype.startswith("video/"): return "videos"
    if ext in {".woff2",".woff",".ttf",".otf"} or ctype.startswith("font/"): return "fonts"
    if ext in {".png",".jpg",".jpeg",".webp",".gif",".svg",".ico"} or ctype.startswith("image/"): return "images"
    if ext in {".js",".mjs"} or "javascript" in ctype: return "modules"
    return "data"

def download_one(item):
    raw, url = item
    req = Request(url, headers={
        "User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152 Safari/537.36",
        "Referer":"https://portecriativo.framer.website/",
        "Accept":"*/*",
    })
    try:
        with urlopen(req, timeout=45) as resp:
            data = resp.read()
            ctype = (resp.headers.get_content_type() or "application/octet-stream").lower()
        if not data:
            return raw, None, "empty"
        path_ext = Path(urlparse(url).path).suffix.lower()
        ext = path_ext if 1 < len(path_ext) <= 6 else content_ext.get(ctype, ".bin")
        if ext == ".js": ext = ".mjs"
        cat = guess_category(url, ctype, ext)
        return raw, (url, data, ctype, ext, cat), None
    except Exception as e:
        return raw, None, f"{type(e).__name__}: {e}"

results = {}
failed = {}
with ThreadPoolExecutor(max_workers=16) as ex:
    futs = [ex.submit(download_one, item) for item in candidates.items()]
    for fut in as_completed(futs):
        raw, result, err = fut.result()
        if result is None:
            failed[raw] = err
        else:
            results[raw] = result

# Stable, clean names by category.
by_cat = {}
for raw, value in results.items():
    by_cat.setdefault(value[4], []).append((raw, value))
replacements = {}
download_manifest = []
for cat, entries in by_cat.items():
    for idx, (raw, (url,data,ctype,ext,cat2)) in enumerate(sorted(entries, key=lambda x:x[1][0]), 1):
        name = f"{cat2[:-1] if cat2.endswith('s') else cat2}-{idx:03d}{ext}"
        dest = localized / cat2 / name
        # Different exact URLs can resolve to identical bytes; keeping variant names is harmless and deterministic.
        dest.write_bytes(data)
        local = "/" + str(dest.relative_to(root)).replace("\\","/")
        replacements[raw] = local
        if html.escape(html.unescape(raw), quote=False) != raw:
            replacements[html.escape(html.unescape(raw), quote=False)] = local
        download_manifest.append({"source":url,"local":local,"bytes":len(data),"content_type":ctype})

# Download relative binary/data chunks referenced by localized JavaScript modules.
# Framer CMS modules commonly resolve *.framercms next to their source module.
relative_manifest = []
relative_rx = re.compile(r"""[\x60"'](\./[^\x60"']+\.(?:framercms|wasm|bin|dat))(?:\?[^\x60"']*)?[\x60"']""", re.I)
for raw, (source_url, data, ctype, ext, cat) in list(results.items()):
    if cat != "modules":
        continue
    try:
        txt = data.decode("utf-8")
    except Exception:
        continue
    for rel in sorted(set(relative_rx.findall(txt))):
        absolute = urljoin(source_url, rel)
        name = Path(urlparse(absolute).path).name
        if not name:
            continue
        dest = localized / "modules" / name
        if dest.exists():
            continue
        req = Request(absolute, headers={
            "User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152 Safari/537.36",
            "Referer":"https://portecriativo.framer.website/",
            "Accept":"*/*",
        })
        try:
            with urlopen(req, timeout=45) as resp:
                child = resp.read()
                child_type = (resp.headers.get_content_type() or "application/octet-stream").lower()
            if child:
                dest.write_bytes(child)
                relative_manifest.append({
                    "source": absolute,
                    "local": "/" + str(dest.relative_to(root)).replace("\\","/"),
                    "bytes": len(child),
                    "content_type": child_type,
                })
        except Exception as e:
            failed[absolute] = f"{type(e).__name__}: {e}"

# Replace exact external resource strings everywhere.
for p in text_files():
    s = p.read_text("utf-8", errors="ignore")
    ns = s
    for raw, local in replacements.items():
        ns = ns.replace(raw, local)

    # Keep Framer's canonical base inside JavaScript: the router uses it as a
    # valid URL base. Only rewrite actual HTML hrefs back to local routes.
    if p.suffix.lower() == ".html":
        ns = re.sub(
            r'''href=(["'])https://portecriativo\.framer\.website(?P<path>/[^"'#? ]*)?(?P<tail>[?#][^"']*)?\1''',
            lambda m: f'href={m.group(1)}{(m.group("path") or "/")}{(m.group("tail") or "")}{m.group(1)}',
            ns,
        )
        # Analytics is not part of the visitor UI and cannot run offline.
        ns = re.sub(
            r'''<script[^>]+src=["']https://events\.framer\.com/script\?v=2["'][^>]*>\s*</script>''',
            "",
            ns,
            flags=re.I,
        )

    # Form posts are persisted by the local server instead of calling Framer.
    ns = re.sub(r"https://api\.framer\.com/forms/v1/forms/[A-Za-z0-9-]+/submit", "/offline-form", ns)

    # The exporter already captured Framer's editor runtime. Keep the dynamic
    # import local in case an editor flag exists in localStorage.
    ns = ns.replace("https://framer.com/edit/runtime-init.mjs", "/assets/js/runtime-init.mjs")
    ns = ns.replace("https://framer.com/edit/init.mjs", "/assets/js/runtime-init.mjs")

    # A root-relative local module path is not itself a valid URL base.
    # Preserve Framer's new URL(relative, base) semantics by making that base
    # absolute at runtime, while keeping every referenced file local.
    local_base_rx = re.compile(
        r"""new URL\((?P<rel>\x60[^\x60]*\x60|"[^"]*"|'[^']*'),(?P<q>[\x60"'])(?P<base>/assets/[^\x60"']+)(?P=q)\)"""
    )
    ns = local_base_rx.sub(
        lambda m: f"new URL({m.group('rel')},globalThis.location.origin+{m.group('q')}{m.group('base')}{m.group('q')})",
        ns,
    )

    if ns != s:
        p.write_text(ns, "utf-8")

(root/"assets/localized/data/editor-disabled.mjs").write_text("export default {};\n","utf-8")

# Three.js worker uses importScripts inside a Blob Worker. Make root-localized script absolute to the worker origin.
for p in text_files():
    s = p.read_text("utf-8", errors="ignore")
    if "importScripts('/assets/localized/" in s or 'importScripts("/assets/localized/' in s:
        s = re.sub(
            r"""self\.importScripts\((['"])(/assets/localized/[^'"]+)\1\)""",
            r"""self.importScripts(self.location.origin + '\2')""",
            s,
        )
        p.write_text(s, "utf-8")

# Remove visible platform badge after hydration and suppress it immediately by known current badge structure.
cleanup = r"""
<style id="pc-offline-cleanup">
.framer-19yaanm{display:none!important}
</style>
<script id="pc-offline-cleanup-js">
(function(){
  function clean(){
    try{
      var marker=document.querySelector('.framer-19yaanm');
      var badge=marker&&marker.closest('a');
      if(badge) badge.remove();
      document.querySelectorAll('p').forEach(function(p){
        if((p.textContent||'').indexOf('Create a free website with Framer')>=0){
          var a=p.closest('a'); if(a)a.remove(); else p.remove();
        }
      });
    }catch(_){}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',clean,{once:true});else clean();
  setTimeout(clean,500);
})();
</script>
"""
for p in root.rglob("*.html"):
    s=p.read_text("utf-8",errors="ignore")
    # Metadata is local and neutral.
    s=re.sub(r'<meta\s+name=["\']generator["\'][^>]*>', '', s, flags=re.I)
    if "pc-offline-cleanup-js" not in s:
        s=s.replace("</body>", cleanup+"</body>")
    p.write_text(s,"utf-8")

# Extend generated server with offline form storage.
server=root/"server.js"
if server.exists():
    s=server.read_text("utf-8",errors="ignore")
    marker="const server = http.createServer((req, res) => {"
    if "offline-form-submissions.jsonl" not in s and marker in s:
        inject="""const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === '/offline-form') {
    let body = '';
    req.on('data', chunk => { if (body.length < 1048576) body += chunk; });
    req.on('end', () => {
      try {
        fs.appendFileSync(path.join(__dirname, 'offline-form-submissions.jsonl'),
          JSON.stringify({at:new Date().toISOString(), body}) + '\\n');
      } catch (_) {}
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({ok:true,success:true}));
    });
    return;
  }"""
        s=s.replace(marker,inject,1)
        server.write_text(s,"utf-8")

launcher=root/"START_LOCAL.command"
launcher.write_text("""#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ não encontrado."
  exit 1
fi
node server.js 8080
""","utf-8")
launcher.chmod(0o755)

(root/"README-OFFLINE.md").write_text("""# PorteCriativo — versão local

Execute START_LOCAL.command no macOS e acesse http://localhost:8080.

Rotas locais:
- /
- /cases
- /cases/volt
- /404

Imagens, vídeos, fontes, módulos e efeitos visuais ficam no próprio pacote.
O formulário salva os envios localmente em offline-form-submissions.jsonl.
Links para WhatsApp, redes sociais, mapa e outros destinos externos continuam sendo links e exigem internet apenas quando clicados.
""","utf-8")

report={
    "candidate_external_resources":len(candidates),
    "localized_resources":len(results),
    "failed_resource_downloads":failed,
    "download_manifest":download_manifest,
    "relative_download_manifest":relative_manifest,
    "renamed_js":js_map,
    "renamed_images":img_map,
}
(root/"localization-report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),"utf-8")
print(json.dumps({
    "candidate_external_resources":len(candidates),
    "localized_resources":len(results),
    "failed_count":len(failed),
    "failed":failed,
},ensure_ascii=False,indent=2))
