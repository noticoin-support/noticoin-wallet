import test from 'node:test';import assert from 'node:assert/strict';import {createLocalDb} from '../server/local-db.mjs';import {handleApi} from '../server/api.mjs';
const origin='https://noticoin.test';
async function identity(){const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);return{keys,publicKey:Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('base64')}}
async function envelope(who,action,payload={}){if(action==='create'&&payload.cipher&&!payload.id)payload={...payload,id:crypto.randomUUID()};const e={action,nonce:Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),issuedAt:Date.now(),payload};return{...e,publicKey:who.publicKey,signature:Buffer.from(await crypto.subtle.sign('Ed25519',who.keys.privateKey,new TextEncoder().encode(JSON.stringify(e)))).toString('base64')}}
const cipher='noticoin-note-v1.'+'A'.repeat(580),recipient='\x6b\x6f\x6b\x6f-recipient-v1.'+'A'.repeat(563);
const point={title:'Тестовая точка',cipher,category:'message',lat:35,lng:139,mode:'free'};
const request=(url,body)=>new Request(origin+url,body?{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}:{});
test('anonymous signed create, ciphertext persistence, replay and delete ownership',async()=>{const DB=createLocalDb(':memory:'),env={DB},alice=await identity(),bob=await identity();try{const signed=await envelope(alice,'create',point),created=await handleApi(request('/api/points',signed),env);assert.equal(created.status,201);const p=(await created.json()).point;assert.equal(p.body,'');assert.equal(p.protectedNote,true);assert.equal(p.cipher,undefined);assert.equal((await handleApi(request('/api/points',await envelope(alice,'create',{...point,body:'Legacy text'})),env)).status,400);const read='/api/points/'+p.id+'/note';assert.equal((await handleApi(request(read,await envelope(bob,'read-my-note')),env)).status,404);assert.deepEqual(await (await handleApi(request(read,await envelope(alice,'read-my-note')),env)).json(),{cipher});assert.equal((await handleApi(request('/api/points',signed),env)).status,409);let list=await (await handleApi(request('/api/points'),env)).json();assert.equal(list.points.length,1);assert.equal((await handleApi(request('/api/points/'+p.id+'/delete',await envelope(bob,'delete')),env)).status,403);assert.equal((await handleApi(request('/api/points/'+p.id+'/delete',await envelope(alice,'delete')),env)).status,200);list=await(await handleApi(request('/api/points'),env)).json();assert.equal(list.points.length,0)}finally{DB.sqlite.close()}});
test('tampering a signed point fails verification',async()=>{const DB=createLocalDb(':memory:');try{const e=await envelope(await identity(),'create',point);e.payload.lng=100;assert.equal((await handleApi(request('/api/points',e),{DB})).status,401)}finally{DB.sqlite.close()}});
test('visitors can open a public note while the author-only copy stays protected',async()=>{
 const DB=createLocalDb(':memory:'),env={DB},author=await identity(),visitor=await identity();
 const id=crypto.randomUUID(),body='A public message anyone can open';
 const packet=await NotiPublicNotes.seal(id,body);
 try{
  const post=await handleApi(request('/api/points',await envelope(author,'create',{...point,id,publicNote:packet})),env);
  assert.equal(post.status,201);
  const published=(await post.json()).point;
  assert.equal(published.publicNote,true);
  assert.equal(published.body,'');
  assert.equal(DB.sqlite.prepare('SELECT body FROM points WHERE id=?').get(id).body,packet);
  const path='/api/points/'+id;
  const opened=await handleApi(request(path+'/public-note'),env);
  assert.equal(opened.status,200);
  assert.equal(await NotiPublicNotes.open(id,(await opened.json()).packet),body);
  assert.equal((await handleApi(request(path+'/note',await envelope(visitor,'read-my-note')),env)).status,404);
  const original=await handleApi(request('/api/points',await envelope(author,'create',point)),env);
  const hidden=(await original.json()).point;
  assert.equal((await handleApi(request('/api/points/'+hidden.id+'/public-note'),env)).status,404);
  DB.sqlite.prepare('UPDATE points SET chain_required=1 WHERE id=?').run(id);
  assert.equal((await handleApi(request(path+'/public-note'),env)).status,404);
 }finally{DB.sqlite.close();}
});
test('a paid point cannot be fabricated when no wallet is connected',async()=>{const DB=createLocalDb(':memory:');try{const e=await envelope(await identity(),'create',{...point,mode:'paid'});assert.equal((await handleApi(request('/api/points',e),{DB})).status,503);assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM invoices').get().n,0)}finally{DB.sqlite.close()}});
test('chain publications can be retried and are not subject to the draft limit',async()=>{
 const DB=createLocalDb(':memory:');
 const env={DB,NOTICOIN_MAP_CHAIN_ANCHORS:'1',NOTICOIN_BRIDGE_URL:'http://127.0.0.1:8788',NOTICOIN_FUND_BRIDGE_TOKEN:'fund'};
 const author=await identity();
 const post=async fields=>handleApi(request('/api/points',await envelope(author,'create',fields)),env);
 try{
  const draft={...point,id:crypto.randomUUID(),chainRecord:true};
  const first=await post(draft).then(response=>response.json());
  const retry=await post(draft).then(response=>response.json());
  assert.deepEqual(first,retry);
  assert.equal(first.invoice.anchorAction,'publish');
  for(let count=0;count<6;count++)assert.equal((await post({...draft,id:crypto.randomUUID()})).status,201);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM points').get().n,7);
 }finally{DB.sqlite.close()}
});
test('an operator reorder between draft and confirmation preserves an encrypted publication',async()=>{
 const DB=createLocalDb(':memory:'),author=await identity(),originalFetch=globalThis.fetch;
 const env={DB,NOTICOIN_MAP_CHAIN_ANCHORS:'1',NOTI_NOTE_REGISTRY:'1',NOTICOIN_BRIDGE_URL:'http://127.0.0.1:8788',NOTICOIN_BRIDGE_TOKEN:'legacy',NOTICOIN_FUND_BRIDGE_TOKEN:'fund'};
 const operators=['A','B','C'].map(letter=>({key:letter.repeat(563)}));
 const reordered=[operators[0],operators[2],operators[1]];
 const txid='f'.repeat(64),address='K'+'a'.repeat(94);
 let canonical=reordered;
 globalThis.fetch=async(_url,init)=>{
  const {method,params}=JSON.parse(init.body);
  if(method==='note_registry_roster'){
   const epoch=params.height===200?200:210;
   return Response.json({result:{height:epoch,epoch,threshold:2,operators:epoch===200?operators:canonical}});
  }
  if(method==='create_address')return Response.json({result:{address,address_index:1}});
  if(method==='check_anchor')return Response.json({result:{found:true,matches:true,confirmations:3,blockHeight:210}});
  assert.equal(method,'get_transfers');
  return Response.json({result:{in:[{txid,amount:600000000,height:210,confirmations:3}],pool:[]}});
 };
 try{
  const offer={nonce:'a'.repeat(32),addresses:[address],amountAtomic:'10000000',operators:operators.map(({key})=>key),
   ciphertext:'a'.repeat(48),custody:operators.map(()=>['a'.repeat(512)]),epoch:200,threshold:2,
   shareHashes:operators.map(()=>'a'.repeat(64)),registry:true};
  const id=await NotiOfflineNotes.pointId(offer);
  const draft=await handleApi(request('/api/points',await envelope(author,'create',{
   ...point,id,category:'secret',mode:'paid',chainRecord:true,secretPriceAtomic:offer.amountAtomic,offlineOffer:offer,
  })),env);
  assert.equal(draft.status,201);
  const record=Buffer.concat([Buffer.from('4e544d500101'+id.replaceAll('-',''),'hex'),Buffer.from(author.publicKey,'base64')]);
  const signature=Buffer.from(await crypto.subtle.sign('Ed25519',author.keys.privateKey,record));
  const anchor=async()=>handleApi(request('/api/points/'+id+'/anchor',await envelope(author,'anchor-point',{
   operation:'publish',txid,record:Buffer.concat([record,signature]).toString('hex'),
  })),env);
  const result=await anchor();
  assert.equal(result.status,200);
  assert.equal((await result.json()).status,'confirmed');
  canonical=[operators[0],operators[2],{key:'D'.repeat(563)}];
  assert.equal((await anchor()).status,409);
 }finally{globalThis.fetch=originalFetch;DB.sqlite.close()}
});
test('a temporary Wi-Fi pin carries an optional signed donation address and amount',async()=>{
 const DB=createLocalDb(':memory:'),env={DB},author=await identity(),visitor=await identity();
 const donationAddress='K'+('a'.repeat(94));
 try{
  const useful={...point,category:'wifi',donationAddress,donationAmountAtomic:'500000000'};
  const signed=await envelope(author,'create',useful);
  const response=await handleApi(request('/api/points',signed),env);
  assert.equal(response.status,201);
  const {point:created,invoice}=await response.json();
  assert.equal(invoice,null);
  assert.equal(created.expiresAt-created.createdAt,7*86400000);
  assert.equal(created.donationAddress,donationAddress);
  assert.equal(created.status,'free');
  assert.equal(created.donationAmountAtomic,'500000000');
  assert.equal(created.donationNote,undefined);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM invoices').get().n,0);
  const list=await (await handleApi(request('/api/points?category=wifi'),env)).json();
  assert.deepEqual(list.points,[created]);
  const vote=await handleApi(request('/api/points/'+created.id+'/vote',await envelope(visitor,'vote')),env);
  assert.equal((await vote.json()).votes,1);
  for(const invalid of [{...useful,donationAddress:'\x6b\x6f\x6b\x6f:wrong'},{...point,donationAmountAtomic:'500000000'}]){
   const post=await handleApi(request('/api/points',await envelope(author,'create',invalid)),env);
   assert.equal(post.status,400);
  }
  const withoutAddress=await handleApi(request('/api/points',await envelope(author,'create',{...point,category:'wifi'})),env);
  assert.equal(withoutAddress.status,201);
  assert.equal((await withoutAddress.json()).point.donationAddress,undefined);
  assert.equal((await handleApi(request('/api/points/'+created.id+'/delete',await envelope(visitor,'delete')),env)).status,403);
  assert.equal((await handleApi(request('/api/points/'+created.id+'/delete',await envelope(author,'delete')),env)).status,200);
  const after=await (await handleApi(request('/api/points'),env)).json();
  assert.ok(after.points.every(pin=>pin.id!==created.id));
 }finally{DB.sqlite.close()}
});

test('a purchased secret leaves the map and only its buyer can reopen it before expiry',async()=>{
 const DB=createLocalDb(':memory:'),env={DB,NOTICOIN_BRIDGE_URL:'http://127.0.0.1:8788',NOTICOIN_BRIDGE_TOKEN:'test',NOTICOIN_FUND_BRIDGE_TOKEN:'fund'};
 const [author,buyer,rival]=await Promise.all([identity(),identity(),identity()]);
 const venueId='building-55441047';
 const payload={...point,venueId,venueName:'Shibuya Cross Tower',category:'secret',secretPriceAtomic:'120000000'};
 const post=async(who,route,action,data)=>handleApi(request(route,await envelope(who,action,data??(action==='buy'?{recipient}:{}))),env);
 const originalFetch=globalThis.fetch;
 let snapshot={in:[],pool:[]},addresses=0;
 globalThis.fetch=async(url,init)=>{
  const {wallet,method}=JSON.parse(init.body);
  const result=method==='create_address'?
   wallet==='fund'?{address:'fund-publication',address_index:1}:{address:'secret-address-'+(++addresses),address_index:addresses}:snapshot;
  return Response.json({result});
 };
 try{
  const create=await post(author,'/api/points','create',payload);
  assert.equal(create.status,201);
  const {point:note,invoice:placement}=await create.json();
  assert.equal(placement.amountAtomic,'200000000');
  assert.equal((await post(buyer,'/api/points/'+note.id+'/buy','buy')).status,404);
  snapshot={in:[{txid:'a'.repeat(64),amount:placement.amountAtomic,height:9,confirmations:3}],pool:[]};
  assert.equal((await post(author,'/api/invoices/'+placement.id,'invoice').then(res=>res.json())).status,'confirmed');
  snapshot={in:[],pool:[]};
  assert.equal(note.body,'');
  assert.equal(note.venueName,payload.venueName);
  assert.equal((await (await handleApi(request('/api/points?q=moonstone'),env)).json()).points.length,0);
  assert.equal((await (await handleApi(request('/api/points?venue='+venueId),env)).json()).points[0].body,'');
  const buy='/api/points/'+note.id+'/buy';
  assert.equal((await post(author,buy,'buy')).status,400);
  const first=await Promise.all([post(buyer,buy,'buy'),post(rival,buy,'buy')]);
  assert.deepEqual(first.map(res=>res.status).sort(),[201,409]);
  const winner=first[0].status===201?buyer:rival,loser=winner===buyer?rival:buyer;
  const invoice=await first.find(res=>res.status===201).json();
  assert.equal(addresses,1);
  assert.equal(invoice.amountAtomic,payload.secretPriceAtomic);
  assert.equal(invoice.address,null);
  assert.equal(invoice.awaitingDelivery,true);
  assert.equal((await post(winner,buy,'buy').then(res=>res.json())).id,invoice.id);
  assert.equal((await post(author,'/api/points/'+note.id+'/delete','delete')).status,409);
  const route='/api/secret-purchases/'+invoice.id;
  assert.equal((await post(loser,route,'secret-status')).status,404);
  assert.equal((await post(winner,route+'/read','secret-read')).status,409);
  const delivery={recipient,cipher:'noticoin-note-v1.'+'B'.repeat(580)};
  assert.equal((await post(loser,route+'/deliver','deliver-note',delivery)).status,409);
  assert.equal((await post(author,route+'/deliver','deliver-note',delivery)).status,200);
  assert.equal((await post(winner,route,'secret-status').then(res=>res.json())).address,'secret-address-1');
  const poll=async()=>{
   DB.sqlite.prepare('UPDATE secret_purchases SET last_checked=0 WHERE id=?').run(invoice.id);
   return post(winner,route,'secret-status').then(res=>res.json());
  };
  snapshot={in:[{txid:'b'.repeat(64),amount:payload.secretPriceAtomic,height:10,confirmations:2}],pool:[]};
  assert.equal((await poll()).status,'included');
  assert.equal((await post(winner,route+'/read','secret-read')).status,409);
  snapshot.in[0].confirmations=3;
  assert.equal((await poll()).status,'confirmed');
  assert.equal((await (await handleApi(request('/api/points?venue='+venueId),env)).json()).points.length,0);
  assert.equal((await post(loser,buy,'buy')).status,404);
  assert.equal((await post(loser,route+'/read','secret-read')).status,404);
  assert.equal((await post(author,route+'/read','secret-read')).status,404);
  const history=async who=>post(who,'/api/secret-purchases','purchase-history').then(res=>res.json());
  const receipt=await history(winner);
  assert.deepEqual(receipt.sales,[]);
  assert.equal(receipt.purchases.length,1);
  assert.equal(receipt.purchases[0].id,invoice.id);
  assert.equal(receipt.purchases[0].title,payload.title);
  assert.equal(receipt.purchases[0].readAvailable,true);
  assert.equal(receipt.purchases[0].body,undefined);
  const sellerHistory=await history(author);
  assert.deepEqual(sellerHistory.purchases,[]);
  assert.deepEqual(sellerHistory.sales,[{pointId:note.id,title:payload.title,amountAtomic:invoice.amountAtomic,paidAt:receipt.purchases[0].readUntil-86400000}]);
  assert.deepEqual(await history(loser),{purchases:[],sales:[],deliveries:[],legacyListings:[],sellerWaiting:false});
  assert.deepEqual(await post(winner,route+'/read','secret-read',{downloadOnly:true}).then(res=>res.json()),{cipher:delivery.cipher});
  assert.equal((await history(winner)).purchases[0].opened,false);
  assert.deepEqual(await post(winner,route+'/read','secret-read').then(res=>res.json()),{cipher:delivery.cipher});
  assert.equal((await history(winner)).purchases[0].opened,true);
  assert.equal((await post(winner,route+'/erase','secret-erase')).status,200);
  assert.deepEqual(await post(winner,route+'/read','secret-read').then(res=>res.json()),{cipher:delivery.cipher});
  assert.equal((await history(winner)).purchases[0].readAvailable,true);
  DB.sqlite.prepare('UPDATE secret_purchases SET sold_at=? WHERE id=?').run(Date.now()-86400001,invoice.id);
  assert.equal((await post(winner,route+'/read','secret-read')).status,410);
  assert.equal((await history(winner)).purchases[0].readAvailable,false);
  assert.equal(DB.sqlite.prepare('SELECT body FROM points WHERE id=?').get(note.id).body,'');
  DB.sqlite.prepare("UPDATE secret_purchases SET status='released' WHERE id=?").run(invoice.id);
  DB.sqlite.prepare('UPDATE points SET deleted=0 WHERE id=?').run(note.id);
  assert.equal((await (await handleApi(request('/api/points?venue='+venueId),env)).json()).points.length,0);
  assert.equal((await post(loser,buy,'buy')).status,404);
  assert.throws(()=>DB.sqlite.prepare('INSERT INTO secret_purchases(id,point_id,buyer,amount_atomic,expires_at,sold_at) VALUES(?,?,?,?,?,?)')
   .run(crypto.randomUUID(),note.id,'third-buyer',invoice.amountAtomic,Date.now(),Date.now()),/Note edition is full/);
 }finally{globalThis.fetch=originalFetch;DB.sqlite.close()}
});

test('premium icon pricing is added to the selected lifetime and appears in the invoice',async()=>{
 const DB=createLocalDb(':memory:'),env={DB,NOTICOIN_BRIDGE_URL:'http://127.0.0.1:8788',NOTICOIN_BRIDGE_TOKEN:'legacy',NOTICOIN_FUND_BRIDGE_TOKEN:'fund'},who=await identity();
 const originalFetch=globalThis.fetch;
 let index=0;
 globalThis.fetch=async(url,init)=>{
  assert.equal(init.headers.authorization,'Bearer fund');
  assert.equal(JSON.parse(init.body).wallet,'fund');
  return Response.json({result:{address:'premium-'+(++index),address_index:index}});
 };
 const publish=async(mode,icon,extra={})=>handleApi(request('/api/points',await envelope(who,'create',{...point,mode,icon,...extra})),env);
 try{
  const week=await publish('free','star').then(res=>res.json());
  assert.equal(week.invoice.amountAtomic,'50000000');
  assert.equal(week.point.icon,'star');
  assert.equal(week.point.expiresAt-week.point.createdAt,7*86400000);
  const month=await publish('paid','diamond').then(res=>res.json());
  assert.equal(month.invoice.amountAtomic,'700000000');
  assert.equal(month.point.expiresAt-month.point.createdAt,30*86400000);
  const basic=await publish('free','camera').then(res=>res.json());
  assert.equal(basic.point.icon,'camera');
  assert.equal(basic.invoice,null);
  const shortSale=await publish('free','pulse-beacon',{secretPriceAtomic:'120000000'}).then(res=>res.json());
  assert.equal(shortSale.invoice.amountAtomic,'450000000');
  assert.equal(shortSale.point.secretPriceAtomic,'120000000');
  assert.equal(shortSale.point.icon,'pulse-beacon');
  const longSale=await publish('paid','pulse-crown',{secretPriceAtomic:'120000000'}).then(res=>res.json());
  assert.equal(longSale.invoice.amountAtomic,'1050000000');
  assert.equal(longSale.point.expiresAt-longSale.point.createdAt,30*86400000);
  const advertised=await handleApi(request('/api/config'),env).then(res=>res.json());
  assert.equal(advertised.saleWeekPriceAtomic,'200000000');
  assert.equal(advertised.priceAtomic,'600000000');
  assert.equal(advertised.iconPrices['pulse-crown'],'450000000');
  assert.equal((await publish('paid','unknown')).status,400);
 }finally{globalThis.fetch=originalFetch;DB.sqlite.close()}
});
test('venue reviews are signed, editable once per author, and isolated by venue',async()=>{
 const DB=createLocalDb(':memory:'),env={DB},first=await identity(),second=await identity();
 const venue='omt-14207650861',route='/api/venues/'+venue+'/reviews';
 const send=async(who,rating,body,key=venue)=>handleApi(request(route,await envelope(who,'review',{venue:key,rating,body})),env);
 try{
  assert.deepEqual(await (await handleApi(request(route),env)).json(),{count:0,average:null,reviews:[]});
  assert.equal((await send(first,0,'Invalid')).status,400);
  assert.equal((await send(first,5,'Wrong venue','omt-13')).status,400);
  assert.equal((await send(first,5,'Good coffee <b>and fast service</b>')).status,200);
  assert.equal((await send(second,3,'')).status,200);
  const initial=await (await handleApi(request(route),env)).json();
  assert.equal(initial.count,2);
  assert.equal(initial.average,4);
  assert.ok(initial.reviews.some(row=>row.body==='Good coffee <b>and fast service</b>'));
  assert.ok(initial.reviews.every(review=>!('owner' in review)));
  const updated=await (await send(first,1,'Updated')).json();
  assert.equal(updated.count,2);
  assert.equal(updated.average,2);
  const myReview=await handleApi(request(route+'/mine',await envelope(first,'read-review',{venue})),env);
  assert.equal((await myReview.json()).review.body,'Updated');
  const otherReview=await handleApi(request(route+'/mine',await envelope(second,'read-review',{venue})),env);
  assert.equal((await otherReview.json()).review.rating,3);
  const unrelated=await handleApi(request('/api/venues/omt-13/reviews'),env);
  assert.equal((await unrelated.json()).count,0);
 }finally{DB.sqlite.close()}
});
test('one visitor cannot inflate community confirmations by replaying votes',async()=>{const DB=createLocalDb(':memory:'),env={DB},alice=await identity(),bob=await identity();try{const p=(await(await handleApi(request('/api/points',await envelope(alice,'create',point)),env)).json()).point;for(let i=0;i<2;i++)assert.equal((await handleApi(request('/api/points/'+p.id+'/vote',await envelope(bob,'vote')),env)).status,200);assert.equal(DB.sqlite.prepare('SELECT votes FROM points WHERE id=?').get(p.id).votes,1);assert.equal((await handleApi(request('/api/points/'+p.id+'/vote',await envelope(alice,'vote')),env)).status,400)}finally{DB.sqlite.close()}});
test('viewport lookup crosses the international date line correctly',async()=>{const DB=createLocalDb(':memory:'),env={DB},who=await identity();try{for(const lng of[179,-179,0])await handleApi(request('/api/points',await envelope(who,'create',{...point,lng})),env);const data=await(await handleApi(request('/api/points?bbox=170,-85,-170,85'),env)).json();assert.equal(data.points.length,2)}finally{DB.sqlite.close()}});
test('global pin scans walk all pages with tied timestamps and hide note bodies',async()=>{
 const DB=createLocalDb(':memory:'),now=Date.now();
 try{
  const insert=DB.sqlite.prepare("INSERT INTO points (id,owner,title,body,category,lat,lng,mode,status,created_at,expires_at) VALUES (?, 'owner', ?, 'body fixture', 'message', ?, ?, 'free', 'free', ?, ?)");
  const ids=Array.from({length:2001},(_,i)=>'00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0'));
  for(const [i,id] of ids.entries())insert.run(id,'Pin '+i,i===0?-33:35,i===0?151:139,now,now+60000);
  const legacy=await handleApi(request('/api/points'),{DB}).then(r=>r.json());
  assert.equal(legacy.truncated,true);
  assert.ok(!legacy.points.some(p=>p.id===ids[0]));
  let scan='/api/points?scan=1',pages=0;
  const found=[];
  while(scan){
   const response=await handleApi(request(scan),{DB});
   assert.equal(response.status,200);
   const page=await response.json();
   assert.ok(page.points.length<=500);
   assert.ok(page.points.every(p=>p.body===''&&!Object.hasOwn(p,'note_cipher')));
   found.push(...page.points.map(p=>p.id));
   scan=page.nextCursor?'/api/points?scan=1&cursor='+encodeURIComponent(page.nextCursor):null;
   assert.ok(++pages<=5);
  }
  assert.equal(pages,5);
  assert.deepEqual(found,ids.toReversed());
  const area=await handleApi(request('/api/points?scan=1&bbox=140,-40,155,-25'),{DB}).then(r=>r.json());
  assert.deepEqual(area.points.map(p=>p.id),[ids[0]]);
  assert.equal(area.nextCursor,null);
  assert.equal((await handleApi(request('/api/points?scan=1&cursor=invalid'),{DB})).status,400);
 }finally{DB.sqlite.close();}
});

test('invoice lifecycle persists confirmations and reverses them on reorg',async()=>{
 const DB=createLocalDb(':memory:'),env={DB,NOTICOIN_BRIDGE_URL:'http://127.0.0.1:8788',NOTICOIN_FUND_BRIDGE_TOKEN:'test'},who=await identity(),originalFetch=globalThis.fetch;
 let snapshot={in:[],pool:[]},broken=false;
 globalThis.fetch=async(url,init)=>{if(broken)return new Response('{}',{status:503});const {method}=JSON.parse(init.body);return Response.json({result:method==='create_address'?{address:'invoice-address',address_index:1}:snapshot});};
 try{
  const created=await handleApi(request('/api/points',await envelope(who,'create',{...point,mode:'paid'})),env);assert.equal(created.status,201);const {point:p,invoice}=await created.json();
  const poll=async()=>{DB.sqlite.prepare('UPDATE invoices SET last_checked=0').run();return handleApi(request('/api/invoices/'+invoice.id,await envelope(who,'invoice')),env);};
  snapshot={in:[{txid:'a'.repeat(64),amount:invoice.amountAtomic,height:10,confirmations:3}],pool:[]};
  assert.equal((await(await poll()).json()).status,'confirmed');assert.equal(DB.sqlite.prepare('SELECT status FROM points WHERE id=?').get(p.id).status,'confirmed');
  snapshot={matchesAddress:false,in:[],pool:[]};
  assert.equal((await(await poll()).json()).status,'confirmed');
  broken=true;assert.equal((await poll()).status,503);assert.equal(DB.sqlite.prepare('SELECT status FROM points WHERE id=?').get(p.id).status,'confirmed');
  let listed=await(await handleApi(request('/api/points'),env)).json();assert.equal(listed.points[0].status,'checking');
  broken=false;snapshot={in:[],pool:[]};assert.equal((await(await poll()).json()).status,'awaiting');listed=await(await handleApi(request('/api/points'),env)).json();assert.equal(listed.points.length,0);
 }finally{globalThis.fetch=originalFetch;DB.sqlite.close();}
});

test('fund invoices with distinct addresses can use the same index after a wallet rotation',async()=>{
 const DB=createLocalDb(':memory:'),env={DB,NOTICOIN_BRIDGE_URL:'http://127.0.0.1:8788',NOTICOIN_FUND_BRIDGE_TOKEN:'fund',NOTICOIN_BRIDGE_TOKEN:'legacy'};
 const author=await identity(),originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{
  const {wallet,method,params}=JSON.parse(init.body);
  assert.equal(init.headers.authorization,'Bearer '+wallet);
  calls.push({wallet,method});
  if(method==='create_address')return Response.json({result:{address:'fund-address',address_index:1}});
  assert.deepEqual(params.subaddr_indices,[1]);
  return Response.json({result:{in:[],pool:[]}});
 };
 try {
  const draft=()=>envelope(author,'create',{...point,mode:'paid'});
  assert.equal((await handleApi(request('/api/points',await draft()),{...env,NOTICOIN_FUND_BRIDGE_TOKEN:''})).status,503);
  DB.sqlite.prepare("INSERT INTO points(id,owner,title,body,category,lat,lng,mode,status,created_at,expires_at) VALUES('old','previous','Old','Message','message',1,1,'paid','awaiting',?,?)").run(Date.now(),Date.now()+3600000);
  DB.sqlite.prepare("INSERT INTO invoices(id,point_id,address,subaddress,amount_atomic,created_at,expires_at,wallet) VALUES('old-invoice','old','old-address',1,'100000000',?,?,'legacy')").run(Date.now(),Date.now()+3600000);
  DB.sqlite.prepare("INSERT INTO points(id,owner,title,body,category,lat,lng,mode,status,created_at,expires_at) VALUES('retired','previous','Retired','Message','message',1,1,'paid','awaiting',?,?)").run(Date.now(),Date.now()+3600000);
  DB.sqlite.prepare("INSERT INTO invoices(id,point_id,address,subaddress,amount_atomic,created_at,expires_at,wallet) VALUES('retired-invoice','retired','retired-address',1,'250000000',?,?,'fund')").run(Date.now(),Date.now()+3600000);
  const result=await handleApi(request('/api/points',await draft()),env);
  assert.equal(result.status,201);
  const {invoice}=await result.json();
  assert.equal(invoice.address,'fund-address');
  assert.equal(invoice.amountAtomic,'600000000');
  const previous=DB.sqlite.prepare("SELECT amount_atomic FROM invoices WHERE id='retired-invoice'").get();
  assert.equal(previous.amount_atomic,'250000000');
  for(const wallet of ['legacy','fund']){
   const reconcile=new Request(origin+'/api/internal/reconcile?wallet='+wallet,{method:'POST',headers:{authorization:'Bearer '+wallet}});
   assert.equal((await handleApi(reconcile,env)).status,200);
  }
  assert.deepEqual(calls,[{wallet:'fund',method:'create_address'},{wallet:'legacy',method:'get_transfers'},{wallet:'fund',method:'get_transfers'},{wallet:'fund',method:'get_transfers'}]);
 }finally{globalThis.fetch=originalFetch;DB.sqlite.close();}
});

test('a verified anchored publication can be rechecked after the fund wallet changes',async()=>{
 const DB=createLocalDb(':memory:'),originalFetch=globalThis.fetch;
 const env={DB,NOTICOIN_BRIDGE_URL:'http://127.0.0.1:8788',NOTICOIN_FUND_BRIDGE_TOKEN:'fund',NOTICOIN_MAP_CHAIN_ANCHORS:'1'};
 const now=Date.now(), txid='a'.repeat(64), record='4e544d500101'+'0'.repeat(224);
 let proof={found:true,matches:true,confirmations:15};
 globalThis.fetch=async(_url,init)=>{
  const {wallet,method,params}=JSON.parse(init.body);
  assert.equal(wallet,'fund');
  if(method==='check_anchor'){
   assert.deepEqual(params,{txid,record});
   return Response.json({result:proof});
  }
  assert.equal(method,'get_transfers');
  return Response.json({result:{matchesAddress:false,in:[],pool:[]}});
 };
 try{
  DB.sqlite.prepare("INSERT INTO points(id,owner,title,body,category,lat,lng,mode,status,created_at,expires_at) VALUES('old','previous','Old','Message','message',1,1,'paid','confirmed',?,?)")
   .run(now,now+3600000);
  DB.sqlite.prepare("INSERT INTO invoices(id,point_id,address,subaddress,amount_atomic,received_atomic,confirmations,txids,created_at,expires_at,wallet) VALUES('old-invoice','old','old-address',1,'250000000','250000000',6,?,?,?,'fund')")
   .run(JSON.stringify([txid]),now,now+3600000);
  DB.sqlite.prepare("INSERT INTO point_chain_records(point_id,operation,txid,record,confirmations,last_checked) VALUES('old','publish',?,?,6,0)").run(txid,record);
  const reconcile=()=>handleApi(new Request(origin+'/api/internal/reconcile?wallet=fund',{method:'POST',headers:{authorization:'Bearer fund'}}),env);
  const pointOnMap=async()=>(await(await handleApi(request('/api/points'),env)).json()).points[0];
  assert.equal((await pointOnMap()).status,'checking');
  assert.equal((await reconcile()).status,200);
  assert.equal((await pointOnMap()).status,'confirmed');
  assert.equal(DB.sqlite.prepare("SELECT confirmations FROM invoices WHERE id='old-invoice'").get().confirmations,15);
  DB.sqlite.prepare("UPDATE invoices SET last_checked=0").run();
  DB.sqlite.prepare("UPDATE point_chain_records SET last_checked=0").run();
  proof={found:false};
  assert.equal((await reconcile()).status,200);
  assert.equal((await pointOnMap()).status,'checking');
 }finally{globalThis.fetch=originalFetch;DB.sqlite.close();}
});
