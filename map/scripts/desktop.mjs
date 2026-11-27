import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,stat,rename,unlink,readdir} from 'node:fs/promises';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import path from 'node:path';
import {handleApi,NETWORK_VERSION,DECIMALS} from '../server/api.mjs';
import {openMapDb} from '../server/local-db.mjs';
import {noticoinEnvironment} from '../server/environment.mjs';
import {MAX_MAP_REQUEST_BYTES,notePolicies,publicNotePolicy} from '../server/note-operators.mjs';
import {atlasStyle} from './atlas-style.mjs';
import {withAtlasMaterials} from './atlas-materials.mjs';
import {openAtlas} from './tile-archive.mjs';

const root=path.resolve(import.meta.dirname,'..');
const atlasChrome=await readFile(path.join(import.meta.dirname,'atlas-chrome.html'),'utf8');
const atlasRenderer=withAtlasMaterials(await readFile(path.join(root,'public','maplibre-gl.js'),'utf8'));
const settings=noticoinEnvironment(process.env);
const language=['en','fr','de','zh','ja'].includes(settings.NOTICOIN_UI_LANG)?settings.NOTICOIN_UI_LANG:'en';
const loadLocale=async code=>JSON.parse(await readFile(path.join(import.meta.dirname,'atlas.'+code+'.json'),'utf8'));
const english=await loadLocale('en');
const dictionary=language==='en'?english:{...english,...await loadLocale(language)};
const light=settings.NOTICOIN_UI_THEME==='light';
const pinnedNotePolicies=notePolicies(process.env.NOTI_NOTE_OPERATOR_KEYS,process.env.NOTI_NOTE_OPERATOR_KEY_EPOCHS);
const data=path.resolve(settings.NOTICOIN_MAP_DATA||path.join(root,'data'));
// Existing Qt builds use this profile name for --regtest. Keep those wallets on their test map.
const regtest=path.basename(path.dirname(data)).toLowerCase()==='regtest-wallet';
const sharedOrigin=settings.NOTICOIN_MAP_API_ORIGIN??(regtest?'':'https://map.noticoin.com');
const sharedMap=sharedOrigin?new URL(sharedOrigin):null;
if(sharedMap&&(sharedMap.username||sharedMap.password||sharedMap.pathname!=='/'||sharedMap.search||sharedMap.hash||
  (sharedMap.protocol!=='https:'&&!(sharedMap.protocol==='http:'&&sharedMap.hostname==='127.0.0.1')))){
 throw new Error('NOTICOIN_MAP_API_ORIGIN must be an HTTPS origin or a local test origin');
}
let sharedNetworkCheck,sharedNetworkExpiresAt=0,sharedNetworkPending=false;
function compatibleSharedMap(refresh){
 if(sharedNetworkCheck&&(sharedNetworkPending||(!refresh&&Date.now()<sharedNetworkExpiresAt)))return sharedNetworkCheck;
 sharedNetworkPending=true;
 sharedNetworkCheck=fetch(new URL('/api/config',sharedMap),{redirect:'error',signal:AbortSignal.timeout(5000)})
  .then(async response=>{
   const config=response.ok&&await response.json();
   return config?.networkVersion===NETWORK_VERSION&&config.decimals===DECIMALS?config:null;
  }).catch(()=>null).then(config=>{
   sharedNetworkPending=false;
   sharedNetworkExpiresAt=Date.now()+(config?30000:2500);
   return config;
  });
 return sharedNetworkCheck;
}
const escapeHtml=value=>value.replace(/[&<>"]/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[character]));

function localizeAtlas(html,nonce){
 const translated=(value)=>Object.hasOwn(dictionary,value)?escapeHtml(dictionary[value]):value;
 return html.replace('lang="ru"','lang="'+language+'"')
  .replace(/>([^<>]+)</g,(_,value)=>'>'+translated(value)+'<')
  .replace(/\b(aria-label|title|placeholder)="([^"]*)"/g,(_,attribute,value)=>attribute+'="'+translated(value)+'"')
  .replace('</head>','<script nonce="'+nonce+'">window.NoticoinAtlasText='+JSON.stringify(dictionary).replaceAll('<','\\u003c')+';</script></head>');
}
await mkdir(data,{recursive:true});
const cacheDir=path.join(data,'tiles');await mkdir(cacheDir,{recursive:true});
const packsDir=path.join(data,'regions');await mkdir(packsDir,{recursive:true});
const atlasDir=path.join(root,'public','atlas');
const [worldArchive,tokyoArchive]=await Promise.all(['world','tokyo'].map(name=>
 openAtlas(path.join(atlasDir,name+'.pmtiles')).catch(error=>{
  console.error('Atlas archive '+name+': '+error.message);
  return null;
 })));
const regions=[];
let regionBytes=0,packing=false;
const maximumRegionStorage=384*1024*1024;
for(const name of (await readdir(packsDir)).filter(name=>/^region-[a-f0-9]{24}\.pmtiles$/.test(name)).slice(0,64)){
 const file=path.join(packsDir,name);
 const bytes=(await stat(file)).size;
 if(bytes>64*1024*1024||regionBytes+bytes>maximumRegionStorage)continue;
 const archive=await openAtlas(file).catch(error=>{
  console.error('Offline archive '+name+': '+error.message);
  return null;
 });
 if(archive){regions.push({name,archive});regionBytes+=bytes;}
}
const DB=await openMapDb(data);
const env={DB,...settings,notePolicies:notePolicies(process.env.NOTI_NOTE_OPERATORS,process.env.NOTI_NOTE_OPERATOR_EPOCHS,true)};
const types={'.json':'application/json; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.pbf':'application/x-protobuf','.pmtiles':'application/vnd.pmtiles','.txt':'text/plain; charset=utf-8'};
const jobs=new Map();
const index=DB.sqlite;
index.exec('CREATE TABLE IF NOT EXISTS desktop_tiles (key TEXT PRIMARY KEY, size INTEGER NOT NULL, accessed INTEGER NOT NULL)');
if(!index.prepare('PRAGMA table_info(desktop_tiles)').all().some(column=>column.name==='pinned')){
 index.exec('ALTER TABLE desktop_tiles ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
}
const maxCache=1024*1024*1024;
const maxPinned=384*1024*1024;
let cacheBytes=Number(index.prepare('SELECT COALESCE(SUM(size),0) AS n FROM desktop_tiles').get().n);
function rewrite(value){
 if(typeof value==='string'&&value.startsWith('https://tiles.openfreemap.org/'))return '/tiles/'+value.slice('https://tiles.openfreemap.org/'.length);
 if(Array.isArray(value))return value.map(rewrite);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v)]));
 return value;
}
class TileResponseError extends Error {
 constructor(status){super('Tile HTTP '+status);this.status=status;}
}
const cacheKey=value=>createHash('sha256').update(value).digest('hex');
async function readCachedTile(key){
 try{
  const bytes=await readFile(path.join(cacheDir,key));
  index.prepare('UPDATE desktop_tiles SET accessed=? WHERE key=?').run(Date.now(),key);
  return bytes;
 }catch{return null;}
}
async function storeTile(key,bytes){
 const file=path.join(cacheDir,key), temp=file+'.tmp';
 await writeFile(temp,bytes);
 await rename(temp,file);
 const previous=Number(index.prepare('SELECT size FROM desktop_tiles WHERE key=?').get(key)?.size||0);
 index.prepare('INSERT INTO desktop_tiles(key,size,accessed) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET size=excluded.size,accessed=excluded.accessed').run(key,bytes.length,Date.now());
 cacheBytes+=bytes.length-previous;
 if(cacheBytes<=maxCache)return;
 for(const old of index.prepare('SELECT key,size FROM desktop_tiles WHERE pinned=0 AND key<>? ORDER BY accessed ASC LIMIT 100').all(key)){
  const removed=index.prepare('DELETE FROM desktop_tiles WHERE key=? AND pinned=0').run(old.key);
  if(removed.changes){
   cacheBytes-=Number(old.size);
   await unlink(path.join(cacheDir,old.key)).catch(()=>{});
  }
  if(cacheBytes<=maxCache*.9)break;
 }
}
async function pinTile(key,bytes){
 let row=index.prepare('SELECT size,pinned FROM desktop_tiles WHERE key=?').get(key);
 if(row?.pinned)return;
 if(!row){
  await storeTile(key,bytes);
  row=index.prepare('SELECT size,pinned FROM desktop_tiles WHERE key=?').get(key);
 }
 const total=Number(index.prepare('SELECT COALESCE(SUM(size),0) AS n FROM desktop_tiles WHERE pinned=1').get().n);
 if(total+Number(row.size)>maxPinned)throw new TileResponseError(507);
 index.prepare('UPDATE desktop_tiles SET pinned=1 WHERE key=?').run(key);
}
async function tile(route,{refresh=false,timeout=15000,stableKey}={}){
 const target=new URL(route,'https://tiles.openfreemap.org/');
 if(target.origin!=='https://tiles.openfreemap.org'||target.username||target.password||target.search||target.hash||route.includes('..')||route.length>600)throw Error('Invalid tile');
 const oldKey=cacheKey(target.href),key=stableKey||oldKey;
 if(!refresh){
  const cached=await readCachedTile(key)||(stableKey&&await readCachedTile(oldKey));
  if(cached)return cached;
 }
 if(jobs.has(key))return jobs.get(key);
 const job=(async()=>{
  const response=await fetch(target,{redirect:'error',signal:AbortSignal.timeout(timeout),headers:{'user-agent':'Noticoin-Wallet/0.1.0'}});
  if(!response.ok)throw new TileResponseError(response.status);
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>8*1024*1024)throw Error('Tile too large');
  await storeTile(key,bytes);
  return bytes;
 })().finally(()=>jobs.delete(key));jobs.set(key,job);return job;
}
let streetMetadata,streetRefresh,lastMetadataCheck=0;
function parseStreetTemplate(bytes){
 const {tiles}=JSON.parse(bytes.toString('utf8'));
 const template=tiles?.[0];
 if(!/^https:\/\/tiles\.openfreemap\.org\/planet\/[a-zA-Z0-9_-]+\/\{z\}\/\{x\}\/\{y\}\.pbf$/.test(template))throw Error('Invalid OpenFreeMap template');
 return template;
}
function streetTemplate(){
 if(!streetMetadata){
  streetMetadata=tile('planet',{timeout:25000}).then(parseStreetTemplate)
   .catch(error=>{streetMetadata=null;throw error;});
 }
 return streetMetadata;
}
function refreshStreetTemplate(){
 if(streetRefresh)return streetRefresh;
 if(Date.now()-lastMetadataCheck<60000)return streetTemplate();
 lastMetadataCheck=Date.now();
 streetRefresh=tile('planet',{refresh:true,timeout:25000}).then(parseStreetTemplate).then(template=>{
  streetMetadata=Promise.resolve(template);
  return template;
 }).finally(()=>{streetRefresh=null;});
 return streetRefresh;
}
function tileCoordinates(pathname){
 const match=pathname.match(/^\/street\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.pbf$/);
 if(!match)return null;
 const [z,x,y]=match.slice(1).map(Number);
 return z>=4&&z<=14&&x<2**z&&y<2**z?{z,x,y}:null;
}
async function installedStreet(z,x,y){
 const tokyo=await tokyoArchive?.tile(z,x,y);
 if(tokyo)return tokyo;
 for(const region of regions){
  const bytes=await region.archive.tile(z,x,y);
  if(bytes)return bytes;
 }
 if(!tokyoArchive)return readFile(path.join(root,'public','tokyo',[z,x,y].join('-')+'.pbf')).catch(()=>null);
 return null;
}
async function streetTile(pathname,pin){
 const coordinates=tileCoordinates(pathname);
 if(!coordinates)return null;
 const {z,x,y}=coordinates;
 const packaged=await installedStreet(z,x,y);
 if(packaged)return packaged;
 const stableKey=cacheKey('street:'+z+'/'+x+'/'+y);
 const cached=await readCachedTile(stableKey);
 if(cached){
  if(pin)await pinTile(stableKey,cached);
  return cached;
 }
 const download=template=>{
  const route=template.replace('https://tiles.openfreemap.org/','').replace('{z}',z).replace('{x}',x).replace('{y}',y);
  return tile(route,{timeout:45000,stableKey});
 };
 const template=await streetTemplate();
 let bytes;
 try{bytes=await download(template);}
 catch(error){
  if(error.status!==404&&error.status!==410)throw error;
  const updated=await refreshStreetTemplate();
  if(updated===template)throw error;
  bytes=await download(updated);
 }
 if(pin)await pinTile(stableKey,bytes);
 return bytes;
}

