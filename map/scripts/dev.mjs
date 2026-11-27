import {createServer} from 'node:http';
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {handleApi} from '../server/api.mjs';
import {openMapDb} from '../server/local-db.mjs';
import {MAX_MAP_REQUEST_BYTES,notePolicies} from '../server/note-operators.mjs';
const root=path.resolve(import.meta.dirname,'..');mkdirSync(path.join(root,'data'),{recursive:true});
const DB=await openMapDb(path.join(root,'data'));
const env={DB,...process.env,notePolicies:notePolicies(process.env.NOTI_NOTE_OPERATORS,process.env.NOTI_NOTE_OPERATOR_EPOCHS,true)};const types={'.json':'application/json; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
const port=Number(process.env.PORT||5173);
createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1:'+port);
  if(url.pathname.startsWith('/api/')){
    const chunks=[];let length=0;
    for await(const chunk of req){length+=chunk.length;if(length>MAX_MAP_REQUEST_BYTES){res.writeHead(413);res.end();return}chunks.push(chunk);}
    const response=await handleApi(new Request(url,{method:req.method,headers:req.headers,...(length?{body:Buffer.concat(chunks)}:{})}),env);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  const name=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));const file=path.resolve(root,'public',name);
  if(!file.startsWith(path.join(root,'public')+path.sep)||!existsSync(file)){res.writeHead(404);res.end('Not found');return}
  res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':'no-cache'});res.end(readFileSync(file));
}catch(e){console.error(e);res.writeHead(500);res.end('Internal error')}}).listen(port,'127.0.0.1',()=>console.log('Noticoin map: http://127.0.0.1:'+port));
