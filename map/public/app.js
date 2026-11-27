'use strict';
(() => {
const $=id=>document.getElementById(id), make=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const walletMap=document.documentElement.classList.contains('wallet-map');
const nativeWallet=window.chrome?.webview;
const walletRequests=new Map();
nativeWallet?.addEventListener('message',event=>{
 if(typeof event.data!=='string'||!event.data.startsWith('map-wallet-reply:'))return;
 const id=event.data.slice(17,53),response=walletRequests.get(id);
 if(response)response(JSON.parse(event.data.slice(54)));
});
function callMapWallet(method,args={}){
 if(!nativeWallet)return Promise.reject(Error(tr('Откройте карту в обновлённом кошельке, чтобы зашифровать записку.')));
 const id=crypto.randomUUID();
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{walletRequests.delete(id);reject(Error(tr('Кошелёк временно недоступен')))},15000);
  walletRequests.set(id,value=>{
   walletRequests.delete(id);clearTimeout(timer);
   if(value.error)reject(Error(value.error));else resolve(value.value);
  });
  nativeWallet.postMessage('map-wallet-request:'+JSON.stringify({id,method,args}));
 });
}
const atlasText=walletMap?window.NoticoinAtlasText:{};
const tr=text=>{
 if(typeof text!=='string')return text;
 const current=text.replace(/\b\x4b\x4f\x4b\x4f\b/g,'Noticoin');
 return Object.hasOwn(atlasText||{},current)?atlasText[current]:current;
};
const formatCount=new Intl.NumberFormat(document.documentElement.lang);
let atlasLight=document.documentElement.classList.contains('atlas-light');
let mapLight=atlasLight;
let tileWarmup;
let streetsFailed=false;
let warmupTimer;
const streetMinimumZoom=7;
const buildingZoom=14;
const motionPreference=window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced=motionPreference.matches;
let atlas3D=false;
let atlasOverview=true;
let atlasDocked=false;

const atlasStyleUrl=(detail,light)=>'/map-'+(detail?'detail':'fast')+'.json'+(light?'?theme=light':'');

async function applyAtlasTheme(light){
 atlasLight=light;
 document.documentElement.classList.toggle('atlas-light',light);
 if(!ready||mapLight===light)return;
 try{
  const response=await fetch(atlasStyleUrl(false,light));
  if(!response.ok)return;
  const {layers}=await response.json();
  if(atlasLight!==light||mapLight===light)return;
  for(const layer of layers){
   if(!map.getLayer(layer.id))continue;
   for(const [key,value] of Object.entries(layer.paint))map.setPaintProperty(layer.id,key,value);
  }
  mapLight=light;
 }catch(error){console.warn('Atlas palette:',error.message)}
}

function streetTilePath(lng,lat,z,dx=0,dy=0){
 const size=2**z;
 const radians=Math.max(-85,Math.min(85,lat))*Math.PI/180;
 const column=Math.floor((lng+180)/360*size)+dx;
 const row=Math.floor((1-Math.asinh(Math.tan(radians))/Math.PI)/2*size)+dy;
 const x=((column%size)+size)%size;
 const y=Math.max(0,Math.min(size-1,row));
 return '/street/'+z+'/'+x+'/'+y+'.pbf';
}

function planetZoom(){
 const {clientWidth,clientHeight}=$('map');
 const diameter=Math.min(clientWidth,clientHeight)*.73;
 return Math.max(.15,Math.min(1.72,1.05+Math.log2(diameter/330)));
}

function warmStreetTiles(lng,lat,zoom){
 if(!walletMap||zoom<streetMinimumZoom||document.hidden)return;
 tileWarmup?.abort();
 const controller=tileWarmup=new AbortController();
 const levels=[...new Set([Math.min(14,Math.floor(zoom)),Math.min(14,Math.floor(zoom)+1)])];
 const next=levels.map(z=>streetTilePath(lng,lat,z));
 Promise.allSettled(next.map(url=>fetch(url,{signal:controller.signal,priority:'low'}).then(r=>r.arrayBuffer())));
}

function connectAtlas(){
 const download=$('atlas-download');
 const depth=$('map-quality');
 let saving=false;
 $('atlas-sources').prepend(NoticoinMapIcons.element('info'));
 $('atlas-sources').onclick=()=>$('atlas-license').showModal();
 $('atlas-points').onclick=()=>atlasExplorer($('atlas-explorer').hidden,true);
 $('atlas-explorer-close').onclick=()=>{
  if(atlasDocked)setAtlasLayout(false);
  else atlasExplorer(false,true);
 };
 $('atlas-layout').onclick=()=>setAtlasLayout(!atlasDocked);
 $('atlas-city-toggle').onclick=()=>showFavoriteCities($('atlas-cities').hidden);
 try{setAtlasLayout(localStorage.getItem('\x6b\x6f\x6b\x6f.atlas.layout')==='docked');}catch{}
 depth.onclick=()=>{
  if(!ready)return;
  if(!atlas3D&&map.getZoom()<10){toast(tr('Приблизьте карту до города, чтобы включить 3D'));return;}
  atlas3D=!atlas3D;
  depth.setAttribute('aria-pressed',String(atlas3D));
  for(const layer of ['atlas-buildings-3d','atlas-buildings-textured']){
   map.setLayoutProperty(layer,'visibility',atlas3D?'visible':'none');
  }
  if(atlas3D){
   map.dragRotate.enable();
   map.touchZoomRotate.enableRotation();
   map.touchPitch.enable();
  }else{
   map.dragRotate.disable();
   map.touchZoomRotate.disableRotation();
   map.touchPitch.disable();
  }
  const point=selected&&map.getBounds().contains([selected.lng,selected.lat])?selected:null;
  map.easeTo({
   ...(point?{center:[point.lng,point.lat],offset:pointOffset(point.lng,point.lat)}:{}),
   zoom:atlas3D?Math.max(buildingZoom+.6,map.getZoom()):map.getZoom(),
   pitch:atlas3D?51:0,duration:reduced?0:310
  });
 };
 map.dragRotate.disable();
 map.touchZoomRotate.disableRotation();
 map.touchPitch.disable();
 map.on('zoomend',()=>{
  if(atlas3D&&map.getZoom()<buildingZoom-.5&&map.getPitch()>0)map.easeTo({pitch:0,duration:reduced?0:180});
  else if(atlas3D&&map.getZoom()>=buildingZoom&&map.getPitch()===0)map.easeTo({pitch:51,duration:reduced?0:210});
 });
 map.on('movestart',event=>{if(event.originalEvent)atlasOverview=false});
 map.on('resize',()=>{
  if(!atlasOverview||map.isMoving())return;
  const zoom=planetZoom();
  if(Math.abs(zoom-map.getZoom())>.025)map.jumpTo({zoom});
 });
 const update=()=>{
  download.disabled=saving||map.getZoom()<9;
  download.title=map.getZoom()<9?tr('Приблизьте карту к району'):tr('Сохранить окрестности центра для просмотра без сети');
 };
 map.on('moveend',update);
 download.onclick=async()=>{
  if(saving||map.getZoom()<9)return;
  saving=true;update();
  const {lng,lat}=map.getCenter();
  const focus=Math.min(14,Math.max(11,Math.floor(map.getZoom())));
  const pending=new Set();
  for(let z=Math.max(9,focus-2);z<=14;z++){
   const radius=z<focus-1?0:1;
   for(let dx=-radius;dx<=radius;dx++)for(let dy=-radius;dy<=radius;dy++){
    pending.add(streetTilePath(lng,lat,z,dx,dy));
   }
  }
  const jobs=[...pending], saved=[];
  let complete=0;
  download.textContent=tr('Сохраняем район…');
  try{
   await Promise.all(Array.from({length:3},async()=>{
    while(jobs.length){
     const path=jobs.shift();
     try{
      const reply=await fetch(path+'?save=1',{cache:'no-store',signal:AbortSignal.timeout(80000)});
      if(!reply.ok)throw Error(String(reply.status));
      await reply.arrayBuffer();
      saved.push(path);
     }catch{}
     download.textContent=tr('Тайлы ')+(++complete)+' / '+pending.size;
    }
   }));
   if(!saved.length){toast(tr('Тайлы района недоступны. Попробуйте позже.'));return;}
   download.textContent=tr('Собираем пакет…');
   const reply=await fetch('/atlas/region',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({tiles:saved}),signal:AbortSignal.timeout(30000)});
   if(!reply.ok)throw Error(reply.status===507?tr('В хранилище карты закончилось место'):tr('Не удалось собрать пакет района'));
   toast(saved.length===complete?tr('Район сохранён для просмотра без сети'):tr('Сохранено ')+saved.length+tr(' из ')+complete+tr(' тайлов. Остальные можно скачать позже.'));
  }catch(error){
   toast(error.message||tr('Не удалось сохранить район'));
  }finally{
   saving=false;
   download.textContent=tr('Скачать район');
   update();
  }
 };
 update();
}

function setAtlasLayout(docked){
 atlasDocked=docked;
 document.documentElement.classList.toggle('atlas-docked',docked);
 $('atlas-layout').setAttribute('aria-pressed',String(docked));
 $('atlas-points').hidden=docked;
 atlasExplorer(false);
 try{localStorage.setItem('\x6b\x6f\x6b\x6f.atlas.layout',docked?'docked':'wide');}catch{}
 requestAnimationFrame(()=>map.resize());
}

function atlasExplorer(open,focus=false){
 if(!walletMap)return;
 if(open&&selected)dismissPoint();
 const wasVisible=!$('atlas-explorer').hidden;
 const visible=open||atlasDocked;
 $('atlas-explorer').hidden=!visible;
 $('atlas-points').setAttribute('aria-expanded',String(visible));
 if(visible){
  void loadCountryOptions();
  if(open||!wasVisible){void loadNoteSearchScope();render();}
 }
 if(!focus)return;
 (open?$('atlas-explorer-close'):atlasDocked?$('atlas-layout'):$('atlas-points')).focus();
}

function dismissPoint(){
 $('detail').hidden=true;
 selected=null;
 if(walletMap&&map?.getLayer('atlas-selected')){
  map.setFilter('atlas-selected',['==',['get','id'],'']);
 }
}

function updateStreetStatus(){
 if(!walletMap||!map||!ready)return;
 const retry=$('retry-streets');
 const nearby=map.getZoom()>=streetMinimumZoom;
 retry.hidden=!nearby||!streetsFailed;
 if(nearby&&!streetsFailed&&!map.isSourceLoaded('openmaptiles')){
  status(tr('Загружаются детали карты…'));
 }
}
const cat={
 message:{label:tr('Сообщение'),glyph:'message-square-text',color:'#7a28d9',highlight:'#d378ff'},
 place:{label:tr('Место'),glyph:'map-pin',color:'#087451',highlight:'#35e1a1'},
 event:{label:tr('Событие'),glyph:'calendar-days',color:'#a34712',highlight:'#ffbe50'},
 art:{label:tr('Искусство'),glyph:'palette',color:'#2055b9',highlight:'#77c4ff'},
 wifi:{label:'Wi-Fi',glyph:'wifi',color:'#106b8e',highlight:'#40cded'},
 food:{label:tr('Еда и напитки'),glyph:'utensils',color:'#a45135',highlight:'#f1a260'},
 shop:{label:tr('Магазины'),glyph:'store',color:'#8b4284',highlight:'#f2a4d7'},
 work:{label:tr('Офисы и предприятия'),glyph:'briefcase-business',color:'#335a94',highlight:'#82acff'},
 transport:{label:tr('Транспорт'),glyph:'train-front',color:'#1f7083',highlight:'#57e4d9'},
 secret:{label:tr('Секретная записка'),glyph:'lock-keyhole',color:'#79500e',highlight:'#e3a749'}
};
const {publicationBase,icons:pinIcons}=NotiPinCatalog;
const pulsingIcons=Object.entries(pinIcons).filter(([,icon])=>icon.pulse);
const pointHitLayers=['points','pulsing-pin-icons','point-labels','clusters'];
const pointIcon=point=>pinIcons[point.icon]?.glyph?pinIcons[point.icon]:cat[point.category];
const privateIcon={glyph:'lock-keyhole',color:'#5c3797',highlight:'#c7a2ff'};
function iconBadge(item,className){
 const badge=make('span',className);
 badge.style.setProperty('--glyph-dark',item.highlight);
 badge.style.setProperty('--glyph-light',item.color);
 if(item.pulse)badge.classList.add('pulsing-pin-icon');
 badge.append(NoticoinMapIcons.element(item.glyph));
 return badge;
}
const coinScale=10n**9n;
function formatCoins(value){
 const amount=BigInt(value);
 const fraction=String(amount%coinScale).padStart(9,'0').replace(/0+$/,'');
 return String(amount/coinScale)+(fraction?'.'+fraction:'');
}
function parseCoins(value){
 const [whole,fraction='']=value.trim().replace(',','.').split('.');
 if(!/^\d{1,7}(?:[.,]\d{1,9})?$/.test(value.trim()))return null;
 const atomic=BigInt(whole)*coinScale+BigInt(fraction.padEnd(9,'0'));
 return atomic>0n&&atomic<=1000000n*coinScale?String(atomic):null;
}
const expiryDate=new Intl.DateTimeFormat(document.documentElement.lang,{dateStyle:'medium',timeStyle:'short'});
const cities=[['Токио','Tokyo',139.6917,35.6895],['Киото','Kyoto',135.7681,35.0116],['Осака','Osaka',135.5023,34.6937],['Москва','Moscow',37.6173,55.7558],['Санкт-Петербург','Saint Petersburg',30.3351,59.9343],['Шанхай','Shanghai',121.4737,31.2304],['Пекин','Beijing',116.4074,39.9042],['Гонконг','Hong Kong',114.1694,22.3193],['Сеул','Seoul',126.978,37.5665],['Тайбэй','Taipei',121.5654,25.033],['Сингапур','Singapore',103.8198,1.3521],['Бангкок','Bangkok',100.5018,13.7563],['Нью-Йорк','New York',-74.006,40.7128],['Лос-Анджелес','Los Angeles',-118.2437,34.0522],['Париж','Paris',2.3522,48.8566],['Лондон','London',-0.1276,51.5072],['Берлин','Berlin',13.405,52.52],['Рим','Rome',12.4964,41.9028],['Барселона','Barcelona',2.1734,41.3851],['Стамбул','Istanbul',28.9784,41.0082],['Дубай','Dubai',55.2708,25.2048],['Тбилиси','Tbilisi',44.8271,41.7151],['Алматы','Almaty',76.886,43.2389],['Дели','Delhi',77.209,28.6139],['Сидней','Sydney',151.2093,-33.8688],['Окленд','Auckland',174.7633,-36.8485],['Рейкьявик','Reykjavik',-21.9426,64.1466],['Кейптаун','Cape Town',18.4241,-33.9249],['Сан-Паулу','Sao Paulo',-46.6333,-23.5505],['Мехико','Mexico City',-99.1332,19.4326],['Буэнос-Айрес','Buenos Aires',-58.3816,-34.6037]];
let map,ready=false,points=[],visible=[],filter='all',view='all',selected=null,placing=false,location=[139.701,35.659],config={paymentsEnabled:false},identity=null,invoice=null,loadAbort=null,loadTimer=null,toastTimer,pointUpdates,resolution,loadedBox='',detailMode=false;
let attachedPlace=null;
let publishing=false;
let mapConfigStatus='loading', mapConfigRequest;
const readList=key=>{try{const value=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(value)?value:[]}catch{return[]}};
const favoriteCities=new Map(walletMap?readList('\x6b\x6f\x6b\x6f.atlas.cities')
 .filter(p=>p?.city===true&&typeof p.title==='string'&&typeof p.subtitle==='string'&&
   Number.isFinite(p.lng)&&Math.abs(p.lng)<=180&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=85&&
   Number.isFinite(p.zoom)&&p.zoom>=0&&p.zoom<=19)
 .map(p=>{
  const known=cities.find(c=>c[2]===p.lng&&c[3]===p.lat);
  return [cityKey(p),known?{...p,title:known[1],subtitle:coords(p.lng,p.lat)}:p];
 }):[]);
