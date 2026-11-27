'use strict';
(() => {
 const text = new TextEncoder(), rsa = {name:'RSA-OAEP',hash:'SHA-256'}, aes = {name:'AES-GCM',length:256};
 const addressFormat = /^[1-9A-HJ-NP-Za-km-z]{95,106}$/;
 const keyFormat = /^[A-Za-z0-9_-]{563}$/;
 const packetFormat = /^[A-Za-z0-9_-]{512}$/;
 const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 const decode = value => Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),character=>character.charCodeAt(0));
 const label = (...parts) => text.encode(JSON.stringify(['noti-offline-note-v1',...parts]));
 const hex = data => Array.from(data,byte=>byte.toString(16).padStart(2,'0')).join('');
 const xor = (a,b) => a.map((byte,index)=>byte^b[index]);
 const MAX_OPERATORS=32;

 // Shamir shares use the AES field GF(256) and x coordinates 1 through n.
 function multiply(a,b) {
  let product=0;
  for(let bit=0;bit<8;bit++){
   if(b&1)product^=a;
   a=(a<<1)^((a&128)?0x11b:0);
   b>>=1;
  }
  return product;
 }
 function inverse(a) {
  let result=1;
  for(let exponent=254;exponent;exponent>>=1){
   if(exponent&1)result=multiply(result,a);
   a=multiply(a,a);
  }
  return result;
 }
 function split(secret,count,threshold) {
  const coefficients=crypto.getRandomValues(new Uint8Array(secret.length*(threshold-1)));
  try {
   return Array.from({length:count},(_,index)=>secret.map((byte,position)=>{
    let value=0;
    for(let term=threshold-2;term>=0;term--)
     value=multiply(value,index+1)^coefficients[position*(threshold-1)+term];
    return multiply(value,index+1)^byte;
   }));
  } finally {coefficients.fill(0);}
 }
 function reconstruct(shares,threshold) {
  const entries=[...shares].slice(0,threshold);
  const secret=new Uint8Array(32);
  for(const [position,share] of entries){
   let weight=1;
   for(const [other] of entries){
    if(other!==position)weight=multiply(weight,multiply(other+1,inverse((position+1)^(other+1))));
   }
   for(let i=0;i<secret.length;i++)secret[i]^=multiply(share[i],weight);
  }
  return secret;
 }
 const sharePositions=(offer,index)=>offer.epoch===undefined?[index,(index+1)%3]:[index];
 const quorum=offer=>offer.threshold??2;
 const matchingPolicy=(offer,policy)=>!!policy&&!!offer.registry===!!policy.registry&&quorum(offer)===policy.threshold&&
  offer.operators.length===policy.keys.length;
 const policyMatches=(offer,policy)=>matchingPolicy(offer,policy)&&(offer.epoch??0)===policy.height&&
  offer.operators.every((key,index)=>key===policy.keys[index]);
 function publicationPolicyMatches(offer,policy) {
  if(!offer.registry)return policyMatches(offer,policy);
  if(!matchingPolicy(offer,policy)||!(offer.epoch<=policy.height))return false;
  // Registry rank can change after a renewal. Shares retain the indexes of the original roster.
  const current=new Set(policy.keys);
  return current.size===policy.keys.length&&new Set(offer.operators).size===current.size&&offer.operators.every(key=>current.has(key));
 }
 async function shareDigest(nonce,index,share) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',label('share',nonce,index,encode(share)))));
 }

 async function pointId(offer) {
  const {nonce,addresses,amountAtomic,operators,ciphertext,custody,epoch,threshold,shareHashes,registry}=offer;
  const revised=epoch!==undefined;
  if(!/^[a-f0-9]{32}$/.test(nonce)||typeof amountAtomic!=='string'||!/^\d{8,16}$/.test(amountAtomic)||
     !Array.isArray(addresses)||addresses.length<1||addresses.length>100||new Set(addresses).size!==addresses.length||
     !addresses.every(address=>typeof address==='string'&&addressFormat.test(address))||
     !Array.isArray(operators)||new Set(operators).size!==operators.length||!operators.every(key=>typeof key==='string'&&keyFormat.test(key))||
     (registry!==undefined&&(registry!==true||!revised))||
     (revised?(!Number.isSafeInteger(epoch)||epoch<1||operators.length>MAX_OPERATORS||!Number.isInteger(threshold)||
       threshold<2||threshold>operators.length||!Array.isArray(shareHashes)||shareHashes.length!==operators.length||
       !shareHashes.every(hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash))):
       (operators.length!==3||threshold!==undefined||shareHashes!==undefined))||
     typeof ciphertext!=='string'||!/^[A-Za-z0-9_-]{39,3500}$/.test(ciphertext)||
     !Array.isArray(custody)||custody.length!==operators.length||!custody.every(pair=>Array.isArray(pair)&&pair.length===(revised?1:2)&&
      pair.every(packet=>typeof packet==='string'&&packetFormat.test(packet))))throw Error('Invalid encrypted note offer');
  const terms=[nonce,addresses,amountAtomic,operators,ciphertext,custody];
  if(revised)terms.push(epoch,threshold,shareHashes);
  if(registry)terms.push(true);
  const hash=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',label(...terms))));
  return hash.slice(0,32).replace(/^(........)(....)(....)(....)(............)$/,'$1-$2-$3-$4-$5');
 }

 async function prepare(body,amountAtomic,addresses,policy) {
  const {keys:operators,height:epoch,threshold,registry}=Array.isArray(policy)?{keys:policy,height:0,threshold:2}:policy;
  const nonce=hex(crypto.getRandomValues(new Uint8Array(16))), iv=crypto.getRandomValues(new Uint8Array(12));
  const raw=crypto.getRandomValues(new Uint8Array(32));
  const metadata=epoch>0?{epoch,threshold,...(registry?{registry:true}:{})}:{};
  let shares;
  if(epoch>0)shares=split(raw,operators.length,threshold);
  else {
   const first=crypto.getRandomValues(new Uint8Array(32)), second=crypto.getRandomValues(new Uint8Array(32));
   shares=[first,second,xor(xor(raw,first),second)];
  }
  const plaintext=text.encode(body);
  try {
   const contentKey=await crypto.subtle.importKey('raw',raw,aes,false,['encrypt']);
   const ciphertext=encode([...iv,...new Uint8Array(await crypto.subtle.encrypt(
    {name:aes.name,iv,additionalData:label('body',nonce)},contentKey,plaintext))]);
   const custody=await Promise.all(operators.map(async(spki,index)=>{
    const operator=await crypto.subtle.importKey('spki',decode(spki),rsa,false,['wrapKey']);
    return Promise.all(sharePositions(metadata,index).map(async position=>{
     const key=await crypto.subtle.importKey('raw',shares[position],aes,true,['encrypt']);
     return encode(new Uint8Array(await crypto.subtle.wrapKey('raw',key,operator,
      {name:rsa.name,label:label('custody',nonce,index,position)})));
    }));
   }));
   const offer={nonce,addresses,amountAtomic,operators,ciphertext,custody,...metadata};
   if(epoch>0)offer.shareHashes=await Promise.all(shares.map((share,index)=>shareDigest(nonce,index,share)));
   return {id:await pointId(offer),offer};
  } finally {
   raw.fill(0);
   plaintext.fill(0);
   for(const share of shares)share.fill(0);
  }
 }

 async function open(id,offer,delivery,orderId,privateKey) {
  if(await pointId(offer)!==id||!Array.isArray(delivery))throw Error('Invalid note delivery');
  const shares=new Map();
  try {
   for(const {index,packets} of delivery){
    if(!Number.isInteger(index)||index<0||index>=offer.operators.length||
       !Array.isArray(packets)||packets.length!==sharePositions(offer,index).length)throw Error('Invalid note delivery');
    for(const [offset,packet] of packets.entries()){
     const position=sharePositions(offer,index)[offset];
     let key;
     try {key=await crypto.subtle.unwrapKey('raw',decode(packet),privateKey,
      {name:rsa.name,label:label('delivery',id,orderId,index,position)},aes,true,['encrypt']);
     }catch(error){if(offer.epoch===undefined)throw error;continue;}
     const share=new Uint8Array(await crypto.subtle.exportKey('raw',key));
     if(offer.epoch!==undefined&&await shareDigest(offer.nonce,index,share)!==offer.shareHashes[index]){
      share.fill(0);
      continue;
     }
     if(shares.has(position)){
      const same=shares.get(position).every((byte,i)=>byte===share[i]);
      share.fill(0);
      if(!same)throw Error('Inconsistent note delivery');
     }else shares.set(position,share);
    }
   }
   if(shares.size<(offer.epoch===undefined?3:quorum(offer)))throw Error('Insufficient note shares');
   const raw=offer.epoch===undefined?xor(xor(shares.get(0),shares.get(1)),shares.get(2)):reconstruct(shares,quorum(offer));
   try {
    const key=await crypto.subtle.importKey('raw',raw,aes,false,['decrypt']);
    const packet=decode(offer.ciphertext);
    const plaintext=new Uint8Array(await crypto.subtle.decrypt(
     {name:aes.name,iv:packet.subarray(0,12),additionalData:label('body',offer.nonce)},key,packet.subarray(12)));
    try {return new TextDecoder('utf-8',{fatal:true}).decode(plaintext);}
    finally {plaintext.fill(0);}
   } finally {raw.fill(0);}
  } finally {
   for(const share of shares.values())share.fill(0);
  }
 }

 globalThis.NotiOfflineNotes={prepare,pointId,open,label,MAX_OPERATORS,quorum,policyMatches,publicationPolicyMatches,sharePositions,shareDigest};
})();
