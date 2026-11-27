import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'dist/server');await mkdir(out,{recursive:true});
const types={'.json':'application/json; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
const assets={};
for(const entry of await readdir(path.join(root,'public'),{withFileTypes:true})){
 if(!entry.isFile())continue;
 const {name}=entry;
 const extension=path.extname(name);
 const binary=extension==='.png';
 const body=await readFile(path.join(root,'public',name),binary?'base64':'utf8');
 assets['/'+name]={body,type:types[extension]||'text/plain',binary};
}
if(!assets['/maplibre-gl.js']||assets['/maplibre-gl.js'].body.length<500000)throw Error('MapLibre vendor bundle is missing');
const modules=await Promise.all(['public/offline-notes.js','public/pin-catalog.js','public/public-notes.js','server/note-operators.mjs','server/environment.mjs','server/api.mjs'].map(async file=>
 (await readFile(path.join(root,file),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')));
await writeFile(path.join(out,'index.js'),modules.join('\n')+'\nconst assets='+JSON.stringify(assets)+';\n'+`
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname.startsWith("/api/"))return handleApi(request,{...env,notePolicies:notePolicies(env.NOTI_NOTE_OPERATORS,env.NOTI_NOTE_OPERATOR_EPOCHS,true)});
  const asset=assets[url.pathname==="/"?"/index.html":url.pathname];
  if(!asset)return new Response("Not found",{status:404});
  const body=asset.binary?Uint8Array.from(atob(asset.body),character=>character.charCodeAt(0)):asset.body;
  return new Response(body,{headers:{"content-type":asset.type,"x-content-type-options":"nosniff",
   "referrer-policy":"strict-origin-when-cross-origin","cache-control":url.pathname==="/"?"no-cache":"public,max-age=3600"}});
 },
};
`);
try {
 const hosting=await readFile(path.join(root,'.openai/hosting.json'));
 await mkdir(path.join(root,'dist/.openai'),{recursive:true});
 await writeFile(path.join(root,'dist/.openai/hosting.json'),hosting);
} catch(error) { if(error.code!=='ENOENT')throw error; }
console.log('Built Noticoin Worker and '+Object.keys(assets).length+' assets.');
