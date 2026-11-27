import {createServer} from 'node:http';
import {generateKeyPairSync,createPrivateKey,createPublicKey,privateDecrypt,publicEncrypt,constants,timingSafeEqual,verify} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import '../public/offline-notes.js';
import {MAX_MAP_REQUEST_BYTES,notePolicies,notePolicyAt} from '../server/note-operators.mjs';
import {noticoinEnvironment} from '../server/environment.mjs';
import {startRegistration} from './note-registration.mjs';

const {pointId,label,policyMatches,publicationPolicyMatches,sharePositions,shareDigest}=globalThis.NotiOfflineNotes;
const policies=notePolicies(process.env.NOTI_NOTE_OPERATOR_KEYS,process.env.NOTI_NOTE_OPERATOR_KEY_EPOCHS);
const registry=process.env.NOTI_NOTE_REGISTRY==='1';
const data=path.resolve(process.env.NOTI_NOTE_OPERATOR_DATA);
const port=Number(process.env.NOTI_NOTE_OPERATOR_PORT);
const token=process.env.NOTI_NOTE_OPERATOR_TOKEN;
const settings=noticoinEnvironment(process.env);
const bridge=new URL(settings.NOTICOIN_BRIDGE_URL);
if(!Number.isInteger(port)||port<1||port>65535||(!registry&&! /^[a-f0-9]{64}$/.test(token))||
   (bridge.protocol!=='https:'&&!(bridge.protocol==='http:'&&bridge.hostname==='127.0.0.1')))
 throw Error('Invalid offline note operator configuration');
