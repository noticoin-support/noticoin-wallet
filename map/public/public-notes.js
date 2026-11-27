'use strict';

(() => {
 const prefix='noticoin-public-note-v1.';
 const packet=/^noticoin-public-note-v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{39,2704}$/;
 const encoder=new TextEncoder();
 const decoder=new TextDecoder('utf-8',{fatal:true});
 const encode=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 const decode=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),character=>character.charCodeAt(0));
 const context=id=>encoder.encode(prefix+id);
 const valid=value=>typeof value==='string'&&packet.test(value);

 // The read key is intentionally public. Private and sold notes use separate keys.
 async function seal(id,body){
  if(typeof body!=='string'||!body.trim()||body.length>500)throw Error('Invalid public note');
  const raw=crypto.getRandomValues(new Uint8Array(32));
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:context(id)},key,encoder.encode(body)));
  return prefix+encode(raw)+'.'+encode([...iv,...cipher]);
 }

 async function open(id,value){
  if(!valid(value))throw Error('Invalid public note');
  const [raw,encoded]=value.slice(prefix.length).split('.');
  const bytes=decode(encoded);
  const key=await crypto.subtle.importKey('raw',decode(raw),'AES-GCM',false,['decrypt']);
  const body=decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData:context(id)},key,bytes.subarray(12)));
  if(!body.trim()||body.length>500)throw Error('Invalid public note');
  return body;
 }

 globalThis.NotiPublicNotes={valid,seal,open};
})();
