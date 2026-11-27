import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {createServer,request} from 'node:http';
const here=import.meta.dirname;
async function start(data,offline=false,language='en',theme='dark',shared=''){
 const child=spawn(process.execPath,['--import',pathToFileURL(path.join(here,'desktop-fetch-fixture.mjs')).href,path.join(here,'../scripts/desktop.mjs')],{env:{...process.env,PORT:'0',NOTICOIN_MAP_DATA:data,NOTICOIN_UI_LANG:language,NOTICOIN_UI_THEME:theme,NOTICOIN_MAP_API_ORIGIN:shared,NOTICOIN_TEST_OFFLINE:offline?'1':'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>errors+=part);
 for(let n=0;n<100;n++){const match=output.match(/Noticoin desktop map: (\d+)/);if(match)return{child,url:'http://127.0.0.1:'+match[1]};if(child.exitCode!==null)throw Error('Desktop server stopped: '+errors);await new Promise(r=>setTimeout(r,30));}
 child.kill();throw Error('Desktop server timeout');
}
async function stop(child){if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
test('Atlas loads the light palette locally and renders each supported interface language',async()=>{
 for(const [preference,code,favorites] of [['en','en','Favorite cities'],['fr','fr','Villes favorites'],['de','de','Favorisierte Städte'],['zh','zh','收藏城市'],['ja','ja','お気に入りの都市'],['ru','en','Favorite cities']]){
  const data=await mkdtemp(path.join(os.tmpdir(),'noticoin-atlas-language-'));
  let app;
  try{
   app=await start(data,true,preference,'light');
   const html=await (await fetch(app.url+'/')).text();
   assert.ok(html.includes('<html lang="'+code+'" class="wallet-map atlas-light">'));
   assert.ok(html.includes('<h2>'+favorites+'</h2>'));
   assert.doesNotMatch(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''),/\p{Script=Cyrillic}/u);
   if(preference!=='en')continue;
   const dark=await (await fetch(app.url+'/map-fast.json')).json();
   const light=await (await fetch(app.url+'/map-fast.json?theme=light')).json();
   assert.deepEqual(light.sources,dark.sources);
   assert.deepEqual(light.layers.map(layer=>layer.id),dark.layers.map(layer=>layer.id));
   assert.notDeepEqual(light.layers[0].paint,dark.layers[0].paint);
   const facade=light.layers.find(layer=>layer.id==='atlas-buildings-textured');
   assert.equal(facade.minzoom,17);
   assert.match(JSON.stringify(facade.paint['fill-extrusion-pattern']),/building-glass-light/);
   const signals=light.layers.find(layer=>layer.id==='atlas-traffic-signals');
   assert.equal(signals.minzoom,17);
   assert.equal(signals.type,'symbol');
   const points=await (await fetch(light.sources['traffic-signals'].data)).json();
   assert.equal(points.attribution,'OpenStreetMap contributors');
   assert.ok(points.features.length && points.features.every(p=>p.geometry.type==='Point'));
   assert.match(html,/<script defer src="\/atlas-details.js"><\/script>/);
   assert.match(html,/<script defer src="\/atlas-reviews.js"><\/script>/);
   assert.match(html,/<script defer src="\/map-icons.js"><\/script>/);
   assert.match(html,/<input type="radio" name="pin-visibility" value="private" id="private-pin">/);
   assert.match(html,/id="private-unlock-dialog"/);
   assert.match(html,/id="copy-map-coordinates"[^>]*aria-label="Copy coordinates"/);
   assert.match(html,/id="pin-category"[^>]*><button[^>]*><selectedcontent>/);
   assert.doesNotMatch(html,/id="atlas-credit"/);
   assert.match(html,/href="https:\/\/www\.openstreetmap\.org\/copyright"/);
   assert.match(html,/id="venue-dialog"/);
   const venues=light.layers.find(layer=>layer.id==='atlas-venues');
   assert.equal(venues.minzoom,15);
   assert.equal(venues['source-layer'],'poi');
   const buildings=await (await fetch(light.sources['named-buildings'].data)).json();
   assert.ok(buildings.features.length&&buildings.features.every(feature=>feature.properties.name));
   assert.match(html,/id="venue-add-note"/);
   assert.match(html,/id="accept-donations"/);
   assert.match(html,/id="secret-options"/);
   assert.match(html,/id="open-purchases"[^>]*>\s*<span>Purchased notes<\/span>/);
   assert.match(html,/<h3>Sold notes<\/h3>/);
   assert.match(html,/id="purchased-note-body"[^>]*hidden/);
   assert.match(html,/id="note-category-filter"[^>]*><button[^>]*><selectedcontent>/);
   assert.match(html,/id="private-pins-open"[^>]*aria-label="Receive a shared pin"/);
   const flags=await fetch(app.url+'/atlas/country-flags.svg');
   assert.equal(flags.headers.get('content-type'),'image/svg+xml');
   assert.match(await flags.text(),/<symbol[^>]*id="flag-jp"/);
   assert.match(JSON.stringify(venues.layout['icon-image']),/venue-coffee/);
   const backdrop=await fetch(app.url+'/atlas/silver-nebula.jpg');
   assert.equal(backdrop.headers.get('content-type'),'image/jpeg');
   assert.equal(Buffer.from(await backdrop.arrayBuffer()).subarray(0,3).toString('hex'),'ffd8ff');
  }finally{
   if(app)await stop(app.child);
   await rm(data,{recursive:true,force:true});
  }
 }
});
test('wallet Atlas can use a shared point API on top of local street tiles',async()=>{
 const data=await mkdtemp(path.join(os.tmpdir(),'noticoin-atlas-shared-'));
 const upstream=createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(req.url==='/api/config'?{networkVersion:'0.3.0',decimals:9}:{points:[{id:'shared',mode:'permanent'}],path:req.url}));
 });
 upstream.listen(0,'127.0.0.1');
 await once(upstream,'listening');
 let app;
 try{
  app=await start(data,false,'en','dark','http://127.0.0.1:'+upstream.address().port);
  const path='/api/points?category=wifi';
  const result=await (await fetch(app.url+path)).json();
  assert.equal(result.path,path);
  assert.equal(result.points[0].mode,'permanent');
  const reviews='/api/venues/omt-13/reviews';
  assert.equal((await (await fetch(app.url+reviews)).json()).path,reviews);
  const purchase='/api/secret-purchases/0132fc13-8610-4471-938c-c37c83e8100c';
  assert.equal((await (await fetch(app.url+purchase)).json()).path,purchase);
  const history='/api/secret-purchases';
  assert.equal((await (await fetch(app.url+history,{method:'POST',body:'{}'})).json()).path,history);
  assert.equal((await fetch(app.url+'/atlas/shibuya-signals.json')).status,200);
 }finally{
  if(app)await stop(app.child);
  await new Promise(resolve=>upstream.close(resolve));
  await rm(data,{recursive:true,force:true});
 }
});
test('native map persists tiles across restart and rejects foreign origins and hosts',async()=>{
 const data=await mkdtemp(path.join(os.tmpdir(),'noticoin-desktop-cache-'));let app;
 try{
  app=await start(data);
  const html=await (await fetch(app.url+'/')).text();
  assert.match(html,/<aside id="atlas-explorer"[^>]* hidden>/);
  assert.match(html,/<button id="atlas-layout"[^>]* aria-pressed="false"/);
  assert.match(html,/<button[^>]* id="atlas-city-toggle"[^>]* aria-controls="atlas-cities"/);
  assert.match(html,/<button id="map-quality"[^>]* aria-pressed="false"[^>]*>3D<\/button>/);
  assert.doesNotMatch(html,/id="locate"/);
  const style=await (await fetch(app.url+'/map-fast.json')).json();
  assert.equal(style.sources['world-vectors'].tiles[0],app.url+'/atlas/world/{z}/{x}/{y}.pbf');
  assert.equal(style.sources.openmaptiles.tiles[0],app.url+'/street/{z}/{x}/{y}.pbf');
  assert.ok(!style.layers.find(layer=>layer.id==='world-land').maxzoom);
  const buildings=style.layers.find(layer=>layer.id==='atlas-buildings-3d');
  assert.equal(buildings.type,'fill-extrusion');
  assert.equal(buildings['source-layer'],'building');
  assert.equal(buildings.layout.visibility,'none');
  const meta=await (await fetch(app.url+'/tiles/planet')).json();assert.match(meta.tiles[0],/^\/tiles\/planet\//);
  const first=await fetch(app.url+'/tiles/natural_earth/ne2sr/0/0/0.png');assert.deepEqual(new Uint8Array(await first.arrayBuffer()),new Uint8Array([1,2,3,4]));
  const street=await fetch(app.url+'/street/12/3600/1612.pbf?save=1');assert.equal(street.status,200);
  assert.equal((await fetch(app.url+'/street/12/3600/1614.pbf')).status,200);
  const region=await fetch(app.url+'/atlas/region',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({tiles:['/street/12/3600/1612.pbf']})});
  assert.equal(region.status,200);
  const {name,tiles}=await region.json();
  assert.equal(tiles,1);
  assert.deepEqual(await readdir(path.join(data,'regions')),[name]);
  assert.equal((await fetch(app.url+'/street/12/4096/1612.pbf')).status,404);
  assert.equal((await fetch(app.url+'/api/config',{headers:{origin:'https://untrusted.example'}})).status,403);
  const foreignHost=await new Promise((resolve,reject)=>{const req=request(app.url+'/',{headers:{host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end();});assert.equal(foreignHost,403);
  assert.equal((await fetch(app.url+'/tiles/https://untrusted.example/image.png')).status,503);
  assert.equal((await fetch(app.url+'/desktop-health')).status,200);
  await stop(app.child);app=await start(data,true);
  const cached=await fetch(app.url+'/tiles/natural_earth/ne2sr/0/0/0.png');assert.equal(cached.status,200);assert.equal((await cached.arrayBuffer()).byteLength,4);
  assert.equal((await fetch(app.url+'/tiles/natural_earth/ne2sr/1/0/0.png')).status,503);
  const cachedMeta=await (await fetch(app.url+'/tiles/planet')).json();assert.match(cachedMeta.tiles[0],/^\/tiles\//);
  assert.equal((await fetch(app.url+'/street/12/3600/1612.pbf')).status,200);
  assert.equal((await fetch(app.url+'/street/12/3600/1614.pbf')).status,200);
  assert.equal((await fetch(app.url+'/street/12/3600/1613.pbf')).status,503);
  const tokyo=await fetch(app.url+'/street/14/14549/6452.pbf');
  assert.equal(tokyo.status,200);
  assert.ok((await tokyo.arrayBuffer()).byteLength>10000);
  const world=await fetch(app.url+'/atlas/world/0/0/0.pbf');
  assert.equal(world.status,200);
  assert.ok((await world.arrayBuffer()).byteLength>10000);
  const globe=await fetch(app.url+'/atlas/globe.png');
  assert.equal(Buffer.from(await globe.arrayBuffer()).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const sky=await fetch(app.url+'/atlas/deep-space.jpg');
  assert.equal(sky.status,200);
  assert.equal(sky.headers.get('content-type'),'image/jpeg');
  assert.equal(Buffer.from(await sky.arrayBuffer()).subarray(0,3).toString('hex'),'ffd8ff');
  const glyph=await fetch(app.url+'/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf');
  assert.ok((await glyph.arrayBuffer()).byteLength>10000);
  for(let z=0;z<=2;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){
   const world=await fetch(app.url+'/world/'+z+'/'+x+'/'+y+'.png');
   assert.equal(world.status,200);
   const bytes=Buffer.from(await world.arrayBuffer());
   assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  }
  await stop(app.child);
  await rm(path.join(data,'tiles'),{recursive:true,force:true});
  await rm(path.join(data,'offline'),{recursive:true,force:true});
  app=await start(data,true,'en');
  const english=await (await fetch(app.url+'/')).text();
  assert.match(english,/<html lang="en" class="wallet-map">/);
  assert.match(english,/aria-label="Favorite cities"/);
  assert.match(english,/<h2>Favorite cities<\/h2>/);
  assert.equal((await fetch(app.url+'/street/12/3600/1614.pbf')).status,503);
  assert.equal((await fetch(app.url+'/street/12/3600/1612.pbf')).status,200);
 }finally{if(app)await stop(app.child);await rm(data,{recursive:true,force:true});}
});