const saved=new Set(readList('\x6b\x6f\x6b\x6f.saved'));
let mapOwner='';
const ownsPoint=point=>mapOwner!==''&&point.owner===mapOwner;
const donationAddressFormat=/^[1-9A-HJ-NP-Za-km-z]{95,106}$/;
const storage=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value))}catch{toast(tr('Браузер не сохранил данные. Проверьте доступное место.'))}};
const labels={free:tr('Бесплатная точка'),seen:tr('Платёж замечен'),included:tr('Платёж в блоке'),confirmed:tr('Оплата подтверждена'),checking:tr('Проверка оплаты недоступна'),awaiting:tr('Ожидает оплаты'),expired:tr('Срок счёта истёк')};
function toast(text,tone=''){
 const notice=$('toast');
 notice.textContent=text;
 notice.dataset.tone=tone;
 if(tone==='success')notice.prepend(NoticoinMapIcons.element('check'));
 notice.hidden=false;
 clearTimeout(toastTimer);
 toastTimer=setTimeout(()=>notice.hidden=true,4500);
}
function atlasNotice(title,message,action){
 const dialog=make('dialog','modal notice-modal');
 const heading=make('h2','',title);
 heading.id='atlas-notice-title';
 dialog.setAttribute('aria-labelledby',heading.id);
 const actions=make('form','notice-actions');
 actions.method='dialog';
 const dismiss=make('button',action?'secondary':'primary',tr(action?'Отмена':'Готово'));
 dismiss.value='dismiss';
 dismiss.autofocus=true;
 actions.append(dismiss);
 if(action){
  const approve=make('button','primary',action);
  approve.value='approve';
  actions.append(approve);
 }
 dialog.append(heading,make('p','muted',message),actions);
 document.body.append(dialog);
 return new Promise(resolve=>{
  dialog.addEventListener('close',()=>{
   const approved=dialog.returnValue==='approve';
   dialog.remove();
   resolve(approved);
  },{once:true});
  dialog.showModal();
 });
}
function coords(lng,lat){return Math.abs(lat).toFixed(4)+'° '+(lat>=0?'N':'S')+' · '+Math.abs(lng).toFixed(4)+'° '+(lng>=0?'E':'W')}
const longitude=lng=>Math.abs(lng)<=180?lng:((lng+180)%360+360)%360-180;
let pendingCoordinateCopy=null;
const copyTimers=new WeakMap();
function copiedCoordinates(button){
 toast(tr('Координаты скопированы'));
 if(!button)return;
 clearTimeout(copyTimers.get(button));
 button.dataset.copied='true';
 button.lastElementChild.replaceWith(NoticoinMapIcons.element('check'));
 copyTimers.set(button,setTimeout(()=>{
  button.lastElementChild.replaceWith(NoticoinMapIcons.element('copy'));
  delete button.dataset.copied;
 },1500));
}
async function copyCoordinates(target,button){
 if(!target)return;
 const [lng,lat]=target;
 const text=lat.toFixed(6)+', '+longitude(lng).toFixed(6);
 if(walletMap&&window.chrome?.webview){
  pendingCoordinateCopy={button,text};
  window.chrome.webview.postMessage('copy-coordinates:'+text);
  return;
 }
 try{
  await navigator.clipboard.writeText(text);
  copiedCoordinates(button);
 }catch{
  if(walletMap)await atlasNotice(tr('Скопировать координаты'),text);
  else toast(text);
 }
}
function configureCoordinateButton(button,position){
 button.append(NoticoinMapIcons.element('copy'));
 button.onclick=()=>void copyCoordinates(position(),button);
}
function status(text){$('map-status').textContent=text;$('map-status').hidden=!text}
async function api(path,options={}){
 const response=await fetch(path,{...options,headers:{'content-type':'application/json',...options.headers},cache:'no-store'});
 const data=await response.json();
 if(!response.ok){
  const message=tr(data.error||'Не удалось выполнить запрос');
  throw Error(walletMap&&/\p{Script=Cyrillic}/u.test(message)?tr('Не удалось выполнить запрос'):message);
 }
 return data;
}
const b64=data=>btoa(String.fromCharCode(...new Uint8Array(data)));
const hex=data=>Array.from(new Uint8Array(data),value=>value.toString(16).padStart(2,'0')).join('');
function keyPair(){
 if(!identity)identity=(async()=>{
  const stored=localStorage.getItem('\x6b\x6f\x6b\x6f.identity');
  if(window.NoticoinMapSigning){
   const key=stored?JSON.parse(stored):await window.NoticoinMapSigning.createKey();
   if(!key.publicKey||!key.privateKey?.d)throw Error(tr('Could not create the embedded map.'));
   if(!stored)localStorage.setItem('\x6b\x6f\x6b\x6f.identity',JSON.stringify(key));
   return key;
  }
  if(stored){
   const parsed=JSON.parse(stored);
   return {publicKey:parsed.publicKey,privateKey:await crypto.subtle.importKey('jwk',parsed.privateKey,{name:'Ed25519'},false,['sign'])};
  }
  const key=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
  const data={publicKey:b64(await crypto.subtle.exportKey('raw',key.publicKey)),privateKey:await crypto.subtle.exportKey('jwk',key.privateKey)};
  localStorage.setItem('\x6b\x6f\x6b\x6f.identity',JSON.stringify(data));
  return {publicKey:data.publicKey,privateKey:key.privateKey};
 })().then(async key=>{
  mapOwner=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key.publicKey)));
  return key;
 }).catch(error=>{identity=null;throw error});
 return identity;
}
async function mapSignature(key,payload){
 if(!window.NoticoinMapSigning)return new Uint8Array(await crypto.subtle.sign('Ed25519',key.privateKey,payload));
 const signature=await window.NoticoinMapSigning.sign(key.privateKey.d,b64(payload));
 if(!signature)throw Error(tr('Не удалось выполнить запрос'));
 return Uint8Array.from(atob(signature),value=>value.charCodeAt(0));
}
async function activeNotePolicy(){
 const readConfig=()=>api('/api/config',{signal:AbortSignal.timeout(8000)});
 const {offlineNotePolicy,offlineNotePolicies,noteRegistry}=await readConfig();
 if(noteRegistry){
  let advertised=offlineNotePolicy;
  for(let attempt=0;attempt<2;attempt++){
   const local=await callMapWallet('note-registry-policy');
   if(!(local?.threshold>=2)&&!(advertised?.threshold>=2))
    throw Error(tr('Encrypted note sales are unavailable.'));
   if(local?.threshold>=2&&sameNotePolicy(local,advertised))return local;
   // The node can advance to a new registry epoch between the two requests.
   if(attempt===0)advertised=(await readConfig()).offlineNotePolicy;
  }
  throw Error(tr('The map and wallet disagree on the current note operator set.'));
 }
 if(!offlineNotePolicy||!offlineNotePolicies?.length)throw Error(tr('Encrypted note sales are unavailable.'));
 if(offlineNotePolicies.length>1){
  const height=await callMapWallet('note-publication-height');
  const expected=offlineNotePolicies.findLast(policy=>policy.height<=height);
  if(expected?.height!==offlineNotePolicy.height)throw Error(tr('The map and wallet disagree on the current note operator set.'));
 }
 return offlineNotePolicy;
}
const sameNotePolicy=(a,b)=>!!(a&&b&&!!a.registry===!!b.registry&&a.threshold===b.threshold&&
 (a.registry||a.height===b.height)&&a.keys.length===b.keys?.length&&
 (a.registry?a.keys.every(key=>b.keys.includes(key)):a.keys.every((key,index)=>key===b.keys[index])));
