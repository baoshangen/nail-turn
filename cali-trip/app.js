(function(){
'use strict';

/* ---------------- Config ---------------- */
const DAYS = [
  { id:1, area:'little-saigon', title:'Ngày 1 · Little Saigon', sub:'Ăn uống sập mặt 🍜', emoji:'🍜',
    c1:'#ff6b4a', c2:'#ffa63a', city:'Westminster, CA', center:[33.7455,-117.9940], start:'11:00' },
  { id:2, area:'la', title:'Ngày 2 · LA tham quan', sub:'Quẩy khắp Los Angeles 🌆', emoji:'🌆',
    c1:'#8b5cf6', c2:'#ec4899', city:'Los Angeles, CA', center:[34.0522,-118.2437], start:'09:30' },
  { id:3, area:'santa-monica', title:'Ngày 3 · Santa Monica', sub:'Biển, pier & hoàng hôn 🌊', emoji:'🌊',
    c1:'#06b6d4', c2:'#34d399', city:'Santa Monica, CA', center:[34.0100,-118.4960], start:'10:30' },
];
const AREA2DAY = {'little-saigon':1,'la':2,'santa-monica':3};
const SLOTS = [
  {id:'morning', label:'Sáng', emoji:'🌅'},
  {id:'noon', label:'Trưa', emoji:'☀️'},
  {id:'afternoon', label:'Chiều', emoji:'🌤️'},
  {id:'evening', label:'Tối', emoji:'🌙'},
  {id:'any', label:'Chưa xếp giờ', emoji:'🕐'},
];
const SUGGEST = {
  'little-saigon':['Phở Thành','Brodard (nem nướng)','Bánh Mì Chả Cá','Lee\'s Sandwiches','Quán Hỷ','Asian Garden Mall','Bánh xèo','Chè / ăn vặt'],
  'la':['Griffith Observatory','Hollywood Walk of Fame','The Broad','Grand Central Market','Getty Center','Hollywood Sign view','Downtown LA'],
  'santa-monica':['Santa Monica Pier','Third Street Promenade','Venice Beach','Muscle Beach','Santa Monica Beach','Tongva Park'],
};

/* ---------------- State ---------------- */
let claude=null, db=null, user=null;
let me = { id:null, name:'' };
let canWrite = null;              // null unknown / true / false
let sharedPlaces = [];
let localPlaces = [];
let dbReady = false;
let state = { tab:1, editingId:null };
let dayStart = {};

/* ---------------- Utils ---------------- */
const $ = s=>document.querySelector(s);
const el = (t,c,h)=>{const e=document.createElement(t); if(c)e.className=c; if(h!=null)e.innerHTML=h; return e;};
const esc = s => String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const uid = ()=> 'x'+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);
function toast(msg){ const t=$('#toast'); if(!t)return; t.textContent=msg; t.classList.remove('hidden'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.add('hidden'),2800); }
function lsGet(k,d){ try{const v=localStorage.getItem(k); return v==null?d:JSON.parse(v);}catch(e){return d;} }
function lsSet(k,v){ try{localStorage.setItem(k,JSON.stringify(v));}catch(e){} }
function cssEsc(id){ try{ return (window.CSS&&CSS.escape)?CSS.escape(id):String(id).replace(/"/g,'\\"'); }catch(e){ return id; } }

function detectPlatform(url){
  if(!url) return '';
  if(/tiktok\.com/i.test(url)) return 'tiktok';
  if(/instagram\.com/i.test(url)) return 'instagram';
  if(/^https?:\/\//i.test(url)) return 'web';
  return '';
}
function tiktokId(url){ const m=String(url||'').match(/\/video\/(\d+)/); return m?m[1]:''; }

function parseCoords(q){
  if(!q) return null;
  const m = q.match(/@(-?\d+\.\d{3,}),\s*(-?\d+\.\d{3,})/) ||
            q.match(/[?&](?:q|ll|daddr|destination)=(-?\d+\.\d{3,}),\s*(-?\d+\.\d{3,})/) ||
            q.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
            q.match(/^\s*(-?\d+\.\d{3,}),\s*(-?\d+\.\d{3,})\s*$/);
  if(m) return {lat:parseFloat(m[1]), lng:parseFloat(m[2])};
  return null;
}
async function geocode(q, city){
  const direct = parseCoords(q);
  if(direct) return direct;
  const query = (q||'').trim();
  if(!query) return null;
  try{
    const full = query + (/\bCA\b|California|USA|United States/i.test(query) ? '' : (', '+city));
    const url='https://nominatim.openstreetmap.org/search?format=json&limit=1&q='+encodeURIComponent(full);
    const r = await fetch(url,{headers:{'Accept':'application/json'}});
    if(!r.ok) return null;
    const j = await r.json();
    if(j && j[0]) return {lat:parseFloat(j[0].lat), lng:parseFloat(j[0].lon)};
  }catch(e){}
  return null;
}
function cityForArea(area){ const d=DAYS.find(x=>x.area===area); return d?d.city:'Los Angeles, CA'; }
function dayOf(p){ return AREA2DAY[p.area]||1; }
function voteCount(p){ return p.votes? Object.values(p.votes).filter(Boolean).length : 0; }
function iVoted(p){ return !!(p.votes && p.votes[me.id]); }
function allPlaces(){
  const out = sharedPlaces.map(p=>p);
  for(const p of localPlaces){ out.push(Object.assign({_local:true}, p)); }
  return out;
}
function sortPlaces(list){
  return list.slice().sort((a,b)=> (voteCount(b)-voteCount(a)) || ((a.createdAt||0)-(b.createdAt||0)) );
}

/* ---------------- Capabilities + init ---------------- */
async function getCap(name){ try{ if(claude && typeof claude.use==='function') return await claude.use(name); }catch(e){} return null; }

async function init(){
  me.name = lsGet('trip_name','') || '';
  me.id = lsGet('trip_vid','') || uid(); lsSet('trip_vid', me.id);
  localPlaces = lsGet('trip_local',[]) || [];
  dayStart = lsGet('trip_daystart',{}) || {};
  importFromHash();
  buildTabs(); bindUI(); render();

  claude = window.claude || null;
  db = await getCap('db');
  user = await getCap('user');
  if(user){
    try{ const rid = await user.id(); if(rid) me.id = rid; }catch(e){}
    try{ if(typeof user.can==='function'){ const c=user.can('data.write'); canWrite=(c===true||c===false)?c:null; } }catch(e){}
  }
  if(db){
    let settled=false;
    const timer=setTimeout(()=>{ if(!settled){ dbReady=true; render(); } },10000);
    try{
      db.collection('places').onSnapshot(snap=>{
        settled=true; clearTimeout(timer);
        sharedPlaces = snap.docs.map(d=>Object.assign({id:d.id,_shared:true}, d.data()));
        dbReady=true; render(); refreshMapIfVisible();
      }, err=>{ settled=true; clearTimeout(timer); dbReady=true; toast('Data chung lỗi — dùng bản offline'); render(); });
    }catch(e){ dbReady=true; }
  } else { dbReady=true; }

  if(!me.name) showNameBar(true);
  render();
}

/* ---------------- CRUD ---------------- */
function placePayload(f){
  const link=(f.link||'').trim();
  return {
    name:(f.name||'').trim(), area:f.area||'la', slot:f.slot||'any',
    link, platform:detectPlatform(link), notes:(f.notes||'').trim(),
    addr:(f.addr||'').trim(),
    lat:(f.lat==null?null:Number(f.lat)), lng:(f.lng==null?null:Number(f.lng)),
    dur:(f.dur?Number(f.dur):null),
    addedById:me.id, addedByName:me.name||'Ẩn danh'
  };
}
async function createPlace(f){
  const data = placePayload(f);
  data.createdAt=Date.now(); data.votes={};
  if(data.lat==null){ const g=await geocode(data.addr||data.name, cityForArea(data.area)); if(g){data.lat=g.lat;data.lng=g.lng;} }
  if(db && canWrite!==false){
    try{ await db.collection('places').add(data); toast('Đã thêm 🎉'); return; }
    catch(e){ handleWriteErr(e); }
  }
  const lp=Object.assign({id:uid()},data); localPlaces.push(lp); lsSet('trip_local',localPlaces);
  toast(db?'Lưu vào bản của bạn (chưa sync)':'Đã lưu (offline)'); render(); refreshMapIfVisible();
}
async function updatePlace(id,f){
  const data=placePayload(f);
  const local=localPlaces.find(p=>p.id===id);
  if(data.lat==null){ const g=await geocode(data.addr||data.name, cityForArea(data.area)); if(g){data.lat=g.lat;data.lng=g.lng;} }
  if(local){ Object.assign(local,data); lsSet('trip_local',localPlaces); toast('Đã sửa'); render(); refreshMapIfVisible(); return; }
  if(db){
    try{ await db.doc('places/'+id).update(data); toast('Đã sửa'); return; }
    catch(e){ handleWriteErr(e); }
  }
}
async function deletePlace(id){
  const li=localPlaces.findIndex(p=>p.id===id);
  if(li>=0){ localPlaces.splice(li,1); lsSet('trip_local',localPlaces); render(); refreshMapIfVisible(); return; }
  if(db){ try{ await db.doc('places/'+id).delete(); toast('Đã xoá'); }catch(e){ handleWriteErr(e); } }
}
async function toggleVote(p){
  if(db && !p._local){
    const cur = p.votes && p.votes[me.id];
    const payload={}; payload[me.id]= cur? null : (me.name||'Ẩn danh');
    try{ await db.doc('places/'+p.id).update({votes:payload}); }
    catch(e){ handleWriteErr(e); }
    return;
  }
  const target = localPlaces.find(x=>x.id===p.id);
  if(target){
    target.votes = target.votes||{};
    if(target.votes[me.id]) target.votes[me.id]=null; else target.votes[me.id]=me.name||'Ẩn danh';
    lsSet('trip_local',localPlaces); render();
  }
}
function handleWriteErr(e){
  const code=e&&e.code;
  if(code==='invalid_argument'){ canWrite=false; toast('Bạn đang ở chế độ Xem — nhờ Ray mời làm Editor để sửa chung'); }
  else if(code==='quota_exceeded'){ toast('Data đầy rồi, xoá bớt địa điểm nha'); }
  else if(code==='resource_exhausted'){ toast('Thao tác hơi nhanh, thử lại chút nữa'); }
  else { toast('Lưu lỗi, thử lại'); }
  render();
}

/* ---------------- Render ---------------- */
function render(){
  const v=$('#view'); if(!v) return;
  renderStats();
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===String(state.tab)));
  v.innerHTML='';
  if(state.tab==='map'){ v.appendChild(renderMapView()); }
  else if(state.tab==='plan'){ v.appendChild(renderPlanView()); }
  else { v.appendChild(renderDayView(Number(state.tab))); }
  const fab=$('#fab'); if(fab) fab.style.display=(state.tab==='map'||state.tab==='plan')?'none':'';
}
function renderStats(){
  const s=$('#stats'); if(!s) return;
  const all=allPlaces();
  const per=DAYS.map(d=>all.filter(p=>dayOf(p)===d.id).length);
  const mode = !dbReady? '…' : (db? (canWrite===false?'👀 xem':'🟢 sync') : '📱 máy này');
  s.innerHTML = '<span>'+all.length+' địa điểm</span><span class="dot">·</span>'+
    DAYS.map((d,i)=>'<span>'+d.emoji+per[i]+'</span>').join('')+
    '<span class="dot">·</span><span class="mode">'+mode+'</span>';
}
function renderDayView(dayId){
  const day=DAYS.find(d=>d.id===dayId)||DAYS[0];
  const wrap=el('div','dayview');
  wrap.style.setProperty('--c1',day.c1); wrap.style.setProperty('--c2',day.c2);
  wrap.appendChild(el('div','dayhead','<div class="dayemoji">'+day.emoji+'</div><div><h2>'+esc(day.title)+'</h2><p>'+esc(day.sub)+'</p></div>'));
  const places=allPlaces().filter(p=>dayOf(p)===dayId);
  if(!places.length){
    const e=el('div','empty','<div class="bigemoji">'+day.emoji+'</div><p>Chưa có địa điểm nào cho ngày này.<br>Dán link TikTok/IG hoặc tự thêm quán nha!</p><button class="btn primary big" data-act="add" data-day="'+dayId+'">+ Thêm địa điểm</button>');
    const st=el('div','suggtitle',null); st.textContent='Gợi ý nhanh — bấm để thêm'; e.appendChild(st);
    const sg=el('div','suggs');
    (SUGGEST[day.area]||[]).forEach(n=>{ const b=el('button','sugg',null); b.textContent='+ '+n; b.dataset.act='sugg'; b.dataset.name=n; b.dataset.day=dayId; sg.appendChild(b); });
    e.appendChild(sg); wrap.appendChild(e); return wrap;
  }
  for(const slot of SLOTS){
    const sp=sortPlaces(places.filter(p=>(p.slot||'any')===slot.id));
    if(!sp.length) continue;
    const sec=el('div','slot');
    sec.appendChild(el('div','slothead',slot.emoji+' '+slot.label+' <span class="count">'+sp.length+'</span>'));
    const list=el('div','cards'); sp.forEach(p=>list.appendChild(renderCard(p,day))); sec.appendChild(list);
    wrap.appendChild(sec);
  }
  return wrap;
}
function renderCard(p,day){
  const c=el('div','card'+(p._local?' local':''));
  const plat = p.platform==='tiktok'?'🎵 TikTok':p.platform==='instagram'?'📸 IG':p.platform==='web'?'🔗 Link':'';
  c.innerHTML =
    '<div class="cardtop"><div class="cardname">'+esc(p.name||'(chưa đặt tên)')+'</div>'+
      '<button class="vote '+(iVoted(p)?'on':'')+'" data-act="vote" data-id="'+esc(p.id)+'">👍 <b>'+voteCount(p)+'</b></button></div>'+
    '<div class="meta">'+
      (plat?'<span class="pill">'+plat+'</span>':'')+
      (p.lat!=null?'<span class="pill">📍 map</span>':'')+
      (p._local?'<span class="pill warn">chỉ mình bạn</span>':'')+
      '<span class="by">bởi '+esc(p.addedByName||'Ẩn danh')+'</span></div>'+
    (p.notes?'<div class="notes">'+esc(p.notes)+'</div>':'')+
    '<div class="cardbtns">'+
      (p.link?'<a class="btn sm" href="'+esc(p.link)+'" target="_blank" rel="noopener">▶ Mở</a>':'')+
      ((p.platform==='tiktok'||p.platform==='instagram')?'<button class="btn sm ghost" data-act="preview" data-id="'+esc(p.id)+'">👁 Preview</button>':'')+
      '<button class="btn sm ghost" data-act="edit" data-id="'+esc(p.id)+'">✏️ Sửa</button>'+
      '<button class="btn sm ghost danger" data-act="del" data-id="'+esc(p.id)+'">🗑</button>'+
    '</div>'+
    '<div class="embed hidden" data-embed="'+esc(p.id)+'"></div>';
  return c;
}

/* ---------------- Map (Google Maps directions) ---------------- */
function gmapsQuery(p){
  if(p.lat!=null&&p.lng!=null) return encodeURIComponent(p.lat+','+p.lng);
  return encodeURIComponent((p.name||'')+', '+cityForArea(p.area));
}
function gmapsSearchUrl(p){ return 'https://www.google.com/maps/search/?api=1&query='+gmapsQuery(p); }
function gmapsDirUrl(places){
  if(!places.length) return '';
  const stops=places.slice(0,10);
  const dest=stops[stops.length-1];
  const wp=stops.slice(0,-1).map(gmapsQuery).join('|');
  let u='https://www.google.com/maps/dir/?api=1&travelmode=driving&destination='+gmapsQuery(dest);
  if(wp) u+='&waypoints='+wp;
  return u;
}
function renderMapView(){
  const w=el('div','mapview');
  w.appendChild(el('div','planintro','🗺️ Bấm là mở Google Maps chỉ đường qua hết các điểm trong ngày (theo thứ tự gợi ý). Trên điện thoại sẽ nhảy thẳng vô app Maps luôn. Muốn chấm đúng vị trí thì khi thêm địa điểm nhớ dán link Google Maps vô ô địa chỉ.'));
  DAYS.forEach(day=>{
    const places=orderForPlan(allPlaces().filter(p=>dayOf(p)===day.id));
    const card=el('div','planday'); card.style.setProperty('--c1',day.c1); card.style.setProperty('--c2',day.c2);
    card.appendChild(el('div','plandayhead',day.emoji+' '+esc(day.title)));
    if(!places.length){ card.appendChild(el('div','planempty','Chưa có địa điểm nào.')); w.appendChild(card); return; }
    const a=el('a','btn primary big'); a.href=gmapsDirUrl(places); a.target='_blank'; a.rel='noopener';
    a.textContent='🧭 Chỉ đường cả ngày ('+Math.min(places.length,10)+' điểm)';
    card.appendChild(a);
    if(places.length>10) card.appendChild(el('div','hint','Google Maps giới hạn ~10 điểm/lộ trình — đang lấy 10 điểm đầu.'));
    const list=el('div','maplist');
    places.forEach((p,i)=>{
      const row=el('div','maprow','<span class="mapnum">'+(i+1)+'</span><span class="mapname">'+esc(p.name)+'</span>');
      const lk=el('a','btn sm ghost'); lk.href=gmapsSearchUrl(p); lk.target='_blank'; lk.rel='noopener'; lk.textContent='📍 Mở';
      row.appendChild(lk); list.appendChild(row);
    });
    card.appendChild(list); w.appendChild(card);
  });
  return w;
}
function refreshMapIfVisible(){ /* derived view — render() already reflects data changes */ }

/* ---------------- Plan ---------------- */
function fmtTime(mins){ mins=((Math.round(mins)%1440)+1440)%1440; const h=Math.floor(mins/60), m=mins%60; return (h<10?'0':'')+h+':'+(m<10?'0':'')+m; }
function toMins(hhmm){ const m=/^(\d{1,2}):(\d{2})$/.exec(hhmm||''); return m?((+m[1])*60+(+m[2])):660; }
function nearestOrder(arr){
  const geo=arr.filter(p=>p.lat!=null&&p.lng!=null), none=arr.filter(p=>p.lat==null||p.lng==null);
  if(geo.length<=2) return arr;
  const rem=geo.slice(), used=[]; let cur=rem.shift(); used.push(cur);
  while(rem.length){ let bi=0,bd=Infinity; rem.forEach((p,i)=>{const d=(p.lat-cur.lat)*(p.lat-cur.lat)+(p.lng-cur.lng)*(p.lng-cur.lng); if(d<bd){bd=d;bi=i;}}); cur=rem.splice(bi,1)[0]; used.push(cur); }
  return used.concat(none);
}
function orderForPlan(places){
  let seq=[];
  SLOTS.forEach(s=>{ seq=seq.concat(nearestOrder(sortPlaces(places.filter(p=>(p.slot||'any')===s.id)))); });
  return seq;
}
function renderPlanView(){
  const w=el('div','planview');
  w.appendChild(el('div','planintro','📋 Lịch gợi ý — xếp theo buổi (sáng → tối), quán nhiều vote lên trước, và đi gần nhau cho đỡ chạy lòng vòng. Chỉnh giờ bắt đầu để xem lại timeline.'));
  DAYS.forEach(day=>{
    const places=allPlaces().filter(p=>dayOf(p)===day.id);
    const card=el('div','planday'); card.style.setProperty('--c1',day.c1); card.style.setProperty('--c2',day.c2);
    card.appendChild(el('div','plandayhead',day.emoji+' '+esc(day.title)));
    const startVal=dayStart[day.id]||day.start;
    const ctrl=el('div','startctrl','<label>Bắt đầu</label>');
    const inp=el('input','timein'); inp.type='time'; inp.value=startVal;
    inp.addEventListener('change',()=>{ dayStart[day.id]=inp.value; lsSet('trip_daystart',dayStart); render(); });
    ctrl.appendChild(inp); card.appendChild(ctrl);
    if(!places.length){ card.appendChild(el('div','planempty','Chưa có địa điểm nào.')); w.appendChild(card); return; }
    const seq=orderForPlan(places); const TRAVEL=20; let t=toMins(startVal);
    const tl=el('div','timeline');
    seq.forEach(p=>{
      const dur=p.dur||75;
      tl.appendChild(el('div','trow','<div class="ttime">'+fmtTime(t)+'</div><div class="tbody"><b>'+esc(p.name)+'</b> <span class="tdur">~'+dur+'’</span>'+(voteCount(p)?' <span class="tv">👍'+voteCount(p)+'</span>':'')+(p.link?' <a href="'+esc(p.link)+'" target="_blank" rel="noopener">▶</a>':'')+'</div>'));
      t+=dur+TRAVEL;
    });
    card.appendChild(tl);
    card.appendChild(el('div','planend','Dự kiến xong khoảng '+fmtTime(t-TRAVEL)));
    w.appendChild(card);
  });
  return w;
}

/* ---------------- Preview embeds ---------------- */
const _scripts={};
function loadScript(src){
  return new Promise(res=>{
    const s=document.createElement('script'); s.src=src; s.async=true;
    s.onload=()=>{_scripts[src]=true;res(true);}; s.onerror=()=>res(false);
    document.body.appendChild(s);
  });
}
async function togglePreview(id){
  const box=document.querySelector('.embed[data-embed="'+cssEsc(id)+'"]'); if(!box) return;
  const p=allPlaces().find(x=>x.id===id); if(!p) return;
  if(!box.classList.contains('hidden')){ box.classList.add('hidden'); box.innerHTML=''; return; }
  box.classList.remove('hidden'); box.innerHTML='<div class="hint">Đang tải preview…</div>';
  if(p.platform==='tiktok'){
    const vid=tiktokId(p.link);
    box.innerHTML='<blockquote class="tiktok-embed" cite="'+esc(p.link)+'" data-video-id="'+esc(vid)+'" style="max-width:100%;min-width:220px"><section></section></blockquote>';
    await loadScript('https://www.tiktok.com/embed.js');
  } else if(p.platform==='instagram'){
    box.innerHTML='<blockquote class="instagram-media" data-instgrm-permalink="'+esc(p.link)+'" data-instgrm-version="14" style="max-width:100%"></blockquote>';
    const ok=await loadScript('https://www.instagram.com/embed.js');
    try{ if(window.instgrm&&window.instgrm.Embeds) window.instgrm.Embeds.process(); }catch(e){}
    if(!ok) box.innerHTML='<div class="hint">Không tải được preview — bấm “▶ Mở” để xem trực tiếp.</div>';
  }
}

/* ---------------- Name / share / IO ---------------- */
function showNameBar(show){
  const b=$('#nameBar'); if(!b)return;
  b.classList.toggle('hidden',!show);
  if(show) b.innerHTML='<span>👋 Tên bạn là gì? (để cả nhóm biết ai thêm gì)</span><input id="nameInput" value="'+esc(me.name)+'" placeholder="Tên của bạn"><button class="btn sm primary" data-act="savename">Lưu</button>';
}
function saveName(){ const i=$('#nameInput'); const v=i?i.value.trim():''; if(v){ me.name=v; lsSet('trip_name',v); showNameBar(false); render(); toast('Chào '+v+'! 🎉'); } }

function openIO(){
  const m=$('#ioModal'); m.classList.remove('hidden');
  const n=allPlaces().length;
  m.innerHTML='<div class="sheet">'+
    '<div class="sheethead"><h3>Chia sẻ & cài đặt</h3><button class="x" data-act="close">✕</button></div>'+
    '<label>Tên hiển thị của bạn</label>'+
    '<div class="inline"><input id="io_name" value="'+esc(me.name)+'" placeholder="Tên của bạn"><button class="btn sm primary" data-act="savename2">OK</button></div>'+
    '<div class="infobox"><b>Chia sẻ cho cả nhóm 👇</b>'+
      '<p>Web này mở được trên <b>mọi điện thoại</b> — cứ gửi link là xong.</p>'+
      '<p>Bấm <b>🔗 Copy link kèm plan</b> để gửi link đã có sẵn '+n+' địa điểm. Ai mở link cũng thấy hết, thêm tiếp rồi gửi link lại cho nhau để gộp.</p></div>'+
    '<button class="btn primary big" data-act="sharelink" style="margin-top:14px">🔗 Copy link kèm plan ('+n+' điểm)</button>'+
    '<div class="inline" style="margin-top:10px">'+
      '<button class="btn sm ghost" data-act="export">📤 Copy code</button>'+
      '<button class="btn sm ghost" data-act="import">📥 Nhập code</button></div>'+
    '<textarea id="io_box" class="hidden" placeholder="Dán code vô đây rồi bấm 📥 Nhập code lần nữa"></textarea>'+
    '<div class="hint" style="margin-top:8px">Địa điểm lưu trên máy bạn (không mất khi tắt web). Dùng link kèm plan để gộp picks cả nhóm.</div>'+
  '</div>';
}
function closeIO(){ const m=$('#ioModal'); if(m){ m.classList.add('hidden'); m.innerHTML=''; } }
function placesForShare(){ return allPlaces().map(p=>{ const o=Object.assign({},p); delete o._shared; delete o._local; delete o.addedById; return o; }); }
function buildShareLink(){
  try{ const b64=btoa(unescape(encodeURIComponent(JSON.stringify(placesForShare())))); return location.origin+location.pathname+'#plan='+b64; }
  catch(e){ return location.href.split('#')[0]; }
}
function doShareLink(){
  const url=buildShareLink();
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(url).then(()=>toast('Đã copy link kèm plan! Gửi cho cả nhóm 🎉')).catch(()=>showBox(url)); }
  else showBox(url);
}
function importFromHash(){
  try{
    const h=location.hash||''; const mm=h.match(/#plan=(.+)$/); if(!mm) return;
    const json=decodeURIComponent(escape(atob(mm[1]))); const arr=JSON.parse(json); if(!Array.isArray(arr)) return;
    const have={}; localPlaces.forEach(p=>{have[p.id]=1;});
    arr.forEach(it=>{ if(it&&(it.name||it.link)){ const id=it.id||uid(); if(have[id]) return; const o=Object.assign({},it); o.id=id; delete o._shared; delete o._local; localPlaces.push(o); have[id]=1; } });
    lsSet('trip_local',localPlaces);
  }catch(e){}
}
function doExport(){
  const data=JSON.stringify(placesForShare());
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(data).then(()=>toast('Đã copy code! Gửi cho nhóm nha')).catch(()=>showBox(data));
  } else showBox(data);
}
function showBox(v){ const b=$('#io_box'); if(b){ b.classList.remove('hidden'); b.value=v; b.focus(); } }
async function doImport(){
  const b=$('#io_box'); if(!b) return;
  if(b.classList.contains('hidden')||!b.value.trim()){ b.classList.remove('hidden'); b.focus(); toast('Dán code vô rồi bấm 📥 Nhập lần nữa'); return; }
  let arr; try{ arr=JSON.parse(b.value); }catch(e){ toast('Code không hợp lệ'); return; }
  if(!Array.isArray(arr)){ toast('Code không hợp lệ'); return; }
  let n=0;
  for(const it of arr){ if(it&&(it.name||it.link)){ await createPlace({name:it.name,link:it.link,area:it.area||'la',slot:it.slot||'any',addr:it.addr||'',notes:it.notes||'',dur:it.dur||'',lat:it.lat,lng:it.lng}); n++; } }
  toast('Đã nhập '+n+' địa điểm'); closeIO();
}

/* ---------------- Add / edit modal ---------------- */
function openModal(place, presetDay){
  const isEdit=!!(place&&place.id);
  state.editingId=isEdit?place.id:null;
  const m=$('#modal'); m.classList.remove('hidden');
  const def=DAYS.find(d=>d.id===presetDay)||DAYS[0];
  const p = place || {area:def.area, slot:'any'};
  m.innerHTML='<div class="sheet">'+
    '<div class="sheethead"><h3>'+(isEdit?'Sửa địa điểm':'Thêm địa điểm')+'</h3><button class="x" data-act="close">✕</button></div>'+
    '<label>Tên quán / địa điểm</label>'+
    '<input id="f_name" value="'+esc(p.name||'')+'" placeholder="VD: Phở Thành, Griffith Observatory…">'+
    '<label>Link TikTok / IG (tuỳ chọn)</label>'+
    '<input id="f_link" value="'+esc(p.link||'')+'" placeholder="Dán link clip vô đây">'+
    '<div id="platHint" class="plathint"></div>'+
    '<label>Ngày / khu</label>'+
    '<div class="choices" id="f_area">'+DAYS.map(d=>'<button type="button" class="chip '+(p.area===d.area?'on':'')+'" data-area="'+d.area+'">'+d.emoji+' Ngày '+d.id+'</button>').join('')+'</div>'+
    '<label>Buổi</label>'+
    '<div class="choices" id="f_slot">'+SLOTS.map(s=>'<button type="button" class="chip '+(((p.slot||'any')===s.id)?'on':'')+'" data-slot="'+s.id+'">'+s.emoji+' '+s.label+'</button>').join('')+'</div>'+
    '<label>Địa chỉ hoặc link Google Maps (để lên bản đồ)</label>'+
    '<input id="f_addr" value="'+esc(p.addr||'')+'" placeholder="Dán link Google Maps hoặc địa chỉ">'+
    '<label>Ghi chú (tuỳ chọn)</label>'+
    '<textarea id="f_notes" placeholder="Món nên thử, giá, lưu ý…">'+esc(p.notes||'')+'</textarea>'+
    '<label>Thời gian chơi ước tính (phút, tuỳ chọn)</label>'+
    '<input id="f_dur" type="number" min="15" step="15" value="'+(p.dur||'')+'" placeholder="75">'+
    '<div class="sheetbtns"><button class="btn primary big" data-act="save">'+(isEdit?'Lưu thay đổi':'Thêm vô plan 🎉')+'</button></div>'+
  '</div>';
  m._area=p.area||def.area; m._slot=p.slot||'any';
  const hint=()=>{ const v=$('#f_link').value; const pl=detectPlatform(v); const h=$('#platHint'); if(h) h.textContent= pl==='tiktok'?'🎵 TikTok — sẽ có nút Preview để xem clip':pl==='instagram'?'📸 Instagram — có nút Preview':pl==='web'?'🔗 Link web':''; };
  $('#f_link').addEventListener('input',hint); hint();
  m.querySelectorAll('#f_area .chip').forEach(b=>b.addEventListener('click',()=>{ m._area=b.dataset.area; m.querySelectorAll('#f_area .chip').forEach(x=>x.classList.toggle('on',x===b)); }));
  m.querySelectorAll('#f_slot .chip').forEach(b=>b.addEventListener('click',()=>{ m._slot=b.dataset.slot; m.querySelectorAll('#f_slot .chip').forEach(x=>x.classList.toggle('on',x===b)); }));
}
function closeModal(){ const m=$('#modal'); if(m){ m.classList.add('hidden'); m.innerHTML=''; } state.editingId=null; }
async function saveModal(){
  const m=$('#modal');
  const f={ name:$('#f_name').value, link:$('#f_link').value, area:m._area, slot:m._slot, addr:$('#f_addr').value, notes:$('#f_notes').value, dur:$('#f_dur').value };
  if(!f.name.trim() && !f.link.trim()){ toast('Nhập tên hoặc link đã nha'); return; }
  if(!f.name.trim()) f.name=f.link.trim();
  const quick=parseCoords(f.addr); if(quick){ f.lat=quick.lat; f.lng=quick.lng; }
  const id=state.editingId; closeModal();
  if(id) await updatePlace(id,f); else await createPlace(f);
}

/* ---------------- Events ---------------- */
function bindUI(){
  document.addEventListener('click',e=>{
    const t=e.target.closest('[data-act]'); if(!t) return;
    const act=t.dataset.act, id=t.dataset.id;
    if(act==='tab'){ state.tab=isNaN(+t.dataset.tab)?t.dataset.tab:+t.dataset.tab; render(); }
    else if(act==='add'){ openModal(null, +t.dataset.day||(typeof state.tab==='number'?state.tab:1)); }
    else if(act==='sugg'){ openModal({name:t.dataset.name, area:(DAYS.find(d=>String(d.id)===String(t.dataset.day))||DAYS[0]).area, slot:'any'}, +t.dataset.day); }
    else if(act==='edit'){ const p=allPlaces().find(x=>x.id===id); if(p) openModal(p); }
    else if(act==='del'){ if(confirm('Xoá địa điểm này?')) deletePlace(id); }
    else if(act==='vote'){ const p=allPlaces().find(x=>x.id===id); if(p) toggleVote(p); }
    else if(act==='preview'){ togglePreview(id); }
    else if(act==='save'){ saveModal(); }
    else if(act==='close'){ closeModal(); closeIO(); }
    else if(act==='savename'){ saveName(); }
    else if(act==='savename2'){ const i=$('#io_name'); const v=i?i.value.trim():''; if(v){ me.name=v; lsSet('trip_name',v); render(); toast('Đã lưu tên'); } }
    else if(act==='io'){ openIO(); }
    else if(act==='sharelink'){ doShareLink(); }
    else if(act==='export'){ doExport(); }
    else if(act==='import'){ doImport(); }
  });
  document.addEventListener('click',e=>{ if(e.target.id==='modal') closeModal(); if(e.target.id==='ioModal') closeIO(); });
  const fab=$('#fab'); if(fab) fab.addEventListener('click',()=>openModal(null, (typeof state.tab==='number')?state.tab:1));
}
function buildTabs(){
  const nav=$('#tabs'); if(!nav) return;
  nav.innerHTML=DAYS.map(d=>'<button class="tab" data-act="tab" data-tab="'+d.id+'">'+d.emoji+' Ngày '+d.id+'</button>').join('')+
    '<button class="tab" data-act="tab" data-tab="map">🗺️ Map</button>'+
    '<button class="tab" data-act="tab" data-tab="plan">📋 Lịch</button>';
}

if(document.readyState!=='loading') init();
else document.addEventListener('DOMContentLoaded', init);
})();
