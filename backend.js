/* Mein Plan: Speicher über Supabase.
   Stellt dieselbe Schnittstelle bereit, die die App früher auf claude.ai hatte
   (claude.use('db'), 'assets', 'downloads'), damit der App-Code fast unverändert bleibt. */
(function(){
'use strict';
var CFG=window.PLAN_CONFIG||{};
var sb=null,user=null,ready=null,readyResolve=null;
ready=new Promise(function(r){readyResolve=r});

function deepFreeze(o){if(o&&typeof o==='object'&&!Object.isFrozen(o)){Object.freeze(o);Object.keys(o).forEach(function(k){deepFreeze(o[k])})}return o}
function copy(o){return o==null?o:JSON.parse(JSON.stringify(o))}
function uid(){var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(b){return('0'+b.toString(16)).slice(-2)}).join('')}
function el(html){var d=document.createElement('div');d.innerHTML=html;return d.firstElementChild}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}

/* ---------- Daten im Speicher halten und Änderungen melden ---------- */
var cache={};            // col -> {id: data}
var colSubs={},docSubs={};
function colOf(c){return cache[c]||(cache[c]={})}
function snapCol(c){var m=colOf(c);return{docs:Object.keys(m).map(function(id){var d=m[id];return{id:id,exists:true,data:function(){return d}}}),size:Object.keys(m).length}}
function snapDoc(c,id){var d=colOf(c)[id];return{id:id,exists:d!==undefined,data:function(){return d}}}
var pending={},flushT=null;
function emit(c,id){pending[c+'\u0000'+id]=1;if(!flushT)flushT=setTimeout(flush,0)}
function flush(){
  flushT=null;var keys=Object.keys(pending);pending={};var cols={};
  keys.forEach(function(k){var p=k.split('\u0000');cols[p[0]]=1;(docSubs[p[0]+'/'+p[1]]||[]).forEach(function(cb){try{cb(snapDoc(p[0],p[1]))}catch(e){console.error(e)}})});
  Object.keys(cols).forEach(function(c){(colSubs[c]||[]).forEach(function(cb){try{cb(snapCol(c))}catch(e){console.error(e)}})});
}
function put(c,id,data){if(data===undefined)delete colOf(c)[id];else colOf(c)[id]=deepFreeze(copy(data));emit(c,id)}

function err(e,code){var x=new Error(e&&e.message||String(e));x.code=code||(e&&e.code)||'error';return x}
function chk(r){if(r&&r.error)throw err(r.error);return r}

function docRef(c,id){
  return{
    id:id,
    set:function(data){var old=colOf(c)[id];put(c,id,data);
      return sb.from('docs').upsert({user_id:user.id,col:c,id:id,data:copy(data),updated_at:new Date().toISOString()},{onConflict:'user_id,col,id'}).then(chk).then(function(){},function(e){put(c,id,old);throw err(e)})},
    update:function(patch){var old=colOf(c)[id];if(old===undefined)return Promise.reject(err('Eintrag nicht gefunden','not_found'));
      put(c,id,Object.assign(copy(old),copy(patch)));
      return sb.rpc('doc_merge',{p_col:c,p_id:id,p_patch:copy(patch)}).then(chk).then(function(){},function(e){put(c,id,old);throw err(e)})},
    delete:function(){var old=colOf(c)[id];put(c,id,undefined);
      return sb.from('docs').delete().match({user_id:user.id,col:c,id:id}).then(chk).then(function(){},function(e){if(old!==undefined)put(c,id,old);throw err(e)})},
    get:function(){return Promise.resolve(snapDoc(c,id))},
    onSnapshot:function(cb,onErr){var k=c+'/'+id;(docSubs[k]=docSubs[k]||[]).push(cb);setTimeout(function(){cb(snapDoc(c,id))},0);
      return function(){docSubs[k]=(docSubs[k]||[]).filter(function(f){return f!==cb})}}
  };
}
var db={
  doc:function(path){var p=String(path).split('/');return docRef(p[0],p.slice(1).join('/'))},
  collection:function(c){return{
    doc:function(id){return docRef(c,id||uid())},
    add:function(data){var id=uid();return docRef(c,id).set(data).then(function(){return docRef(c,id)})},
    get:function(){return Promise.resolve(snapCol(c))},
    onSnapshot:function(cb,onErr){(colSubs[c]=colSubs[c]||[]).push(cb);setTimeout(function(){cb(snapCol(c))},0);
      return function(){colSubs[c]=(colSubs[c]||[]).filter(function(f){return f!==cb})}}
  }}
};

