'use strict';
(() => {
 const day=86400000;
 const receiverPrefix='noti-recipient-v1.',legacyReceiverPrefix='\x6b\x6f\x6b\x6f-recipient-v1.';
 const pinPrefix='noti-pin-v1.',legacyPinPrefix='\x6b\x6f\x6b\x6f-pin-v1.';
 const context=new TextEncoder().encode(pinPrefix);
 const rsa={name:'RSA-OAEP',hash:'SHA-256'};
 const notePrefix='noticoin-note-v1.';
 const purchaseLabel=id=>new TextEncoder().encode('noti-purchased-note-v1:'+id);
 const aes={name:'AES-GCM',length:256};
 const unlockIterations=600000;
 const categories=new Set(['message','place','event','art','wifi','food','shop','work','transport']);

 function base64(bytes){
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 }
 function decode(code,prefix,limit){
  const text=code.trim();
  const encoded=text.slice(prefix.length);
  if(text.length>limit||!text.startsWith(prefix)||!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('Invalid code');
  return Uint8Array.from(atob(encoded.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
 }
 function newKeyPair(extractable=false){
  return crypto.subtle.generateKey({...rsa,modulusLength:3072,publicExponent:Uint8Array.of(1,0,1)},extractable,['wrapKey','unwrapKey']);
 }
 async function receiverCode(publicKey){
  return receiverPrefix+base64(new Uint8Array(await crypto.subtle.exportKey('spki',publicKey)));
 }
 async function recipientKey(code){
  const prefix=code.trim().startsWith(legacyReceiverPrefix)?legacyReceiverPrefix:receiverPrefix;
  const key=await crypto.subtle.importKey('spki',decode(code,prefix,700),rsa,false,['wrapKey']);
  if(key.algorithm.modulusLength!==3072||String(key.algorithm.publicExponent)!=='1,0,1')throw Error('Invalid key');
  return key;
 }

 function checkedPin(value){
  if(typeof value?.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)||
     typeof value.title!=='string'||value.title.trim().length<2||value.title.length>64||
     typeof value.body!=='string'||!value.body.trim()||value.body.length>500||
     !categories.has(value.category)||!Number.isFinite(value.lat)||Math.abs(value.lat)>85||
     !Number.isFinite(value.lng)||Math.abs(value.lng)>180||
     !Number.isSafeInteger(value.createdAt)||value.createdAt<0||value.createdAt>Date.now()+300000||
     value.expiresAt!==value.createdAt+7*day||
     (value.venueName!==undefined&&(typeof value.venueName!=='string'||value.venueName.length>128)))throw Error('Invalid pin');
  const {id,title,body,category,lat,lng,createdAt,expiresAt,venueName}=value;
  return {id,title,body,category,lat,lng,createdAt,expiresAt,...(venueName?{venueName}:{})};
 }
 const packetHeader=12+384;
 async function encryptPacket(value,publicKey,label){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await crypto.subtle.generateKey(aes,true,['encrypt']);
  const plaintext=new TextEncoder().encode(JSON.stringify(value));
  try{
   const [wrapped,encrypted]=await Promise.all([
    crypto.subtle.wrapKey('raw',key,publicKey,{name:'RSA-OAEP',label}),
    crypto.subtle.encrypt({name:aes.name,iv,additionalData:label},key,plaintext)
   ]);
   const packet=new Uint8Array(packetHeader+encrypted.byteLength);
   packet.set(iv);
   packet.set(new Uint8Array(wrapped),iv.length);
   packet.set(new Uint8Array(encrypted),packetHeader);
   return base64(packet);
  }finally{plaintext.fill(0)}
 }
 async function decryptPacket(packet,privateKey,label){
  if(packet.length<=packetHeader+16)throw Error('Invalid code');
  const key=await crypto.subtle.unwrapKey('raw',packet.subarray(12,packetHeader),privateKey,{name:'RSA-OAEP',label},aes,false,['decrypt']);
  const plaintext=new Uint8Array(await crypto.subtle.decrypt({name:aes.name,iv:packet.subarray(0,12),additionalData:label},key,packet.subarray(packetHeader)));
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext))}
  finally{plaintext.fill(0)}
 }
 async function seal(value,publicKey){
  return pinPrefix+await encryptPacket(checkedPin(value),publicKey,context);
 }
 async function unseal(code,privateKey){
  const prefix=code.trim().startsWith(legacyPinPrefix)?legacyPinPrefix:pinPrefix;
  const label=prefix===pinPrefix?context:new TextEncoder().encode(legacyPinPrefix);
  return checkedPin(await decryptPacket(decode(code,prefix,10000),privateKey,label));
 }

 async function sealNote(note,publicKey){
  const label=new TextEncoder().encode(notePrefix+note.id);
  return notePrefix+await encryptPacket({body:note.body,donationNote:note.donationNote||'',...(note.saleTerms?{saleTerms:note.saleTerms}:{})},publicKey,label);
 }
 async function openNote(id,code,privateKey){
  const label=new TextEncoder().encode(notePrefix+id);
  const {body,donationNote,saleTerms}=await decryptPacket(decode(code,notePrefix,6017),privateKey,label);
  if(typeof body!=='string'||body.length>500||typeof donationNote!=='string'||donationNote.length>140)throw Error('Invalid note');
  if(saleTerms&&(typeof saleTerms.address!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(saleTerms.address)||
    typeof saleTerms.amountAtomic!=='string'||!/^\d{1,19}$/.test(saleTerms.amountAtomic)))throw Error('Invalid sale terms');
  return {id,body,donationNote,...(saleTerms?{saleTerms}:{})};
 }
 async function recipientFingerprint(code){
  await recipientKey(code);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code)));
  return Array.from(digest.subarray(0,16),v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
 }

 async function passwordKey(passphrase,salt,usage){
  const password=new TextEncoder().encode(passphrase);
  let base;
  try{
   base=await crypto.subtle.importKey('raw',password,'PBKDF2',false,['deriveKey']);
  }finally{password.fill(0)}
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:unlockIterations},base,aes,false,[usage]);
 }
 function vaultCipher({iv,publicCode}){
  const domain=publicCode.startsWith(legacyReceiverPrefix)?'\x6b\x6f\x6b\x6f':'noti';
  return {name:aes.name,iv,additionalData:new TextEncoder().encode(domain+'-pin-vault-v1:'+publicCode)};
 }
 async function protectKeyPair(pair,passphrase){
  if(passphrase.length<16||passphrase.length>256)throw Error('Invalid passphrase length');
  const vault={version:1,publicCode:await receiverCode(pair.publicKey),
   salt:crypto.getRandomValues(new Uint8Array(16)),iv:crypto.getRandomValues(new Uint8Array(12))};
  const key=await passwordKey(passphrase,vault.salt,'wrapKey');
  vault.encryptedKey=await crypto.subtle.wrapKey('pkcs8',pair.privateKey,key,vaultCipher(vault));
  return vault;
 }
 async function openVault(vault,passphrase){
  if(vault.version!==1||passphrase.length>256||vault.salt.byteLength!==16||vault.iv.byteLength!==12)
   throw Error('Invalid vault');
  const key=await passwordKey(passphrase,vault.salt,'unwrapKey');
  const [privateKey,publicKey]=await Promise.all([
   crypto.subtle.unwrapKey('pkcs8',vault.encryptedKey,key,vaultCipher(vault),rsa,false,['unwrapKey']),
   recipientKey(vault.publicCode)
  ]);
  return {privateKey,publicKey,publicCode:vault.publicCode.replace(legacyReceiverPrefix,receiverPrefix)};
 }

 function database(){
  return new Promise((resolve,reject)=>{
   const req=indexedDB.open('\x6b\x6f\x6b\x6f-private-pins',3);
   req.onupgradeneeded=event=>{
    if(event.oldVersion===0){
     req.result.createObjectStore('profile');
     req.result.createObjectStore('pins',{keyPath:'id'});
    }
    if(event.oldVersion<3)req.result.createObjectStore('purchases',{keyPath:'id'});
   };
   req.onsuccess=()=>{
    req.result.onversionchange=()=>req.result.close();
    resolve(req.result);
   };
   req.onerror=()=>reject(req.error);
   req.onblocked=()=>reject(Error('Private pins database is blocked'));
  });
 }
 function transaction(db,name,mode,work){
  return new Promise((resolve,reject)=>{
   const tx=db.transaction(name,mode);
   const req=work(tx.objectStore(name));
   tx.oncomplete=()=>resolve(req?.result);
   tx.onabort=()=>reject(tx.error||Error('Private pins transaction failed'));
  });
 }

 function installVault(db,previous,vault,replacements){
  return new Promise((resolve,reject)=>{
   const tx=db.transaction(['profile','pins'],'readwrite');
   tx.oncomplete=()=>resolve();
   tx.onabort=()=>reject(tx.error||Error('The private pins changed during setup'));
   const profile=tx.objectStore('profile'),pins=tx.objectStore('pins');
   const existing=profile.get('vault');
   existing.onsuccess=()=>{
    if(existing.result){tx.abort();return}
    const records=pins.getAll();
    records.onsuccess=()=>{
     const latest=records.result;
     if(latest.length!==previous.length||latest.some((row,i)=>row.id!==previous[i].id||row.code!==previous[i].code)){
      tx.abort();
      return;
     }
     for(const row of replacements)pins.put(row);
     profile.add(vault,'vault');
     profile.delete('keys');
    };
   };
  });
 }
 function openRows(rows,privateKey){
  return Promise.all(rows.map(async row=>{
   const pin=await unseal(row.code,privateKey);
   if(pin.id!==row.id)throw Error('Invalid local pin');
   return pin;
  }));
 }
 async function open(){
  const db=await database();
  let session=null,lockVersion=0;
  const profile=key=>transaction(db,'profile','readonly',store=>store.get(key));
  const rows=()=>transaction(db,'pins','readonly',store=>store.getAll());
  const purchaseRow=id=>transaction(db,'purchases','readonly',store=>store.get(id));
  const purchaseSummary=({cipher,...summary})=>summary;
  function unlocked(expected=session){
   if(!expected||expected!==session)throw Error('Private pins are locked');
   return expected;
  }
  const display=pin=>({...pin,isPrivate:true,mode:'private',status:'private',icon:'default',votes:0});
  return {
   async state(){
    if(await profile('vault'))return 'locked';
    return await profile('keys')?'legacy':'new';
   },
   async unlock(passphrase,setup=false){
    const connected=lockVersion;
    const vault=await profile('vault');
    if(setup===!!vault)throw Error('Private pins setup has changed');
    let keys,pins;
    const saved=await rows();
    if(setup){
     const legacy=await profile('keys');
     if(saved.length&&!legacy?.privateKey)throw Error('Missing legacy map key');
     pins=saved.length?await openRows(saved,legacy.privateKey):[];
     const pair=await newKeyPair(true);
     const protectedVault=await protectKeyPair(pair,passphrase);
     keys=await openVault(protectedVault,passphrase);
     const migrated=await Promise.all(pins.map(async pin=>({id:pin.id,code:await seal(pin,keys.publicKey)})));
     await installVault(db,saved,protectedVault,migrated);
    }else{
     keys=await openVault(vault,passphrase);
     pins=await openRows(saved,keys.privateKey);
    }
    const now=Date.now();
    const expired=pins.filter(pin=>pin.expiresAt<=now);
    if(expired.length)await transaction(db,'pins','readwrite',store=>{
     for(const pin of expired)store.delete(pin.id);
    });
    if(connected!==lockVersion)throw Error('Private pins are locked');
    session=keys;
    return {receiving:keys.publicCode,pins:pins.filter(pin=>pin.expiresAt>now).map(display)};
   },
   lock(){session=null;lockVersion++},
   async encryptNote(note,recipient){
    const keys=unlocked();
    const packet=await sealNote(note,recipient?await recipientKey(recipient):keys.publicKey);
    unlocked(keys);
    return packet;
   },
   async decryptNote(id,packet){
    const keys=unlocked();
    const note=await openNote(id,packet,keys.privateKey);
    unlocked(keys);
    return note;
   },
   async purchaseIndex(){
    const records=await transaction(db,'purchases','readonly',store=>store.getAll());
    return records.map(purchaseSummary);
   },
   async savePurchase(item,receipt){
    const keys=unlocked();
    const existing=await purchaseRow(item.id);
    if(existing)return purchaseSummary(existing);
    const body=item.offline
     ?await NotiOfflineNotes.open(item.pointId,receipt.offer,receipt.delivery,item.id,keys.privateKey)
     :(await openNote(item.pointId,receipt.cipher,keys.privateKey)).body;
    if(typeof body!=='string'||body.length>500)throw Error('Invalid purchased note');
    const cipher=await encryptPacket({body},keys.publicKey,purchaseLabel(item.id));
    const record={id:item.id,pointId:item.pointId,title:item.title,amountAtomic:item.amountAtomic,paidAt:item.readUntil-day,cipher};
    unlocked(keys);
    const current=await transaction(db,'purchases','readwrite',store=>{
     const req=store.get(item.id);
     req.onsuccess=()=>{if(!req.result)store.add(record)};
     return req;
    });
    unlocked(keys);
    return purchaseSummary(current??record);
   },
   async readPurchase(id){
    const keys=unlocked();
    const row=await purchaseRow(id);
    if(!row?.cipher)return null;
    const note=await decryptPacket(decode(row.cipher,'',6017),keys.privateKey,purchaseLabel(id));
    unlocked(keys);
    return note;
   },
   async deletePurchase(id){
    unlocked();
    // Keep only the order ID so a remote history sync cannot restore the copy.
    await transaction(db,'purchases','readwrite',store=>store.put({id,deleted:true}));
   },
   async create(fields){
    const keys=unlocked();
    const createdAt=Date.now();
    const pin=checkedPin({...fields,id:crypto.randomUUID(),createdAt,expiresAt:createdAt+7*day});
    const code=await seal(pin,keys.publicKey);
    unlocked(keys);
    await transaction(db,'pins','readwrite',store=>store.add({id:pin.id,code}));
    unlocked(keys);
    return display(pin);
   },
   async share(pin,code){
    const keys=unlocked();
    if(pin.expiresAt<=Date.now())throw Error('Expired pin');
    const sealed=await seal(pin,await recipientKey(code));
    unlocked(keys);
    return sealed;
   },
   async import(code){
    const saved=code.trim();
    const keys=unlocked();
    const pin=await unseal(saved,keys.privateKey);
    if(pin.expiresAt<=Date.now())throw Error('Expired pin');
    unlocked(keys);
    const existing=await transaction(db,'pins','readwrite',store=>{
     const req=store.get(pin.id);
     req.onsuccess=()=>{if(!req.result)store.add({id:pin.id,code:saved})};
     return req;
    });
    const opened=existing?await unseal(existing.code,keys.privateKey):pin;
    unlocked(keys);
    return display(opened);
   },
   async remove(id){
    unlocked();
    await transaction(db,'pins','readwrite',store=>store.delete(id));
   }
  };
 }

 globalThis.NoticoinPrivatePins={open,newKeyPair,receiverCode,recipientKey,seal,unseal,protectKeyPair,openVault,sealNote,openNote,recipientFingerprint};
})();