async function signed(action,payload={}){const key=await keyPair(),envelope={action,nonce:Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),issuedAt:Date.now(),payload};return {...envelope,publicKey:key.publicKey,signature:b64(await mapSignature(key,new TextEncoder().encode(JSON.stringify(envelope))))}}
async function write(path,action,payload={},signal){return api(path,{method:'POST',body:JSON.stringify(await signed(action,payload)),signal})}
async function mapRecord(item){
 const key=await keyPair();
 const id=item.pointId.replaceAll('-','');
 if(!/^[a-f0-9]{32}$/.test(id))throw Error(tr('Не удалось выполнить запрос'));
 const header=Uint8Array.from(('4e544d50010'+(item.anchorAction==='withdraw'?'2':'1')+id).match(/../g),pair=>parseInt(pair,16));
 const record=new Uint8Array(118);
 record.set(header);
 record.set(Uint8Array.from(atob(key.publicKey),value=>value.charCodeAt(0)),22);
 record.set(await mapSignature(key,record.slice(0,54)),54);
 return hex(record);
}
function currentBounds(){if(!ready)return[-180,-85,180,85];if(map.getZoom()<2.5)return[-180,-85,180,85];const b=map.getBounds();let west=b.getWest(),east=b.getEast();if(east-west>=360)return[-180,Math.max(-85,b.getSouth()),180,Math.min(85,b.getNorth())];west=((west+180)%360+360)%360-180;east=((east+180)%360+360)%360-180;return[west,Math.max(-85,b.getSouth()),east,Math.min(85,b.getNorth())]}
function inside(p,b){return p.lat>=b[1]&&p.lat<=b[3]&&(b[0]<=b[2]?p.lng>=b[0]&&p.lng<=b[2]:p.lng>=b[0]||p.lng<=b[2])}
function pointCity(p){if(p.venueName||p.city)return p.venueName||p.city;let nearest=null,distance=Infinity;for(const c of cities){const d=(c[2]-p.lng)**2+(c[3]-p.lat)**2;if(d<distance){nearest=c;distance=d}}return distance<.12?nearest[walletMap?1:0]:coords(p.lng,p.lat)}
function pointPrice(p){const amount=p.secretPriceAtomic||p.displayPriceAtomic;return !p.isPrivate&&amount?formatCoins(amount)+' Noticoin':'';}
const openedNoteTexts=new Map();
let noteQuery=[],noteSearchTimer,countryAreas,countryLoading=false,activeCountry=null;
let noteScan=null,noteResultPage=0;
const notePageSize=30;
function matchesNote(point,terms=noteQuery){
 return NoticoinMapRuntime.noteMatches(terms,point.title,openedNoteTexts.get(point.id)??point.body??'');
}
function matchesNoteFilters(point){
 return matchesNote(point)&&(!activeCountry||activeCountry.contains(point.lng,point.lat));
}
function applyNoteFilters(){
 noteResultPage=0;
 if(selected&&!matchesNoteFilters(selected))dismissPoint();
 void loadNoteSearchScope();
 render();
}
async function loadNoteSearchScope(){
 if(!noteQuery.length){
  if(noteScan?.loading){noteScan.controller.abort();noteScan=null;}
  return;
 }
 if(noteScan?.country===activeCountry&&(noteScan.loading||noteScan.refreshAfter>Date.now()))return;
 noteScan?.controller.abort();
 const scan={country:activeCountry,controller:new AbortController(),points:[],loading:true,partial:false,refreshAfter:0};
 noteScan=scan;
 const params=new URLSearchParams({scan:'1',bbox:NoticoinMapRuntime.noteSearchBounds(scan.country).join(',')});
 try{
  for(;;){
   const data=await api('/api/points?'+params,{signal:scan.controller.signal,priority:'low'});
   if(noteScan!==scan)return;
   for(const point of data.points){
    if(!scan.country||scan.country.contains(point.lng,point.lat))scan.points.push(point);
   }
   if(!data.truncated){scan.refreshAfter=Date.now()+30000;break;}
   if(!data.nextCursor||data.nextCursor===params.get('cursor')){scan.partial=true;break;}
   params.set('cursor',data.nextCursor);
  }
 }catch{
  if(noteScan===scan)scan.partial=true;
 }finally{
  if(noteScan===scan){scan.loading=false;render();}
 }
}
async function loadCountryOptions(){
 if(countryAreas||countryLoading)return;
 countryLoading=true;
 const input=$('note-country'),hint=$('note-country-status');
 try{
  const response=await fetch('/atlas/country-boundaries.json');
  if(!response.ok)throw Error('Country boundaries unavailable');
  const {countries}=await response.json();
  const language=document.documentElement.lang;
  const names=new Intl.DisplayNames([language],{type:'region'});
  const options=Object.entries(countries).map(([code,country])=>{
   const title=country.names?.[language]??(code.length===2?names.of(code):country.names?.en??code);
   const option=new Option('',code);
   option.append(countryFlag(code),make('span','note-option-label',title));
   return option;
  });
  const collator=new Intl.Collator(language);
  options.sort((a,b)=>collator.compare(a.text,b.text));
  input.append(...options);
  countryAreas=countries;
  input.disabled=false;
  hint.hidden=true;
 }catch{
  hint.textContent=tr('Фильтр стран временно недоступен.');
  hint.hidden=false;
 }finally{countryLoading=false}
}
function countryFlag(code){
 if(code.length!==2||code==='XD')return NoticoinMapIcons.element('globe');
 const namespace='http://www.w3.org/2000/svg';
 const svg=document.createElementNS(namespace,'svg');
 const flag=document.createElementNS(namespace,'use');
 svg.setAttribute('viewBox','0 0 4 3');
 svg.setAttribute('class','country-flag');
 svg.setAttribute('aria-hidden','true');
 flag.setAttribute('href','/atlas/country-flags.svg#flag-'+code.toLowerCase());
 flag.setAttribute('width','4');
 flag.setAttribute('height','3');
 svg.append(flag);
 return svg;
}
function render(){
 if(!ready)return;
 const b=currentBounds(),now=Date.now();
 const searching=noteQuery.length>0;
 const available=[...points,...(privatePins?.items()||[])];
 const inView=p=>(p.expiresAt==null||p.expiresAt>now)&&(filter==='all'||p.category===filter)&&
  (view!=='saved'||saved.has(p.id))&&(view!=='mine'||ownsPoint(p)||p.isPrivate);
 const eligible=available.filter(p=>inView(p)&&matchesNoteFilters(p));
 visible=eligible.filter(p=>inside(p,b));
 const scan=searching&&noteScan?.country===activeCountry?noteScan:null;
 const currentIds=searching?new Set(available.map(p=>p.id)):null;
 const highlight=searching&&selected&&!currentIds.has(selected.id)&&inView(selected)&&matchesNoteFilters(selected);
 pointUpdates.update(highlight?[...eligible,selected]:eligible);
 syncPinPulse();
 if(searching&&$('atlas-explorer').hidden)return;
 let listed=visible;
 if(searching){
  const remote=scan?.points.filter(p=>!currentIds.has(p.id)&&inView(p)&&matchesNote(p))??[];
  listed=[...eligible,...remote].sort((a,b)=>(b.createdAt??0)-(a.createdAt??0));
 }
 if(walletMap){
  const count=$('atlas-count');
  count.textContent=String(listed.length);
  count.hidden=!listed.length;
  const report=$('note-search-status');
  report.textContent=scan?.loading?tr('Загружаем метки для поиска…'):scan?.partial?tr('Сервер карты вернул не все метки.'):'';
  report.hidden=!report.textContent;
  $('list-title').textContent=searching?tr('Результаты поиска'):view==='mine'?tr('Мои точки'):view==='saved'?tr('Сохранённые'):tr('В пределах карты');
 }
 $('point-count').textContent=walletMap?formatCount.format(listed.length):
  visible.length+' '+(visible.length===1?'точка':visible.length>1&&visible.length<5?'точки':'точек');
 $('point-list').replaceChildren();
 const totalPages=Math.ceil(listed.length/notePageSize);
 noteResultPage=searching?Math.min(noteResultPage,Math.max(0,totalPages-1)):0;
 const start=noteResultPage*notePageSize;
 for(const p of listed.slice(start,start+notePageSize)){
  const button=make('button','point-row'+(selected?.id===p.id?' active':''));
  const symbol=iconBadge(p.isPrivate?privateIcon:pointIcon(p),'point-symbol');
  const summary=make('span','point-summary');
  summary.append(make('strong','',p.title));
  if(p.body)summary.append(make('p','',p.body));
  const meta=make('span','point-meta');
  meta.append(make('span','',pointCity(p)));
  if(p.isPrivate)meta.append(make('b','',tr('Закрытая метка')));
  summary.append(meta);button.append(symbol,summary);
  button.addEventListener('click',()=>openPoint(p,true));
  $('point-list').append(button);
 }
 if(!listed.length&&!scan?.loading&&!scan?.partial)$('point-list').append(make('p','empty',searching||activeCountry?tr('Нет заметок, подходящих под фильтры.'):view==='mine'?tr('Здесь будут твои точки. Начни с кнопки «Оставить точку».'):view==='saved'?tr('Сохраняй понравившиеся места, чтобы вернуться к ним.'):tr('Здесь пока тихо. Оставь первую историю.')));
 if(searching&&totalPages>1){
  const pages=make('div','note-result-pages');
  const previous=make('button','secondary',tr('Назад')),next=make('button','secondary',tr('Далее'));
  previous.disabled=noteResultPage===0;
  next.disabled=noteResultPage===totalPages-1;
  previous.onclick=()=>{noteResultPage--;render();$('point-list').scrollTop=0;};
  next.onclick=()=>{noteResultPage++;render();$('point-list').scrollTop=0;};
  pages.append(previous,make('span','small-note',(noteResultPage+1)+' / '+totalPages),next);
  $('point-list').append(pages);
 }else if(!searching&&visible.length>notePageSize)$('point-list').append(make('p','empty',tr('Показаны первые 30. Приблизь карту, чтобы увидеть остальные.')));
}
async function load(force=true,background=false){
 if(!ready)return;
 const box=currentBounds().map(n=>n.toFixed(3)).join(',');
 if(!force&&box===loadedBox){render();return}
 loadAbort?.abort();
 const controller=loadAbort=new AbortController();
 try{
  const data=await api('/api/points?bbox='+box,{signal:controller.signal});
  if(controller.signal.aborted)return;
  const unchanged=background&&box===loadedBox&&JSON.stringify(points)===JSON.stringify(data.points);
  loadedBox=box;
  if(unchanged)return;
  points=data.points;
  if(selected&&!selected.isPrivate&&inside(selected,currentBounds())){
   const latest=points.find(point=>point.id===selected.id);
   if(!latest&&!data.truncated){
    if(noteScan)noteScan.points=noteScan.points.filter(p=>p.id!==selected.id);
    dismissPoint();
   }
   if(latest&&(latest.status!==selected.status||latest.reserved!==selected.reserved||latest.votes!==selected.votes))select(latest);
  }
  render();
  status(data.truncated?tr('Приблизь карту, чтобы увидеть больше точек'):walletMap?(streetsFailed?tr('Улицы временно недоступны'):''):points.length?'Точки загружены':'Здесь может начаться твоя история');
 }catch(e){
  if(e.name==='AbortError')return;
  if(selected?.expiresAt&&selected.expiresAt<=Date.now())dismissPoint();
  render();
  status(tr('Точки временно недоступны.'));
 }
}
function scheduleLoad(){clearTimeout(loadTimer);loadTimer=setTimeout(()=>load(false),300)}
function pointOffset(lng,lat){
 const {clientWidth:width,clientHeight:height}=map.getContainer();
 if(selected?.lng!==lng||selected?.lat!==lat||width>=810)return [0,0];
 if(width<560)return [0,-Math.min(125,height*.22)];
 return [Math.min(115,410-width/2),0];
}
function fly(lng,lat,zoom=12){
 warmStreetTiles(lng,lat,zoom);
 if(walletMap){
  atlasOverview=false;
  const target={center:[lng,lat],zoom,pitch:atlas3D&&zoom>=buildingZoom?51:0,bearing:0,offset:pointOffset(lng,lat)};
  if(reduced)map.easeTo({...target,duration:0});
  else map.flyTo({...target,duration:map.getZoom()<5&&zoom>=10?620:360});
  return;
 }
 const padding=walletMap?{left:0,right:0,top:38,bottom:0}
  :innerWidth>850?{left:330,right:0,top:0,bottom:0}:{left:0,right:0,top:110,bottom:220};
 map.flyTo({center:[lng,lat],zoom,pitch:detailMode&&zoom>10?25:0,bearing:0,duration:reduced?0:900,essential:false,padding});
}
const countedVisits=new Set(),pendingVisits=new Set();
function openPoint(point,move=false){
 select(point,move);
 if(point.isPrivate||ownsPoint(point)||countedVisits.has(point.id)||pendingVisits.has(point.id))return;
 pendingVisits.add(point.id);
 void (async()=>{
  try{
   await keyPair();
   if(ownsPoint(point))return;
   const {votes}=await write('/api/points/'+point.id+'/vote','vote');
   countedVisits.add(point.id);
   point.votes=votes;
   if(selected?.id===point.id){
    selected.votes=votes;
    $('pin-visits').textContent=votes+tr(' «я был здесь»');
   }
  }catch{}finally{pendingVisits.delete(point.id);}
 })();
}
function select(p,move=false){selected=p;$('detail').hidden=false;
 if(walletMap){
  atlasExplorer(false);
  if(ready)map.setFilter('atlas-selected',['==',['get','id'],p.id]);
 }else if(innerWidth<=850)$('detail').style.bottom='65px';
 if(move)fly(p.lng,p.lat,walletMap?Math.max(13,Math.min(map.getZoom(),16)):Math.max(6,Math.min(map.getZoom(),12)));
 const box=$('detail-content');
 box.replaceChildren();
 const category=make('span','detail-category');
 category.append(NoticoinMapIcons.element(pointIcon(p).glyph),cat[p.category].label);
 const heading=make('header','pin-note-heading');
 heading.append(category,make('h2','',p.title));
 box.append(heading);
 if(p.body)box.append(make('p','detail-body pin-note-body',p.body));
 if(p.publicNote){
  const text=openedNoteTexts.get(p.id);
  if(text)box.append(make('p','detail-body pin-note-body',text));
  else{
   const open=make('button','primary',tr('Открыть записку'));
   open.onclick=async()=>{
    open.disabled=true;
    try{
     const {packet}=await api('/api/points/'+p.id+'/public-note');
     const note=await NotiPublicNotes.open(p.id,packet);
     if(!open.isConnected||selected?.id!==p.id)return;
     openedNoteTexts.set(p.id,note);
     open.replaceWith(make('p','detail-body pin-note-body',note));
    }catch{toast(tr('Записка недоступна.'));}
    finally{open.disabled=false;}
   };
   box.append(open);
  }
 }else if(p.protectedNote&&ownsPoint(p)&&privatePins){
  const open=make('button','secondary',tr('Открыть записку'));
  open.onclick=async()=>{
   try{
    const {cipher}=await write('/api/points/'+p.id+'/note','read-my-note');
    const note=await privatePins.decryptNote(p.id,cipher);
    if(!note||selected!==p)return;
    openedNoteTexts.set(p.id,note.body);
    const paragraph=make('p','detail-body pin-note-body',note.body);
    paragraph.dataset.decryptedNote='true';
    open.replaceWith(paragraph);
    if(!p.secretPriceAtomic){
     const share=make('button','secondary',tr('Поделиться закрытой меткой'));
     share.dataset.decryptedNote='true';
     share.onclick=()=>{
      const createdAt=Date.now();
      privatePins.share({...p,body:note.body,createdAt,expiresAt:createdAt+7*86400000});
     };
     paragraph.after(share);
    }
    if(note.donationNote){
     const detail=make('p','detail-body',note.donationNote);
     detail.dataset.decryptedNote='true';
     paragraph.after(detail);
    }
   }catch(error){toast(error.message)}
  };
  box.append(open);
 }
 const pointCoordinates=make('div','detail-coords');
 const copy=make('button','coordinate-button',coords(p.lng,p.lat));
 copy.type='button';
 copy.title=tr('Скопировать координаты');
 copy.setAttribute('aria-label',copy.title);
 configureCoordinateButton(copy,()=>[p.lng,p.lat]);
 pointCoordinates.append(make('span','',pointCity(p)),copy);
 box.append(pointCoordinates);
 if(p.expiresAt)box.append(make('p','small-note',tr('На карте до %1').replace('%1',expiryDate.format(p.expiresAt))));
 if(p.isPrivate){
  box.append(make('span','badge',tr('Закрытая метка')));
  const actions=make('div','detail-actions');
  const share=make('button','primary',tr('Поделиться закрытой меткой'));
  share.onclick=()=>privatePins.share(p);
  const remove=make('button','secondary',tr('Удалить из кошелька'));
  remove.onclick=async()=>{
   if(!await atlasNotice(tr('Удалить точку'),tr('Удалить закрытую метку с этого устройства?'),tr('Удалить')))return;
   try{await privatePins.remove(p.id);dismissPoint();render()}catch{toast(tr('Не удалось сохранить закрытую метку.'))}
  };
  const focus=make('button','secondary',tr('⌖ К месту'));
  focus.disabled=!ready;
  focus.onclick=()=>fly(p.lng,p.lat,15);
  actions.append(share,focus,remove);
  box.append(actions);
  render();
  return;
 }
 if(!p.secretPriceAtomic){
  if(p.displayPriceAtomic)box.append(make('span','badge',tr('Цена автора')+' · '+pointPrice(p)));
  const badge=make('span','badge'+(p.status==='confirmed'?' confirmed':''),labels[p.status]||p.status);
  if(!p.displayPriceAtomic||p.status!=='free')box.append(badge);
 }else{
  box.append(make('p','small-note',tr('Осталось копий: %1 из %2').replace('%1',p.remainingCopies??1).replace('%2',p.secretCopies??1)));
  const pending=[...localPurchases.values(),...pendingInvoices.values()].find(item=>item.pointId===p.id);
  const ownSale=ownsPoint(p);
  if(ownSale||pending||p.reserved)box.append(make('span','badge',tr('Цена автора')+' · '+pointPrice(p)));
  if(!ownSale){
   const buy=make('button','primary full donation-action',pending?tr(readableNote(pending)?'Открыть записку':'Открыть счёт'):p.reserved?
    tr('Проверить доступность записки'):tr('Купить за %1 Noticoin').replace('%1',formatCoins(p.secretPriceAtomic)));
   buy.disabled=!pending&&(!privatePins||!p.protectedNote||!(config.secretPaymentsEnabled??config.paymentsEnabled)||!['free','confirmed'].includes(p.status));
   buy.onclick=()=>pending?openInvoice(pending):buySecret(p,buy);
   box.append(buy);
  }
 }
 const visits=make('span','badge',p.votes+tr(' «я был здесь»'));
 visits.id='pin-visits';
 box.append(visits);
 const actions=make('div','detail-actions'),save=make('button','secondary',saved.has(p.id)?tr('♥ Сохранено'):tr('♡ Сохранить'));save.onclick=()=>{if(saved.has(p.id))saved.delete(p.id);else saved.add(p.id);storage('\x6b\x6f\x6b\x6f.saved',[...saved]);select(p);render()};const focus=make('button','secondary',tr('⌖ К месту'));focus.onclick=()=>fly(p.lng,p.lat,walletMap?15:14);actions.append(save,focus);box.append(actions);
 if(donationAddressFormat.test(p.donationAddress||'')){
  if(ownsPoint(p)){
   box.append(make('p','small-note',tr('На этой метке включены донаты.')));
  }else if(walletMap){
   const support=make('section','donation-panel');
   support.append(make('h3','',tr('Поддержать автора в Noticoin')));
   if(p.donationNote)support.append(make('p','detail-body',p.donationNote));
   const presets=make('div','donation-presets');
   const amounts=[...new Set([p.donationAmountAtomic,'100000000','500000000','1000000000'].filter(Boolean))];
   for(const amount of amounts){
    const choice=make('a',amount===p.donationAmountAtomic?'primary':'secondary',formatCoins(amount)+' Noticoin');
    choice.href='noticoin:'+p.donationAddress+'?donate=1&tx_amount='+formatCoins(amount);
    if(amount===p.donationAmountAtomic)choice.title=tr('Сумма, предложенная автором');
    presets.append(choice);
   }
   const custom=make('a','secondary',tr('Другая сумма'));
   custom.href='noticoin:'+p.donationAddress+'?donate=1';
   presets.append(custom);
   support.append(presets);
   box.append(support);
  }else{
   const copy=make('button','secondary full donation-action',tr('Скопировать адрес для доната'));
   copy.onclick=async()=>{
    try{await navigator.clipboard.writeText(p.donationAddress);toast(tr('Адрес скопирован'))}
    catch{toast(p.donationAddress)}
   };
   box.append(copy);
  }
 }
 if(ownsPoint(p)){
  const del=make('button','text-btn full',tr('Удалить мою точку'));
  del.style.marginTop='18px';
  del.onclick=async()=>{
   const question=tr('Удалить эту точку с карты?');
   const approved=walletMap?await atlasNotice(tr('Удалить точку'),question,tr('Удалить')):confirm(question);
   if(!approved)return;
   try{
    const existing=[...pendingInvoices.values()].find(item=>item.pointId===p.id&&item.anchorAction==='withdraw');
    if(existing){openInvoice(existing);return}
    const outcome=await write('/api/points/'+p.id+'/delete','delete',{pointId:p.id});
    if(outcome.invoice){
     openInvoice({...outcome.invoice,title:p.title,record:await mapRecord(outcome.invoice)});
     return;
    }
    dismissPoint();await load();toast(tr('Точка удалена'));
   }catch(error){toast(error.message)}
  };
  box.append(del);
 }
 render();
}
function composerCoordinates(){
 if(attachedPlace)return location;
 const {parseCoordinate}=NoticoinMapRuntime;
 return [parseCoordinate($('pin-longitude').value,180),parseCoordinate($('pin-latitude').value,85)];
}
function setCoordinateInputs([lng,lat]){
 $('pin-latitude').value=lat.toFixed(8).replace(/\.?0+$/,'');
 $('pin-longitude').value=lng.toFixed(8).replace(/\.?0+$/,'');
}
function syncCoordinateInputs(){
 for(const id of ['pin-latitude','pin-longitude'])$(id).removeAttribute('aria-invalid');
 $('copy-compose-coordinates').disabled=composerCoordinates().includes(null);
}
function newPin(point=map?.getCenter()){
 if(placing){returnToComposer();return}
 resetComposer();
 dismissPoint();
 atlasExplorer(false);
 if(point)location=[longitude(point.lng),Math.max(-85,Math.min(85,point.lat))];
 setCoordinateInputs(location);
 openComposer();
}
function beginPlacement(){
 if(!ready){
  $('compose-error').textContent=tr('Подожди, пока загрузится карта');
  return;
 }
 const position=composerCoordinates();
 if(!position.includes(null))location=position;
 placing=true;
 $('compose').close();
 $('placement').hidden=false;
 map.stop();
 if(!map.getBounds().contains(location)){
  atlasOverview=false;
  map.jumpTo({center:location});
 }
 map.getCanvas().style.cursor='pointer';
 $('placement-next').hidden=true;
}
function endPlacement(){
 placing=false;
 $('placement').hidden=true;
 if(map)map.getCanvas().style.cursor='';
}
function returnToComposer(){
 endPlacement();
 openComposer('pin-latitude');
}
function acceptPlacement(){
 setCoordinateInputs(location);
 returnToComposer();
}
function connectMapContextMenu(){
 const menu=$('map-context'),marker=$('map-context-target'),canvas=map.getCanvas();
 const choose=$('map-context-select'),copy=$('map-context-copy'),center=$('map-context-center');
 const options=[choose,copy,center];
 let target;
 copy.prepend(NoticoinMapIcons.element('copy'));
 center.prepend(NoticoinMapIcons.element('crosshair'));
 const close=(restore=false)=>{
  if(menu.hidden)return;
  menu.hidden=true;
  marker.hidden=true;
  target=null;
  if(restore)canvas.focus({preventScroll:true});
 };
 function show(point,x,y){
  if(!ready||document.querySelector('dialog[open]')||!Number.isFinite(point?.lng)||!Number.isFinite(point?.lat))return;
  target=[longitude(point.lng),Math.max(-85,Math.min(85,point.lat))];
  marker.style.left=x+'px';
  marker.style.top=y+'px';
  marker.hidden=false;
  $('map-context-coordinates').textContent=coords(...target);
  choose.replaceChildren(NoticoinMapIcons.element('map-pin'),document.createTextNode(tr(placing?'Выбрать это место':'Оставить точку здесь')));
  menu.hidden=false;
  const gap=20,width=menu.offsetWidth,height=menu.offsetHeight;
  const left=x+gap+width<=innerWidth-8?x+gap:x-width-gap;
  const top=y+gap+height<=innerHeight-8?y+gap:y-height-gap;
  menu.style.left=Math.max(8,Math.min(left,innerWidth-width-8))+'px';
  menu.style.top=Math.max(8,Math.min(top,innerHeight-height-8))+'px';
  choose.focus({preventScroll:true});
 }
 choose.onclick=()=>{
  if(!target)return;
  const [lng,lat]=target;
  close();
  if(placing){location=[lng,lat];acceptPlacement();}
  else newPin({lng,lat});
 };
 copy.onclick=()=>{
  if(!target)return;
  const position=target;
  close(true);
  void copyCoordinates(position);
 };
 center.onclick=()=>{
  if(!target)return;
  const position=target;
  close(true);
  map.easeTo({center:position,duration:reduced?0:220});
 };
 map.on('contextmenu',event=>{
  event.originalEvent?.preventDefault();
  const bounds=canvas.getBoundingClientRect();
  show(event.lngLat,event.originalEvent?.clientX??bounds.left+event.point.x,event.originalEvent?.clientY??bounds.top+event.point.y);
 });
 canvas.addEventListener('keydown',event=>{
  if(event.key!=='ContextMenu'&&!(event.shiftKey&&event.key==='F10'))return;
  event.preventDefault();
  const bounds=canvas.getBoundingClientRect();
  show(map.getCenter(),bounds.left+bounds.width/2,bounds.top+bounds.height/2);
 });
 menu.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();close(true);return;}
  if(event.key==='Tab'){close(true);return;}
  const index=options.indexOf(document.activeElement);
  const targetIndex={Home:0,End:options.length-1,ArrowDown:(index+1)%options.length,ArrowUp:(index-1+options.length)%options.length};
  if(!Object.hasOwn(targetIndex,event.key))return;
  event.preventDefault();
  options[targetIndex[event.key]].focus();
 });
 document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))close();},true);
 map.on('movestart',()=>close());
 window.addEventListener('resize',()=>close());
 window.addEventListener('blur',()=>close());
}
function composerAccess(){
 const closed=walletMap&&$('private-pin').checked;
 const saleCategory=$('pin-category').value==='secret';
 const secret=!closed&&(saleCategory||$('sell-note').checked);
 const donating=!closed&&!secret&&$('accept-donations').checked;
 return {closed,saleCategory,secret,donating};
}
let donationBusy=false;
function showDonationAddress(){
 const preview=$('donation-address-preview');
 preview.textContent=$('donation-address').value;
 preview.hidden=!preview.textContent;
}
async function loadDonationAddresses(create=false){
 if(!nativeWallet||donationBusy)return;
 donationBusy=true;
 syncComposer();
 const choices=$('donation-address'),status=$('donation-address-status');
 status.textContent=tr(create?'Создаём субадрес…':'Загружаем адреса кошелька…');
 status.hidden=false;
 try{
  const {addresses,selected}=await callMapWallet('donation-addresses',{create});
  const previous=selected||choices.value;
  for(const option of Array.from(choices.options))option.remove();
  choices.append(new Option(tr('Выберите адрес кошелька'),''));
  for(const {index,address} of addresses){
   if(!donationAddressFormat.test(address))continue;
   const name=index===0?tr('Основной адрес'):tr('Субадрес %1').replace('%1',index);
   choices.append(new Option(name+' · '+address.slice(0,9)+'…'+address.slice(-7),address));
  }
  choices.value=previous;
  if(choices.selectedIndex<0)choices.selectedIndex=0;
  showDonationAddress();
  status.textContent='';
 }catch(error){status.textContent=error.message}
 finally{
  donationBusy=false;
  status.hidden=!status.textContent;
  syncComposer();
 }
}
function syncComposer(){
 const form=$('compose-form');
 const {closed,saleCategory,secret,donating}=composerAccess();
 const category=form.elements.category;
 const secretChoice=category.querySelector('option[value="secret"]');
 secretChoice.disabled=closed;
 if(closed&&category.value==='secret'){category.value='message';setIconOptions()}
 $('sale-setup').hidden=closed||saleCategory;
 $('secret-options').hidden=!secret;
 $('secret-price').disabled=$('secret-copies').disabled=!secret;
 $('donation-setup').hidden=closed||saleCategory;
 $('donation-options').hidden=!donating;
 $('donation-address').disabled=$('new-donation-address').disabled=!donating||!nativeWallet||donationBusy;
 $('private-pin-hint').hidden=!closed;
 $('encrypted-note-hint').hidden=closed||(!secret&&!donating);
 $('public-note-hint').hidden=closed||secret||donating;
 $('compose-icon-field').hidden=closed;
 $('publication-plans').hidden=closed;
 $('publication-price').hidden=closed;
 $('manual-coordinates').hidden=!!attachedPlace;
 $('change-location').hidden=!!attachedPlace;
 $('attached-location').hidden=!attachedPlace;
 const week=publicationBase('free',secret,config), month=publicationBase('paid',secret,config);
 $('seven-day-price').textContent=week?formatCoins(week)+' Noticoin':tr('Бесплатно');
 $('extended-price').textContent=formatCoins(month)+' Noticoin';
 const base=form.elements.mode.value==='paid'?month:week;
 const icon=form.elements.icon.value||'default';
 const iconPrice=BigInt(config.iconPrices?.[icon]||pinIcons[icon].price);
 const total=base+iconPrice;
 $('publication-total').textContent=formatCoins(total)+' Noticoin';
 if(config.chainAnchors) $('publication-total').textContent=total?formatCoins(total)+' Noticoin + '+tr('сетевая комиссия'):tr('Сетевая комиссия');
 const publicUnavailable=!closed&&!secret&&!donating&&!config.publicNotes;
 const paymentUnavailable=!closed&&(config.readOnly||!walletMap||!config.encryptedNotes||(secret&&!(config.secretPaymentsEnabled??config.paymentsEnabled))||
  (total>0n&&!config.paymentsEnabled)||(config.chainAnchors&&!walletMap));
 const availability=$('payment-availability');
 availability.textContent=paymentUnavailable||publicUnavailable?tr(
  walletMap&&mapConfigStatus==='unavailable'?'Сервис карты недоступен. Повторяем подключение…':
  walletMap&&mapConfigStatus==='loading'?'Подключаемся к сервису карты…':
  config.readOnly?'Публикация меток временно недоступна.':
  !walletMap||!config.encryptedNotes?'Откройте карту в обновлённом кошельке, чтобы зашифровать записку.':
  publicUnavailable?'Сервис карты нужно обновить для публичных записок.':
  'Для этой точки нужно подключить оплату Noticoin.'
 ):'';
 $('publish').disabled=publishing||paymentUnavailable||publicUnavailable||(donating&&donationBusy);
 $('publish').textContent=tr(closed?'Сохранить закрытую метку':'Оставить точку');
}
function resetComposer(){
 $('compose-form').reset();
 $('donation-address-status').hidden=true;
 showDonationAddress();
 $('character-count').textContent='0 / 500';
 attachedPlace=null;
 setIconOptions();
}
function openComposer(focus='title'){
 if(walletMap)void refreshMapConfig();
 $('compose-error').textContent='';
 syncComposer();
 syncCoordinateInputs();
 $('compose').showModal();
 $(focus).focus();
}
function composeAt(place){
 endPlacement();
 resetComposer();
 attachedPlace=place;
 location=[...place.location];
 $('attached-location').textContent='⌖ '+place.name;
 openComposer();
}
let publicationRetry=null;
async function publish(event){
 event.preventDefault();
 if(publishing||$('publish').disabled)return;
 const form=event.currentTarget;
 const values=new FormData(form);
 const title=values.get('title').trim(),body=values.get('body').trim();
 const mode=values.get('mode'),category=values.get('category'),icon=values.get('icon');
 const {closed,secret,donating}=composerAccess();
 const donationAddress=donating?$('donation-address').value:'';
 const donationAmount=donating?values.get('donationAmount').trim():'';
 const donationAmountAtomic=donationAmount?parseCoins(donationAmount):null;
 const secretPriceAtomic=secret?parseCoins(values.get('secretPrice')):null;
 const secretCopies=secret?Number(values.get('secretCopies')):1;
 const [lng,lat]=composerCoordinates();
 const error=lat===null?['pin-latitude','Введите широту от −85 до 85.']:
  lng===null?['pin-longitude','Введите долготу от −180 до 180.']:
  title.length<2?['title','Введите не менее двух символов в названии.']:
  !body?['body','Введите сообщение.']:
  secret&&(!secretPriceAtomic||BigInt(secretPriceAtomic)<BigInt(config.secretMinimumAtomic||'10000000'))?['secret-price','Минимальная цена записки — 0.01 Noticoin.']:
  secret&&(!Number.isInteger(secretCopies)||secretCopies<1||secretCopies>100)?['secret-copies','Укажите от 1 до 100 копий.']:
  donating&&!donationAddressFormat.test(donationAddress)?['donation-address','Выберите адрес кошелька']:
  donationAmount&&!donationAmountAtomic?['donation-amount','Проверьте сумму в Noticoin.']:null;
 if(error){
  if(error[0].startsWith('pin-'))$(error[0]).setAttribute('aria-invalid','true');
  if(walletMap)await atlasNotice(tr('Проверьте данные точки'),tr(error[1]));
  else $('compose-error').textContent=tr(error[1]);
  $(error[0]).focus();
  return;
 }
 publishing=true;
 syncComposer();
 $('compose-error').textContent='';
 try{
  if(closed){
   const pin=await privatePins.create({
    title,body,category,lng,lat,...(attachedPlace?{venueName:attachedPlace.name.slice(0,128)}:{})
   });
   if(!pin)return;
   $('compose').close();
   endPlacement();
   resetComposer();
   select(pin);
   toast(tr('Закрытая метка сохранена'),'success');
   return;
  }
  const fields={
   title,category,mode,icon,lng,lat,
   ...(attachedPlace?{venueId:attachedPlace.id,venueName:attachedPlace.name.slice(0,128)}:{}),
   ...(secret?{secretPriceAtomic,secretCopies}:{}),
   ...(config.chainAnchors&&walletMap?{chainRecord:true}:{}),
   ...(donating?{donationAddress,donationAmountAtomic}:{})
  };
  const donationNote=donating?values.get('donationNote').trim():'';
  const policy=secret?await activeNotePolicy():null;
  const fingerprint=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([fields,body,donationNote,policy]))));
  if(publicationRetry?.fingerprint!==fingerprint){
   let id=crypto.randomUUID(),offlineOffer;
   if(secret){
    const addresses=await callMapWallet('sale-addresses',{count:secretCopies});
    const prepared=await NotiOfflineNotes.prepare(body,secretPriceAtomic,addresses,policy);
    id=prepared.id;
    offlineOffer=prepared.offer;
   }
   const cipher=await privatePins.encryptNote({id,body,donationNote});
   if(!cipher)return;
   const publicNote=!secret&&!donating?await NotiPublicNotes.seal(id,body):null;
   publicationRetry={fingerprint,request:{...fields,id,cipher,...(offlineOffer?{offlineOffer}:{}),...(publicNote?{publicNote}:{})}};
  }
  const result=await write('/api/points','create',publicationRetry.request);
  publicationRetry=null;
  $('compose').close();endPlacement();resetComposer();syncComposer();
  await load();
  if(result.invoice)openInvoice({...result.invoice,title,...(policy?{notePolicy:policy}:{}),
   ...(result.invoice.anchorAction?{record:await mapRecord(result.invoice)}:{})});
  else{
   points=[result.point,...points.filter(p=>p.id!==result.point.id)];
   if(ready)select(result.point,!map.getBounds().contains([lng,lat]));
   toast(tr('Твоя история теперь на карте'),'success');
  }
 }catch(error){
  if(closed)await atlasNotice(tr('Закрытая метка'),tr('Не удалось сохранить закрытую метку.'));
  else if(walletMap)await atlasNotice(tr('Не удалось оставить точку'),error.message);
  else $('compose-error').textContent=error.message;
 }finally{publishing=false;syncComposer()}
}
const pendingInvoices=new Map(readList('\x6b\x6f\x6b\x6f.map.invoices').filter(item=>item?.id&&(item.address||item.awaitingDelivery)).map(item=>[item.id,item]));
const checkingInvoices=new Set();
const localPurchases=new Map(),deletedPurchases=new Set(),archiveRequests=new Map();
const receiptNotices=new Map(readList('noti.map.receipt-notices').filter(entry=>Array.isArray(entry)&&
 typeof entry[0]==='string'&&['ready','dismissed'].includes(entry[1])));
