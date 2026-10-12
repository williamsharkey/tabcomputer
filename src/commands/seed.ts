import { Command, CommandContext } from './index';
import { captureTerminal, addOverlay, encodeGIF } from '../gif-encoder';
import { getShiroOrigin } from '../utils/shiro-origin';

import { collectSeedState, describeSeedContents, SEED_VERSION, type SeedState, type SeedStats } from '../seed-state';

/**
 * seed: a copy of this machine that boots somewhere else.
 *
 *   seed            a snippet on the clipboard: pasted into a page's DevTools
 *                   console, it opens tabcomputer in a floating frame with this state
 *   seed blob       the same, self-contained (runs in the host page's origin)
 *   seed gif|html   a file on your disk (a GIF to drag onto a tab, a page to open)
 *   seed share      uploads it; anyone with the link can download it
 *
 * Every form goes through collectSeedState (src/seed-state.ts): a seed
 * carries no credentials, and the output lists what was left out.
 * `--with-credentials` keeps them, for the forms that stay on your disk or
 * clipboard (moving your own machine); `seed share` refuses it. `seed share`
 * shows what it will upload and asks first (`--yes` skips the question).
 */

const SHIRO_VERSION = SEED_VERSION;

function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(data as unknown as BufferSource);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function buildSnippet(url: string, ndjson: string, storage: string, stats: SeedStats): string {
  // Escape for embedding in template literal
  const escapeForTemplate = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  const escapedNdjson = escapeForTemplate(ndjson);
  const escapedStorage = escapeForTemplate(storage);

  // Build header comment with stats
  const header = `// shiro seed v${stats.version} | ${stats.files} files, ${stats.dirs} dirs | ${stats.sizeMB} MB`;

  return `${header}
(function(){
  if(document.getElementById('shiro-seed')){console.log('tabcomputer already seeded');return}
  var host=document.createElement('div');host.id='shiro-seed';
  var root=host.attachShadow?host.attachShadow({mode:'open'}):host;
  var w=document.createElement('div');
  var S=w.style;S.position='fixed';S.bottom='20px';S.right='20px';S.width='32em';S.height='22em';
  S.zIndex='2147483647';S.borderRadius='8px';S.overflow='hidden';
  S.boxShadow='rgb(206,170,227) 0px 5px 11px -3px';S.opacity='0.88';S.backdropFilter='blur(8px)';
  S.fontFamily='-apple-system,BlinkMacSystemFont,sans-serif';S.display='flex';S.flexDirection='column';
  var tb=document.createElement('div');
  var T=tb.style;T.background='#1a1a2e';T.height='32px';T.display='flex';T.alignItems='center';
  T.padding='0 10px';T.cursor='grab';T.userSelect='none';T.flexShrink='0';
  var dots=document.createElement('div');dots.style.display='flex';dots.style.gap='6px';
  function mkDot(col,icon){
    var d=document.createElement('div');d.style.cssText='width:14px;height:14px;border-radius:50%;background:'+col+';cursor:pointer;position:relative;margin:auto 0';
    var ic=document.createElement('span');ic.textContent=icon;ic.style.cssText='position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:9px;line-height:1;color:#333;opacity:0;pointer-events:none;transition:opacity 0.12s';
    d.appendChild(ic);d.onmouseenter=function(){ic.style.opacity='0.8'};d.onmouseleave=function(){ic.style.opacity='0'};return d;
  }
  var close=mkDot('#ff5f57','\\u00b7');
  close.onclick=function(){host.remove()};
  var mini=mkDot('#febc2e','\\u2013');
  var minimized=false;
  mini.onclick=function(){
    minimized=!minimized;
    iframe.style.display=minimized?'none':'block';
    rh.style.display=minimized?'none':'block';
    w.style.height=minimized?'32px':savedH+'px';
    if(!minimized)setTimeout(focusShiro,0);
  };
  dots.appendChild(close);dots.appendChild(mini);
  var title=document.createElement('span');title.textContent='shiro';
  var ts=title.style;ts.color='#8888cc';ts.fontSize='13px';ts.fontWeight='600';ts.marginLeft='10px';ts.flex='1';
  /* Font size controls - hidden until hover */
  var fontSize=14;
  var zoomWrap=document.createElement('div');zoomWrap.style.cssText='display:flex;gap:4px;opacity:0;transition:opacity 0.15s';
  var zoomOut=document.createElement('div');zoomOut.textContent='\\u2212';
  zoomOut.style.cssText='width:14px;height:14px;border-radius:50%;background:#555;color:#fff;font-size:12px;line-height:14px;text-align:center;cursor:pointer';
  var zoomIn=document.createElement('div');zoomIn.textContent='+';
  zoomIn.style.cssText='width:14px;height:14px;border-radius:50%;background:#555;color:#fff;font-size:12px;line-height:14px;text-align:center;cursor:pointer';
  zoomOut.onclick=function(e){e.stopPropagation();fontSize=Math.max(8,fontSize-1);iframe.contentWindow.postMessage({type:'shiro-fontsize',size:fontSize},'*')};
  zoomIn.onclick=function(e){e.stopPropagation();fontSize=Math.min(24,fontSize+1);iframe.contentWindow.postMessage({type:'shiro-fontsize',size:fontSize},'*')};
  zoomWrap.appendChild(zoomOut);zoomWrap.appendChild(zoomIn);
  tb.onmouseenter=function(){zoomWrap.style.opacity='1'};
  tb.onmouseleave=function(){zoomWrap.style.opacity='0'};
  tb.appendChild(dots);tb.appendChild(title);tb.appendChild(zoomWrap);
  var iframe=document.createElement('iframe');iframe.src='${url}';
  var is=iframe.style;is.border='none';is.width='100%';is.flex='1';is.display='block';is.pointerEvents='auto';is.background='#0a0a1a';
  iframe.tabIndex=0;iframe.title='tabcomputer';
  iframe.allow='clipboard-read; clipboard-write; cross-origin-isolated';
  var rh=document.createElement('div');var rs=rh.style;
  rs.position='absolute';rs.bottom='0';rs.right='0';rs.width='16px';rs.height='16px';
  rs.cursor='nwse-resize';rs.background='linear-gradient(135deg,transparent 50%,#555 50%)';
  w.appendChild(tb);w.appendChild(iframe);w.appendChild(rh);
  root.appendChild(w);document.body.appendChild(host);
  function focusShiro(){
    iframe.style.pointerEvents='auto';
    try{iframe.focus()}catch(ex){}
    try{iframe.contentWindow&&iframe.contentWindow.focus&&iframe.contentWindow.focus()}catch(ex){}
    try{iframe.contentWindow&&iframe.contentWindow.postMessage({type:'shiro-focus-terminal'},'*')}catch(ex){}
  }
  var dx=0,dy=0,sx=0,sy=0,dragging=false;
  tb.onmousedown=function(e){dragging=true;sx=e.clientX;sy=e.clientY;
    var r=w.getBoundingClientRect();dx=r.left;dy=r.top;
    tb.style.cursor='grabbing';iframe.style.pointerEvents='none';e.preventDefault()};
  document.addEventListener('mousemove',function(e){
    if(dragging){w.style.left=(dx+e.clientX-sx)+'px';w.style.top=(dy+e.clientY-sy)+'px';
      w.style.right='auto';w.style.bottom='auto'}
    if(resizing){var rr=w.getBoundingClientRect();
      var nw=Math.max(300,e.clientX-rr.left);var nh=Math.max(200,e.clientY-rr.top);
      w.style.width=nw+'px';w.style.height=nh+'px';savedH=nh}});
  document.addEventListener('mouseup',function(){dragging=false;resizing=false;tb.style.cursor='grab';iframe.style.pointerEvents='auto'});
  var resizing=false,savedH=w.offsetHeight||352;
  rh.onmousedown=function(e){resizing=true;iframe.style.pointerEvents='none';e.preventDefault();e.stopPropagation()};
  /* Click on wrapper focuses iframe and terminal for keyboard input */
  iframe.onmousedown=function(){focusShiro()};
  iframe.ontouchstart=function(){focusShiro()};
  w.addEventListener('mousedown',function(e){if(e.target===iframe||iframe.contains(e.target)){focusShiro()}});
  /* NDJSON seed data - parsed incrementally */
  var SEED_FS=\`${escapedNdjson}\`;
  var SEED_STORAGE=\`${escapedStorage}\`;
  function buildContext(){
    return {
      mode:'seed',
      injected:true,
      hcOuterAvailable:true,
      sameOriginParentAccess:false,
      hostUrl:location.href,
      hostOrigin:location.origin,
      hostTitle:document.title||'',
      createdAt:new Date().toISOString()
    };
  }
  var seeded=false,seedReady=false;
  function maybeSeed(){
    if(seeded||!seedReady||!iframe.contentWindow)return;
    seeded=true;
    iframe.contentWindow.postMessage({type:'shiro-seed-v2',ndjson:SEED_FS,storage:SEED_STORAGE,context:buildContext()},'${new URL(url).origin}');
  }
  window.addEventListener('message',function(e){
    if(e.source===iframe.contentWindow&&e.data&&e.data.type==='shiro-seed-ready'){
      seedReady=true;
      maybeSeed();
    }
  });
  iframe.onload=function(){
    setTimeout(focusShiro,0);
    maybeSeed();
  };
  /* HC bridge: lets the Shiro iframe run HC commands against the host DOM */
  (function(){
    var cur=document.body,lastR=[],lastG=null;
    function _t(el,lim){var t=(el.textContent||'').replace(/\\s+/g,' ').trim();return lim&&t.length>lim?t.slice(0,lim)+'…':t}
    function _d(el){var d=0;while(el&&el!==document.body&&el!==document.documentElement){d++;el=el.parentElement}return d}
    function exec(cmd){
      cmd=cmd.trim();var m;
      if(cmd.includes(';')&&!cmd.startsWith(';'))return cmd.split(';').map(function(c){return c.trim()}).filter(Boolean).map(exec).join('\\n---\\n');
      if(cmd==='s')return 'p:outer c:'+lastR.length+' d:'+_d(cur)+' @'+(cur.tagName||'doc').toLowerCase();
      if(cmd==='t')return _t(cur);
      if((m=cmd.match(/^t(\\d+)$/)))return _t(cur,parseInt(m[1]));
      if(cmd.startsWith('q1 ')){try{var el=document.querySelector(cmd.slice(3).trim());if(!el)return '∅';cur=el;lastR=[el];return _t(el).slice(0,200)}catch(e){return '✗ '+e.message}}
      if(cmd.startsWith('q ')){try{var els=Array.from(document.querySelectorAll(cmd.slice(2).trim()));lastR=els;if(!els.length)return '∅';return els.slice(0,10).map(function(el,i){return '['+i+']'+_t(el).slice(0,60)}).join('\\n')}catch(e){return '✗ '+e.message}}
      if((m=cmd.match(/^n(\\d+)$/))){var idx=parseInt(m[1]);if(idx>=lastR.length)return '✗ out of range';cur=lastR[idx];return '✓ ['+idx+'] '+_t(cur).slice(0,100)}
      if(cmd==='up'){if(cur.parentElement)cur=cur.parentElement;return '✓ @'+(cur.tagName||'').toLowerCase()}
      if((m=cmd.match(/^up(\\d+)$/))){for(var i=0;i<parseInt(m[1]);i++)if(cur.parentElement)cur=cur.parentElement;return '✓ @'+(cur.tagName||'').toLowerCase()}
      if(cmd==='ch'){var ch=Array.from(cur.children);if(!ch.length)return '∅ no children';return ch.slice(0,15).map(function(c,i){var tag=c.tagName.toLowerCase();var cls=c.className?'.'+String(c.className).split(' ')[0]:'';return '['+i+']<'+tag+cls+'>'+_t(c).slice(0,30)}).join('\\n')}
      if(cmd.startsWith('g ')){var lines=(cur.textContent||'').split('\\n');var re=new RegExp(cmd.slice(2).trim(),'gi');var matches=[];lines.forEach(function(line,i){if(re.test(line)){var clean=line.replace(/\\s+/g,' ').trim();if(clean)matches.push('L'+(i+1)+': '+clean.slice(0,60))}});return matches.length?matches.slice(0,10).join('\\n'):'∅ no matches'}
      if(cmd==='look'){var inter=cur.querySelectorAll('a,button,input,select,textarea,[onclick],[href],.btn,[role=button]');var items=[];inter.forEach(function(el,idx){var text=(el.textContent||el.value||el.placeholder||el.getAttribute('title')||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim().slice(0,20);if(text||el.tagName.toLowerCase()==='input')items.push({text:text||'['+(el.type||'input')+']',el:el,idx:idx})});lastG=items;if(!items.length)return '∅ no interactive elements';var out=items.length+' elements\\n';items.slice(0,20).forEach(function(item,i){var tag=item.el.tagName.toLowerCase();var href=item.el.getAttribute('href');out+='@'+i+' <'+tag+'> "'+item.text+'"'+(href?' →'+href.slice(0,25):'')+' \\n'});return out.trim()}
      if((m=cmd.match(/^@(\\d+)$/))){if(!lastG||parseInt(m[1])>=lastG.length)return '✗ call look first or index out of range';var it=lastG[parseInt(m[1])];try{it.el.click()}catch(e){}return '✓ clicked "'+it.text+'"'}
      if(cmd==='a'){if(!cur.attributes)return '∅';var attrs=[];for(var j=0;j<cur.attributes.length;j++){var at=cur.attributes[j];attrs.push(at.name+'='+at.value.slice(0,30))}return attrs.length?attrs.join(' '):'∅ no attrs'}
      if(cmd==='h')return cur.outerHTML;
      if((m=cmd.match(/^h(\\d+)$/))){var html=cur.outerHTML;var lim=parseInt(m[1]);return html.length>lim?html.slice(0,lim)+'…[truncated]':html}
      return '✗ unknown: '+cmd;
    }
    window.addEventListener('message',function(e){
      if(e.data&&e.data.type==='shiro-hc'){
        var result;try{result=exec(e.data.cmd)}catch(err){result='✗ '+err.message}
        e.source.postMessage({type:'shiro-hc-result',id:e.data.id,result:result},'*');
      }
    });
  })();
})();`;
}