await mkdir(data,{recursive:true});
const keyFile=path.join(data,'operator.pem');
try {await readFile(keyFile);}
catch(error){
 if(error.code!=='ENOENT')throw error;
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:3072,publicExponent:65537});
 await writeFile(keyFile,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
}
const key=createPrivateKey(await readFile(keyFile));
const publicKey=createPublicKey(key).export({type:'spki',format:'der'}).toString('base64url');
const db=new DatabaseSync(path.join(data,'sales.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS issued(point TEXT, slot INTEGER, invoice TEXT, txid TEXT UNIQUE, recipient TEXT,
 PRIMARY KEY(point,slot));`);
const getIssued=db.prepare('SELECT * FROM issued WHERE point=? AND slot=?');
const insertIssued=db.prepare('INSERT OR IGNORE INTO issued VALUES(?,?,?,?,?)');
const oaep={padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'};
const auth=Buffer.from('Bearer '+token);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const txHash=/^[a-f0-9]{64}$/;

async function rpc(wallet,method,params) {
 const token=wallet==='fund'?settings.NOTICOIN_FUND_BRIDGE_TOKEN:settings.NOTICOIN_BRIDGE_TOKEN;
 const response=await fetch(new URL('/rpc',bridge),{
  method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},
  body:JSON.stringify({method,params,wallet}),redirect:'error',signal:AbortSignal.timeout(6000)
 });
 if(!response.ok)throw Error('Unverified blockchain transaction');
 return (await response.json()).result;
}

async function issue({index,offer,transaction,order}) {
 const id=await pointId(offer);
 const {slot,recipient,invoice,txid,proof}=order;
 if(!Number.isInteger(index)||index<0||offer.operators[index]!==publicKey||
    !Number.isInteger(slot)||slot<0||slot>=offer.addresses.length||
    !uuid.test(invoice)||!txHash.test(txid)||!txHash.test(transaction.txid)||
    !/^noti-recipient-v1\.[A-Za-z0-9_-]{563}$/.test(recipient)||
    typeof proof!=='string'||!/^OutProofV[12][1-9A-HJ-NP-Za-km-z]{16,4000}$/.test(proof)||
    typeof transaction.record!=='string'||!/^4e544d500101[a-f0-9]{224}$/.test(transaction.record)||
    transaction.record.slice(12,44)!==id.replaceAll('-',''))throw Error('Invalid note sale');
 const record=Buffer.from(transaction.record,'hex');
 const signer=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),record.subarray(22,54)]),format:'der',type:'spki'});
 if(!verify(null,record.subarray(0,54),signer,record.subarray(54)))throw Error('Invalid publication signature');
 const buyer=createPublicKey({key:Buffer.from(recipient.split('.')[1],'base64url'),type:'spki',format:'der'});
 if(buyer.asymmetricKeyType!=='rsa'||buyer.asymmetricKeyDetails.modulusLength!==3072||buyer.asymmetricKeyDetails.publicExponent!==65537n)
  throw Error('Invalid note recipient');
 const [anchor,payment]=await Promise.all([
  rpc('fund','check_anchor',{txid:transaction.txid,record:transaction.record}),
  rpc('legacy','check_tx_proof',{txid,address:offer.addresses[slot],message:['noti-note-v2',invoice,id,recipient].join(':'),signature:proof}),
 ]);
 if(!anchor.found||!anchor.matches||anchor.confirmations<3||
    !payment.good||payment.in_pool||payment.confirmations<3||payment.unlockedOutput!==true||
    BigInt(payment.received)<BigInt(offer.amountAtomic))throw Error('Note payment is not confirmed');
 if(registry){
  const current=await rpc('fund','note_registry_roster',{height:anchor.blockHeight});
  const policy={height:current.epoch,threshold:current.threshold,keys:current.operators?.map(operator=>operator.key)??[],registry:true};
  if(!publicationPolicyMatches(offer,policy))throw Error('Note policy is invalid for the publication block');
 }else if((policies.length&&!policyMatches(offer,notePolicyAt(policies,anchor.blockHeight)))||
    (!policies.length&&offer.epoch!==undefined))throw Error('Note policy is invalid for the publication block');
 const packets=await Promise.all(offer.custody[index].map(async(packet,offset)=>{
  const position=sharePositions(offer,index)[offset];
  const bytes=privateDecrypt({...oaep,key,oaepLabel:label('custody',offer.nonce,index,position)},Buffer.from(packet,'base64url'));
  try {
   if(bytes.length!==32||offer.epoch!==undefined&&await shareDigest(offer.nonce,index,bytes)!==offer.shareHashes[index])
    throw Error('Invalid encryption share');
   return publicEncrypt({...oaep,key:buyer,oaepLabel:label('delivery',id,invoice,index,position)},bytes).toString('base64url');
  } finally {bytes.fill(0);}
 }));
 insertIssued.run(id,slot,invoice,txid,recipient);
 const allowed=getIssued.get(id,slot);
 if(allowed?.invoice!==invoice||allowed.txid!==txid||allowed.recipient!==recipient)throw Error('This copy was already sold');
 return packets;
}

const send=(res,status,value)=>{
 res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
 res.end(JSON.stringify(value));
};
createServer(async(req,res)=>{
 if(req.method==='GET'&&req.url==='/health')return send(res,200,{key:publicKey});
 if(req.method!=='POST'||req.url!=='/release')return send(res,404,{error:'Not found'});
 const candidate=Buffer.from(req.headers.authorization||'');
 if(!registry&&(candidate.length!==auth.length||!timingSafeEqual(candidate,auth)))return send(res,403,{error:'Forbidden'});
 try {
  const chunks=[];let length=0;
  for await(const chunk of req){
   length+=chunk.length;
   if(length>MAX_MAP_REQUEST_BYTES)return send(res,413,{error:'Request too large'});
   chunks.push(chunk);
  }
  send(res,200,await issue(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
 }catch {send(res,409,{error:'Note release unavailable'});}
}).listen(port,'127.0.0.1',()=>console.log('Noti note operator ready on loopback '+port));
if(registry&&process.env.NOTI_NOTE_OPERATOR_URL)await startRegistration({
 data,key:publicKey,roster:()=>rpc('fund','note_registry_roster',{}),
 registrationStatus:async txid=>(await rpc('fund','note_registration_status',{txid})).found,
});