let purchaseIndexRequest;
let saleHistory=[],purchaseHistoryRequest=null,selling=false;
let currentReceipt=null,receiptRequest=0;
const remoteReadable=item=>item?.kind==='secret'&&item.status==='confirmed'&&item.readAvailable!==false&&item.readUntil>Date.now();
const readableNote=item=>!!item&&!deletedPurchases.has(item.id)&&(localPurchases.has(item.id)||remoteReadable(item));
try{
 const previous=JSON.parse(localStorage.getItem('\x6b\x6f\x6b\x6f.invoice')||'null');
 if(previous?.id&&previous.expiresAt>Date.now())pendingInvoices.set(previous.id,previous);
 localStorage.removeItem('\x6b\x6f\x6b\x6f.invoice');
}catch{}
function rememberLocalPurchase(record){
 pendingInvoices.delete(record.id);
 if(record.deleted){
  localPurchases.delete(record.id);
  deletedPurchases.add(record.id);
 }else if(!deletedPurchases.has(record.id))localPurchases.set(record.id,{...record,kind:'secret',status:'confirmed'});
}
function loadPurchaseIndex(){
 if(!privatePins)return Promise.resolve();
 if(!purchaseIndexRequest)purchaseIndexRequest=privatePins.purchaseIndex().then(records=>{
  for(const record of records)rememberLocalPurchase(record);
  refreshInvoiceList();
  showDeferredReceipt();
 }).catch(error=>{purchaseIndexRequest=null;throw error;});
 return purchaseIndexRequest;
}
function archiveNote(item){
 if(!privatePins)return Promise.resolve(null);
 if(!archiveRequests.has(item.id)){
  const task=(async()=>{
   await loadPurchaseIndex();
   if(deletedPurchases.has(item.id))return null;
   if(localPurchases.has(item.id))return localPurchases.get(item.id);
   if(!remoteReadable(item))return null;
   const receipt=await write('/api/secret-purchases/'+item.id+'/read','secret-read',{downloadOnly:true});
   const summary=await privatePins.savePurchase(item,receipt);
   if(!summary)return null;
   rememberLocalPurchase(summary);
   refreshInvoiceList();
   return localPurchases.get(item.id)??null;
  })().finally(()=>archiveRequests.delete(item.id));
  archiveRequests.set(item.id,task);
 }
 return archiveRequests.get(item.id);
}
function renderPurchasedNote(item){
 const row=make('div','purchased-note-row');
 const open=make('button','invoice-entry');
 open.type='button';
 open.disabled=!readableNote(item);
 const status=tr(open.disabled?'Текст недоступен':localPurchases.has(item.id)?'Сохранено в кошельке':'Открыть записку');
 const price=item.amountAtomic?formatCoins(item.amountAtomic)+' Noticoin · ':'';
 open.append(make('strong','',item.title||tr('Купленная записка')),make('small','',price+status));
 open.onclick=()=>readSecret(item);
 row.append(open);
 if(walletMap){
  const remove=make('button','purchased-note-delete');
  remove.type='button';
  remove.title=tr('Удалить записку из кошелька');
  remove.setAttribute('aria-label',remove.title);
  remove.append(NoticoinMapIcons.element('trash-2'));
  remove.onclick=async()=>{
   remove.disabled=true;
   try{
    if(!await privatePins.deletePurchase(item.id))throw Error(tr('Разблокируйте хранилище, чтобы прочитать записку.'));
    rememberLocalPurchase({id:item.id,deleted:true});
    dismissReceiptNotice(item.id);
    showDeferredReceipt();
    openedNoteTexts.delete(item.pointId);
    applyNoteFilters();
    refreshInvoiceList();
    toast(tr('Записка удалена из кошелька'));
   }catch(error){await atlasNotice(tr('Купленная записка'),error.message);}
   finally{remove.disabled=false;}
  };
  row.append(remove);
 }
 $('purchased-notes').append(row);
}
function setInvoiceListPage(purchased){
 $('invoice-overview').hidden=purchased;
 $('purchases-section').hidden=!purchased;
 $('invoice-list-back').hidden=!purchased;
 $('invoice-list-heading').textContent=tr(purchased?'Купленные записки':'Счета карты');
 if($('invoice-list').open)$(purchased?'invoice-list-heading':'open-purchases').focus();
}
function refreshInvoiceList(){
 storage('\x6b\x6f\x6b\x6f.map.invoices',[...pendingInvoices.values()]);
 $('pending-invoices').replaceChildren();
 $('purchased-notes').replaceChildren();
 for(const item of [...localPurchases.values()].sort((a,b)=>b.paidAt-a.paidAt))renderPurchasedNote(item);
 for(const item of pendingInvoices.values()){
  if(deletedPurchases.has(item.id)||localPurchases.has(item.id))continue;
  if(item.kind==='secret'&&item.status==='confirmed'){renderPurchasedNote(item);continue;}
  const button=make('button','invoice-entry');
  button.type='button';
  const status=item.awaitingDelivery?tr('Ждём продавца'):item.status==='confirmed'?tr('Оплата подтверждена'):item.submitted?tr('Ждём подтверждения оплаты'):'';
  const charge=item.address==='self'?tr('Сетевая комиссия'):formatCoins(item.amountAtomic)+' Noticoin';
  button.append(make('strong','',item.title||tr(item.kind==='secret'?'Секретная записка':'Оплата публикации')),
   make('small','',charge+(status?' · '+status:'')));
  button.onclick=()=>{$('invoice-list').close();openInvoice(item)};
  $('pending-invoices').append(button);
 }
 const purchases=$('purchased-notes').childElementCount;
 $('purchased-note-count').textContent=String(purchases);
 $('purchased-note-count').hidden=!purchases;
 $('purchases-empty').hidden=!!purchases;
 $('pending-invoices-empty').hidden=!!$('pending-invoices').childElementCount;
 $('sold-notes').replaceChildren();
 for(const sale of saleHistory){
  const row=make('div','invoice-entry');
  row.append(make('strong','',sale.title),make('small','',formatCoins(sale.amountAtomic)+' Noticoin · '+expiryDate.format(sale.paidAt)));
  $('sold-notes').append(row);
 }
 $('sales-section').hidden=!saleHistory.length;
}
function rememberInvoice(item){pendingInvoices.set(item.id,item);refreshInvoiceList()}
function forgetInvoice(item){pendingInvoices.delete(item.id);refreshInvoiceList()}
function showPaymentStatus(){
 const status=$('map-payment-status');
 if(!status||!walletMap)return;
 const pending=[...pendingInvoices.values()].filter(item=>item.submitted&&item.status!=='confirmed'&&!item.released);
 const item=pending.at(-1);
 status.hidden=!item;
 if(!item)return;
 $('map-payment-heading').textContent=tr(item.checkError?'Проверка оплаты недоступна':
  item.direct&&item.confirmations>=3?'Оплата подтверждена · ждём выдачу':'Платёж отправлен · ждём подтверждения');
 $('map-payment-detail').textContent=(item.title||tr(item.kind==='secret'?'Покупка записки':'Оплата публикации'))+' · '+
  (item.checkError||String(item.confirmations||0)+' / '+String(item.requiredConfirmations||3)+tr(' подтверждений'));
 $('map-payment-open').onclick=()=>void openInvoice(item);
}
function announceNote(item){
 if(!readableNote(item)||receiptNotices.has(item.id))return;
 receiptNotices.set(item.id,'ready');
 storage('noti.map.receipt-notices',[...receiptNotices]);
 showDeferredReceipt();
}
function dismissReceiptNotice(id){
 if(receiptNotices.get(id)!=='ready')return;
 receiptNotices.set(id,'dismissed');
 storage('noti.map.receipt-notices',[...receiptNotices]);
 const notice=$('map-receipt-status');
 if(notice.dataset.receipt===id){
  notice.hidden=true;
  delete notice.dataset.receipt;
 }
}
function showDeferredReceipt(){
 if(!walletMap||document.hidden||document.querySelector('dialog[open]'))return;
 const notice=$('map-receipt-status');
 if(!notice.hidden)return;
 for(const [id,state] of receiptNotices){
  if(state!=='ready')continue;
  const item=localPurchases.get(id)??pendingInvoices.get(id);
  if(!readableNote(item))continue;
  notice.dataset.receipt=id;
  $('map-receipt-title').textContent=item.title||tr('Купленная записка');
  $('map-receipt-open').onclick=()=>void readSecret(item);
  $('map-receipt-close').onclick=()=>{dismissReceiptNotice(id);showDeferredReceipt()};
  notice.hidden=false;
  return;
 }
}
function syncPurchaseHistory(){
 if(purchaseHistoryRequest)return purchaseHistoryRequest;
 purchaseHistoryRequest=(async()=>{
  const visibleStatus=$('invoice-list-status');
  try{
   await loadPurchaseIndex();
   const result=await write('/api/secret-purchases','purchase-history');
   for(const saved of result.purchases){
    if(localPurchases.has(saved.id)||deletedPurchases.has(saved.id))continue;
    const item=pendingInvoices.get(saved.id);
    const awaiting=Boolean(item?.submitted&&item.status!=='confirmed'&&saved.status==='confirmed');
    const newlyPayable=Boolean(item?.awaitingDelivery&&saved.address);
    if(item)Object.assign(item,saved);
    else pendingInvoices.set(saved.id,saved);
    if(awaiting||!item&&remoteReadable(saved))announceNote(item??saved);
    if(remoteReadable(saved))void archiveNote(item??saved).catch(()=>{});
    if(newlyPayable&&invoice===item&&$('invoice').open){
     fillInvoicePayment(item);
     $('invoice-status').textContent=tr('Счёт готов к оплате');
    }
    if(invoice===item&&item&&$('invoice').open&&saved.status==='confirmed'){
     $('invoice-status').textContent=tr('Оплата подтверждена · записка готова');
     updateInvoiceControls(item);
    }
   }
   saleHistory=result.sales;
   if(nativeWallet)void fulfillSales(result);
   refreshInvoiceList();
   showPaymentStatus();
   showDeferredReceipt();
   visibleStatus.textContent='';
  }catch(error){
   visibleStatus.textContent=error.message;
  }finally{
   visibleStatus.hidden=!visibleStatus.textContent;
   purchaseHistoryRequest=null;
  }
 })();
 return purchaseHistoryRequest;
}
async function buySecret(point,button){
 if(walletMap&&!await atlasNotice(tr('Секретная записка'),tr('Купить за %1 Noticoin').replace('%1',formatCoins(point.secretPriceAtomic)),tr('Создать счёт')))return;
 button.disabled=true;
 try{
  const recipient=await privatePins.noteRecipient();
  if(!recipient)return;
  const item=await write('/api/points/'+point.id+'/buy','buy',{recipient,automatic:true});
  if(point.offlineSale){
   const trusted=item.offer?.registry
    ?NotiOfflineNotes.policyMatches(item.offer,await callMapWallet('note-registry-policy',{height:item.offer.epoch}))
    :config.offlineNotePolicies?.some(policy=>NotiOfflineNotes.policyMatches(item.offer,policy));
   if(!item.offline||await NotiOfflineNotes.pointId(item.offer)!==point.id||
      !trusted||
      item.offer.addresses[item.slot]!==item.address||item.offer.amountAtomic!==item.amountAtomic||
      item.amountAtomic!==point.secretPriceAtomic||item.offer.addresses.length!==point.secretCopies)
    throw Error(tr('Invalid encrypted note offer.'));
   delete item.offer;
  }
  openInvoice({...item,title:point.title});
 }catch(error){
  if(walletMap)await atlasNotice(tr('Секретная записка'),error.message);
  else toast(error.message);
 }finally{button.disabled=false}
}
async function openInvoice(item){
 item=pendingInvoices.get(item.id)||item;
 if(readableNote(item)){void readSecret(item);return}
 invoice=item;
 rememberInvoice(item);
 $('invoice-heading').textContent=tr(item.anchorAction==='withdraw'?'Снятие метки':item.anchorAction?'Запись метки в блокчейн':item.kind==='secret'?'Покупка записки':'Оплата публикации');
 $('invoice-status').textContent=tr(item.awaitingDelivery?'Ждём продавца':item.anchorAction&&!item.txid?'Ожидаем платёж':'Проверяем оплату…');
 $('payment-progress-bar').style.width='0%';
 fillInvoicePayment(item);
 if(!$('invoice').open)$('invoice').showModal();
 void checkInvoice(item);
}
function fillInvoicePayment(item){
 const amount=formatCoins(item.amountAtomic);
 const uri='noticoin:'+item.address+'?tx_amount='+amount;
 $('invoice-address').textContent=item.address==='self'?'':item.address||'';
 $('copy-address').hidden=walletMap||item.address==='self';
 $('invoice-amount').textContent=item.address==='self'?tr('Сетевая комиссия'):amount;
 $('invoice-amount').nextElementSibling.hidden=item.address==='self';
 $('invoice-deadline').textContent=tr('Оплатите до %1. Сетевая комиссия оплачивается отдельно.').replace('%1',expiryDate.format(item.expiresAt));
 if(item.address)$('wallet-link').href=walletMap?uri+'&map_invoice='+encodeURIComponent(item.id)+
  (item.kind==='secret'?'&map_purchase=1':'')+(item.record?'&map_record='+item.record:''):uri;
 else $('wallet-link').removeAttribute('href');
 $('wallet-link').onclick=item.notePolicy?async event=>{
  event.preventDefault();
  const destination=$('wallet-link').href;
  try {
   if(!sameNotePolicy(await activeNotePolicy(),item.notePolicy)){
    forgetInvoice(item);
    $('invoice').close();
    await atlasNotice(tr('Запись метки в блокчейн'),tr('The note operator set changed. Create the publication again.'));
    return;
   }
   if(invoice===item&&$('invoice').open)window.location.assign(destination);
  }catch(error){$('invoice-status').textContent=error.message;}
 }:null;
 $('wallet-link').textContent=tr(walletMap?'Оплатить из кошелька':'Открыть кошелёк');
 $('qr').replaceChildren();
 $('qr').hidden=walletMap;
 if(item.address&&!walletMap&&window.QRCode)new QRCode($('qr'),{text:uri,width:144,height:144,correctLevel:QRCode.CorrectLevel.M});
 updateInvoiceControls(item);
}
function updateInvoiceControls(item){
 const now=Date.now();
 const awaitingTransfer=walletMap&&(item.submitted||item.status==='seen'||item.status==='included');
 $('invoice-payment').hidden=!item.address||awaitingTransfer||item.status==='confirmed'||item.expiresAt<=now;
 $('read-secret').hidden=!readableNote(item);
 $('check-invoice').hidden=item.status==='confirmed'||item.released;
}
function paymentSubmitted(id,txid){
 const item=pendingInvoices.get(id);
 if(!item||item.submitted)return;
 if(item.anchorAction&&!/^[a-f0-9]{64}$/.test(txid||''))return;
 item.txid=txid;
 item.submitted=true;
 rememberInvoice(item);
 if(invoice===item&&$('invoice').open)$('invoice').close();
 showPaymentStatus();
 void checkInvoice(item);
}
async function checkInvoice(item=invoice){
 if(!item||checkingInvoices.has(item.id)||(item.anchorAction&&!item.txid))return;
 checkingInvoices.add(item.id);
 try{
  const secret=item.kind==='secret';
  if(item.direct&&item.submitted&&item.txid&&!item.proofRecorded){
   const proof=await callMapWallet('sign-payment',{txid:item.txid,address:item.proofAddress,paymentMessage:item.paymentMessage});
   await write('/api/secret-purchases/'+item.id+'/payment','note-payment',{txid:item.txid,proof});
   item.proofRecorded=true;
   rememberInvoice(item);
  }
  const current=item.anchorAction
   ?await write('/api/points/'+item.pointId+'/anchor','anchor-point',{operation:item.anchorAction,txid:item.txid,record:item.record})
   :await write(secret?'/api/secret-purchases/'+item.id:'/api/invoices/'+item.id,secret?'secret-status':'invoice');
  if(pendingInvoices.get(item.id)!==item)return;
  const previous=item.status;
  const previousAddress=item.address;
  delete item.checkError;
  Object.assign(item,current);
  const showing=invoice===item&&$('invoice').open;
  const confirmed=current.status==='confirmed';
  const readable=readableNote(item);
  if(showing){
   const texts={awaiting:tr(item.submitted?'Ждём подтверждения оплаты':'Ожидаем платёж'),seen:tr('Платёж замечен · ждём блок'),
    included:tr('В блоке · ')+current.confirmations+' / '+current.requiredConfirmations+tr(' подтверждений'),
    confirmed:tr(item.anchorAction==='withdraw'?'Метка снята с карты':secret?(readable?'Оплата подтверждена · записка готова':'Текст недоступен'):'Оплата подтверждена · точка на карте'),
    partial:tr('Получена часть суммы. Проверьте сумму перевода.'),
    expired:tr('Срок счёта истёк. Не отправляй на него новый платёж.')};
    $('invoice-status').textContent=item.awaitingDelivery&&current.status==='awaiting'?tr('Ждём продавца'):texts[current.status]||current.status;
   $('payment-progress-bar').style.width=(confirmed?100:current.status==='seen'?15:Math.min(90,current.confirmations/current.requiredConfirmations*100))+'%';
   if(previousAddress!==item.address)fillInvoicePayment(item);
   else updateInvoiceControls(item);
  }
  if(confirmed||current.released||(!secret&&current.status==='expired')){
   if(secret&&confirmed)rememberInvoice(item);
   else forgetInvoice(item);
  }
  if(item.submitted)showPaymentStatus();
  if(confirmed&&walletMap){
   if(showing&&!secret)$('invoice').close();
   if(secret&&readable)void archiveNote(item).catch(()=>{});
   if(previous!=='confirmed'){
    if(secret)announceNote(item);
    else toast(tr(item.anchorAction==='withdraw'?'Метка снята с карты':'Оплата подтверждена · точка на карте'),'success');
   }
  }
  if(previous!==current.status&&(confirmed||['included','seen'].includes(current.status)))await load();
 }catch(error){
  item.checkError=error.message;
  if(item.submitted)showPaymentStatus();
  if(invoice===item&&$('invoice').open)$('invoice-status').textContent=error.message+tr(' · последняя проверка не обновлена');
 }finally{checkingInvoices.delete(item.id)}
}
async function readSecret(item){
 if(!readableNote(item))return;
 dismissReceiptNotice(item.id);
 if($('invoice').open)$('invoice').close();
 const fromPurchases=$('invoice-list').open&&!$('purchases-section').hidden;
 if($('invoice-list').open&&!fromPurchases)$('invoice-list').close();
 $('purchased-note-back').hidden=!fromPurchases;
 const dialog=$('purchased-note'),body=$('purchased-note-body'),status=$('purchased-note-status');
 const generation=++receiptRequest;
 currentReceipt=item;
 $('purchased-note-title').textContent=item.title||tr('Купленная записка');
 body.hidden=true;
 body.textContent='';
 $('retry-note').hidden=true;
 status.textContent=tr('Открываем записку…');
 if(!dialog.open)dialog.showModal();
 try{
  const archived=localPurchases.get(item.id)??await archiveNote(item);
  if(generation!==receiptRequest||!dialog.open)return;
  const note=archived?await privatePins.readPurchase(item.id):null;
  if(generation!==receiptRequest||!dialog.open)return;
  if(!note){status.textContent=tr('Разблокируйте хранилище, чтобы прочитать записку.');$('retry-note').hidden=false;return;}
  if(item.pointId)openedNoteTexts.set(item.pointId,note.body);
  body.textContent=note.body;
  body.hidden=false;
  status.textContent=tr('Сохранено в кошельке');
 }catch(error){
  if(generation===receiptRequest&&dialog.open){
   status.textContent=error.message;
   $('retry-note').hidden=false;
  }
 }
}
async function fulfillSales(result){
 if(selling||!privatePins||!(result.sellerWaiting||result.deliveries?.some(order=>order.direct)||result.legacyListings?.length))return;
 selling=true;
 try{
  if(!await privatePins.readyForSales())return;
  if(result.sellerWaiting)await write('/api/secret-purchases/ready','seller-ready');
  for(const order of result.deliveries||[]){
   if(!order.direct)continue;
   const note=await privatePins.decryptNote(order.pointId,order.cipher);
   if(!note?.saleTerms||note.saleTerms.address!==order.address)continue;
   const paymentMessage=['noti-note-v2',order.id,order.pointId,order.recipient].join(':');
   if(!await callMapWallet('verify-payment',{...note.saleTerms,txid:order.txid,proof:order.proof,paymentMessage}))continue;
   const cipher=await privatePins.encryptNote({id:note.id,body:note.body,donationNote:note.donationNote},order.recipient);
   if(cipher)await write('/api/secret-purchases/'+order.id+'/deliver','deliver-note',{recipient:order.recipient,cipher});
  }
  for(const listing of result.legacyListings||[]){
   const {cipher}=await write('/api/points/'+listing.id+'/note','read-my-note');
   const note=await privatePins.decryptNote(listing.id,cipher);
   if(!note)continue;
   const address=await callMapWallet('sale-address');
   const protectedNote=await privatePins.encryptNote({...note,saleTerms:{address,amountAtomic:listing.amountAtomic}});
   if(protectedNote)await write('/api/points/'+listing.id+'/direct-sales','direct-sales',{address,cipher:protectedNote,amountAtomic:listing.amountAtomic});
  }
 }catch(error){console.warn('Noti sales are waiting:',error.message)}
 finally{selling=false;}
}
function cityKey(place){
 return place.lat.toFixed(4)+':'+place.lng.toFixed(4);
}

