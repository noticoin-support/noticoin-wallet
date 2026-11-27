import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {handleApi,NETWORK_VERSION} from '../server/api.mjs';
import {noticoinEnvironment} from '../server/environment.mjs';
import {openMapDb} from '../server/local-db.mjs';
import {MAX_MAP_REQUEST_BYTES,notePolicies} from '../server/note-operators.mjs';

const settings=noticoinEnvironment(process.env);
const origin=new URL(settings.NOTICOIN_MAP_PUBLIC_ORIGIN||'https://map.noticoin.com');
const data=settings.NOTICOIN_MAP_DATA;
const readOnly=settings.NOTICOIN_MAP_READ_ONLY==='1';
if(!data||origin.protocol!=='https:'||origin.href!==origin.origin+'/') throw Error('Set a map data directory and HTTPS origin');
if(!readOnly&&(settings.NOTICOIN_MAP_CHAIN_ANCHORS!=='1'||!settings.NOTICOIN_BRIDGE_URL||!settings.NOTICOIN_FUND_BRIDGE_TOKEN))
 throw Error('Public map writes require a Noticoin payment bridge and chain verification');
await mkdir(data,{recursive:true});
const DB=await openMapDb(data);
const env={...settings,DB,notePolicies:notePolicies(settings.NOTI_NOTE_OPERATORS,settings.NOTI_NOTE_OPERATOR_EPOCHS,true)};

function json(res,status,value){
 res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
 res.end(JSON.stringify(value));
}

const server=createServer({headersTimeout:6000,requestTimeout:15000,keepAliveTimeout:4000},async(req,res)=>{
 try{
  const url=new URL(req.url,origin);
  if(url.origin!==origin.origin) return json(res,400,{error:'Invalid request URL'});
  if(req.method==='GET'&&(url.pathname==='/health'||url.pathname==='/')){
   DB.sqlite.prepare('SELECT 1 FROM _local_migrations LIMIT 1').get();
   return json(res,200,{service:'noticoin-map',networkVersion:NETWORK_VERSION,readOnly});
  }
  if(!url.pathname.startsWith('/api/'))return json(res,404,{error:'Not found'});
  if(!['GET','HEAD','POST'].includes(req.method))return json(res,405,{error:'Method not allowed'});
  const chunks=[];
  let size=0;
  for await(const chunk of req){
   size+=chunk.length;
   if(size>MAX_MAP_REQUEST_BYTES)return json(res,413,{error:'Request too large'});
   chunks.push(chunk);
  }
  const request=new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'&&size?{body:Buffer.concat(chunks)}:{})});
  const response=await handleApi(request,env);
  res.writeHead(response.status,Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){
  if(!req.aborted)console.error('Noticoin map:',error.message);
  if(!res.headersSent)json(res,500,{error:'Map service unavailable'});
  else res.end();
 }
});
server.listen(Number(settings.PORT||5173),'127.0.0.1',()=>console.log('Noticoin map API listening on '+server.address().port));
process.once('SIGTERM',()=>server.close(()=>DB.sqlite.close()));