function loadAll(){
  var all=[],step=1000;
  function page(a){return sb.from('docs').select('col,id,data').order('col').order('id').range(a,a+step-1).then(chk).then(function(r){all=all.concat(r.data||[]);if((r.data||[]).length===step)return page(a+step)})}
  return page(0).then(function(){cache={};all.forEach(function(r){colOf(r.col)[r.id]=deepFreeze(r.data)})});
}
function live(){
  sb.channel('docs-'+user.id).on('postgres_changes',{event:'*',schema:'public',table:'docs'},function(p){
    var row=p.eventType==='DELETE'?p.old:p.new;if(!row||(row.user_id&&row.user_id!==user.id))return;
    put(row.col,row.id,p.eventType==='DELETE'?undefined:row.data);
  }).subscribe();
  /* Nach dem Aufwecken (Handy) einmal alles neu holen, falls etwas verpasst wurde */
  document.addEventListener('visibilitychange',function(){if(document.hidden)return;
    loadAll().then(function(){Object.keys(cache).concat(Object.keys(colSubs)).forEach(function(c){emit(c,'')})}).catch(function(){})});
}

/* ---------- Dateien ---------- */
var MAXFILE=48*1024*1024;
var assets={
  upload:function(blob,opts){
    var id=uid(),type=(opts&&opts.type)||blob.type||'application/octet-stream';
    if(blob.size>MAXFILE)return Promise.reject(err('Datei zu groß','too_large'));
    return sb.storage.from('files').upload(user.id+'/'+id,blob,{contentType:type,upsert:false}).then(chk).then(function(){return{id:id,size:blob.size,type:type}});
  },
  delete:function(id){return sb.storage.from('files').remove([user.id+'/'+id]).then(chk).then(function(){})}
};
var realFetch=window.fetch.bind(window);
window.fetch=function(input,init){
  var u=typeof input==='string'?input:input&&input.url;
  var m=u&&String(u).match(/^(?:https?:\/\/[^/]+)?\/_blob\/([^?#]+)/);
  if(!m||!sb)return realFetch(input,init);
  return ready.then(function(){return sb.storage.from('files').download(user.id+'/'+decodeURIComponent(m[1]))}).then(function(r){
    if(r.error)return new Response('',{status:404});return new Response(r.data,{status:200,headers:{'content-type':r.data.type||'application/octet-stream'}})});
};
var downloads={save:function(o){
  var url=URL.createObjectURL(o.data),a=document.createElement('a');a.href=url;a.download=o.filename||'download';document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(url);a.remove()},4000);return Promise.resolve();
}};

/* ---------- Anmelden ---------- */
var CSS='.acct{position:fixed;inset:0;z-index:9999;background:var(--bg,#f5f5f7);color:var(--fg,#1d1d1f);display:flex;align-items:center;justify-content:center;padding:16px;font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow:auto}'
 +'.acct .box{width:100%;max-width:400px;background:var(--card,#fff);border-radius:18px;padding:22px;box-shadow:0 4px 24px rgba(0,0,0,.08)}'
 +'.acct h2{margin:0 0 6px;font-size:24px}.acct p{margin:0 0 14px;color:var(--mut,#6e6e73);font-size:15px}'
 +'.acct label{display:block;font-size:14px;font-weight:600;margin:10px 0 4px}.acct input[type=email],.acct input[type=password]{width:100%;box-sizing:border-box;font:inherit;padding:11px 12px;border-radius:10px;border:1px solid var(--line,#d2d2d7);background:var(--bg,#fff);color:inherit}'
 +'.acct button{width:100%;margin-top:12px;font:inherit;font-weight:600;padding:12px;border-radius:12px;border:0;background:var(--acc,#0b6bcb);color:#fff;cursor:pointer}'
 +'.acct button.ghost{background:none;color:var(--acc,#0b6bcb);border:1px solid var(--line,#d2d2d7)}.acct .msg{min-height:20px;margin-top:10px;font-size:14px}.acct .bad{color:#d1342f}.acct .good{color:#1a8f3c}'
 +'@media (prefers-color-scheme:dark){.acct{background:var(--bg,#000);color:var(--fg,#f5f5f7)}.acct .box{background:var(--card,#1c1c1e)}}';
function style(){if(document.getElementById('acctcss'))return;var s=document.createElement('style');s.id='acctcss';s.textContent=CSS;document.head.appendChild(s)}
function loginScreen(){
  style();var w=el('<div class="acct"><form class="box" autocomplete="on"><h2>Mein Plan</h2><p>Melde dich an, damit Handy, iPad und PC dieselben Daten sehen.</p>'
    +'<label>E-Mail<input type="email" name="email" autocomplete="username" required></label>'
    +'<label>Passwort<input type="password" name="pw" autocomplete="current-password" minlength="8" required></label>'
    +'<button type="submit">Anmelden</button><button type="button" class="ghost" data-new>Neues Konto anlegen</button><div class="msg"></div></form></div>');
  document.body.appendChild(w);var f=w.querySelector('form'),msg=w.querySelector('.msg');
  function say(t,ok){msg.className='msg '+(ok?'good':'bad');msg.textContent=t}
  f.onsubmit=function(e){e.preventDefault();say('Melde an …',true);
    sb.auth.signInWithPassword({email:f.email.value.trim(),password:f.pw.value}).then(function(r){
      if(r.error)say(/confirm/i.test(r.error.message)?'Bitte bestätige zuerst den Link in der E-Mail von Supabase.':'Anmelden hat nicht geklappt: E-Mail oder Passwort falsch.');})};
  w.querySelector('[data-new]').onclick=function(){if(!f.reportValidity())return;say('Lege Konto an …',true);
    sb.auth.signUp({email:f.email.value.trim(),password:f.pw.value,options:{emailRedirectTo:location.href.split('#')[0]}}).then(function(r){
      if(r.error)return say('Konto anlegen hat nicht geklappt: '+r.error.message);
      if(!r.data.session)say('Fast fertig: Öffne die E-Mail von Supabase und tippe auf den Link. Danach hier anmelden.',true)})};
  return w;
}
function fail(t){style();document.body.appendChild(el('<div class="acct"><div class="box"><h2>Mein Plan</h2><p>'+esc(t)+'</p></div></div>'))}

function start(u){
  if(user&&u&&user.id===u.id)return;user=u;
  var ls=document.querySelector('.acct');if(ls)ls.remove();
  loadAll().then(function(){live();readyResolve(true)}).catch(function(e){console.error(e);fail('Deine Daten konnten nicht geladen werden ('+e.message+'). Lade die Seite neu.')});
}
function boot(){
  if(!window.supabase||!CFG.supabaseUrl||!CFG.supabaseKey){fail('Die Datenbank ist noch nicht eingerichtet. Trage in config.js die Supabase-Adresse und den Schlüssel ein.');return}
  sb=window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  var shown=null;
  sb.auth.onAuthStateChange(function(ev,session){
    if(session&&session.user)start(session.user);
    else if(ev==='SIGNED_OUT'){location.reload()}
  });
  sb.auth.getSession().then(function(r){var s=r.data&&r.data.session;if(s&&s.user)start(s.user);else if(!user)shown=loginScreen()});
}

/* ---------- Konto & Datenumzug (für die App erreichbar über PLAN.account()) ---------- */
function dataCounts(){return Object.keys(cache).map(function(c){return c+': '+Object.keys(cache[c]).length}).join(', ')||'noch leer'}
function importJson(obj){
  /* Format: {modules:{id:data}, blocks:{...}, study:{...}, logs:{...}, settings:{main:{...}}} */
  var rows=[];Object.keys(obj).forEach(function(c){var m=obj[c];if(!m||typeof m!=='object')return;Object.keys(m).forEach(function(id){rows.push({user_id:user.id,col:c,id:id,data:m[id],updated_at:new Date().toISOString()})})});
  var i=0,N=200;function next(){if(i>=rows.length)return Promise.resolve(rows.length);var part=rows.slice(i,i+N);i+=N;
    return sb.from('docs').upsert(part,{onConflict:'user_id,col,id'}).then(chk).then(function(){part.forEach(function(r){put(r.col,r.id,r.data)});return next()})}
  return next();
}
/* PDFs neu verknüpfen: Datei aus dem Studienordner wird dem Material mit gleichem Pfad oder Namen zugeordnet */
function relinkFiles(files,onStep){
  var mods=cache.modules||{},list=[];
  Object.keys(mods).forEach(function(mid){(mods[mid].materials||[]).forEach(function(x,ix){list.push({mid:mid,ix:ix,x:x})})});
  function norm(s){return String(s||'').replace(/\\/g,'/').toLowerCase()}
  var jobs=[];
  Array.prototype.forEach.call(files,function(f){
    var rp=norm(f.webkitRelativePath||f.name),nm=norm(f.name);
    var hit=list.filter(function(m){return m.x.path&&rp.slice(-norm(m.x.path).length-1)==='/'+norm(m.x.path)})[0]
      ||list.filter(function(m){return m.x.path&&rp===norm(m.x.path)})[0]
      ||list.filter(function(m){return norm(m.x.title)===nm||norm(String(m.x.path||'').split('/').pop())===nm})[0];
    if(hit&&!hit.done){hit.done=1;jobs.push({f:f,m:hit})}
  });
  var ok=0,skip=files.length-jobs.length,i=0,byMod={};
  function upOne(j){
    var f=j.f;
    if(f.size<=MAXFILE)return assets.upload(f,{type:f.type||'application/pdf'}).then(function(r){return{id:r.id}});
    /* große Datei in Teile zerlegen (Supabase nimmt bis 50 MB pro Datei) */
    var parts=[],P=45*1024*1024,a=0;function nx(){if(a>=f.size)return Promise.resolve();var b=f.slice(a,a+P,f.type);a+=P;return assets.upload(b,{type:f.type||'application/pdf'}).then(function(r){parts.push({id:r.id});return nx()})}
    return nx().then(function(){return{id:parts[0].id,parts:parts,mime:f.type||'application/pdf'}});
  }
  function next(){
    if(i>=jobs.length)return Promise.resolve();var j=jobs[i++];onStep&&onStep(i,jobs.length,j.f.name);
    return upOne(j).then(function(r){
      var mid=j.m.mid,m=byMod[mid]||(byMod[mid]={materials:copy(mods[mid].materials||[]),path:copy(mods[mid].path||[])}),x=m.materials[j.m.ix],old=x.assetId;
      x.assetId=r.id;if(r.parts){x.parts=r.parts;x.mime=r.mime;x.size=j.f.size}else{delete x.parts;delete x.mime}
      if(old)m.path.forEach(function(s){if(s.refs)s.refs=s.refs.map(function(q){return q===old?r.id:q})});
      ok++;
    }).catch(function(e){console.warn(j.f.name,e);skip++}).then(next);
  }
  return next().then(function(){return Promise.all(Object.keys(byMod).map(function(mid){return db.doc('modules/'+mid).update(byMod[mid])}))})
    .then(function(){return{ok:ok,skip:skip}});
}
function accountSheet(){
  style();var w=el('<div class="acct"><div class="box"><h2>Konto & Daten</h2><p>Angemeldet als <b>'+esc(user&&user.email)+'</b>.<br>Gespeichert: '+esc(dataCounts())+'</p>'
    +'<label>Alte Daten übernehmen (Datei von Claude)<input type="file" accept=".json,application/json" data-json></label>'
    +'<label>PDFs neu hochladen (Studienordner wählen)<input type="file" multiple webkitdirectory data-dir></label>'
    +'<label>… oder einzelne Dateien wählen (iPad/iPhone)<input type="file" multiple accept="application/pdf,image/*" data-files></label>'
    +'<div class="msg"></div><button type="button" class="ghost" data-out>Abmelden</button><button type="button" data-close>Fertig</button></div></div>');
  /* kurz keine Klicks annehmen, sonst trifft der Tipp, der das Fenster geöffnet hat, gleich einen Knopf darin */
  w.style.pointerEvents='none';setTimeout(function(){w.style.pointerEvents=''},450);
  document.body.appendChild(w);var msg=w.querySelector('.msg');
  function say(t,ok){msg.className='msg '+(ok?'good':'bad');msg.textContent=t}
  w.querySelector('[data-close]').onclick=function(){w.remove()};
  w.querySelector('[data-out]').onclick=function(){sb.auth.signOut()};
  w.querySelector('[data-json]').onchange=function(e){var f=e.target.files[0];if(!f)return;say('Übernehme Daten …',true);
    f.text().then(function(t){return importJson(JSON.parse(t))}).then(function(n){say(n+' Einträge übernommen.',true)}).catch(function(e){say('Das hat nicht geklappt: '+e.message)})};
  function files(e){var fs=e.target.files;if(!fs||!fs.length)return;say('Ordne Dateien zu …',true);
    relinkFiles(fs,function(i,n,name){say('Lade hoch '+i+' von '+n+': '+name,true)}).then(function(r){say(r.ok+' Dateien hochgeladen und zugeordnet'+(r.skip?', '+r.skip+' übersprungen (kein passendes Material).':'.'),true)}).catch(function(e){say('Das hat nicht geklappt: '+e.message)})}
  w.querySelector('[data-dir]').onchange=files;w.querySelector('[data-files]').onchange=files;
}

window.PLAN={account:accountSheet,ready:ready,_db:db};
window.claude={use:function(name){
  if(name==='db')return ready.then(function(){return db});
  if(name==='assets')return ready.then(function(){return assets});
  if(name==='downloads')return Promise.resolve(downloads);
  return Promise.resolve(null);
}};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