function showFavoriteCities(show,focus=false){
 const panel=$('atlas-cities'),toggle=$('atlas-city-toggle');
 panel.hidden=!show;
 toggle.setAttribute('aria-expanded',String(show));
 if(show){
  $('search-results').hidden=true;
  renderFavoriteCities();
 }
 if(focus)toggle.focus();
}

function renderFavoriteCities(){
 const list=$('atlas-city-list');
 list.replaceChildren();
 if(!favoriteCities.size){
  list.append(make('p','empty',tr('Найдите город и нажмите звёздочку рядом с его названием.')));
  return;
 }
 for(const place of favoriteCities.values())list.append(atlasCityRow(place,true));
}

function atlasCityRow(place,inFavorites=false){
 const row=make('div','atlas-search-row');
 const result=make('button','search-result',place.title);
 result.type='button';
 result.append(make('small','',place.subtitle));
 result.onclick=()=>{
  $('search-results').hidden=true;
  if(walletMap)showFavoriteCities(false);
  if(!ready)return;
  if(place.point&&walletMap)openPoint(place.point,true);
  else{
   dismissPoint();
   fly(place.lng,place.lat,place.zoom);
   if(place.point)openPoint(place.point);
   render();
  }
 };
 row.append(result);
 if(!walletMap||!place.city)return row;
 const key=cityKey(place);
 const star=make('button','atlas-favorite-star');
 star.type='button';
 const update=()=>{
  const saved=favoriteCities.has(key);
  star.textContent=saved?'★':'☆';
  star.setAttribute('aria-pressed',String(saved));
  star.setAttribute('aria-label',(saved?tr('Убрать из избранного: '):tr('Добавить в избранное: '))+place.title);
  star.title=saved?tr('Убрать из избранного'):tr('Добавить в избранное');
 };
 update();
 star.onclick=()=>{
  if(favoriteCities.has(key))favoriteCities.delete(key);
  else favoriteCities.set(key,place);
  storage('\x6b\x6f\x6b\x6f.atlas.cities',[...favoriteCities.values()]);
  if(inFavorites){renderFavoriteCities();$('atlas-city-toggle').focus();}
  else update();
 };
 row.append(star);
 return row;
}