/** Get the current subdomain (or null if on main domain) */
function getCurrentSubdomain(): string | null {
  if (typeof window === 'undefined') return null;
  const host = window.location.hostname;
  const match = host.match(/^([^.]+)\.shiro\.computer$/);
  return match ? match[1] : null;
}

/**
 * Where the snippet's frame loads tabcomputer from: this site. (It used to be
 * https://shiro.computer whatever site made the seed, so a tabcomputer.com
 * seed posted its state into another origin.) A subdomain argument names a
 * shiro.computer subdomain and works only there.
 */
function buildTargetUrl(targetSubdomain?: string): string {
  const onShiro = typeof window !== 'undefined' && /(^|\.)shiro\.computer$/.test(window.location.hostname);
  if (targetSubdomain) {
    if (!onShiro) throw new Error(`a subdomain target ("${targetSubdomain}") exists on shiro.computer only; without it the seed opens ${getShiroOrigin()}`);
    return `https://${targetSubdomain}.shiro.computer/`;
  }
  if (onShiro) {
    const current = getCurrentSubdomain();
    return current ? `https://${current}.shiro.computer/` : 'https://shiro.computer/';
  }
  return `${getShiroOrigin()}/`;
}

/**
 * Inline all external resources in the current document.
 * Replaces <script src> with <script>content</script>
 * Replaces <link rel="stylesheet" href> with <style>content</style>
 */
