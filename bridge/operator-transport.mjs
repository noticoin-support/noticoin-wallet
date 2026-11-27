import {lookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {BlockList} from 'node:net';

const blocked=new BlockList();
for(const [address,bits] of [
 ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
 ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],
 ['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
])blocked.addSubnet(address,bits,'ipv4');

export async function requestNoteOperator(origin,network,operation,payload) {
 const url=new URL(origin);
 const local=network==='fakechain'&&url.protocol==='http:'&&url.hostname==='127.0.0.1';
 if(url.username||url.password||url.href!==url.origin+'/'||(!local&&url.protocol!=='https:')||
    !['health','release'].includes(operation))throw Error('Invalid registered operator endpoint');
 const record=local?{address:'127.0.0.1'}:await lookup(url.hostname,{family:4});
 if(!local&&blocked.check(record.address,'ipv4'))throw Error('Operator endpoint must resolve to a public address');
 const body=operation==='release'?JSON.stringify(payload):null;
 const signal=AbortSignal.timeout(6000);
 return new Promise((resolve,reject)=>{
  const send=local?httpRequest:httpsRequest;
  const request=send(new URL('/'+operation,url),{
   method:body?'POST':'GET',family:4,signal,agent:false,
   lookup(_hostname,_options,callback){callback(null,record.address,4);},
   ...(body?{headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}}:{})
  },response=>{
   if(response.statusCode!==200){response.resume();reject(Error('Registered operator declined the request'));return;}
   const chunks=[];let length=0;
   response.on('data',chunk=>{
    length+=chunk.length;
    if(length>8192)request.destroy(Error('Operator reply is too large'));
    else chunks.push(chunk);
   });
   response.on('error',reject);
   response.on('end',()=>{
    try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
    catch(error){reject(error);}
   });
  });
  request.on('error',reject);
  request.end(body);
 });
}