async function doSearch(event){
 event?.preventDefault();
 const query=$('search').value.trim();
 $('clear-search').hidden=!query;
 if(walletMap)showFavoriteCities(false);
 if(!query){$('search-results').hidden=true;render();return;}
 const results=$('search-results');
 results.replaceChildren();
 const phrase=query.toLowerCase();
 let matches=cities.filter(c=>(c[0]+' '+c[1]).toLowerCase().includes(phrase)).slice(0,5)
  .map(([local,english,lng,lat])=>({title:walletMap?english:local,subtitle:walletMap?coords(lng,lat):english,lng,lat,zoom:11,city:true}));
 const coordinate=NoticoinMapRuntime.parseCoordinatePair(query);
 if(coordinate){
  const {lat,lng}=coordinate;
  matches.unshift({title:coords(lng,lat),subtitle:tr('Координаты'),lng,lat,zoom:13});
 }
 const terms=NoticoinMapRuntime.noteTerms(query);
 const local=[...(privatePins?.items()||[]),...points].filter(p=>NoticoinMapRuntime.noteMatches(terms,p.title)).slice(0,3);
 for(const p of local)matches.push({title:p.title,subtitle:pointCity(p),lng:p.lng,lat:p.lat,point:p,zoom:12});
 if(!matches.length){
  results.append(make('p','empty',tr('Ищем это место…')));
  results.hidden=false;
  try{
   const data=await api('/api/search?q='+encodeURIComponent(query));
   if($('search').value.trim()!==query||(walletMap&&!$('atlas-cities').hidden))return;
   matches=data.results.filter(p=>Number.isFinite(p.lng)&&Number.isFinite(p.lat))
    .map(p=>({title:p.name,subtitle:p.description,lng:p.lng,lat:p.lat,zoom:11,city:true}));
  }catch(error){
   if($('search').value.trim()===query)results.replaceChildren(make('p','empty',error.message));
   return;
  }
 }
 results.replaceChildren(...matches.map(place=>atlasCityRow(place)));
 if(!matches.length)results.append(make('p','empty',tr('Место не найдено. Попробуйте другое название или введите широту и долготу.')));
 results.hidden=false;
}
function markerSprite({color,highlight,glyph,pulse}){
 const canvas=document.createElement('canvas');
 canvas.width=72;canvas.height=84;
 const ctx=canvas.getContext('2d',{willReadFrequently:true});
 ctx.scale(2,2);
 ctx.beginPath();
 ctx.moveTo(18,39);
 ctx.bezierCurveTo(15,37,2.8,27,2.8,17.5);
 ctx.arc(18,17.5,15.2,Math.PI,0);
 ctx.bezierCurveTo(33.2,27,21,37,18,39);
 ctx.closePath();
 const fill=ctx.createLinearGradient(10,3,25,37);
 fill.addColorStop(0,highlight);
 fill.addColorStop(pulse ? .78 : .54,color);
 fill.addColorStop(1,color);
 ctx.fillStyle=fill;
 ctx.fill();
 ctx.strokeStyle='#ffffff';ctx.lineWidth=pulse?2.8:2.4;ctx.stroke();
 if(pulse){
  ctx.shadowColor='#142137';ctx.shadowBlur=3;
  NoticoinMapIcons.draw(ctx,glyph,7.5,7,21);
 }else NoticoinMapIcons.draw(ctx,glyph,8.5,8,19);
 return ctx.getImageData(0,0,canvas.width,canvas.height);
}