function compressRegion(tiles,metadata){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./atlas-pack-worker.mjs',import.meta.url),{workerData:{tiles,metadata}});
  worker.once('message',message=>resolve(Buffer.from(message)));
  worker.once('error',reject);
  worker.once('exit',code=>{if(code!==0)reject(new Error('Could not pack offline region'));});
 });
}

async function saveRegion(request){
 if(packing)throw new TileResponseError(409);
 if(regions.length>=64||regionBytes>=maximumRegionStorage)throw new TileResponseError(507);
 packing=true;
 try{
  let body='';
  for await(const chunk of request){
   body+=chunk;
   if(body.length>8000)throw new TileResponseError(413);
  }
  const list=JSON.parse(body).tiles;
  if(!Array.isArray(list)||list.length===0||list.length>48||list.some(name=>typeof name!=='string'||!tileCoordinates(name)))
   throw new TileResponseError(400);
  const names=[...new Set(list)].sort();
  const name='region-'+cacheKey(names.join('\n')).slice(0,24)+'.pmtiles';
  if(regions.some(region=>region.name===name))return {name,tiles:names.length};
  const inputs=[];
  let contentBytes=0;
  for(const pathname of names){
   const {z,x,y}=tileCoordinates(pathname);
   const bytes=await installedStreet(z,x,y)||await readCachedTile(cacheKey('street:'+z+'/'+x+'/'+y));
   if(!bytes)throw new TileResponseError(409);
   contentBytes+=bytes.length;
   if(contentBytes>64*1024*1024)throw new TileResponseError(507);
   inputs.push({z,x,y,bytes});
  }
  const minZoom=Math.min(...inputs.map(tile=>tile.z));
  const maxZoom=Math.max(...inputs.map(tile=>tile.z));
  const block=await compressRegion(inputs,{name:'Noticoin Atlas region',minZoom,maxZoom,
   attribution:'© OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap'});
  if(regionBytes+block.length>maximumRegionStorage)throw new TileResponseError(507);
  const file=path.join(packsDir,name), temp=file+'.tmp';
  await writeFile(temp,block);
  await rename(temp,file);
  regions.push({name,archive:await openAtlas(file)});
  regionBytes+=block.length;
  return {name,tiles:names.length,bytes:block.length};
 }finally{packing=false;}
}

