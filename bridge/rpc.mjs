import {createHash,randomBytes} from 'node:crypto';
import {request as httpRequest,Agent} from 'node:http';
const md5 = value => createHash('md5').update(value).digest('hex');

// Node 24 exposes the original JSON token: atomic uint64 amounts never pass
// through a rounded JavaScript number on their way from wallet to application.
export function parseExact(text) {
  return JSON.parse(text,(key,value,context)=>{
    if(typeof value==='number' && /^-?\d+$/.test(context.source||'') && !Number.isSafeInteger(value)) return context.source;
    return value;
  });
}
export function digestAuthorization(challenge,{username,password,method,uri,cnonce=randomBytes(16).toString('hex'),nc='00000001'}) {
  if(!/^Digest\s/i.test(challenge)) throw Error('Wallet RPC must use Digest authentication');
  const fields={};for(const match of challenge.slice(7).matchAll(/(\w+)=(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g)) fields[match[1]]=match[2]??match[3];
  const {realm,nonce,opaque}=fields, algorithm=fields.algorithm||'MD5';
  if(!realm||!nonce||!['MD5','MD5-sess'].includes(algorithm)) throw Error('Unsupported RPC Digest challenge');
  const qop=fields.qop?.split(',').map(v=>v.trim()).includes('auth')?'auth':undefined;
  if(fields.qop&&!qop)throw Error('RPC requires unsupported Digest qop');
  let ha1=md5(`${username}:${realm}:${password}`);if(algorithm==='MD5-sess')ha1=md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2=md5(`${method}:${uri}`),response=md5(qop?`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`:`${ha1}:${nonce}:${ha2}`);
  const quoted=value=>'"'+String(value).replace(/["\\]/g,'\\$&')+'"';
  return 'Digest '+[['username',username],['realm',realm],['nonce',nonce],['uri',uri],['response',response],...(opaque?[['opaque',opaque]]:[])].map(([k,v])=>k+'='+quoted(v)).join(', ')+`, algorithm=${algorithm}`+(qop?`, qop=auth, nc=${nc}, cnonce=${quoted(cnonce)}`:'');
}
export function localEndpoint(value,label) {
  const url=new URL(value);
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password) throw Error(label+' must be an HTTP loopback endpoint');
  return url;
}
export function walletClient({url,username,password}) {
  const endpoint=new URL('/json_rpc',localEndpoint(url,'Wallet RPC'));
  if(!username||!password)throw Error('Set NOTICOIN_WALLET_USER and NOTICOIN_WALLET_PASSWORD');
  // The upstream server keeps Digest nonces per TCP connection. One keep-alive
  // socket and a serialized challenge/retry pair prevent a pool from changing
  // sockets between the 401 response and the authenticated request.
  const agent=new Agent({keepAlive:true,maxSockets:1,maxFreeSockets:1});let queue=Promise.resolve();
  const send=(body,authorization)=>new Promise((resolve,reject)=>{
    const req=httpRequest(endpoint,{agent,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...(authorization?{authorization}:{})},signal:AbortSignal.timeout(20000)},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;if(text.length>8000000)req.destroy(Error('Wallet RPC response too large'));});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body);
  });
  const call=async(method,params)=>{
    const body=JSON.stringify({jsonrpc:'2.0',id:'noticoin',method,params});let response=await send(body);
    if(response.status===401){let challenge=response.headers['www-authenticate'];if(Array.isArray(challenge))challenge=challenge[0];else challenge=(challenge||'').split(/,\s*(?=Digest\s)/i)[0];const authorization=digestAuthorization(challenge,{username,password,method:'POST',uri:endpoint.pathname});response=await send(body,authorization);}
    if(response.status!==200)throw Error('Wallet RPC HTTP '+response.status);
    const data=parseExact(response.text);
    if(data.error)throw Object.assign(Error('Wallet RPC '+data.error.code+': '+data.error.message),{rpcCode:data.error.code});
    if(!data.result||typeof data.result!=='object')throw Error('Wallet RPC returned an invalid result');
    return data.result;
  };
  return(method,params={})=>{const next=queue.then(()=>call(method,params));queue=next.catch(()=>{});return next;};
}
