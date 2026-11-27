'use strict';
(() => {
 function connect({byId,make,tr,onChange,onLock,select}){
  const store=NoticoinPrivatePins.open();
  const pins=new Map();
  const inbox=byId('private-pins-dialog'),shareDialog=byId('private-share-dialog');
  const inboxStatus=byId('private-pins-status'),shareStatus=byId('private-share-status');
  const receiving=byId('private-receive-code'),copyReceiving=byId('copy-private-receive');
  const openButton=byId('private-pins-open');
  const unlockDialog=byId('private-unlock-dialog'),unlockStatus=byId('private-unlock-status');
  const unlockButton=byId('private-unlock-button'),unlockClose=byId('private-unlock-close');
  const passphrase=byId('private-passphrase'),confirmPhrase=byId('private-passphrase-confirm');
  const native=window.chrome?.webview;
  const idleTime=10*60*1000;
  let sharing,copyStatus,active,unlockTask,completeUnlock,setup,lockTimer,lockDeadline,unlockGeneration=0;
  let walletUnlockTask,receiveWalletSecret;
  let needsOldPhrase=false;

  function items(){
   const now=Date.now();
   return [...pins.values()].filter(pin=>pin.expiresAt>now);
  }
  function refresh(){
   const list=byId('private-pins-list');
   list.replaceChildren();
   const active=items().sort((a,b)=>b.createdAt-a.createdAt);
   for(const pin of active){
    const button=make('button','place-note',pin.title);
    button.type='button';
    button.append(NoticoinMapIcons.element('lock-keyhole'));
    button.onclick=()=>{inbox.close();select(pin)};
    list.append(button);
   }
   if(!active.length)list.append(make('p','small-note',tr('Закрытых меток пока нет')));
   onChange();
  }
  store.catch(()=>{
   byId('private-pin').disabled=true;
   openButton.disabled=true;
  });

  function lock(){
   if(!active&&!unlockDialog.open&&!walletUnlockTask)return;
   unlockGeneration++;
   active?.lock();
   active=null;
   clearTimeout(lockTimer);
   pins.clear();
   receiving.value='';
   copyReceiving.disabled=true;
   sharing=undefined;
   for(const field of ['private-import-code','private-recipient-code','private-share-code'])byId(field).value='';
   if(inbox.open)inbox.close();
   if(shareDialog.open)shareDialog.close();
   if(unlockDialog.open)unlockDialog.close();
   onLock();
   refresh();
  }
  function checkIdle(){
   if(active&&Date.now()>=lockDeadline)lock();
  }
  function armLock(){
   clearTimeout(lockTimer);
   lockDeadline=Date.now()+idleTime;
   lockTimer=setTimeout(lock,idleTime);
  }
  for(const trigger of ['pointerdown','keydown'])document.addEventListener(trigger,()=>{
   checkIdle();
   if(active)armLock();
  },true);
  document.addEventListener('visibilitychange',checkIdle);
  window.addEventListener('pagehide',lock);
  byId('private-lock').onclick=lock;

  function activate(db,unlocked){
   active=db;
   armLock();
   pins.clear();
   for(const pin of unlocked.pins)pins.set(pin.id,pin);
   receiving.value=unlocked.receiving;
   copyReceiving.disabled=false;
   refresh();
   return db;
  }
  function walletUnlock(){
   if(active||!native||needsOldPhrase)return Promise.resolve(active);
   if(!walletUnlockTask){
    const generation=unlockGeneration;
    walletUnlockTask=(async()=>{
     const secret=await new Promise(resolve=>{
      const timeout=setTimeout(()=>receiveWalletSecret?.(''),2000);
      receiveWalletSecret=value=>{clearTimeout(timeout);receiveWalletSecret=null;resolve(value)};
      native.postMessage('note-vault-request');
     });
     if(!secret||generation!==unlockGeneration)return null;
     const db=await store,state=await db.state();
     let unlocked;
     try{unlocked=await db.unlock(secret,state!=='locked');}
     catch(error){if(state==='locked')needsOldPhrase=true;else throw error;return null;}
     if(generation!==unlockGeneration){db.lock();return null;}
     return activate(db,unlocked);
    })().finally(()=>{walletUnlockTask=null});
   }
   return walletUnlockTask;
  }

  function setUnlockForm(state){
   setup=state!=='locked';
   byId('private-setup-hint').hidden=!setup;
   byId('private-upgrade-hint').hidden=state!=='legacy';
   byId('private-confirm-fields').hidden=!setup;
   confirmPhrase.required=setup;
   passphrase.autocomplete=setup?'new-password':'current-password';
   passphrase.type='password';
   unlockButton.textContent=tr(setup?'Включить защиту':'Разблокировать');
  }
  function ensureUnlocked(){
   checkIdle();
   if(active)return Promise.resolve(active);
   if(!unlockTask){
    unlockTask=(async()=>{
     const unlocked=await walletUnlock();
     if(unlocked)return unlocked;
     const db=await store;
     setUnlockForm(await db.state());
     unlockStatus.textContent='';
     unlockDialog.showModal();
     passphrase.focus();
     return new Promise(resolve=>{completeUnlock=resolve});
    })().finally(()=>{unlockTask=undefined});
   }
   return unlockTask;
  }
  unlockDialog.addEventListener('close',()=>{
   if(unlockDialog.open)return;
   passphrase.value='';
   confirmPhrase.value='';
   completeUnlock?.(active||null);
   completeUnlock=undefined;
  });
  unlockDialog.addEventListener('cancel',event=>{if(unlockButton.disabled)event.preventDefault()});
  byId('private-generate-passphrase').onclick=()=>{
   const generated=crypto.getRandomValues(new Uint8Array(18));
   const phrase=Array.from(generated,byte=>byte.toString(16).padStart(2,'0')).join('');
   passphrase.type='text';
   passphrase.value=confirmPhrase.value=phrase;
   passphrase.select();
  };
  byId('private-unlock-form').onsubmit=async event=>{
   event.preventDefault();
   if(unlockButton.disabled)return;
   const phrase=passphrase.value;
   if(setup&&(phrase.length<16||phrase!==confirmPhrase.value)){
    unlockStatus.textContent=tr('Введите одинаковую фразу из 16 или более символов.');
    return;
   }
   unlockButton.disabled=unlockClose.disabled=true;
   passphrase.value=confirmPhrase.value='';
   unlockStatus.textContent='';
   const attempt=unlockGeneration;
   try{
    const db=await store;
    const unlocked=await db.unlock(phrase,setup);
    if(attempt!==unlockGeneration||!unlockDialog.open){db.lock();return}
    activate(db,unlocked);
    if(native){
     needsOldPhrase=false;
     native.postMessage('note-vault-save:'+btoa(String.fromCharCode(...new TextEncoder().encode(phrase))));
    }
    unlockDialog.close();
   }catch{
    if(attempt!==unlockGeneration)return;
    unlockStatus.textContent=tr('Проверьте фразу доступа. Не удалось открыть хранилище.');
    passphrase.type='password';
    passphrase.focus();
   }finally{unlockButton.disabled=unlockClose.disabled=false}
  };

  async function copy(field,status){
   if(!field.value)return;
   if(window.chrome?.webview){
    copyStatus=status;
    window.chrome.webview.postMessage('copy-private-code:'+field.value);
    return;
   }
   try{
    await navigator.clipboard.writeText(field.value);
    status.textContent=tr('Код скопирован');
   }catch{
    field.select();
    status.textContent=tr('Скопируйте выделенный код');
   }
  }
  native?.addEventListener('message',event=>{
   if(typeof event.data==='string'&&event.data.startsWith('note-vault-secret:')){
    const secret=atob(event.data.slice('note-vault-secret:'.length));
    receiveWalletSecret?.(new TextDecoder().decode(Uint8Array.from(secret,character=>character.charCodeAt(0))));
   }
   if(event.data==='private-code-copied'&&copyStatus)copyStatus.textContent=tr('Код скопирован');
   if(event.data==='lock-private-pins')lock();
  });
  if(native)queueMicrotask(()=>void walletUnlock().catch(()=>{}));
  copyReceiving.onclick=()=>copy(receiving,inboxStatus);
  byId('copy-private-share').onclick=()=>copy(byId('private-share-code'),shareStatus);
  openButton.append(NoticoinMapIcons.element('inbox'));
  openButton.onclick=async()=>{
   try{
    if(!await ensureUnlocked()||inbox.open)return;
    inboxStatus.textContent='';
    refresh();
    inbox.showModal();
   }catch{openButton.disabled=true}
  };

  byId('private-import-form').onsubmit=async event=>{
   event.preventDefault();
   const field=byId('private-import-code'),button=byId('private-import-button');
   if(button.disabled)return;
   button.disabled=true;
   inboxStatus.textContent='';
   try{
    const db=active;
    if(!db)return;
    const pin=await db.import(field.value);
    if(active!==db)return;
    pins.set(pin.id,pin);
    refresh();
    field.value='';
    if(inbox.open){inbox.close();select(pin)}
   }catch{
    inboxStatus.textContent=tr('Код повреждён, просрочен или создан для другого получателя.');
   }finally{button.disabled=false}
  };

  byId('private-share-form').onsubmit=async event=>{
   event.preventDefault();
   const pin=sharing,button=byId('private-share-button');
   if(!pin||button.disabled)return;
   button.disabled=true;
   shareStatus.textContent='';
   byId('private-share-output').hidden=true;
   try{
    if(!active)return;
    const code=await active.share(pin,byId('private-recipient-code').value);
    if(!shareDialog.open||sharing!==pin)return;
    byId('private-share-code').value=code;
    byId('private-share-output').hidden=false;
    byId('copy-private-share').focus();
   }catch{
    if(sharing===pin)shareStatus.textContent=tr('Проверьте код получателя и срок действия метки.');
   }finally{button.disabled=false}
  };
  shareDialog.addEventListener('close',()=>{
   if(shareDialog.open)return;
   sharing=undefined;
   byId('private-recipient-code').value='';
   byId('private-share-code').value='';
  });

  return {
   items,
   async readyForSales(){return !!await walletUnlock()},
   async noteRecipient(){
    return await ensureUnlocked()?receiving.value:null;
   },
   async encryptNote(note,recipient){
    const db=await ensureUnlocked();
    return db?db.encryptNote(note,recipient):null;
   },
   async decryptNote(id,packet){
    const db=await ensureUnlocked();
    return db?db.decryptNote(id,packet):null;
   },
   async purchaseIndex(){
    return (await store).purchaseIndex();
   },
   async savePurchase(item,receipt){
    const db=await walletUnlock();
    return db?db.savePurchase(item,receipt):null;
   },
   async readPurchase(id){
    const db=await walletUnlock();
    return db?db.readPurchase(id):null;
   },
   async deletePurchase(id){
    const db=await walletUnlock();
    if(!db)return false;
    await db.deletePurchase(id);
    return true;
   },
   expire(){
    const active=items();
    if(active.length===pins.size)return;
    pins.clear();
    for(const pin of active)pins.set(pin.id,pin);
    refresh();
   },
   async create(fields){
    const db=await ensureUnlocked();
    if(!db)return null;
    const pin=await db.create(fields);
    pins.set(pin.id,pin);
    refresh();
    return pin;
   },
   share(pin){
    if(!active)return;
    sharing=pin;
    shareStatus.textContent='';
    byId('private-share-output').hidden=true;
    shareDialog.showModal();
   },
   async remove(id){
    if(!active)return;
    await active.remove(id);
    pins.delete(id);
    refresh();
   }
  };
 }
 globalThis.NoticoinPrivatePinControls={connect};
})();