const server=createServer(async(req,res)=>{
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  if(req.headers.host!==new URL(origin).host){res.writeHead(403);res.end();return;}
  const url=new URL(req.url,origin);
  if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end();return;}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  if(url.pathname==='/desktop-health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,cacheBytes,regionBytes,world:!!worldArchive}));return;}
  if(url.pathname==='/atlas/region'){
   if(req.method!=='POST'){res.writeHead(405);res.end();return;}
   const region=await saveRegion(req);
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify(region));
   return;
  }
  if(url.pathname.startsWith('/atlas/world/')){
   const match=url.pathname.match(/^\/atlas\/world\/(\d)\/(\d{1,2})\/(\d{1,2})\.pbf$/);
   if(req.method!=='GET'||!match||!worldArchive){res.writeHead(404);res.end();return;}
   const [z,x,y]=match.slice(1).map(Number);
   if(z>6||x>=2**z||y>=2**z){res.writeHead(404);res.end();return;}
   const bytes=await worldArchive.tile(z,x,y);
   res.setHeader('content-type','application/x-protobuf');
   res.setHeader('cache-control','public,max-age=86400');
   res.end(bytes??Buffer.alloc(0));
   return;
  }
  if(url.pathname.startsWith('/street/')){
   if(req.method!=='GET'){res.writeHead(405);res.end();return;}
   const bytes=await streetTile(url.pathname,url.searchParams.get('save')==='1');
   if(!bytes){res.writeHead(404);res.end();return;}
   res.setHeader('content-type','application/x-protobuf');
   res.setHeader('cache-control','public,max-age=86400');
   res.end(bytes);return;
  }
  if(url.pathname.startsWith('/tiles/')){
   if(req.method!=='GET'){res.writeHead(405);res.end();return;}
   const route=url.pathname.slice(7);
   const packagedGlyph=route.match(/^fonts\/Noto%20Sans%20Regular\/(0-255|1024-1279)\.pbf$/);
   const bytes=(packagedGlyph&&await readFile(path.join(atlasDir,'glyph-'+packagedGlyph[1]+'.pbf')).catch(()=>null))||await tile(route);
   const isJson=route==='planet'||route.endsWith('.json');
   res.setHeader('content-type',isJson?'application/json':types[path.extname(route)]||'application/octet-stream');
   res.setHeader('cache-control','public,max-age=86400');
   res.end(isJson?JSON.stringify(rewrite(JSON.parse(bytes.toString('utf8')))):bytes);return;
  }
  if(url.pathname.startsWith('/api/')){
   const chunks=[];let length=0;
   for await(const chunk of req){length+=chunk.length;if(length>MAX_MAP_REQUEST_BYTES){res.writeHead(413);res.end();return;}chunks.push(chunk);}
   const body=Buffer.concat(chunks);
   const request={method:req.method,...(length?{body}:{})};
   const sharedRoute=/^\/api\/(?:config$|points(?:\/|$)|invoices\/|venues\/|secret-purchases(?:\/|$))/.test(url.pathname);
   const needsSharedApi=sharedMap&&sharedRoute;
   const readsSharedConfig=url.pathname==='/api/config'&&req.method==='GET';
   const sharedConfig=needsSharedApi?await compatibleSharedMap(readsSharedConfig):null;
   if(needsSharedApi&&!sharedConfig){
    res.writeHead(503,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    res.end(JSON.stringify({error:'Shared map is unavailable'}));
    return;
   }
   let result;
   if(needsSharedApi&&readsSharedConfig){
    result=Response.json(sharedConfig);
   }else if(needsSharedApi){
    result=await fetch(new URL(url.pathname+url.search,sharedMap),{
      ...request,headers:{'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)
    });
   }else result=await handleApi(new Request(url,{...request,headers:req.headers}),env);
   let bytes=Buffer.from(await result.arrayBuffer());
   if(sharedMap&&url.pathname==='/api/config'&&result.ok){
    const config=JSON.parse(bytes.toString('utf8'));
    if(!config.noteRegistry){
     const advertised=config.offlineNotePolicy??{height:0,threshold:2,keys:config.offlineNoteOperators??[]};
     const trusted=pinnedNotePolicies.find(policy=>policy.height===advertised.height&&policy.threshold===advertised.threshold&&
      policy.keys.length===advertised.keys?.length&&policy.keys.every((key,index)=>key===advertised.keys[index]));
     config.offlineNotePolicy=publicNotePolicy(trusted);
     config.offlineNoteOperators=trusted?.keys??[];
    }
    config.offlineNotePolicies=pinnedNotePolicies.map(publicNotePolicy);
    bytes=Buffer.from(JSON.stringify(config));
   }
   res.writeHead(result.status,{'content-type':result.headers.get('content-type')||'application/json; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff'});
   res.end(bytes);return;
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  const name=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
  const file=path.resolve(root,'public',name);
  if(!file.startsWith(path.join(root,'public')+path.sep)){res.writeHead(404);res.end();return;}
  let bytes=name==='maplibre-gl.js'?atlasRenderer:await readFile(file);
  if(name==='map-fast.json'||name==='map-detail.json')
   bytes=Buffer.from(JSON.stringify(atlasStyle(name==='map-detail.json',!!worldArchive,origin,url.searchParams.get('theme')==='light',language)));
  if(name==='index.html'){
   const nonce=randomBytes(16).toString('base64');
   res.setHeader('Content-Security-Policy',[
    "default-src 'none'","script-src 'self' 'nonce-"+nonce+"'","style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:","font-src 'self'","connect-src 'self'","worker-src 'self' blob:",
    "base-uri 'none'","frame-ancestors 'none'","form-action 'none'"
   ].join('; '));
   const html=bytes.toString('utf8');
   const canvasStart=html.indexOf('<div class="space"');
   const composerStart=html.indexOf('<dialog id="compose"');
   if(canvasStart<0||composerStart<canvasStart)throw new Error('Missing map template sections');
   bytes=Buffer.from(localizeAtlas((html.slice(0,canvasStart)+atlasChrome+html.slice(composerStart))
    .replace('<html lang="ru">','<html lang="ru" class="wallet-map'+(light?' atlas-light':'')+'">')
    .replace('<title>Noticoin — ты здесь</title>','<title>Noti Atlas</title>')
    .replace(/<meta name="description"[^>]*>/,'')
    .replace('<script defer src="/app.js?v=2">','<script defer src="/atlas-details.js"></script><script defer src="/atlas-reviews.js"></script><script defer src="/offline-notes.js"></script><script defer src="/private-pins.js"></script><script defer src="/private-pin-controls.js"></script><script defer src="/app.js?v=2">')
    .replace('<link rel="stylesheet" href="/notes.css">','<link rel="stylesheet" href="/desktop.css"><link rel="stylesheet" href="/notes.css">')
    .replace('в этом браузере','в этом кошельке')
    .replace('резервную копию браузера','резервную копию данных приложения')
    .replace('Браузер создаёт','Кошелёк создаёт'),nonce));
  }
  res.setHeader('content-type',types[path.extname(file)]||'application/octet-stream');res.setHeader('cache-control','no-cache');res.end(bytes);
 }catch(e){res.writeHead([400,409,413,507].includes(e.status)?e.status:e.code==='ENOENT'?404:503);res.end('Resource unavailable. Saved map areas remain available.');}
});
server.listen(Number(process.env.PORT||0),'127.0.0.1',()=>console.log('Noticoin desktop map: '+server.address().port));