async function inlineDocument(): Promise<string> {
  const sourceUrl = window.location?.href || document.baseURI || 'https://shiro.computer/';
  const sourceOrigin = (() => {
    try {
      return new URL(sourceUrl, 'https://shiro.computer/').origin;
    } catch {
      return 'https://shiro.computer';
    }
  })();
  let doc: Document | null = null;

  try {
    const res = await fetch(sourceUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (typeof DOMParser !== 'undefined') {
      doc = new DOMParser().parseFromString(html, 'text/html');
    }
  } catch (e) {
    console.warn(`Failed to fetch canonical HTML: ${sourceUrl}`, e);
  }

  if (!doc || !doc.documentElement) {
    doc = document.cloneNode(true) as Document;
  }

  // Seeded blobs should boot from a clean app shell, not a clone of the
  // current live xterm DOM or previously injected seed window.
  doc.getElementById('shiro-seed')?.remove();
  const terminalEl = doc.getElementById('terminal');
  if (terminalEl) terminalEl.innerHTML = '';

  let head = doc.head;
  if (!head) {
    head = doc.createElement('head');
    doc.documentElement.insertBefore(head, doc.body || null);
  }

  let baseEl = head.querySelector('base');
  if (!baseEl) {
    baseEl = doc.createElement('base');
    head.insertBefore(baseEl, head.firstChild);
  }
  baseEl.setAttribute('href', `${sourceOrigin}/`);

  // Find all external scripts
  const scripts = doc.querySelectorAll('script[src]');
  for (const script of scripts) {
    const src = script.getAttribute('src');
    if (!src) continue;

    try {
      const url = new URL(src, sourceUrl).href;
      const res = await fetch(url);
      const content = await res.text();

      const inlineScript = doc.createElement('script');
      // Preserve type attribute (important for module scripts)
      const type = script.getAttribute('type');
      if (type) inlineScript.setAttribute('type', type);
      inlineScript.textContent = content;

      script.parentNode?.replaceChild(inlineScript, script);
    } catch (e) {
      console.warn(`Failed to inline script: ${src}`, e);
    }
  }

  // Find all external stylesheets
  const links = doc.querySelectorAll('link[rel="stylesheet"]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;

    try {
      const url = new URL(href, sourceUrl).href;
      const res = await fetch(url);
      const content = await res.text();

      const style = doc.createElement('style');
      style.textContent = content;

      link.parentNode?.replaceChild(style, link);
    } catch (e) {
      console.warn(`Failed to inline stylesheet: ${href}`, e);
    }
  }

  // Serialize the document
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

/**
 * Build a self-contained blob seed snippet.
 * Uses DecompressionStream (browser built-in) instead of a custom inflate.
 * All data (HTML, filesystem NDJSON, localStorage) is gzip-compressed and base64-encoded.
 */
function buildBlobSnippet(compressedHtmlB64: string, compressedFsB64: string, compressedStorageB64: string, stats: SeedStats & { htmlSize: number; compressedSize: number }): string {
  const header = `// shiro blob seed v${stats.version} | ${stats.files} files | ${(stats.compressedSize / 1024).toFixed(0)}KB compressed`;

  // Note: base64 strings are safe in single-quoted JS (no ', \, or newlines)
  return `${header}
(async function(){
  if(document.getElementById('shiro-seed')){console.log('tabcomputer already seeded');return}
  async function _dc(b){var a=atob(b),u=new Uint8Array(a.length),i=0;for(;i<a.length;)u[i]=a.charCodeAt(i++);var s=new DecompressionStream('gzip'),w=s.writable.getWriter();w.write(u);w.close();var r=s.readable.getReader(),c=[],v;while(!(v=await r.read()).done)c.push(v.value);var t=0,x;for(x of c)t+=x.length;var o=new Uint8Array(t),p=0;for(x of c){o.set(x,p);p+=x.length}return new TextDecoder().decode(o)}
  var html=await _dc('${compressedHtmlB64}');
  var blob=new Blob([html],{type:'text/html'});
  var blobUrl=URL.createObjectURL(blob);
  var _fsP=_dc('${compressedFsB64}');
  var _lsP=_dc('${compressedStorageB64}');
  var host=document.createElement('div');host.id='shiro-seed';
  var root=host.attachShadow?host.attachShadow({mode:'open'}):host;
  var w=document.createElement('div');
  var S=w.style;S.position='fixed';S.bottom='20px';S.right='20px';S.width='32em';S.height='22em';
  S.zIndex='2147483647';S.borderRadius='8px';S.overflow='hidden';
  S.boxShadow='rgb(206,170,227) 0px 5px 11px -3px';S.opacity='0.88';S.backdropFilter='blur(8px)';
  S.fontFamily='-apple-system,BlinkMacSystemFont,sans-serif';S.display='flex';S.flexDirection='column';
  var tb=document.createElement('div');
  var T=tb.style;T.background='#1a1a2e';T.height='32px';T.display='flex';T.alignItems='center';
  T.padding='0 10px';T.cursor='grab';T.userSelect='none';T.flexShrink='0';
  var dots=document.createElement('div');dots.style.display='flex';dots.style.gap='6px';
  function mkDot(col,icon){
    var d=document.createElement('div');d.style.cssText='width:14px;height:14px;border-radius:50%;background:'+col+';cursor:pointer;position:relative;margin:auto 0';
    var ic=document.createElement('span');ic.textContent=icon;ic.style.cssText='position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:9px;line-height:1;color:#333;opacity:0;pointer-events:none;transition:opacity 0.12s';
    d.appendChild(ic);d.onmouseenter=function(){ic.style.opacity='0.8'};d.onmouseleave=function(){ic.style.opacity='0'};return d;
  }
  var close=mkDot('#ff5f57','\\u00b7');
  close.onclick=function(){URL.revokeObjectURL(blobUrl);host.remove()};
  var mini=mkDot('#febc2e','\\u2013');
  var minimized=false;
  mini.onclick=function(){
    minimized=!minimized;
    iframe.style.display=minimized?'none':'block';
    rh.style.display=minimized?'none':'block';
    w.style.height=minimized?'32px':savedH+'px';
    if(!minimized)setTimeout(focusShiro,0);
  };
  dots.appendChild(close);dots.appendChild(mini);
  var title=document.createElement('span');title.textContent='shiro';
  var ts=title.style;ts.color='#8888cc';ts.fontSize='13px';ts.fontWeight='600';ts.marginLeft='10px';ts.flex='1';
  var fontSize=14;
  var zoomWrap=document.createElement('div');zoomWrap.style.cssText='display:flex;gap:4px;opacity:0;transition:opacity 0.15s';
  var zoomOut=document.createElement('div');zoomOut.textContent='\\u2212';
  zoomOut.style.cssText='width:14px;height:14px;border-radius:50%;background:#555;color:#fff;font-size:12px;line-height:14px;text-align:center;cursor:pointer';
  var zoomIn=document.createElement('div');zoomIn.textContent='+';
  zoomIn.style.cssText='width:14px;height:14px;border-radius:50%;background:#555;color:#fff;font-size:12px;line-height:14px;text-align:center;cursor:pointer';
  zoomOut.onclick=function(e){e.stopPropagation();fontSize=Math.max(8,fontSize-1);iframe.contentWindow.postMessage({type:'shiro-fontsize',size:fontSize},'*')};
  zoomIn.onclick=function(e){e.stopPropagation();fontSize=Math.min(24,fontSize+1);iframe.contentWindow.postMessage({type:'shiro-fontsize',size:fontSize},'*')};
  zoomWrap.appendChild(zoomOut);zoomWrap.appendChild(zoomIn);
  tb.onmouseenter=function(){zoomWrap.style.opacity='1'};
  tb.onmouseleave=function(){zoomWrap.style.opacity='0'};
  tb.appendChild(dots);tb.appendChild(title);tb.appendChild(zoomWrap);
  var iframe=document.createElement('iframe');iframe.src=blobUrl;
  var is=iframe.style;is.border='none';is.width='100%';is.flex='1';is.display='block';is.pointerEvents='auto';is.background='#0a0a1a';
  iframe.tabIndex=0;iframe.title='tabcomputer';
  iframe.allow='clipboard-read; clipboard-write; cross-origin-isolated';
  var rh=document.createElement('div');var rs=rh.style;
  rs.position='absolute';rs.bottom='0';rs.right='0';rs.width='16px';rs.height='16px';
  rs.cursor='nwse-resize';rs.background='linear-gradient(135deg,transparent 50%,#555 50%)';
  w.appendChild(tb);w.appendChild(iframe);w.appendChild(rh);
  root.appendChild(w);document.body.appendChild(host);
  function focusShiro(){
    iframe.style.pointerEvents='auto';
    try{iframe.focus()}catch(ex){}
    try{iframe.contentWindow&&iframe.contentWindow.focus&&iframe.contentWindow.focus()}catch(ex){}
    try{iframe.contentWindow&&iframe.contentWindow.postMessage({type:'shiro-focus-terminal'},'*')}catch(ex){}
  }
  var dx=0,dy=0,sx=0,sy=0,dragging=false;
  tb.onmousedown=function(e){dragging=true;sx=e.clientX;sy=e.clientY;
    var r=w.getBoundingClientRect();dx=r.left;dy=r.top;
    tb.style.cursor='grabbing';iframe.style.pointerEvents='none';e.preventDefault()};
  document.addEventListener('mousemove',function(e){
    if(dragging){w.style.left=(dx+e.clientX-sx)+'px';w.style.top=(dy+e.clientY-sy)+'px';
      w.style.right='auto';w.style.bottom='auto'}
    if(resizing){var rr=w.getBoundingClientRect();
      var nw=Math.max(300,e.clientX-rr.left);var nh=Math.max(200,e.clientY-rr.top);
      w.style.width=nw+'px';w.style.height=nh+'px';savedH=nh}});
  document.addEventListener('mouseup',function(){dragging=false;resizing=false;tb.style.cursor='grab';iframe.style.pointerEvents='auto'});
  var resizing=false,savedH=w.offsetHeight||352;
  rh.onmousedown=function(e){resizing=true;iframe.style.pointerEvents='none';e.preventDefault();e.stopPropagation()};
  iframe.onmousedown=function(){focusShiro()};
  iframe.ontouchstart=function(){focusShiro()};
  w.addEventListener('mousedown',function(e){if(e.target===iframe||iframe.contains(e.target)){focusShiro()}});
  function buildContext(){
    return {
      mode:'seed-blob',
      injected:true,
      hcOuterAvailable:true,
      sameOriginParentAccess:true,
      hostUrl:location.href,
      hostOrigin:location.origin,
      hostTitle:document.title||'',
      createdAt:new Date().toISOString()
    };
  }
  var seeded=false,seedReady=false;
  async function maybeSeed(){
    if(seeded||!seedReady||!iframe.contentWindow)return;
    seeded=true;
    iframe.contentWindow.postMessage({type:'shiro-seed-v2',ndjson:await _fsP,storage:await _lsP,context:buildContext()},'*');
  }
  window.addEventListener('message',function(e){
    if(e.source===iframe.contentWindow&&e.data&&e.data.type==='shiro-seed-ready'){
      seedReady=true;
      maybeSeed();
    }
  });
  iframe.onload=function(){
    setTimeout(focusShiro,0);
    maybeSeed();
  };
  (function(){
    var cur=document.body,lastR=[],lastG=null;
    function _t(el,lim){var t=(el.textContent||'').replace(/\\s+/g,' ').trim();return lim&&t.length>lim?t.slice(0,lim)+'\\u2026':t}
    function _d(el){var d=0;while(el&&el!==document.body&&el!==document.documentElement){d++;el=el.parentElement}return d}
    function exec(cmd){
      cmd=cmd.trim();var m;
      if(cmd.includes(';')&&!cmd.startsWith(';'))return cmd.split(';').map(function(c){return c.trim()}).filter(Boolean).map(exec).join('\\n---\\n');
      if(cmd==='s')return 'p:outer c:'+lastR.length+' d:'+_d(cur)+' @'+(cur.tagName||'doc').toLowerCase();
      if(cmd==='t')return _t(cur);
      if((m=cmd.match(/^t(\\d+)$/)))return _t(cur,parseInt(m[1]));
      if(cmd.startsWith('q1 ')){try{var el=document.querySelector(cmd.slice(3).trim());if(!el)return '\\u2205';cur=el;lastR=[el];return _t(el).slice(0,200)}catch(e){return '\\u2717 '+e.message}}
      if(cmd.startsWith('q ')){try{var els=Array.from(document.querySelectorAll(cmd.slice(2).trim()));lastR=els;if(!els.length)return '\\u2205';return els.slice(0,10).map(function(el,i){return '['+i+']'+_t(el).slice(0,60)}).join('\\n')}catch(e){return '\\u2717 '+e.message}}
      if((m=cmd.match(/^n(\\d+)$/))){var idx=parseInt(m[1]);if(idx>=lastR.length)return '\\u2717 out of range';cur=lastR[idx];return '\\u2713 ['+idx+'] '+_t(cur).slice(0,100)}
      if(cmd==='up'){if(cur.parentElement)cur=cur.parentElement;return '\\u2713 @'+(cur.tagName||'').toLowerCase()}
      if((m=cmd.match(/^up(\\d+)$/))){for(var i=0;i<parseInt(m[1]);i++)if(cur.parentElement)cur=cur.parentElement;return '\\u2713 @'+(cur.tagName||'').toLowerCase()}
      if(cmd==='ch'){var ch=Array.from(cur.children);if(!ch.length)return '\\u2205 no children';return ch.slice(0,15).map(function(c,i){var tag=c.tagName.toLowerCase();var cls=c.className?'.'+String(c.className).split(' ')[0]:'';return '['+i+']<'+tag+cls+'>'+_t(c).slice(0,30)}).join('\\n')}
      if(cmd.startsWith('g ')){var lines=(cur.textContent||'').split('\\n');var re=new RegExp(cmd.slice(2).trim(),'gi');var matches=[];lines.forEach(function(line,i){if(re.test(line)){var clean=line.replace(/\\s+/g,' ').trim();if(clean)matches.push('L'+(i+1)+': '+clean.slice(0,60))}});return matches.length?matches.slice(0,10).join('\\n'):'\\u2205 no matches'}
      if(cmd==='look'){var inter=cur.querySelectorAll('a,button,input,select,textarea,[onclick],[href],.btn,[role=button]');var items=[];inter.forEach(function(el,idx){var text=(el.textContent||el.value||el.placeholder||el.getAttribute('title')||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim().slice(0,20);if(text||el.tagName.toLowerCase()==='input')items.push({text:text||'['+(el.type||'input')+']',el:el,idx:idx})});lastG=items;if(!items.length)return '\\u2205 no interactive elements';var out=items.length+' elements\\n';items.slice(0,20).forEach(function(item,i){var tag=item.el.tagName.toLowerCase();var href=item.el.getAttribute('href');out+='@'+i+' <'+tag+'> "'+item.text+'"'+(href?' \\u2192'+href.slice(0,25):'')+' \\n'});return out.trim()}
      if((m=cmd.match(/^@(\\d+)$/))){if(!lastG||parseInt(m[1])>=lastG.length)return '\\u2717 call look first or index out of range';var it=lastG[parseInt(m[1])];try{it.el.click()}catch(e){}return '\\u2713 clicked "'+it.text+'"'}
      if(cmd==='a'){if(!cur.attributes)return '\\u2205';var attrs=[];for(var j=0;j<cur.attributes.length;j++){var at=cur.attributes[j];attrs.push(at.name+'='+at.value.slice(0,30))}return attrs.length?attrs.join(' '):'\\u2205 no attrs'}
      if(cmd==='h')return cur.outerHTML;
      if((m=cmd.match(/^h(\\d+)$/))){var html2=cur.outerHTML;var lim=parseInt(m[1]);return html2.length>lim?html2.slice(0,lim)+'\\u2026[truncated]':html2}
      return '\\u2717 unknown: '+cmd;
    }
    window.addEventListener('message',function(e){
      if(e.data&&e.data.type==='shiro-hc'){
        var result;try{result=exec(e.data.cmd)}catch(err){result='\\u2717 '+err.message}
        e.source.postMessage({type:'shiro-hc-result',id:e.data.id,result:result},'*');
      }
    });
  })();
})();`;
}

interface SeedOptions { withCredentials: boolean; yes: boolean }

const USAGE = 'Usage: seed [blob|gif|html|share] [--with-credentials] [--yes]\n';

export const seedCmd: Command = {
  name: 'seed',
  description: 'Export tabcomputer state, without credentials (seed [blob|gif|html|share] [--with-credentials] [--yes])',

  async exec(ctx: CommandContext): Promise<number> {
    const flags = ctx.args.filter((a) => a.startsWith('-'));
    const unknown = flags.filter((f) => !['--with-credentials', '--yes', '-y'].includes(f));
    if (unknown.length) { ctx.stderr = `seed: unknown option ${unknown[0]}\n${USAGE}`; return 2; }
    const opts: SeedOptions = { withCredentials: flags.includes('--with-credentials'), yes: flags.includes('--yes') || flags.includes('-y') };
    ctx = Object.assign(ctx, { args: ctx.args.filter((a) => !a.startsWith('-')) });

    // ─── seed gif ────────────────────────────────────────
    if (ctx.args[0] === 'gif') {
      return execSeedGif(ctx, opts);
    }

    // ─── seed html ───────────────────────────────────────
    if (ctx.args[0] === 'html') {
      return execSeedHtml(ctx, opts);
    }

    // ─── seed share ──────────────────────────────────────
    if (ctx.args[0] === 'share') {
      return execSeedShare(ctx, opts);
    }

    // Check for blob mode: seed blob
    const isBlob = ctx.args[0] === 'blob';
    const targetArg = isBlob ? ctx.args[1] : ctx.args[0];
    try {
      const url = buildTargetUrl(targetArg);
      // For blob mode, we need to inline the document and compress it
      let compressedB64 = '';
      let htmlSize = 0;
      let compressedSize = 0;

      if (isBlob) {
        ctx.stdout = 'Inlining document resources...\n';

        // Inline all external resources
        const inlinedHtml = await inlineDocument();
        htmlSize = inlinedHtml.length;

        ctx.stdout += `  HTML size: ${(htmlSize / 1024).toFixed(0)} KB\n`;
        ctx.stdout += 'Compressing...\n';

        // Compress HTML with gzip
        const htmlBytes = new TextEncoder().encode(inlinedHtml);
        const compressed = await gzipCompress(htmlBytes);

        compressedSize = compressed.length;
        compressedB64 = uint8ToBase64(compressed);

        ctx.stdout += `  Compressed: ${(compressedSize / 1024).toFixed(0)} KB (${((1 - compressedSize / htmlSize) * 100).toFixed(0)}% reduction)\n`;
      }

      // The state, without credentials unless asked (src/seed-state.ts)
      const state = await collectSeedState(ctx.fs, opts);
      const { ndjson, storageJson, stats } = state;
      const fileCount = stats.files;
      const dirCount = stats.dirs;

      // Build the appropriate snippet
      let snippet: string;
      if (isBlob) {
        // Compress NDJSON and storage for blob mode (huge size reduction)
        ctx.stdout += 'Compressing filesystem data...\n';
        const compressedFs = await gzipCompress(new TextEncoder().encode(ndjson));
        const compressedFsB64 = uint8ToBase64(compressedFs);
        const compressedStorage = await gzipCompress(new TextEncoder().encode(storageJson));
        const compressedStorageB64 = uint8ToBase64(compressedStorage);
        ctx.stdout += `  FS compressed: ${(compressedFs.length / 1024).toFixed(0)} KB (was ${(ndjson.length / 1024).toFixed(0)} KB)\n`;
        snippet = buildBlobSnippet(compressedB64, compressedFsB64, compressedStorageB64, { ...stats, htmlSize, compressedSize });
      } else {
        snippet = buildSnippet(url, ndjson, storageJson, stats);
      }

      const snippetSizeKBNum = snippet.length / 1024;
      const snippetSizeKB = snippetSizeKBNum.toFixed(0);
      const snippetSizeMB = (snippet.length / (1024 * 1024)).toFixed(2);

      await navigator.clipboard.writeText(snippet);

      // Build output with stats
      let output = '\n';
      output += `  tabcomputer ${isBlob ? 'Blob ' : ''}Seed v${SHIRO_VERSION}\n`;
      output += `  ${'─'.repeat(30)}\n`;
      if (isBlob) {
        output += `  Mode:        self-contained blob (CSP-safe)\n`;
        output += `  HTML size:   ${(htmlSize / 1024).toFixed(0)} KB\n`;
        output += `  Compressed:  ${(compressedSize / 1024).toFixed(0)} KB\n`;
      } else {
        output += `  Target:      ${url}\n`;
      }
      output += `  Files:       ${fileCount}\n`;
      output += `  Directories: ${dirCount}\n`;
      output += `  Data size:   ${stats.sizeMB} MB\n`;
      output += `  Seed size:   ${snippetSizeMB} MB (${snippetSizeKB} KB)\n`;

      output += describeSeedContents(state);
      if (isBlob) output += `\n  A blob seed runs inside the page you paste it into: that site's scripts can read these files.\n`;

      // Size warning for large seeds
      if (snippetSizeKBNum > 10000) {
        output += `\n  Warning: Large seed may crash low-memory devices.\n`;
        output += `  Consider: rm -rf node_modules && seed\n`;
      }

      output += `\n  Copied. Open DevTools (F12 or Cmd+Opt+J) → Console → Paste.\n\n`;

      ctx.stdout = output;
      return 0;
    } catch (e: any) {
      ctx.stderr = `seed: ${e.message}\n`;
      return 1;
    }
  },
};

// ─── seed gif implementation ─────────────────────────────────

const serializeState = (ctx: CommandContext, opts: SeedOptions): Promise<SeedState> => collectSeedState(ctx.fs, opts);

function triggerDownload(data: Uint8Array | string, type: string, filename: string) {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function execSeedGif(ctx: CommandContext, opts: SeedOptions): Promise<number> {
  try {
    ctx.stdout = 'Capturing terminal...\n';
    const state = await serializeState(ctx, opts);
    const { ndjson, storageJson, stats } = state;

    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'shiro.computer';

    // Build seed envelope and compress
    const seedEnvelope = JSON.stringify({
      version: SHIRO_VERSION, hostname, timestamp: Date.now(),
      files: stats.files, dirs: stats.dirs, totalBytes: stats.totalBytes,
      ndjson, storage: storageJson,
    });
    const compressed = await gzipCompress(new TextEncoder().encode(seedEnvelope));

    // Capture terminal and add overlay
    const term = (window as any).__tabcomputer?.terminal?.term;
    if (!term) {
      ctx.stderr = 'seed gif: terminal not available\n';
      return 1;
    }
    const canvas = captureTerminal(term);
    addOverlay(canvas, { files: stats.files, sizeMB: stats.sizeMB }, hostname);

    // Encode GIF with embedded seed
    ctx.stdout += 'Encoding GIF...\n';
    const gifBytes = encodeGIF(canvas, compressed);

    // Store on __tabcomputer for demo/drag access
    if (typeof window !== 'undefined' && (window as any).__tabcomputer) {
      (window as any).__tabcomputer.lastSeedGif = gifBytes;
    }

    // Download
    const subdomain = getCurrentSubdomain();
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${subdomain || 'shiro'}-${date}.gif`;
    triggerDownload(gifBytes, 'image/gif', filename);

    // Show draggable thumbnail
    showDraggableGif(gifBytes, filename);

    // Stats output
    const imageApprox = gifBytes.length - compressed.length;
    let output = '\n';
    output += `  tabcomputer GIF Seed v${SHIRO_VERSION}\n`;
    output += `  ${'─'.repeat(30)}\n`;
    output += `  Files:       ${stats.files}\n`;
    output += `  Directories: ${stats.dirs}\n`;
    output += `  Data size:   ${stats.sizeMB} MB\n`;
    output += `  GIF size:    ${(gifBytes.length / 1024).toFixed(0)} KB (seed: ${(compressed.length / 1024).toFixed(0)} KB + image: ${(imageApprox / 1024).toFixed(0)} KB)\n`;

    output += describeSeedContents(state);

    output += `\n  Downloaded: ${filename}\n`;
    output += `  To restore: drag this GIF onto a tabcomputer tab.\n\n`;
    ctx.stdout = output;
    return 0;
  } catch (e: any) {
    ctx.stderr = `seed gif: ${e.message}\n`;
    return 1;
  }
}

// ─── draggable GIF thumbnail ─────────────────────────────────

function showDraggableGif(gifBytes: Uint8Array, filename: string) {
  if (typeof document === 'undefined') return;
  const container = document.getElementById('terminal');
  if (!container) return;

  // Remove any existing thumbnail
  const existing = document.getElementById('seed-gif-thumb');
  if (existing) existing.remove();

  const blob = new Blob([gifBytes as BlobPart], { type: 'image/gif' });
  const url = URL.createObjectURL(blob);

  const el = document.createElement('div');
  el.id = 'seed-gif-thumb';
  el.draggable = true;
  el.style.cssText = [
    'position:absolute', 'bottom:16px', 'right:16px', 'z-index:1000',
    'background:#1a1a2e', 'border:2px solid #51cf66', 'border-radius:8px',
    'padding:6px', 'cursor:grab', 'box-shadow:0 4px 12px rgba(0,0,0,0.5)',
    'display:flex', 'flex-direction:column', 'align-items:center', 'gap:4px',
  ].join(';');

  const img = document.createElement('img');
  img.src = url;
  img.style.cssText = 'width:120px;height:auto;border-radius:4px;pointer-events:none';

  const label = document.createElement('span');
  label.textContent = '\u2b06 Drag to another tabcomputer tab';
  label.style.cssText = 'font-size:10px;color:#51cf66;font-family:system-ui;font-weight:600';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '\u00d7';
  closeBtn.style.cssText = [
    'position:absolute', 'top:2px', 'right:6px', 'background:none',
    'border:none', 'color:#666', 'font-size:14px', 'cursor:pointer',
    'line-height:1', 'padding:0',
  ].join(';');
  closeBtn.onclick = () => { el.remove(); URL.revokeObjectURL(url); };

  el.appendChild(closeBtn);
  el.appendChild(img);
  el.appendChild(label);

  // Use native HTML5 drag — no setDragImage override, let browser
  // render the default drag ghost (which animates across windows)
  el.addEventListener('dragstart', (e) => {
    const file = new File([gifBytes as BlobPart], filename, { type: 'image/gif' });
    e.dataTransfer!.items.add(file);
    e.dataTransfer!.effectAllowed = 'copy';
  });

  container.appendChild(el);

  // Auto-remove after 60 seconds
  setTimeout(() => { if (el.parentNode) { el.remove(); URL.revokeObjectURL(url); } }, 60000);
}

// ─── seed share implementation ───────────────────────────────

/** One line typed at the terminal, or null when there is nobody to ask (a script, an agent's tool, a pipe) */
async function askAtTerminal(ctx: CommandContext, text: string): Promise<string | null> {
  const term = ctx.terminal as (CommandContext['terminal'] & { waitForUserInput?: () => Promise<string> }) | undefined;
  if (!term?.waitForUserInput || ctx.stdinIsTTY === false || ctx.stdoutIsTTY === false) return null;
  term.writeOutput(text);
  return term.waitForUserInput();
}

async function execSeedShare(ctx: CommandContext, opts: SeedOptions): Promise<number> {
  try {
    if (opts.withCredentials) {
      ctx.stderr = 'seed share: a shared seed is kept on the server and anyone with the link can download it, so it never carries credentials.\n'
        + 'To move your own machine with its sign-ins, make a file instead: seed gif --with-credentials (or seed html --with-credentials).\n';
      return 2;
    }
    const state = await collectSeedState(ctx.fs, opts);
    const { ndjson, storageJson, stats } = state;
    const origin = getShiroOrigin();

    // Build seed envelope and compress
    const seedEnvelope = JSON.stringify({
      version: SHIRO_VERSION,
      hostname: typeof window !== 'undefined' ? window.location.hostname : 'shiro.computer',
      timestamp: Date.now(),
      files: stats.files,
      dirs: stats.dirs,
      totalBytes: stats.totalBytes,
      ndjson,
      storage: storageJson,
    });
    const compressed = await gzipCompress(new TextEncoder().encode(seedEnvelope));

    // What will be shared, before anything is sent
    let summary = '\n';
    summary += `  tabcomputer Shared Seed v${SHIRO_VERSION}\n`;
    summary += `  ${'─'.repeat(30)}\n`;
    summary += `  Files:       ${stats.files}\n`;
    summary += `  Directories: ${stats.dirs}\n`;
    summary += `  Data size:   ${stats.sizeMB} MB\n`;
    summary += `  Compressed:  ${(compressed.length / 1024).toFixed(0)} KB\n`;
    summary += describeSeedContents(state);
    summary += `\n  This uploads every other file on this machine to ${origin}.\n`;
    summary += `  \x1b[1mAnyone with the link can download all of it.\x1b[0m The server keeps it, with your\n`;
    summary += `  address, until 60 days after the link was last opened. There is no way to take it back.\n`;

    if (compressed.length > SHARE_MAX_BYTES) {
      ctx.stdout = summary;
      ctx.stderr = `seed share: too large to share (${(compressed.length / 1024).toFixed(0)} KB compressed; the limit is ${SHARE_MAX_BYTES / 1024} KB). Nothing was uploaded.\n`;
      return 1;
    }

    let shown = false;
    if (!opts.yes) {
      const answer = await askAtTerminal(ctx, `${summary}\n  Upload? Type yes to share, anything else to cancel: `);
      if (answer === null) {
        ctx.stdout = summary;
        ctx.stderr = 'seed share: nothing was uploaded. This needs a yes: run it at a terminal, or pass --yes after reading the list above.\n';
        return 1;
      }
      shown = true;
      if (answer.trim().toLowerCase() !== 'yes') {
        ctx.stdout = '\n  Cancelled. Nothing was uploaded.\n\n';
        return 1;
      }
    }

    const res = await fetch(`${origin}/api/seed`, {
      method: 'POST',
      body: compressed as unknown as BodyInit,
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      ctx.stderr = `seed share: ${err.error}\n`;
      return 1;
    }

    const { id, url } = await res.json();
    const fullUrl = `${origin}${url}`;

    // Copy URL to clipboard
    try {
      await navigator.clipboard.writeText(fullUrl);
    } catch {}

    let output = shown ? '\n' : summary;
    output += `\n  Uploaded.\n`;
    output += `  ID:          ${id}\n`;
    output += `  URL:         ${fullUrl}\n`;
    output += `\n  URL copied to clipboard. Whoever opens it gets a tabcomputer with these files.\n`;
    output += `  Link expires after 60 days of no visits.\n\n`;
    ctx.stdout = output;
    return 0;
  } catch (e: any) {
    ctx.stderr = `seed share: ${e.message}\n`;
    return 1;
  }
}

/** server.mjs SEED_MAX_SIZE */
const SHARE_MAX_BYTES = 512 * 1024;

// ─── seed html implementation ────────────────────────────────

async function execSeedHtml(ctx: CommandContext, opts: SeedOptions): Promise<number> {
  try {
    ctx.stdout = 'Inlining document resources...\n';
    const html = await inlineDocument();
    ctx.stdout += `  HTML size: ${(html.length / 1024).toFixed(0)} KB\n`;

    ctx.stdout += 'Serializing filesystem...\n';
    const state = await serializeState(ctx, opts);
    const { ndjson, storageJson, stats } = state;

    // Compress NDJSON + storage for smaller file
    ctx.stdout += 'Compressing state...\n';
    const compressedFs = await gzipCompress(new TextEncoder().encode(ndjson));
    const compressedFsB64 = uint8ToBase64(compressedFs);
    const compressedStorage = await gzipCompress(new TextEncoder().encode(storageJson));
    const compressedStorageB64 = uint8ToBase64(compressedStorage);

    ctx.stdout += `  FS compressed: ${(compressedFs.length / 1024).toFixed(0)} KB (was ${(ndjson.length / 1024).toFixed(0)} KB)\n`;

    // Inject seed script before </body>
    const seedScript = `<script>
(async function(){
  async function _dc(b){
    var a=atob(b),u=new Uint8Array(a.length);
    for(var i=0;i<a.length;i++)u[i]=a.charCodeAt(i);
    var s=new DecompressionStream('gzip'),w=s.writable.getWriter();
    w.write(u);w.close();
    var r=s.readable.getReader(),c=[],v;
    while(!(v=await r.read()).done)c.push(v.value);
    var t=0;for(var x of c)t+=x.length;
    var o=new Uint8Array(t),p=0;for(var x of c){o.set(x,p);p+=x.length}
    return new TextDecoder().decode(o);
  }
  var attempts=0;
  var timer=setInterval(async function(){
    if(window.__tabcomputer||attempts++>50){
      clearInterval(timer);
      if(window.__tabcomputer){
        window.postMessage({
          type:'shiro-seed-v2',
          ndjson:await _dc('${compressedFsB64}'),
          storage:await _dc('${compressedStorageB64}')
        },'*');
      }
    }
  },100);
})();
</script>`;

    const fullHtml = html.replace('</body>', seedScript + '\n</body>');

    // Download
    const subdomain = getCurrentSubdomain();
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${subdomain || 'shiro'}-${date}.html`;
    triggerDownload(fullHtml, 'text/html', filename);

    let output = '\n';
    output += `  tabcomputer HTML Seed v${SHIRO_VERSION}\n`;
    output += `  ${'─'.repeat(30)}\n`;
    output += `  Files:       ${stats.files}\n`;
    output += `  Directories: ${stats.dirs}\n`;
    output += `  Data size:   ${stats.sizeMB} MB\n`;
    output += `  HTML size:   ${(fullHtml.length / 1024).toFixed(0)} KB\n`;

    output += describeSeedContents(state);

    output += `\n  Downloaded: ${filename}\n`;
    output += `  Open in any browser to boot with your filesystem.\n\n`;
    ctx.stdout = output;
    return 0;
  } catch (e: any) {
    ctx.stderr = `seed html: ${e.message}\n`;
    return 1;
  }
}