const pinPulseRest={icon:1,stroke:.42,fill:.09,width:1.8,spread:0};
const pinPulseBright={icon:1,stroke:1,fill:.28,width:3.3,spread:4};
const pinPulseDim={icon:.46,stroke:.16,fill:.05,width:1.3,spread:0};
let pinPulseTimer, pinPulseFade;
function paintPinPulse({icon,stroke,fill,width,spread}){
 if(!map?.getLayer('pulsing-pins')||!map.getLayer('pulsing-pin-icons'))return;
 map.setPaintProperty('pulsing-pin-icons',walletMap?'icon-opacity':'circle-opacity',icon);
 map.setPaintProperty('pulsing-pins','circle-stroke-opacity',stroke);
 map.setPaintProperty('pulsing-pins','circle-opacity',fill);
 map.setPaintProperty('pulsing-pins','circle-stroke-width',width);
 map.setPaintProperty('pulsing-pins','circle-radius',(walletMap?18:9)+spread);
}
function syncPinPulse(){
 const active=ready&&!motionPreference.matches&&!document.hidden&&!map.isMoving()&&visible.some(p=>pinIcons[p.icon]?.pulse);
 if(!active){
  if(pinPulseTimer){
   clearInterval(pinPulseTimer);
   clearTimeout(pinPulseFade);
   pinPulseTimer=null;
   paintPinPulse(pinPulseRest);
  }
  return;
 }
 if(pinPulseTimer)return;
 const pulse=()=>{
  if(!ready||!map.getLayer('pulsing-pins')||!map.queryRenderedFeatures({layers:['pulsing-pins']}).length)return;
  paintPinPulse(pinPulseBright);
  pinPulseFade=setTimeout(()=>paintPinPulse(pinPulseDim),560);
 };
 pulse();
 pinPulseTimer=setInterval(pulse,1850);
}
document.addEventListener('visibilitychange',syncPinPulse);
motionPreference.addEventListener('change',syncPinPulse);

function addPointLayers(){
 const single=['!', ['has','point_count']];
 const pulseIcon=['in',['get','icon'],['literal',pulsingIcons.map(([name])=>name)]];
 const flashing=['all',single,pulseIcon], steady=['all',single,['!',pulseIcon]];
 const transition={duration:230};
 const glow=['match',['get','icon'],...pulsingIcons.flatMap(([name,icon])=>[name,icon.highlight]),'#ffffff'];
 map.addSource('noticoin-points',{type:'geojson',data:{type:'FeatureCollection',features:[]},cluster:true,clusterMaxZoom:13,clusterRadius:walletMap?47:45});
 map.addLayer({
  id:'pulsing-pins',type:'circle',source:'noticoin-points',
  filter:flashing,
  paint:{'circle-radius':walletMap?18:9,'circle-color':glow,'circle-opacity':pinPulseRest.fill,'circle-opacity-transition':transition,
   'circle-stroke-width':pinPulseRest.width,'circle-stroke-opacity':pinPulseRest.stroke,'circle-stroke-color':glow,
   'circle-stroke-opacity-transition':transition,'circle-stroke-width-transition':transition,'circle-radius-transition':transition,
   'circle-translate':walletMap?[0,-21]:[0,0],'circle-translate-anchor':'viewport',
   'circle-pitch-alignment':'viewport','circle-pitch-scale':'viewport'}
 });
 if(walletMap){
  for(const [category,item] of Object.entries({...cat,...pinIcons,private:privateIcon})){
   if(!item.glyph)continue;
   if(!map.hasImage('pin-'+category))map.addImage('pin-'+category,markerSprite(item),{pixelRatio:2});
  }
  map.addLayer({
   id:'atlas-selected',type:'circle',source:'noticoin-points',filter:['==',['get','id'],selected?.id||''],
   paint:{'circle-radius':19,'circle-color':'#8f7dff','circle-opacity':.48,'circle-stroke-width':2,
    'circle-stroke-color':'#ece8ff','circle-translate':[0,-21],'circle-translate-anchor':'viewport',
    'circle-pitch-alignment':'viewport','circle-pitch-scale':'viewport'}
  });
  const layout={
   'icon-image':['concat','pin-',['get','icon']],'icon-anchor':'bottom',
   'icon-size':['interpolate',['linear'],['zoom'],0,.73,11,1.04,16,1.14],
   'icon-allow-overlap':true,'icon-ignore-placement':true,'icon-pitch-alignment':'viewport'
  };
  map.addLayer({id:'points',type:'symbol',source:'noticoin-points',filter:steady,layout});
  map.addLayer({id:'pulsing-pin-icons',type:'symbol',source:'noticoin-points',filter:flashing,layout,
   paint:{'icon-opacity':pinPulseRest.icon,'icon-opacity-transition':transition}});
 }else{
  const paint={
   'circle-radius':['interpolate',['linear'],['zoom'],0,4,8,7],'circle-color':['get','color'],'circle-stroke-color':'#15253b','circle-stroke-width':2
  };
  map.addLayer({id:'points',type:'circle',source:'noticoin-points',filter:steady,paint});
  map.addLayer({id:'pulsing-pin-icons',type:'circle',source:'noticoin-points',filter:flashing,
   paint:{...paint,'circle-color':glow,'circle-opacity':pinPulseRest.icon,'circle-opacity-transition':transition}});
 }
 const titleOffset=walletMap?['interpolate',['linear'],['zoom'],
  0,['literal',[0,-2.6]],11,['literal',[0,-3.4]],16,['literal',[0,-3.7]]]:[0,-.85];
 map.addLayer({id:'point-labels',type:'symbol',source:'noticoin-points',filter:['all',single,['!=',['get','title'],'']],
  layout:{'text-field':['get','title'],'text-font':['Noto Sans Regular'],'text-size':14,'text-anchor':'bottom','text-justify':'center','text-max-width':14,
   'text-offset':titleOffset,'text-pitch-alignment':'viewport','text-padding':3},
  paint:{'text-color':'#ffffff','text-halo-color':'#101224','text-halo-width':1.5}});
 map.addLayer({id:'clusters',type:'circle',source:'noticoin-points',filter:['has','point_count'],paint:{
  'circle-color':walletMap?['step',['get','point_count'],'#5a3edd',4,'#a136d0',12,'#245ab4']:'#f0ac8e',
  'circle-radius':['step',['get','point_count'],17,10,21,50,25],
  'circle-stroke-width':2,'circle-stroke-color':walletMap?'#e2e7ff':'#513d39'
 }});
 map.addLayer({id:'cluster-count',type:'symbol',source:'noticoin-points',filter:['has','point_count'],layout:{
  'text-field':['get','point_count_abbreviated'],'text-size':12,'text-font':['Noto Sans Regular'],'text-allow-overlap':walletMap
 },paint:{'text-color':walletMap?'#ffffff':'#302121'}});
}

function ringContains(ring,[x,y]){
 let inside=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const [xi,yi]=ring[i],[xj,yj]=ring[j];
  if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
 }
 return inside;
}

function openAtlasPlace(event,places){
 const labels=['atlas-venues','atlas-building-names'].filter(id=>map.getLayer(id));
 const [label]=labels.length?map.queryRenderedFeatures([[event.point.x-4,event.point.y-4],[event.point.x+4,event.point.y+4]],{layers:labels}):[];
 if(label){
  dismissPoint();
  places.open(label,{building:label.layer.id==='atlas-building-names'});
  return true;
 }
 const layers=['atlas-buildings','atlas-buildings-3d','atlas-buildings-textured'].filter(id=>map.getLayer(id));
 if(!layers.length)return false;
 const [building]=map.queryRenderedFeatures(event.point,{layers});
 if(!building)return false;
 const polygons=building.geometry.type==='MultiPolygon'?building.geometry.coordinates:[building.geometry.coordinates];
 if(!polygons[0]?.[0]?.length)return false;
 const named=map.querySourceFeatures('named-buildings').find(label=>polygons.some(([outer,...holes])=>
  ringContains(outer,label.geometry.coordinates)&&!holes.some(hole=>ringContains(hole,label.geometry.coordinates))));
 dismissPoint();
 if(named){places.open(named,{building:true});return true}
 const outline=polygons.flatMap(polygon=>polygon[0]);
 const xs=outline.map(item=>item[0]),ys=outline.map(item=>item[1]);
 const anchor=[(Math.min(...xs)+Math.max(...xs))/2,(Math.min(...ys)+Math.max(...ys))/2];
 places.open(building,{building:true,coordinates:[event.lngLat.lng,event.lngLat.lat],anchor});
 return true;
}

function init(){
 if(!window.maplibregl){status(tr('Не загрузился движок карты. Обнови страницу после восстановления сети.'));return;}
 const runtime=NoticoinMapRuntime,software=runtime.rendererIsSoftware();
 const places=walletMap?NoticoinAtlasReviews.create({api,write,tr,notice:atlasNotice,compose:composeAt,showNote:openPoint,formatCoins,configureCoordinateButton}):null;
 try{detailMode=!walletMap&&localStorage.getItem('\x6b\x6f\x6b\x6f.map.detail')==='1';}catch{}
 maplibregl.setWorkerCount(walletMap&&!software&&navigator.hardwareConcurrency>=8?4:2);
 maplibregl.setMaxParallelImageRequests(6);
 try{map=new maplibregl.Map({container:'map',style:atlasStyleUrl(detailMode,mapLight),center:[80,28],zoom:walletMap?planetZoom():1.05,minZoom:-.2,maxZoom:19,maxPitch:walletMap?58:detailMode?45:0,renderWorldCopies:false,pixelRatio:runtime.pixelRatio(innerWidth,innerHeight,devicePixelRatio,{software,detail:detailMode}),maxTileCacheSize:walletMap?160:80,attributionControl:walletMap?false:{compact:true},fadeDuration:0,canvasContextAttributes:{antialias:false,preserveDrawingBuffer:false,powerPreference:'high-performance'}});}catch(e){status(tr('WebGL недоступен. Карте нужен браузер с поддержкой WebGL.'));return;}
 if(walletMap){
  connectAtlas();
  connectMapContextMenu();
  window.chrome?.webview?.addEventListener('message',event=>{
   if(event.data==='theme-light'||event.data==='theme-dark')applyAtlasTheme(event.data==='theme-light');
   if(event.data==='map-active'){
    showDeferredReceipt();
    for(const item of pendingInvoices.values())if(item.submitted&&item.status!=='confirmed')void checkInvoice(item);
   }
   if(typeof event.data==='string'&&event.data.startsWith('map-payment-submitted:'))
    paymentSubmitted(...event.data.slice('map-payment-submitted:'.length).split(':'));
   if(typeof event.data==='string'&&event.data.startsWith('map-donation-sent:')){
    const amount=event.data.slice('map-donation-sent:'.length);
    if(/^\d+(?:\.\d{1,9})?$/.test(amount))toast(tr('Донат отправлен: %1 Noticoin').replace('%1',amount),'success');
   }
   const pending=pendingCoordinateCopy;
   if(pending&&event.data==='coordinates-copied:'+pending.text){
    pendingCoordinateCopy=null;
    copiedCoordinates(pending.button);
   }
  });
 }
 pointUpdates=runtime.pointUpdater(map,cat);resolution=runtime.adaptiveResolution(map,{software,detail:detailMode});
 if(!walletMap){
  const quality=$('map-quality');const qualityLabel=()=>{quality.textContent=detailMode?'Легче':'Детальнее';quality.title=detailMode?'Уменьшить нагрузку на графику':'Показать больше деталей карты';quality.setAttribute('aria-pressed',String(detailMode));};qualityLabel();
  quality.onclick=()=>{detailMode=!detailMode;try{localStorage.setItem('\x6b\x6f\x6b\x6f.map.detail',detailMode?'1':'0');}catch{}ready=false;loadAbort?.abort();clearTimeout(loadTimer);map.stop();map.setPitch(0);map.setMaxPitch(detailMode?45:0);resolution.setDetail(detailMode);qualityLabel();map.setStyle(detailMode?'/map-detail.json':'/map-fast.json',{diff:false});};
 }
 map.on('style.load',()=>{
 map.setProjection({type:'globe'});
 if(walletMap)NoticoinAtlasDetails.install(map);
 addPointLayers();
 ready=true;streetsFailed=false;pointUpdates.reset();render();load(false);updateCoordinates();updateStreetStatus();});
 map.on('click',e=>{
  if(placing){
   if(walletMap)return;
   location=[longitude(e.lngLat.lng),Math.max(-85,Math.min(85,e.lngLat.lat))];
   acceptPlacement();
   return;
  }
  const layers=pointHitLayers.filter(id=>map.getLayer(id));
  if(!layers.length)return;
  const [feature]=map.queryRenderedFeatures(e.point,{layers});
  if(!feature){
   if(places)openAtlasPlace(e,places);
   return;
  }
  if(feature.properties.cluster){
   atlasOverview=false;
   map.getSource('noticoin-points').getClusterExpansionZoom(feature.properties.cluster_id)
    .then(zoom=>map.easeTo({center:feature.geometry.coordinates,zoom,duration:reduced?0:420}))
    .catch(()=>{});
   return;
  }
  const point=[...(privatePins?.items()||[]),...points].find(p=>p.id===feature.properties.id);
  if(point)openPoint(point);
 });
 const hoverLayers=walletMap?[...pointHitLayers,'atlas-venues','atlas-building-names','atlas-buildings','atlas-buildings-3d','atlas-buildings-textured']:pointHitLayers;
 map.on('mousemove',runtime.hoverHandler(map,()=>placing,undefined,hoverLayers));
 map.on('movestart',syncPinPulse);
 map.on('moveend',()=>{
  syncPinPulse();
  updateCoordinates();scheduleLoad();updateStreetStatus();
  clearTimeout(warmupTimer);
  if(walletMap)warmupTimer=setTimeout(()=>{
   const center=map.getCenter();warmStreetTiles(center.lng,center.lat,map.getZoom()+1);
  },180);
 });
 map.on('error',e=>{
  console.warn('Map:',e.error?.message);
  const url=String(e.error?.url||'');
  if(walletMap&&(e.sourceId==='openmaptiles'||url.includes('/street/'))){
   streetsFailed=true;updateStreetStatus();
  }else if(!ready)status(tr('Картография загружается медленно. Проверь подключение к сети.'));
 });
 if(walletMap){
  let notified=false;
  const firstFrame=()=>{
   if(notified||!ready)return;
   notified=true;
   window.chrome?.webview?.postMessage('atlas-ready');
  };
  map.on('sourcedata',event=>{
   if(!notified&&event.isSourceLoaded&&['world-vectors','world'].includes(event.sourceId)){
    map.once('render',firstFrame);
   }
  });
  $('retry-streets').onclick=()=>{
   const source=map.getSource('openmaptiles');
   if(!source)return;
   streetsFailed=false;
   source.setTiles([window.location.origin+'/street/{z}/{x}/{y}.pbf']);
   updateStreetStatus();
  };
  map.on('idle',()=>{
   firstFrame();
   if(ready&&$('map-status').textContent===tr('Загружаются детали карты…'))status('');
  });
 }
 const zoomDuration=reduced?0:walletMap?200:300;
 $('planet').onclick=()=>{
  if(walletMap){dismissPoint();atlasOverview=true;}
  map.flyTo({center:[80,walletMap?28:22],zoom:walletMap?planetZoom():.7,bearing:0,pitch:0,padding:0,duration:reduced?0:walletMap?620:1600});
 };
 $('zoom-in').onclick=()=>{atlasOverview=false;map.zoomIn({duration:zoomDuration})};
 $('zoom-out').onclick=()=>{atlasOverview=false;map.zoomOut({duration:zoomDuration})};
 $('compass').onclick=()=>map.easeTo({bearing:0,pitch:walletMap&&atlas3D?map.getPitch():0,duration:reduced?0:walletMap?200:600});
 if(!walletMap)$('locate').onclick=()=>{if(!navigator.geolocation){toast('Геолокация недоступна');return}navigator.geolocation.getCurrentPosition(p=>fly(p.coords.longitude,p.coords.latitude,13),()=>toast('Не удалось получить местоположение. Выбери место на карте.'),{timeout:10000,maximumAge:60000})};
}
function updateCoordinates(){
 if(!map)return;
 const {lng,lat}=map.getCenter();
 $('coordinates').textContent=coords(longitude(lng),lat);
 $('copy-map-coordinates').disabled=false;
 const z=map.getZoom();
 $('zoom-label').textContent=z<3?tr('Планета'):z<6?tr('Страна'):z<10?tr('Регион'):z<14?tr('Город'):tr('Улицы');
}
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{
 view=button.dataset.view;
 noteResultPage=0;
 document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));
 $('list-title').textContent=view==='mine'?tr('Мои точки'):view==='saved'?tr('Сохранённые'):walletMap?tr('В пределах карты'):'В объективе';
 render();
});
if(walletMap){
 $('note-query').oninput=event=>{
  clearTimeout(noteSearchTimer);
  const query=event.target.value;
  noteSearchTimer=setTimeout(()=>{noteQuery=NoticoinMapRuntime.noteTerms(query);applyNoteFilters()},90);
 };
 $('note-country').onchange=event=>{
  const country=countryAreas?.[event.target.value];
  activeCountry=country?NoticoinMapRuntime.countryArea(country.polygons):null;
  applyNoteFilters();
  if(!activeCountry||!ready)return;
  atlasOverview=false;
  atlasExplorer(true);
  map.fitBounds(activeCountry.bounds,{padding:46,maxZoom:10,duration:reduced?0:420});
 };
}
if(walletMap){
 $('note-category-filter').onchange=event=>{
  filter=event.target.value;
  noteResultPage=0;
  render();
 };
}else{
 $('filters').onclick=event=>{
  const button=event.target.closest('[data-category]');
  if(!button)return;
  filter=button.dataset.category;
  document.querySelectorAll('[data-category]').forEach(b=>b.classList.toggle('active',b===button));
  render();
 };
}
$('detail-close').onclick=()=>{dismissPoint();render();if(walletMap)$(atlasDocked?'atlas-layout':'atlas-points').focus()};
$('create').onclick=()=>newPin();
$('placement-cancel').onclick=returnToComposer;
$('placement-next').onclick=acceptPlacement;
$('change-location').onclick=beginPlacement;
configureCoordinateButton($('copy-map-coordinates'),()=>{
 if(!ready)return null;
 const {lng,lat}=map.getCenter();
 return [lng,lat];
});
configureCoordinateButton($('copy-compose-coordinates'),()=>{
 const position=composerCoordinates();
 return position.includes(null)?null:position;
});
$('manual-coordinates').addEventListener('input',syncCoordinateInputs);
$('manual-coordinates').addEventListener('paste',event=>{
 const coordinate=NoticoinMapRuntime.parseCoordinatePair(event.clipboardData.getData('text/plain'));
 if(!coordinate)return;
 event.preventDefault();
 setCoordinateInputs([coordinate.lng,coordinate.lat]);
 syncCoordinateInputs();
});
$('compose-form').noValidate=walletMap;
$('new-donation-address').onclick=()=>void loadDonationAddresses(true);
$('compose-form').onsubmit=publish;
$('compose-form').addEventListener('change',event=>{
 const id=event.target.id;
 if(id==='pin-category')setIconOptions();
 else if(id==='private-pin'&&event.target.checked){
  $('sell-note').checked=false;
  $('accept-donations').checked=false;
 }
 else if(id==='accept-donations'&&event.target.checked){
  $('sell-note').checked=false;
  void loadDonationAddresses();
 }else if(id==='sell-note'&&event.target.checked)$('accept-donations').checked=false;
 else if(id==='donation-address')showDonationAddress();
 syncComposer();
});
function optionBody(option,label,icon,price){
 option.replaceChildren(iconBadge(icon,'note-option-icon'),make('span','note-option-label',label));
 if(price&&price!=='0')option.append(make('small','note-option-price',' +'+formatCoins(price)+' Noticoin'));
}
for(const [key,item] of Object.entries(cat)){
 const option=new Option('',key);
 optionBody(option,item.label,item);
 $('pin-category').append(option);
 if(walletMap){
  const choice=new Option('',key);
  optionBody(choice,item.label,item);
  $('note-category-filter').append(choice);
  continue;
 }
 let chip=$('filters').querySelector('[data-category="'+key+'"]');
 if(!chip){
  chip=make('button','chip',item.label);
  chip.type='button';
  chip.dataset.category=key;
  $('filters').append(chip);
 }
 chip.prepend(NoticoinMapIcons.element(item.glyph));
}
if(walletMap){
 $('note-country').options[0].prepend(NoticoinMapIcons.element('globe'));
 $('note-category-filter').options[0].prepend(NoticoinMapIcons.element('layers'));
 $('about').append(NoticoinMapIcons.element('info'));
}
function setIconOptions(){
 const select=$('pin-icon'),selected=select.value||'default';
 for(const option of Array.from(select.options))option.remove();
 for(const [key,item] of Object.entries(pinIcons)){
  if(config.iconPrices&&!Object.hasOwn(config.iconPrices,key))continue;
  const price=config.iconPrices?.[key]||item.price;
  const option=new Option('',key);
  optionBody(option,tr(item.label),item.glyph?item:cat[$('pin-category').value],price);
  select.append(option);
 }
 select.value=[...select.options].some(option=>option.value===selected)?selected:'default';
}
setIconOptions();
syncComposer();
$('private-pin-option').hidden=!walletMap;
$('visibility-public-icon').append(NoticoinMapIcons.element('map-pin'));
$('visibility-private-icon').append(NoticoinMapIcons.element('lock-keyhole'));
$('compose-close').replaceChildren(NoticoinMapIcons.element('x'));
const privatePins=walletMap?NoticoinPrivatePinControls.connect({
 byId:$,make,tr,onChange:render,select,
 onLock(){
  clearTimeout(noteSearchTimer);
  $('note-query').value='';
  noteQuery=[];
  void loadNoteSearchScope();
  openedNoteTexts.clear();
  if($('purchased-note').open)$('purchased-note').close();
  const opened=$('detail-content').querySelector('[data-decrypted-note]');
  if(opened&&selected)select(selected);
  if(selected?.isPrivate){
   dismissPoint();
   $('detail-content').replaceChildren();
  }
  $('search-results').hidden=true;
  $('search-results').replaceChildren();
  if($('private-pin').checked){
   if($('compose').open)$('compose').close();
   resetComposer();
  }
 }
}):null;
$('body').oninput=()=>$('character-count').textContent=$('body').value.length+' / 500';
$('about').onclick=()=>$('about-modal').showModal();
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
$('compose').addEventListener('close',()=>{if(!placing)endPlacement()});
$('invoice').addEventListener('close',()=>{
 if($('invoice').open)return;
 invoice=null;
});
$('purchased-note').addEventListener('close',()=>{
 if($('purchased-note').open)return;
 receiptRequest++;
 currentReceipt=null;
 $('purchased-note-body').textContent='';
});
$('retry-note').onclick=()=>void readSecret(currentReceipt);
$('read-secret').onclick=()=>void readSecret(invoice);
$('open-purchases').append(NoticoinMapIcons.element('chevron-right'));
$('open-purchases').onclick=()=>setInvoiceListPage(true);
$('invoice-list-back').append(NoticoinMapIcons.element('chevron-left'));
$('invoice-list-back').onclick=()=>setInvoiceListPage(false);
$('purchased-note-back').append(NoticoinMapIcons.element('chevron-left'));
$('purchased-note-back').onclick=()=>$('purchased-note').close();
document.querySelectorAll('.map-panel-heading [data-close]').forEach(button=>button.replaceChildren(NoticoinMapIcons.element('x')));
const invoiceMenu=$('map-invoices')||make('button','text-btn',tr('Счета'));
if(!walletMap){
 invoiceMenu.id='web-map-invoices';
 document.querySelector('.explorer-footer').append(invoiceMenu);
}
invoiceMenu.hidden=false;
invoiceMenu.onclick=()=>{
 setInvoiceListPage(false);
 $('invoice-list').showModal();
 void syncPurchaseHistory();
};
refreshInvoiceList();
void loadPurchaseIndex().catch(()=>{});
showPaymentStatus();
$('search-form').onsubmit=doSearch;
$('clear-search').onclick=()=>{$('search').value='';$('search-results').hidden=true;$('clear-search').hidden=true;render()};
$('search').oninput=()=>{
 if(walletMap)showFavoriteCities(false);
 $('clear-search').hidden=!$('search').value;
 if(!$('search').value){$('search-results').hidden=true;render()}
};
document.addEventListener('click',e=>{
 if(e.target.closest('.search-wrap'))return;
 $('search-results').hidden=true;
 if(walletMap)showFavoriteCities(false);
});
$('check-invoice').onclick=()=>void checkInvoice();
setInterval(()=>{
 if(document.hidden)return;
 if(walletMap&&$('compose').open&&(mapConfigStatus!=='ready'||!config.paymentsEnabled))void refreshMapConfig();
 showDeferredReceipt();
 if(invoice)void checkInvoice(invoice);
 if(walletMap)for(const item of pendingInvoices.values()){
  if(item!==invoice&&item.status!=='confirmed'&&(item.submitted||item.status==='seen'||item.status==='included'))
   void checkInvoice(item);
 }
 if($('invoice-list').open)void syncPurchaseHistory();
},5000);
setInterval(()=>{if(walletMap&&config.secretPaymentsEnabled&&nativeWallet)void syncPurchaseHistory()},10000);
document.addEventListener('visibilitychange',showDeferredReceipt);
document.addEventListener('close',showDeferredReceipt,true);
$('copy-address').onclick=async()=>{
 try{await navigator.clipboard.writeText(invoice.address);toast(tr('Адрес скопирован'))}
 catch{toast(tr('Выделите и скопируйте адрес вручную'))}
};
document.addEventListener('keydown',e=>{
 if(e.defaultPrevented||e.key!=='Escape'||document.querySelector('dialog[open]'))return;
 if(walletMap&&!$('atlas-cities').hidden)showFavoriteCities(false,true);
 else if(placing)returnToComposer();
 else if(walletMap&&!$('detail').hidden)$('detail-close').click();
 else if(walletMap&&!atlasDocked&&!$('atlas-explorer').hidden)atlasExplorer(false,true);
});
function refreshMapConfig(){
 if(!mapConfigRequest)mapConfigRequest=api('/api/config',{signal:AbortSignal.timeout(8000)}).then(c=>{
  const first=mapConfigStatus!=='ready';
  config=c;
  mapConfigStatus='ready';
  if(!walletMap)$('network').textContent=c.paymentsEnabled?'Noticoin · 45 секунд / блок':'Карта без границ';
  setIconOptions();
  if(selected?.secretPriceAtomic)select(selected);
  if(first&&walletMap&&c.secretPaymentsEnabled)void syncPurchaseHistory();
 }).catch(()=>{
  mapConfigStatus='unavailable';
  config={...config,encryptedNotes:false,paymentsEnabled:false,secretPaymentsEnabled:false};
 }).finally(()=>{
  mapConfigRequest=null;
  syncComposer();
 });
 return mapConfigRequest;
}
void refreshMapConfig();
void keyPair().then(()=>{
 if(selected)select(selected);
 render();
}).catch(()=>{});
setInterval(()=>{
 if(document.hidden)return;
 if(selected?.expiresAt&&selected.expiresAt<=Date.now())dismissPoint();
 privatePins?.expire();
 if(!map?.isMoving())void load(true,true);
},30000);
init();
})();
