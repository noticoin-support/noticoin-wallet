import {MAX_MAP_REQUEST_BYTES,availableNoteOperators,releaseNote,notePolicyAt,publicNotePolicy} from './note-operators.mjs';
import {noticoinEnvironment} from './environment.mjs';
import '../public/offline-notes.js';
import '../public/public-notes.js';

const {pointId:offlinePointId,policyMatches,publicationPolicyMatches}=globalThis.NotiOfflineNotes;
export const NETWORK_VERSION = '0.3.0';
export const DECIMALS = 9;
import '../public/pin-catalog.js';

const {extendedPrice,saleWeekPrice,publicationBase,icons}=globalThis.NotiPinCatalog;
export const PRICE_ATOMIC = extendedPrice;
export const REQUIRED_CONFIRMATIONS = 3;
const baseCategories = new Set(['message','place','event','art']);
const categories = new Set([...baseCategories,'wifi','food','shop','work','transport','secret']);
const iconPrices = Object.freeze(Object.fromEntries(Object.entries(icons).map(([key,icon])=>[key,icon.price])));
const donationFormat = /^[1-9A-HJ-NP-Za-km-z]{95,106}$/;
const venueFormat = /^(?:omt-[1-9]\d{0,15}|geo-[a-f0-9]{32}|building-[a-f0-9]{32}|building-[1-9]\d{0,15})$/;
const visiblePoint = 'points.expires_at>?';
const chainVisible = "((points.chain_required=0 OR EXISTS(SELECT 1 FROM point_chain_records r WHERE r.point_id=points.id AND r.operation='publish' AND r.confirmations>=3)) AND NOT EXISTS(SELECT 1 FROM point_chain_records r WHERE r.point_id=points.id AND r.operation='withdraw' AND r.confirmations>=3))";
const pendingWithdrawal = "EXISTS(SELECT 1 FROM point_chain_records r WHERE r.point_id=points.id AND r.operation='withdraw' AND r.confirmations>0)";
const soldCount = '(SELECT COUNT(*) FROM secret_purchases WHERE point_id=points.id AND sold_at IS NOT NULL)';
const occupiedCount = "(SELECT COUNT(*) FROM secret_purchases WHERE point_id=points.id AND (status!='released' OR sold_at IS NOT NULL))";
const soldPoint = '('+soldCount+' >= COALESCE(point_details.secret_copies,1))';
const annotatedPoints = 'points LEFT JOIN point_details ON point_details.point_id=points.id';
const pointCategory = 'COALESCE(point_details.category,points.category)';
const pointColumns = 'points.*,'+pointCategory+' AS display_category,point_details.icon,point_details.venue_id,point_details.venue_name,'+
 'point_details.donation_address,point_details.donation_amount,point_details.donation_note,point_details.secret_price,point_details.display_price,point_details.secret_copies,point_details.sale_address,point_details.offline_offer,'+
 soldCount+' AS sold,'+occupiedCount+' AS occupied,'+
 "(SELECT txid FROM point_chain_records WHERE point_id=points.id AND operation='publish' AND confirmations>=3) AS publication_tx";
const reviewColumns = 'rating,body,updated_at AS updatedAt';
const day = 86400000;
const hour = 3600000;
const paymentGrace = 30*60000;
const sellerReadyWindow = 90000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const noteCipher = value=>typeof value==='string'&&/^noticoin-note-v1\.[A-Za-z0-9_-]{551,6000}$/.test(value);
const publicNoteCipher=globalThis.NotiPublicNotes.valid;
const recipientFormat = /^(?:noti|\x6b\x6f\x6b\x6f)-recipient-v1\.[A-Za-z0-9_-]{563}$/;
const json = (value, status=200) => new Response(JSON.stringify(value), {status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const fault = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const bytes = value => Uint8Array.from(atob(value), c=>c.charCodeAt(0));
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const all = async statement => (await statement.all()).results;
const recipientMaterial = code=>code?.slice(code.indexOf('.')+1);
const paymentMessage = row=>['noti-note-v2',row.id,row.point_id,row.recipient_key].join(':');
const publicPoint = row => ({
 id:row.id,title:row.title,body:'',protectedNote:!!row.note_cipher,category:row.display_category,lat:row.lat,lng:row.lng,
 ...(publicNoteCipher(row.body)?{publicNote:true}:{}),
 mode:row.mode,icon:row.icon||'default',
 status:row.mode==='paid'&&['seen','included','confirmed'].includes(row.status)&&Date.now()-(row.payment_checked_at||0)>120000?'checking':row.status,
 createdAt:row.created_at,expiresAt:row.expires_at,
 ...(row.venue_id?{venueId:row.venue_id,venueName:row.venue_name}:{}),
 ...(row.secret_price?{secretPriceAtomic:row.secret_price,secretCopies:row.secret_copies,remainingCopies:row.secret_copies-row.sold,
  reserved:row.occupied>=row.secret_copies,directSales:!!row.sale_address,offlineSale:!!row.offline_offer}:{}),
 ...(row.display_price?{displayPriceAtomic:row.display_price}:{}),
 ...(row.publication_tx?{publicationTx:row.publication_tx}:{}),
 ...(row.donation_address?{donationAddress:row.donation_address,donationAmountAtomic:row.donation_amount}:{}),
 votes:row.votes,owner:row.owner,paymentCheckedAt:row.payment_checked_at||null
});

async function reviewsFor(db, venue) {
 const totals=await db.prepare('SELECT COUNT(*) AS count, AVG(rating) AS average FROM venue_reviews WHERE venue_id=?').bind(venue).first();
 const reviews=await all(db.prepare('SELECT '+reviewColumns+' FROM venue_reviews WHERE venue_id=? ORDER BY updated_at DESC,owner LIMIT 25').bind(venue));
 return {...totals,reviews};
}

export function atomic(value) {
  if (typeof value==='number' && (!Number.isSafeInteger(value)||value<0)) throw new Error('Unsafe atomic amount');
  if (!/^\d{1,30}$/.test(String(value))) throw new Error('Invalid atomic amount');
  return BigInt(value);
}

// Recompute from the wallet's present canonical view. Never accumulate old poll totals.
export function evaluatePayment(transfers, expected=PRICE_ATOMIC, required=REQUIRED_CONFIRMATIONS) {
  const seen = new Map();
  for (const tx of [...(transfers.pool||[]),...(transfers.in||[])]) {
    if (!/^[a-f0-9]{64}$/i.test(tx.txid||'')) continue;
    if (Number(tx.unlock_time||0)!==0 || tx.double_spend_seen) continue;
    const confirmations=tx.type==='pool'||!Number(tx.height)?0:Math.max(0,Number(tx.confirmations||0));
    const item={txid:tx.txid,amount:atomic(tx.amount),confirmations};
    const old=seen.get(tx.txid);
    if (!old||item.confirmations>old.confirmations) seen.set(tx.txid,item);
  }
  const values=[...seen.values()], target=atomic(expected);
  const total=values.reduce((n,t)=>n+t.amount,0n);
  const included=values.filter(t=>t.confirmations>=1).reduce((n,t)=>n+t.amount,0n);
  const confirmed=values.filter(t=>t.confirmations>=required).reduce((n,t)=>n+t.amount,0n);
  let status=confirmed>=target?'confirmed':included>=target?'included':total>=target?'seen':'awaiting';
  const sorted=values.slice().sort((a,b)=>b.confirmations-a.confirmations);
  let sum=0n, confirmations=0;
  for (const tx of sorted) {sum+=tx.amount;if(sum>=target){confirmations=tx.confirmations;break;}}
  return {status,receivedAtomic:String(total),confirmations,txids:values.map(t=>t.txid)};
}

async function signed(request, db, action) {
  const reader=request.body?.getReader();let text='',length=0;const decoder=new TextDecoder();
  if(reader){for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_MAP_REQUEST_BYTES){await reader.cancel();fault(413,'Слишком большой запрос');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
  let e;try{e=JSON.parse(text);}catch{fault(400,'Некорректный JSON');}
  if(e.action!==action||typeof e.nonce!=='string'||!/^[a-f0-9]{32}$/.test(e.nonce)||!Number.isSafeInteger(e.issuedAt)||Math.abs(Date.now()-e.issuedAt)>300000) fault(400,'Подпись запроса устарела');
  if(typeof e.publicKey!=='string'||e.publicKey.length>64||typeof e.signature!=='string'||e.signature.length>100||!e.payload||typeof e.payload!=='object') fault(400,'Неверная подпись');
  let valid=false;
  try {
    const key=await crypto.subtle.importKey('raw',bytes(e.publicKey),{name:'Ed25519'},false,['verify']);
    valid=await crypto.subtle.verify('Ed25519',key,bytes(e.signature),new TextEncoder().encode(JSON.stringify({action:e.action,nonce:e.nonce,issuedAt:e.issuedAt,payload:e.payload})));
  } catch {}
  if(!valid) fault(401,'Не удалось проверить подпись устройства');
  const owner=await hash(e.publicKey);
  const nonce=await db.prepare('INSERT OR IGNORE INTO nonces(id,expires_at) VALUES(?,?)').bind(owner+':'+e.nonce,Date.now()+600000).run();
  if(nonce.meta.changes!==1) fault(409,'Этот запрос уже выполнен');
  return {owner,publicKey:e.publicKey,payload:e.payload};
}

async function rate(db,key,limit) {
  const bucket=Math.floor(Date.now()/3600000),id=key+':'+bucket;
  const row=await db.prepare('INSERT INTO rate_limits(id,hits,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET hits=hits+1 WHERE hits<? RETURNING hits').bind(id,Date.now()+7200000,limit).first();
  if(!row) fault(429,'Лимит на этот час исчерпан. Попробуйте позже.');
}

function bridgeToken(env,wallet) {
  return wallet==='fund'?env.NOTICOIN_FUND_BRIDGE_TOKEN:env.NOTICOIN_BRIDGE_TOKEN;
}

async function rpc(env,method,params,wallet='legacy') {
  const token=bridgeToken(env,wallet);
  if(!env.NOTICOIN_BRIDGE_URL||!token) fault(503,'Кошелёк Noticoin пока не подключён. Бесплатные точки уже доступны.');
  const url=new URL('/rpc',env.NOTICOIN_BRIDGE_URL);
  if(url.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(url.hostname)) fault(503,'Для кошелька требуется HTTPS');
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify({method,params,wallet}),signal:AbortSignal.timeout(15000)});
  if(!response.ok) fault(503,'Кошелёк временно недоступен');
  const data=await response.json();if(data.error) fault(503,'Кошелёк не смог обработать запрос');return data.result;
}

async function invoiceStatus(db, env, invoice, snapshot) {
  if(!snapshot&&Date.now()-invoice.last_checked<12000) return invoice;
  const transfers=snapshot??await rpc(env,'get_transfers',{account_index:0,subaddr_indices:[invoice.subaddress],expected_address:invoice.address},invoice.wallet);
  if(transfers.matchesAddress===false)return recheckVerifiedPublication(db,env,invoice);
  if(!Array.isArray(transfers.in)&&!Array.isArray(transfers.pool)) fault(503,'Кошелёк вернул неполный ответ');
  const value=evaluatePayment(transfers,invoice.amount_atomic);
  const expired=Date.now()>invoice.expires_at&&value.status==='awaiting';
  const status=expired?'expired':value.status;
  // The paid lifetime starts on sufficient payment, never on invoice creation.
  await db.batch([
    db.prepare('UPDATE invoices SET received_atomic=?,confirmations=?,txids=?,last_checked=? WHERE id=?').bind(value.receivedAtomic,value.confirmations,JSON.stringify(value.txids),Date.now(),invoice.id),
    db.prepare("UPDATE points SET status=?,expires_at=CASE WHEN status IN ('awaiting','expired') AND ? IN ('seen','included','confirmed') THEN ?+?*COALESCE((SELECT duration_days FROM point_details WHERE point_id=points.id),30) ELSE expires_at END WHERE id=?").bind(status,status,Date.now(),day,invoice.point_id)
  ]);
  return {...invoice,received_atomic:value.receivedAtomic,confirmations:value.confirmations,txids:JSON.stringify(value.txids),status};
}

async function recheckVerifiedPublication(db,env,invoice) {
  if(env.NOTICOIN_MAP_CHAIN_ANCHORS!=='1'||invoice.status!=='confirmed'||
     invoice.confirmations<REQUIRED_CONFIRMATIONS||atomic(invoice.received_atomic)<atomic(invoice.amount_atomic))return invoice;
  const anchor=await db.prepare("SELECT txid,record FROM point_chain_records WHERE point_id=? AND operation='publish'")
    .bind(invoice.point_id).first();
  // Only revisit a single payment that the former fund wallet already verified,
  // tied to the same transaction as the publication. Never approve a new invoice here.
  const paid=JSON.parse(invoice.txids||'[]');
  if(!anchor||!Array.isArray(paid)||paid.length!==1||paid[0]!==anchor.txid)return {...invoice,status:'checking'};
  const proof=await rpc(env,'check_anchor',anchor,'fund');
  if(!proof.found||!proof.matches||!Number.isSafeInteger(proof.confirmations)||
     proof.confirmations<REQUIRED_CONFIRMATIONS)return {...invoice,status:'checking'};
  const checked=Date.now();
  await db.prepare('UPDATE invoices SET confirmations=?,last_checked=? WHERE id=? AND txids=?')
    .bind(proof.confirmations,checked,invoice.id,invoice.txids).run();
  return {...invoice,confirmations:proof.confirmations,last_checked:checked};
}

const hex = data => Array.from(data, byte => byte.toString(16).padStart(2,'0')).join('');
const mapRecordFormat = /^4e544d50010[12][a-f0-9]{224}$/;
async function authorizedRecord(record, id, operation, publicKey) {
  if(typeof record!=='string'||!mapRecordFormat.test(record))return false;
  const header='4e544d50010'+(operation==='publish'?'1':'2')+id.replaceAll('-','')+hex(bytes(publicKey));
  if(!record.startsWith(header))return false;
  const raw=Uint8Array.from(record.match(/../g),pair=>parseInt(pair,16));
  const key=await crypto.subtle.importKey('raw',raw.slice(22,54),{name:'Ed25519'},false,['verify']);
  return crypto.subtle.verify('Ed25519',key,raw.slice(54),raw.slice(0,54));
}

function mapInvoice(pointId, operation, expiresAt, invoice=null) {
  return {...(invoice??{id:pointId,address:'self',amountAtomic:'1',expiresAt}),pointId,anchorAction:operation};
}

async function publicationPolicy(env) {
  if(env.NOTI_NOTE_REGISTRY==='1')return registryPolicy(env);
  const policies=env.notePolicies;
  if(!policies?.length)return {};
  if(policies.length===1)return {policy:policies[0]};
  const {height}=await rpc(env,'note_chain_height',{},'fund');
  if(!Number.isSafeInteger(height)||height<0)fault(503,'Encrypted note sales are unavailable.');
  // A new transaction can first appear in the block after the current tip.
  return {height,policy:notePolicyAt(policies,height+1)};
}

async function registryPolicy(env,height){
  const roster=await rpc(env,'note_registry_roster',height?{height}:{},'fund');
  if(!Number.isSafeInteger(roster.height)||!Number.isSafeInteger(roster.epoch))
    fault(503,'Encrypted note sales are unavailable.');
  const operators=roster.operators??[];
  return {height:roster.height-1,policy:roster.threshold>=2&&roster.threshold<=operators.length?{height:roster.epoch,threshold:roster.threshold,
   keys:operators.map(operator=>operator.key),operators,registry:true}:null};
}

async function deliveryPolicy(env,offer){
  if(offer.registry){
    if(env.NOTI_NOTE_REGISTRY!=='1')return null;
    const {policy}=await registryPolicy(env,offer.epoch);
    return policyMatches(offer,policy)?policy:null;
  }
  return env.notePolicies?.find(entry=>policyMatches(offer,entry));
}

function operatorProxy(env,policy){
  if(!policy.registry)return undefined;
  return (index,operation,payload)=>rpc(env,'note_operator_request',{height:policy.height,index,operation,payload},'fund');
}

async function chainConfirmations(db,env,row) {
  const proof=await rpc(env,'check_anchor',{txid:row.txid,record:row.record},'fund');
  if(!proof.found)return null;
  if(!proof.matches)fault(400,'Транзакция не содержит подпись этой метки.');
  let confirmations=Number(proof.confirmations)||0;
  if(row.operation==='publish'&&confirmations>0&&row.offline_offer){
    const offer=JSON.parse(row.offline_offer);
    if(offer.registry||env.notePolicies?.length>1){
      if(!Number.isSafeInteger(proof.blockHeight))fault(503,'Encrypted note sales are unavailable.');
    }
    if(offer.registry){
      if(env.NOTI_NOTE_REGISTRY!=='1'||!publicationPolicyMatches(offer,(await registryPolicy(env,proof.blockHeight)).policy))return -1;
    }else if(env.notePolicies?.length>1&&!policyMatches(offer,notePolicyAt(env.notePolicies,proof.blockHeight)))return -1;
  }
  if(row.operation==='publish'&&row.mode==='paid'&&confirmations>0){
    const invoice=await db.prepare('SELECT * FROM invoices WHERE point_id=?').bind(row.point_id).first();
    if(!invoice)fault(409,'Счёт публикации не найден');
    const transfers=await rpc(env,'get_transfers',{account_index:0,subaddr_indices:[invoice.subaddress],expected_address:invoice.address},invoice.wallet);
    if(transfers.matchesAddress===false)return row.confirmations;
    const matching={in:(transfers.in||[]).filter(tx=>tx.txid===row.txid),pool:(transfers.pool||[]).filter(tx=>tx.txid===row.txid)};
    confirmations=Math.min(confirmations,evaluatePayment(matching,invoice.amount_atomic).confirmations);
    await invoiceStatus(db,env,invoice,transfers);
  }
  return confirmations;
}

function coinAmount(value, minimum) {
  if(typeof value!=='string'||!/^\d{1,19}$/.test(value)||atomic(value)<minimum||atomic(value)>1000000n*10n**BigInt(DECIMALS))
    fault(400,'Проверьте сумму в Noticoin.');
  return String(atomic(value));
}

async function paymentAddress(env,label,wallet) {
  const address=await rpc(env,'create_address',{account_index:0,label},wallet);
  if(!address.address||!Number.isInteger(address.address_index)||address.address_index<1)
    fault(503,'Не удалось создать адрес оплаты');
  return address;
}

function purchaseInvoice(row) {
  const direct=!!row.direct_address;
  const offline=row.offline_slot!=null;
  const ready=direct&&(offline||row.proof_txid||row.seller_ready_at&&Date.now()-row.seller_ready_at<sellerReadyWindow);
  const awaitingDelivery=direct?!ready:!!row.recipient_key&&!row.delivery_cipher;
  return {id:row.id,pointId:row.point_id,kind:'secret',address:awaitingDelivery?null:row.direct_address||row.address,amountAtomic:row.amount_atomic,awaitingDelivery,
    ...(direct?{direct:true,proofAddress:offline||row.seller_ready_at?row.direct_address:null,proofRecorded:!!row.proof_txid,paymentMessage:paymentMessage(row)}:{}),
    ...(offline?{offline:true,slot:row.offline_slot}:{}),
    ...(awaitingDelivery?{recipient:row.recipient_key}:{}),
    status:row.status==='released'?'expired':row.status,released:row.status==='released',receivedAtomic:row.received_atomic,confirmations:row.confirmations,
    requiredConfirmations:REQUIRED_CONFIRMATIONS,expiresAt:row.expires_at,opened:!!row.opened_at,
    readUntil:row.sold_at?row.sold_at+day:null,
    ...(row.title!==undefined?{title:row.title,readAvailable:!!(row.sold_at&&row.sold_at+day>Date.now()&&row.has_body)}:{})};
}

async function releaseConfirmedNote(db,env,row,proof,now) {
  if(!proof.good||proof.in_pool||proof.confirmations<REQUIRED_CONFIRMATIONS||
     proof.unlockedOutput!==true||atomic(proof.received)<atomic(row.amount_atomic))return;
  const listing=await db.prepare("SELECT d.offline_offer,r.txid,r.record FROM point_details d JOIN point_chain_records r ON r.point_id=d.point_id WHERE d.point_id=? AND r.operation='publish'")
    .bind(row.point_id).first();
  if(!listing?.offline_offer)return;
  const offer=JSON.parse(listing.offline_offer);
  const policy=await deliveryPolicy(env,offer);
  if(!policy)return;
  const delivery=await releaseNote(policy.operators,offer,{txid:listing.txid,record:listing.record},{
    slot:row.offline_slot,invoice:row.id,txid:row.proof_txid,proof:row.payment_proof,recipient:row.recipient_key
  },operatorProxy(env,policy));
  if(delivery.length<policy.threshold)return;
  await db.batch([
    db.prepare("UPDATE secret_purchases SET delivery_cipher=?,status='confirmed',sold_at=?,confirmations=?,last_checked=? WHERE id=? AND sold_at IS NULL AND proof_txid=? AND status!='released'")
      .bind(JSON.stringify(delivery),now,proof.confirmations,now,row.id,row.proof_txid),
    db.prepare('UPDATE points SET deleted=1 WHERE id=? AND '+soldCount+' >= (SELECT secret_copies FROM point_details WHERE point_id=points.id)').bind(row.point_id)
  ]);
}

async function checkPurchase(db,env,row) {
  const now=Date.now();
  if(row.direct_address){
    if(row.sold_at||row.status==='released'||now-row.last_checked<12000)return row;
    if(!row.proof_txid){
      if(now>=row.expires_at+paymentGrace)await db.prepare("UPDATE secret_purchases SET status='released' WHERE id=? AND proof_txid IS NULL").bind(row.id).run();
      return db.prepare('SELECT * FROM secret_purchases WHERE id=?').bind(row.id).first();
    }
    const proof=await directPayment(env,row,row.proof_txid,row.payment_proof);
    const confirmations=proof.good?Math.max(0,Number(proof.confirmations||0)):0;
    await db.prepare("UPDATE secret_purchases SET status=?,confirmations=?,last_checked=? WHERE id=? AND sold_at IS NULL")
      .bind(confirmations?'included':'seen',confirmations,now,row.id).run();
    if(row.offline_slot!=null)await releaseConfirmedNote(db,env,row,proof,now);
    return db.prepare('SELECT * FROM secret_purchases WHERE id=?').bind(row.id).first();
  }
  if(!row.address||row.sold_at||row.status==='released'||now-row.last_checked<12000)return row;
  const transfers=await rpc(env,'get_transfers',{account_index:0,subaddr_indices:[row.subaddress],expected_address:row.address});
  if(transfers.matchesAddress===false)return row;
  if(!Array.isArray(transfers.in)&&!Array.isArray(transfers.pool))fault(503,'Кошелёк вернул неверный ответ');
  const payment=evaluatePayment(transfers,row.amount_atomic);
  const unpaid=payment.receivedAtomic==='0';
  const status=payment.status==='confirmed'?'confirmed':unpaid&&now>=row.expires_at+paymentGrace?'released':
    now>=row.expires_at&&payment.status==='awaiting'?(unpaid?'expired':'partial'):payment.status;
  const confirmation=status==='confirmed'?now:null;
  await db.batch([
    db.prepare("UPDATE secret_purchases SET status=?,last_checked=?,received_atomic=?,confirmations=?,sold_at=? WHERE id=? AND sold_at IS NULL AND status!='released' AND last_checked<?")
      .bind(status,now,payment.receivedAtomic,payment.confirmations,confirmation,row.id,now),
    db.prepare('UPDATE points SET deleted=1 WHERE id=? AND '+soldCount+' >= COALESCE((SELECT secret_copies FROM point_details WHERE point_id=points.id),1)')
      .bind(row.point_id)
  ]);
  return db.prepare('SELECT * FROM secret_purchases WHERE id=?').bind(row.id).first();
}
async function directPayment(env,row,txid,proof){
  return rpc(env,'check_tx_proof',{txid,address:row.direct_address,message:paymentMessage(row),signature:proof});
}

async function reserveSecret(db,env,id,buyer,recipient,automatic) {
  if(typeof recipient!=='string'||!recipientFormat.test(recipient))fault(400,'Проверьте код получателя.');
  const now=Date.now();
  const point=await db.prepare("SELECT points.*,secret_price,sale_address,secret_copies,offline_offer FROM points JOIN point_details ON point_id=points.id WHERE points.id=? AND deleted=0 AND expires_at>? AND status IN ('free','confirmed') AND secret_price IS NOT NULL AND "+chainVisible+" AND NOT "+pendingWithdrawal+" AND NOT "+soldPoint)
    .bind(id,now).first();
  if(!point)fault(404,'Записка недоступна.');
  if(!point.note_cipher)fault(409,'Автору нужно заново опубликовать записку с шифрованием.');
  if(point.owner===buyer)fault(400,'Свою записку купить нельзя.');
  if(point.mode==='paid'){
    const publication=await db.prepare('SELECT invoices.*,points.status FROM invoices JOIN points ON points.id=invoices.point_id WHERE points.id=?').bind(id).first();
    if(!publication||(await invoiceStatus(db,env,publication)).status!=='confirmed')fault(409,'Публикация ещё подтверждается.');
  }
  let current=await db.prepare("SELECT * FROM secret_purchases WHERE point_id=? AND buyer=? AND (status!='released' OR sold_at IS NOT NULL)").bind(id,buyer).first();
  if((current?.address||current?.direct_address)&&now>=current.expires_at)current=await checkPurchase(db,env,current);
  if(current?.status==='reserving'&&now>=current.expires_at){
    await db.prepare("UPDATE secret_purchases SET status='released' WHERE id=? AND status='reserving' AND expires_at<=?").bind(current.id,now).run();
    current=await db.prepare('SELECT * FROM secret_purchases WHERE id=?').bind(current.id).first();
  }
  if(current&&current.status!=='released'){
    if(!current.address&&!current.direct_address)fault(409,'Записка уже зарезервирована.');
    if(automatic&&!current.direct_address&&!current.delivery_cipher)fault(409,'Продавцу нужно открыть карту в обновлённом кошельке.');
    if(recipientMaterial(current.recipient_key)!==recipientMaterial(recipient))fault(409,'Счёт привязан к исходному коду получателя.');
    return {...purchaseInvoice(current),...(current.offline_slot!=null?{offer:JSON.parse(point.offline_offer)}:{})};
  }
  if(automatic&&!point.sale_address&&!point.offline_offer)fault(409,'Продавцу нужно открыть карту в обновлённом кошельке.');
  await rate(db,'buy:'+buyer,8);
  const invoiceId=crypto.randomUUID();
  if(point.offline_offer){
    const offer=JSON.parse(point.offline_offer);
    const policy=await deliveryPolicy(env,offer);
    if(!policy||await availableNoteOperators(policy.operators,operatorProxy(env,policy))<policy.threshold)
      fault(503,'Encrypted note sales are unavailable.');
    const reserved=await db.prepare(`INSERT OR IGNORE INTO secret_purchases(id,point_id,buyer,amount_atomic,expires_at,recipient_key,direct_address,offline_slot,status)
      SELECT ?,points.id,?,?,?,?,candidate.value,candidate.key,'awaiting'
      FROM points JOIN point_details ON point_details.point_id=points.id, json_each(point_details.offline_offer,'$.addresses') candidate
      WHERE points.id=? AND deleted=0 AND expires_at>? AND status IN ('free','confirmed') AND `+chainVisible+' AND NOT '+pendingWithdrawal+
      ` AND NOT EXISTS(SELECT 1 FROM secret_purchases s WHERE s.point_id=points.id AND s.offline_slot=candidate.key
       AND (s.status!='released' OR s.sold_at IS NOT NULL)) ORDER BY candidate.key LIMIT 1`)
      .bind(invoiceId,buyer,point.secret_price,now+hour,recipient,id,now).run();
    if(reserved.meta.changes!==1)fault(409,'Записка уже зарезервирована.');
    return {...purchaseInvoice(await db.prepare('SELECT * FROM secret_purchases WHERE id=?').bind(invoiceId).first()),offer};
  }
  const reserved=await db.prepare("INSERT OR IGNORE INTO secret_purchases(id,point_id,buyer,amount_atomic,expires_at,recipient_key,direct_address,status) SELECT ?,points.id,?,?,?,?,?,? FROM points JOIN point_details ON point_id=points.id WHERE points.id=? AND deleted=0 AND expires_at>? AND status IN ('free','confirmed') AND "+occupiedCount+' < point_details.secret_copies AND NOT '+pendingWithdrawal)
    .bind(invoiceId,buyer,point.secret_price,now+(point.sale_address?hour:60000),recipient,point.sale_address,point.sale_address?'awaiting':'reserving',id,now).run();
  if(reserved.meta.changes!==1)fault(409,'Записка уже зарезервирована.');
  if(point.sale_address)return purchaseInvoice(await db.prepare('SELECT * FROM secret_purchases WHERE id=?').bind(invoiceId).first());
  try{
    const address=await paymentAddress(env,'Noticoin secret '+invoiceId);
    const saved=await db.prepare("UPDATE secret_purchases SET address=?,subaddress=?,status='awaiting',expires_at=? WHERE id=? AND status='reserving'")
      .bind(address.address,address.address_index,Date.now()+hour,invoiceId).run();
    if(saved.meta.changes!==1)fault(409,'Записка уже зарезервирована.');
  }catch(error){
    await db.prepare("UPDATE secret_purchases SET status='released' WHERE id=? AND status='reserving'").bind(invoiceId).run();
    throw error;
  }
  return purchaseInvoice(await db.prepare('SELECT * FROM secret_purchases WHERE id=?').bind(invoiceId).first());
}

async function purgeSecrets(db,now) {
  await db.batch([
    db.prepare("UPDATE secret_purchases SET status='released' WHERE status='reserving' AND expires_at<=?").bind(now),
    db.prepare("UPDATE points SET body='' WHERE body!='' AND id IN (SELECT point_id FROM secret_purchases WHERE sold_at<=?)").bind(now-day),
    db.prepare("UPDATE points SET body='' WHERE body GLOB 'noticoin-public-note-v1.*' AND (expires_at<=? OR deleted=1)").bind(now),
    db.prepare("UPDATE points SET note_cipher=NULL WHERE note_cipher IS NOT NULL AND (expires_at<=? OR deleted=1) AND NOT EXISTS (SELECT 1 FROM secret_purchases WHERE point_id=points.id AND status!='released' AND (sold_at IS NULL OR sold_at>?))").bind(now,now-day),
    db.prepare("UPDATE point_details SET offline_offer=NULL WHERE offline_offer IS NOT NULL AND EXISTS(SELECT 1 FROM points WHERE id=point_details.point_id AND note_cipher IS NULL)"),
    db.prepare('UPDATE secret_purchases SET delivery_cipher=NULL WHERE delivery_cipher IS NOT NULL AND (sold_at<=? OR status=\'released\')').bind(now-day),
    db.prepare("UPDATE points SET body='' WHERE body!='' AND (expires_at<=? OR deleted=1) AND id IN (SELECT point_id FROM point_details WHERE secret_price IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM secret_purchases WHERE point_id=points.id AND status!='released')").bind(now)
  ]);
}

export async function handleApi(request, env) {
 env=noticoinEnvironment(env);
  try {
    const url=new URL(request.url), path=url.pathname, db=env.DB;
    if(request.method==='POST'&&request.headers.get('origin')&&request.headers.get('origin')!==url.origin) fault(403,'Запрос должен идти с сайта Noticoin');
    const paymentsEnabled=!!(env.NOTICOIN_BRIDGE_URL&&env.NOTICOIN_FUND_BRIDGE_TOKEN);
    const secretPaymentsEnabled=!!(env.NOTICOIN_BRIDGE_URL&&env.NOTICOIN_BRIDGE_TOKEN);
    const chainAnchors=env.NOTICOIN_MAP_CHAIN_ANCHORS==='1';
    const readOnly=env.NOTICOIN_MAP_READ_ONLY==='1';
    if(path==='/api/config'){
      const {policy,height}=chainAnchors&&secretPaymentsEnabled?await publicationPolicy(env):{};
      return json({name:'Noticoin',networkVersion:NETWORK_VERSION,targetBlockSeconds:45,requiredConfirmations:REQUIRED_CONFIRMATIONS,priceAtomic:PRICE_ATOMIC,saleWeekPriceAtomic:saleWeekPrice,iconPrices,secretMinimumAtomic:'10000000',decimals:DECIMALS,paymentsEnabled,secretPaymentsEnabled,chainAnchors,readOnly,encryptedNotes:true,publicNotes:true,
        chainHeight:height,noteRegistry:env.NOTI_NOTE_REGISTRY==='1',offlineNotePolicy:publicNotePolicy(policy),
        offlineNoteOperators:policy?.keys??[],freeDays:7,paidDays:30});
    }
    if(readOnly&&request.method!=='GET'&&request.method!=='HEAD') fault(503,'Map publishing is temporarily unavailable.');
    if(!db) fault(503,'База точек ещё не подключена');
    const venuePath=path.match(/^\/api\/venues\/(omt-[1-9]\d{0,15}|geo-[a-f0-9]{32})\/reviews(\/mine)?$/);
    if(venuePath){
      const [,venue,mine]=venuePath;
      if(request.method==='GET'&&!mine) return json(await reviewsFor(db,venue));
      if(request.method==='POST'){
        const {owner,payload}=await signed(request,db,mine?'read-review':'review');
        if(payload.venue!==venue) fault(400,'Проверьте заведение и оценку от 1 до 5.');
        if(mine){
          const review=await db.prepare('SELECT '+reviewColumns+' FROM venue_reviews WHERE venue_id=? AND owner=?').bind(venue,owner).first();
          return json({review});
        }
        if(!Number.isInteger(payload.rating)||payload.rating<1||payload.rating>5||
           typeof payload.body!=='string'||payload.body.length>500)
          fault(400,'Проверьте заведение и оценку от 1 до 5.');
        await rate(db,'review:'+owner,20);
        const now=Date.now();
        const body=payload.body.trim();
        await db.prepare('INSERT INTO venue_reviews(venue_id,owner,rating,body,created_at,updated_at) VALUES(?,?,?,?,?,?) '+
          'ON CONFLICT(venue_id,owner) DO UPDATE SET rating=excluded.rating,body=excluded.body,updated_at=excluded.updated_at')
          .bind(venue,owner,payload.rating,body,now,now).run();
        return json(await reviewsFor(db,venue));
      }
      return json({error:'Не найдено'},405);
    }
    if(path==='/api/internal/reconcile'&&request.method==='POST') {
      const wallet=url.searchParams.get('wallet')||'legacy';
      if(!['legacy','fund'].includes(wallet)||!bridgeToken(env,wallet)||request.headers.get('authorization')!=='Bearer '+bridgeToken(env,wallet)) fault(403,'Нет доступа');
      const invoices=await all(db.prepare('SELECT invoices.*,points.status FROM invoices JOIN points ON points.id=invoices.point_id WHERE invoices.wallet=? AND points.deleted=0 AND points.expires_at>? AND invoices.last_checked<? ORDER BY invoices.last_checked LIMIT 20').bind(wallet,Date.now(),Date.now()-15000));
      let updated=0,deferred=0;
      async function reconcile(check){
        try{await check();updated++;}
        catch(error){if(error.status!==503)throw error;deferred++;}
      }
      for(const invoice of invoices)await reconcile(()=>invoiceStatus(db,env,invoice));
      if(wallet==='fund'&&chainAnchors){
        const records=await all(db.prepare('SELECT r.*,p.mode,d.offline_offer FROM point_chain_records r JOIN points p ON p.id=r.point_id LEFT JOIN point_details d ON d.point_id=p.id WHERE p.deleted=0 AND p.expires_at>? AND r.last_checked<? ORDER BY r.last_checked LIMIT 20')
          .bind(Date.now(),Date.now()-15000));
        for(const row of records)await reconcile(async()=>{
          const confirmations=await chainConfirmations(db,env,row);
          await db.prepare('UPDATE point_chain_records SET confirmations=?,last_checked=? WHERE point_id=? AND operation=? AND txid=?')
            .bind(Math.max(confirmations??0,0),Date.now(),row.point_id,row.operation,row.txid).run();
        });
      }
      if(wallet==='legacy'){
        const purchases=await all(db.prepare("SELECT * FROM secret_purchases WHERE (address IS NOT NULL OR proof_txid IS NOT NULL OR (direct_address IS NOT NULL AND expires_at+1800000<=?)) AND sold_at IS NULL AND status!='released' AND last_checked<? ORDER BY last_checked LIMIT 20").bind(Date.now(),Date.now()-15000));
        for(const purchase of purchases)await reconcile(()=>checkPurchase(db,env,purchase));
      }
      await purgeSecrets(db,Date.now());
      await db.batch([db.prepare('DELETE FROM nonces WHERE expires_at<?').bind(Date.now()),db.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now())]);
      return json(deferred?{updated,deferred}:{updated},deferred&&!updated?503:200);
    }
    if(path==='/api/search'&&request.method==='GET') {
      const query=(url.searchParams.get('q')||'').trim();if(query.length<2||query.length>100) fault(400,'Введите название места');
      const cached=await db.prepare('SELECT response FROM geocode_cache WHERE query=? AND expires_at>?').bind(query.toLowerCase(),Date.now()).first();if(cached)return json(JSON.parse(cached.response));
      const gate=await db.prepare('INSERT OR IGNORE INTO rate_limits(id,hits,expires_at) VALUES(?,1,?)').bind('geocode:'+Math.floor(Date.now()/1000),Date.now()+60000).run();if(gate.meta.changes!==1)fault(429,'Подождите секунду и повторите поиск');
      const target=new URL(env.NOTICOIN_GEOCODER_URL||'https://photon.komoot.io/api/');target.searchParams.set('q',query);target.searchParams.set('limit','5');target.searchParams.set('lang','en');
      let response;try{response=await fetch(target,{headers:{'User-Agent':'Noticoin Map/0.1 ('+url.origin+')'},signal:AbortSignal.timeout(10000)});}catch{fault(503,'Поиск мест временно недоступен. Можно ввести координаты: широта, долгота.');}
      if(!response.ok)fault(503,'Поиск мест временно недоступен');const raw=await response.json();
      if(!Array.isArray(raw.features))fault(503,'Поиск вернул неполный ответ');
      const data={results:raw.features.map(p=>({name:p.properties.name||p.properties.city||query,description:[p.properties.city,p.properties.state,p.properties.country].filter(Boolean).join(', '),lng:Number(p.geometry.coordinates[0]),lat:Number(p.geometry.coordinates[1])})),attribution:'© OpenStreetMap contributors'};
      await db.prepare('INSERT INTO geocode_cache(query,response,expires_at) VALUES(?,?,?) ON CONFLICT(query) DO UPDATE SET response=excluded.response,expires_at=excluded.expires_at').bind(query.toLowerCase(),JSON.stringify(data),Date.now()+day).run();return json(data);
    }
    if(path==='/api/points'&&request.method==='GET') {
      const bbox=(url.searchParams.get('bbox')||'-180,-85,180,85').split(',').map(Number);
      if(bbox.length!==4||bbox.some(n=>!Number.isFinite(n))||bbox[1]>bbox[3]) fault(400,'Неверная область карты');
      const [west,south,east,north]=bbox;
      const q=(url.searchParams.get('q')||'').slice(0,80),category=url.searchParams.get('category'),venue=url.searchParams.get('venue');
      const where=["deleted=0",visiblePoint,chainVisible,'NOT '+soldPoint,"points.status IN ('free','seen','included','confirmed')",'lat BETWEEN ? AND ?',west<=east?'lng BETWEEN ? AND ?':'(lng>=? OR lng<=?)'];
      const args=[Date.now(),Math.max(-85,south),Math.min(85,north),west,east];
      if(categories.has(category)){
        where.push(pointCategory+'=?');args.push(category);
      }
      if(venue){
        if(!venueFormat.test(venue))fault(400,'Проверьте место.');
        where.push('point_details.venue_id=?');args.push(venue);
      }
      if(q){where.push('title LIKE ?');args.push('%'+q+'%');}
      const scan=url.searchParams.get('scan')==='1';
      const cursor=url.searchParams.get('cursor');
      if(cursor!==null){
        const match=/^(\d{1,16}):([a-f0-9-]{36})$/.exec(cursor);
        if(!scan||!match||!Number.isSafeInteger(Number(match[1])))fault(400,'Invalid map page cursor.');
        where.push('(points.created_at,points.id) < (?,?)');
        args.push(Number(match[1]),match[2]);
      }
      const limit=scan?500:2000;
      const rows=await all(db.prepare('SELECT '+pointColumns+', (SELECT last_checked FROM invoices WHERE point_id=points.id) AS payment_checked_at FROM '+annotatedPoints+' WHERE '+where.join(' AND ')+' ORDER BY points.created_at DESC,points.id DESC LIMIT ?').bind(...args,limit+1));
      const truncated=rows.length>limit;
      const last=rows[limit-1];
      return json({points:rows.slice(0,limit).map(publicPoint),truncated,
        ...(scan?{nextCursor:truncated?last.created_at+':'+last.id:null}:{})});
    }
    if(path==='/api/points'&&request.method==='POST') {
      const {owner,payload:p}=await signed(request,db,'create');
      if(chainAnchors&&(!paymentsEnabled||p.chainRecord!==true))
        fault(503,'Для записи метки нужен обновлённый кошелёк Noticoin.');
      if(typeof p.id!=='string'||!uuid.test(p.id)||!noteCipher(p.cipher)||Object.hasOwn(p,'body')||Object.hasOwn(p,'donationNote'))fault(400,'Записку нужно зашифровать в кошельке.');
      if(typeof p.title!=='string'||p.title.trim().length<2||p.title.length>64||!categories.has(p.category)||!Number.isFinite(p.lat)||Math.abs(p.lat)>85||!Number.isFinite(p.lng)||Math.abs(p.lng)>180||!['free','paid','permanent'].includes(p.mode)) fault(400,'Проверьте текст и координаты');
      const existing=await db.prepare('SELECT '+pointColumns+' FROM '+annotatedPoints+' WHERE points.id=?').bind(p.id).first();
      if(existing){
        if(existing.owner!==owner||existing.note_cipher!==p.cipher||existing.deleted||existing.expires_at<=Date.now())fault(409,'Такая метка уже существует.');
        const invoiceRow=await db.prepare('SELECT id,address,amount_atomic AS amountAtomic,expires_at AS expiresAt FROM invoices WHERE point_id=?').bind(p.id).first();
        const chainRow=await db.prepare("SELECT txid,record,confirmations FROM point_chain_records WHERE point_id=? AND operation='publish'").bind(p.id).first();
        let invoice=invoiceRow;
        if(existing.chain_required){
          invoice=chainRow?.confirmations>=REQUIRED_CONFIRMATIONS?null:mapInvoice(p.id,'publish',existing.created_at+hour,invoiceRow);
          if(invoice&&chainRow?.txid)Object.assign(invoice,chainRow,{submitted:true,status:chainRow.confirmations?'included':'seen'});
        }else if(existing.status==='confirmed')invoice=null;
        return json({point:publicPoint(existing),invoice},201);
      }
      const venue=p.venueId??null,venueName=p.venueName??null;
      if(venue!==null&&(typeof venue!=='string'||!venueFormat.test(venue)||typeof venueName!=='string'||!venueName.trim()||venueName.length>128))
        fault(400,'Проверьте место.');
      const icon=p.icon??'default';
      if(!Object.hasOwn(iconPrices,icon))fault(400,'Выберите значок точки.');
      const donation=p.donationAddress??'';
      const secretPrice=p.category==='secret'||p.secretPriceAtomic!=null?coinAmount(p.secretPriceAtomic,10000000n):null;
      const copies=p.secretCopies??1, saleAddress=p.saleAddress??null;
      if(!Number.isSafeInteger(copies)||copies<1||copies>100||(!secretPrice&&(saleAddress||copies!==1))||
         (saleAddress!==null&&(typeof saleAddress!=='string'||!donationFormat.test(saleAddress)))||(copies>1&&!saleAddress&&!p.offlineOffer))
        fault(400,'Укажите от 1 до 100 копий и проверьте адрес продавца.');
      let offlineOffer=null;
      if(p.offlineOffer!==undefined){
        const offer=p.offlineOffer;
        if(!chainAnchors||(!env.notePolicies?.length&&env.NOTI_NOTE_REGISTRY!=='1'))fault(503,'Encrypted note sales are unavailable.');
        let committedId;
        try {committedId=await offlinePointId(offer);}catch {}
        if(committedId!==p.id||saleAddress||!secretPrice||offer.amountAtomic!==secretPrice||offer.addresses.length!==copies)
          fault(400,'Invalid encrypted note offer.');
        const {policy}=await publicationPolicy(env);
        if(!policy)fault(503,'Encrypted note sales are unavailable.');
        if(!publicationPolicyMatches(offer,policy)||offer.registry&&!policyMatches(offer,policy)&&!await deliveryPolicy(env,offer))
          fault(409,'The note operator set changed. Create the publication again.');
        const {nonce,addresses,amountAtomic,operators,ciphertext,custody,epoch,threshold,shareHashes,registry}=offer;
        offlineOffer=JSON.stringify({nonce,addresses,amountAtomic,operators,ciphertext,custody,epoch,threshold,shareHashes,registry});
      }else if(secretPrice&&(env.NOTI_NOTE_REGISTRY==='1'||env.notePolicies?.length>1&&(await publicationPolicy(env)).policy.height>0)){
        fault(409,'The note operator set changed. Create the publication again.');
      }
      if(typeof donation!=='string'||(donation&&!donationFormat.test(donation))||(!donation&&p.donationAmountAtomic)||(secretPrice&&donation))
        fault(400,'Проверьте адрес Noticoin для донатов.');
      const donationAmount=p.donationAmountAtomic?coinAmount(p.donationAmountAtomic,1n):null;
      const displayPrice=p.displayPriceAtomic===undefined||p.displayPriceAtomic===null?null:coinAmount(p.displayPriceAtomic,1n);
      if(secretPrice&&displayPrice)fault(400,'Укажите только цену открытия записки.');
      if(p.publicNote!==undefined&&(secretPrice||donation||displayPrice||!publicNoteCipher(p.publicNote)))
        fault(400,'Не удалось подготовить публичную записку.');
      if(secretPrice&&!secretPaymentsEnabled)fault(503,'Для секретной записки нужно подключить оплату Noticoin.');
      if(!chainAnchors)await rate(db,'create:'+owner,5);
      const ip=request.headers.get('cf-connecting-ip');
      if(ip) await rate(db,'ip:'+await hash((env.RATE_LIMIT_SALT||url.hostname)+ip+new Date().toISOString().slice(0,10)),20);
      const id=p.id,now=Date.now(),duration=p.mode==='paid'?30:7;
      const total=publicationBase(p.mode,!!secretPrice)+atomic(iconPrices[icon]);
      let invoice=null;
      if(total){
        const address=await paymentAddress(env,'Noticoin map '+id,'fund');
        invoice={id:crypto.randomUUID(),address:address.address,subaddress:address.address_index,amountAtomic:String(total),expiresAt:now+hour};
      }
      const statements=[
        db.prepare('INSERT INTO points(id,owner,title,body,category,lat,lng,mode,status,created_at,expires_at,chain_required,note_cipher) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id,owner,p.title.trim(),p.publicNote??'',baseCategories.has(p.category)?p.category:'place',p.lat,p.lng,total?'paid':'free',total?'awaiting':'free',now,now+duration*day,chainAnchors?1:0,p.cipher),
        db.prepare('INSERT INTO point_details(point_id,category,venue_id,venue_name,icon,duration_days,donation_address,donation_amount,donation_note,secret_price,display_price,secret_copies,sale_address,offline_offer) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id,p.category,venue,venue?venueName.trim():null,icon,duration,donation||null,donationAmount,null,secretPrice,displayPrice,copies,saleAddress,offlineOffer)
      ];
      if(invoice)statements.push(db.prepare("INSERT INTO invoices(id,point_id,address,subaddress,amount_atomic,created_at,expires_at,wallet) VALUES(?,?,?,?,?,?,?,'fund')")
        .bind(invoice.id,id,invoice.address,invoice.subaddress,invoice.amountAtomic,now,invoice.expiresAt));
      await db.batch(statements);
      if(invoice)delete invoice.subaddress;
      if(chainAnchors)invoice=mapInvoice(id,'publish',now+hour,invoice);
      return json({point:publicPoint(await db.prepare('SELECT '+pointColumns+' FROM '+annotatedPoints+' WHERE points.id=?').bind(id).first()),invoice},201);
    }
    const anchorMatch=path.match(/^\/api\/points\/([a-f0-9-]{36})\/anchor$/);
    if(anchorMatch&&request.method==='POST'){
      const id=anchorMatch[1],{owner,publicKey,payload}=await signed(request,db,'anchor-point');
      const {operation,txid,record}=payload;
      if(!['publish','withdraw'].includes(operation)||typeof txid!=='string'||!/^[a-f0-9]{64}$/.test(txid)
        ||!await authorizedRecord(record,id,operation,publicKey))fault(400,'Неверная подпись записи метки.');
      const point=await db.prepare('SELECT owner,mode,chain_required,offline_offer FROM '+annotatedPoints+' WHERE points.id=? AND deleted=0 AND expires_at>?').bind(id,Date.now()).first();
      if(!point?.chain_required||point.owner!==owner)fault(403,'Записать изменение может только автор.');
      if(operation==='withdraw'){
        const publication=await db.prepare("SELECT 1 FROM point_chain_records WHERE point_id=? AND operation='publish' AND confirmations>=3").bind(id).first();
        if(!publication)fault(409,'Публикация ещё подтверждается.');
        const reservation=await db.prepare("SELECT 1 FROM secret_purchases WHERE point_id=? AND status!='released' AND sold_at IS NULL").bind(id).first();
        if(reservation)fault(409,'Записка уже зарезервирована.');
      }
      const confirmations=await chainConfirmations(db,env,{point_id:id,mode:point.mode,offline_offer:point.offline_offer,operation,txid,record});
      if(confirmations===-1)fault(409,'The note operator set changed. Create the publication again.');
      if(confirmations===null)return json({status:'seen',confirmations:0,requiredConfirmations:REQUIRED_CONFIRMATIONS});
      const updated=await db.prepare('INSERT INTO point_chain_records(point_id,operation,txid,record,confirmations,last_checked) VALUES(?,?,?,?,?,?) '+
        'ON CONFLICT(point_id,operation) DO UPDATE SET txid=excluded.txid,record=excluded.record,confirmations=excluded.confirmations,last_checked=excluded.last_checked '+
        'WHERE point_chain_records.txid=excluded.txid OR point_chain_records.confirmations=0')
        .bind(id,operation,txid,record,confirmations,Date.now()).run();
      if(!updated.meta.changes)fault(409,'Запись этой метки уже подтверждена.');
      return json({status:confirmations>=REQUIRED_CONFIRMATIONS?'confirmed':confirmations?'included':'seen',confirmations,requiredConfirmations:REQUIRED_CONFIRMATIONS});
    }
    const buyMatch=path.match(/^\/api\/points\/([a-f0-9-]{36})\/buy$/);
    if(buyMatch&&request.method==='POST'){
      const {owner,payload}=await signed(request,db,'buy');
      return json(await reserveSecret(db,env,buyMatch[1],owner,payload.recipient,payload.automatic===true),201);
    }
    const saleMatch=path.match(/^\/api\/points\/([a-f0-9-]{36})\/direct-sales$/);
    if(saleMatch&&request.method==='POST'){
      const {owner,payload}=await signed(request,db,'direct-sales');
      if(typeof payload.address!=='string'||!donationFormat.test(payload.address)||!noteCipher(payload.cipher))fault(400,'Проверьте адрес продавца.');
      const id=saleMatch[1];
      const old=await db.prepare("SELECT secret_price FROM "+annotatedPoints+" WHERE points.id=? AND owner=? AND deleted=0 AND sale_address IS NULL AND offline_offer IS NULL AND note_cipher IS NOT NULL").bind(id,owner).first();
      if(!old||old.secret_price!==payload.amountAtomic)fault(409,'Продажа этой записки уже настроена.');
      const results=await db.batch([
        db.prepare("UPDATE secret_purchases SET status='released' WHERE point_id=? AND direct_address IS NULL AND delivery_cipher IS NULL AND sold_at IS NULL AND received_atomic='0' AND status IN ('awaiting','reserving')").bind(id),
        db.prepare("UPDATE point_details SET sale_address=? WHERE point_id=? AND sale_address IS NULL AND NOT EXISTS(SELECT 1 FROM secret_purchases WHERE point_id=point_details.point_id AND (status!='released' OR sold_at IS NOT NULL))").bind(payload.address,id),
        db.prepare('UPDATE points SET note_cipher=? WHERE id=? AND EXISTS (SELECT 1 FROM point_details WHERE point_id=points.id AND sale_address=?)').bind(payload.cipher,id,payload.address),
      ]);
      if(!results[1].meta.changes)fault(409,'Продажа этой записки уже настроена.');
      return json({ok:true});
    }
    const authorNote=path.match(/^\/api\/points\/([a-f0-9-]{36})\/note$/);
    if(authorNote&&request.method==='POST'){
      const {owner}=await signed(request,db,'read-my-note');
      const record=await db.prepare('SELECT note_cipher AS cipher FROM points WHERE id=? AND owner=? AND deleted=0 AND expires_at>?').bind(authorNote[1],owner,Date.now()).first();
      if(!record?.cipher)fault(404,'Записка недоступна.');
      return json(record);
    }
    const publicNote=path.match(/^\/api\/points\/([a-f0-9-]{36})\/public-note$/);
    if(publicNote&&request.method==='GET'){
      const row=await db.prepare("SELECT points.body FROM "+annotatedPoints+" WHERE points.id=? AND deleted=0 AND status IN ('free','confirmed') AND secret_price IS NULL AND donation_address IS NULL AND display_price IS NULL AND "+visiblePoint+" AND "+chainVisible+" AND NOT "+pendingWithdrawal)
        .bind(publicNote[1],Date.now()).first();
      if(!publicNoteCipher(row?.body))fault(404,'Записка недоступна.');
      return json({packet:row.body});
    }
    const deliveryMatch=path.match(/^\/api\/secret-purchases\/([a-f0-9-]{36})\/deliver$/);
    if(deliveryMatch&&request.method==='POST'){
      const {owner,payload}=await signed(request,db,'deliver-note');
      if(!noteCipher(payload.cipher)||typeof payload.recipient!=='string'||!recipientFormat.test(payload.recipient))fault(400,'Проверьте код получателя.');
      const order=await db.prepare('SELECT s.* FROM secret_purchases s JOIN points p ON p.id=s.point_id WHERE s.id=? AND p.owner=?').bind(deliveryMatch[1],owner).first();
      if(order?.offline_slot!=null)fault(409,'This note is released automatically.');
      if(order?.direct_address){
        if(order.recipient_key!==payload.recipient||!order.proof_txid||order.status==='released')fault(409,'Счёт недоступен или получатель изменился.');
        if(order.sold_at)return json({ok:true});
        const paid=await directPayment(env,order,order.proof_txid,order.payment_proof);
        if(!paid.good||paid.in_pool||Number(paid.confirmations)<REQUIRED_CONFIRMATIONS||atomic(paid.received)<atomic(order.amount_atomic))fault(409,'Дождитесь подтверждения оплаты.');
        await db.batch([
          db.prepare("UPDATE secret_purchases SET delivery_cipher=?,status='confirmed',sold_at=?,confirmations=? WHERE id=? AND sold_at IS NULL AND proof_txid=?")
            .bind(payload.cipher,Date.now(),Number(paid.confirmations),order.id,order.proof_txid),
          db.prepare('UPDATE points SET deleted=1 WHERE id=? AND '+soldCount+' >= (SELECT secret_copies FROM point_details WHERE point_id=points.id)').bind(order.point_id),
        ]);
        return json({ok:true});
      }
      const result=await db.prepare("UPDATE secret_purchases SET delivery_cipher=?,expires_at=? WHERE id=? AND recipient_key=? AND delivery_cipher IS NULL AND status='awaiting' AND expires_at>? AND point_id IN (SELECT id FROM points WHERE owner=? AND note_cipher IS NOT NULL AND deleted=0 AND expires_at>?)")
        .bind(payload.cipher,Date.now()+hour,deliveryMatch[1],payload.recipient,Date.now(),owner,Date.now()).run();
      if(!result.meta.changes)fault(409,'Счёт недоступен или получатель изменился.');
      return json({ok:true});
    }
    const proofMatch=path.match(/^\/api\/secret-purchases\/([a-f0-9-]{36})\/payment$/);
    if(proofMatch&&request.method==='POST'){
      const {owner,payload}=await signed(request,db,'note-payment');
      if(typeof payload.txid!=='string'||!/^[a-f0-9]{64}$/.test(payload.txid)||typeof payload.proof!=='string'||!/^OutProofV[12][1-9A-HJ-NP-Za-km-z]{16,4000}$/.test(payload.proof))fault(400,'Проверьте доказательство оплаты.');
      const row=await db.prepare("SELECT * FROM secret_purchases WHERE id=? AND buyer=? AND direct_address IS NOT NULL AND (offline_slot IS NOT NULL OR seller_ready_at IS NOT NULL) AND status!='released'").bind(proofMatch[1],owner).first();
      if(!row)fault(404,'Счёт не найден');
      if(row.proof_txid===payload.txid&&row.payment_proof===payload.proof)return json({ok:true});
      if(row.proof_txid)fault(409,'Оплата этого счёта уже зарегистрирована.');
      const payment=await directPayment(env,row,payload.txid,payload.proof);
      if(!payment.good||atomic(payment.received)<atomic(row.amount_atomic))fault(409,'Проверьте сумму перевода и подтверждение.');
      const confirmations=payment.in_pool?0:Number(payment.confirmations||0);
      const result=await db.prepare("UPDATE OR IGNORE secret_purchases SET proof_txid=?,payment_proof=?,received_atomic=?,confirmations=?,status=?,last_checked=? WHERE id=? AND proof_txid IS NULL AND status!='released'")
        .bind(payload.txid,payload.proof,String(payment.received),confirmations,confirmations?'included':'seen',Date.now(),row.id).run();
      if(!result.meta.changes)fault(409,'Эта транзакция уже зарегистрирована.');
      return json({ok:true});
    }
    if(path==='/api/secret-purchases/ready'&&request.method==='POST'){
      const {owner}=await signed(request,db,'seller-ready');
      await db.prepare("UPDATE secret_purchases SET seller_ready_at=? WHERE offline_slot IS NULL AND direct_address IS NOT NULL AND proof_txid IS NULL AND status='awaiting' AND point_id IN (SELECT id FROM points WHERE owner=? AND deleted=0 AND expires_at>?)")
        .bind(Date.now(),owner,Date.now()).run();
      return json({ok:true});
    }
    if(path==='/api/secret-purchases'&&request.method==='POST'){
      const {owner}=await signed(request,db,'purchase-history');
      const [purchases,sales,deliveries,legacyListings,waiting]=await Promise.all([
        all(db.prepare("SELECT s.*,p.title,s.delivery_cipher IS NOT NULL AS has_body FROM secret_purchases s JOIN points p ON p.id=s.point_id "+
          "WHERE s.buyer=? AND (s.address IS NOT NULL OR s.direct_address IS NOT NULL) AND s.status!='released' ORDER BY COALESCE(s.sold_at,s.expires_at) DESC LIMIT 120").bind(owner)),
        all(db.prepare("SELECT p.id AS pointId,p.title,s.amount_atomic AS amountAtomic,s.sold_at AS paidAt FROM secret_purchases s "+
          "JOIN points p ON p.id=s.point_id WHERE p.owner=? AND s.sold_at IS NOT NULL ORDER BY s.sold_at DESC LIMIT 50").bind(owner)),
        all(db.prepare("SELECT s.*,p.id AS pointId,p.title,p.note_cipher AS cipher,s.recipient_key AS recipient FROM secret_purchases s JOIN points p ON p.id=s.point_id "+
          "WHERE p.owner=? AND p.note_cipher IS NOT NULL AND s.sold_at IS NULL AND s.delivery_cipher IS NULL AND s.recipient_key IS NOT NULL AND s.offline_slot IS NULL AND "+
          "((s.direct_address IS NOT NULL AND s.proof_txid IS NOT NULL AND s.confirmations>=3) OR (s.direct_address IS NULL AND p.deleted=0 AND p.expires_at>? AND s.expires_at>? AND s.status='awaiting')) LIMIT 20").bind(owner,Date.now(),Date.now())),
        all(db.prepare("SELECT points.id,point_details.secret_price AS amountAtomic FROM "+annotatedPoints+" WHERE points.owner=? AND points.deleted=0 AND points.expires_at>? AND point_details.secret_price IS NOT NULL AND point_details.sale_address IS NULL AND point_details.offline_offer IS NULL AND NOT EXISTS(SELECT 1 FROM secret_purchases WHERE point_id=points.id AND (sold_at IS NOT NULL OR (status!='released' AND (delivery_cipher IS NOT NULL OR received_atomic!='0')))) LIMIT 8").bind(owner,Date.now())),
        db.prepare("SELECT 1 AS waiting FROM secret_purchases s JOIN points p ON p.id=s.point_id WHERE p.owner=? AND p.deleted=0 AND p.expires_at>? AND s.offline_slot IS NULL AND s.direct_address IS NOT NULL AND s.proof_txid IS NULL AND s.status='awaiting' AND s.expires_at>? LIMIT 1").bind(owner,Date.now(),Date.now()).first(),
      ]);
      return json({purchases:purchases.map(purchaseInvoice),sales,legacyListings,sellerWaiting:!!waiting,
        deliveries:deliveries.map(row=>({id:row.id,pointId:row.pointId,title:row.title,cipher:row.cipher,recipient:row.recipient,
          ...(row.direct_address?{direct:true,address:row.direct_address,amountAtomic:row.amount_atomic,txid:row.proof_txid,proof:row.payment_proof,paymentMessage:paymentMessage(row)}:{})}))});
    }
    const purchaseMatch=path.match(/^\/api\/secret-purchases\/([a-f0-9-]{36})(?:\/(read|erase))?$/);
    if(purchaseMatch&&request.method==='POST'){
      const [,id,action]=purchaseMatch,{owner,payload}=await signed(request,db,action?'secret-'+action:'secret-status');
      const row=await db.prepare("SELECT s.*,p.title,s.delivery_cipher IS NOT NULL AS has_body FROM secret_purchases s "+
        "JOIN points p ON p.id=s.point_id WHERE s.id=? AND s.buyer=?").bind(id,owner).first();
      if(!row)fault(404,'Счёт не найден');
      if(!action){
        const current=await checkPurchase(db,env,row);
        return json(purchaseInvoice({...current,title:row.title,has_body:!!current.delivery_cipher}));
      }
      const current=row.sold_at?row:await checkPurchase(db,env,row);
      if(!current.sold_at)fault(409,'Дождитесь подтверждения оплаты.');
      if(action==='read'){
        const now=Date.now();
        if(!current.delivery_cipher||current.sold_at+day<=now){await purgeSecrets(db,now);fault(410,'Записка уже уничтожена.');}
        if(payload.downloadOnly!==true)
          await db.prepare('UPDATE secret_purchases SET opened_at=COALESCE(opened_at,?) WHERE id=?').bind(now,id).run();
        if(current.offline_slot!=null){
          const listing=await db.prepare('SELECT offline_offer FROM point_details WHERE point_id=?').bind(current.point_id).first();
          return json({offer:JSON.parse(listing.offline_offer),delivery:JSON.parse(current.delivery_cipher)});
        }
        return json({cipher:current.delivery_cipher});
      }
      // Older wallets call this immediately after fetching a paid note. Keep
      // the receipt accessible to its original buyer until the read deadline.
      return json({ok:true});
    }
    const invoiceMatch=path.match(/^\/api\/invoices\/([a-f0-9-]{36})$/);
    if(invoiceMatch&&request.method==='POST') {
      const {owner}=await signed(request,db,'invoice');
      const row=await db.prepare('SELECT invoices.*,points.owner,points.status FROM invoices JOIN points ON points.id=invoices.point_id WHERE invoices.id=? AND points.deleted=0').bind(invoiceMatch[1]).first();
      if(!row||row.owner!==owner) fault(404,'Счёт не найден');
      const current=await invoiceStatus(db,env,row);
      return json({id:current.id,address:current.address,amountAtomic:current.amount_atomic,receivedAtomic:current.received_atomic,confirmations:current.confirmations,requiredConfirmations:REQUIRED_CONFIRMATIONS,status:current.status,txids:JSON.parse(current.txids),expiresAt:current.expires_at});
    }
    const pointMatch=path.match(/^\/api\/points\/([a-f0-9-]{36})\/(vote|delete)$/);
    if(pointMatch&&request.method==='POST') {
      const action=pointMatch[2],{owner}=await signed(request,db,action),id=pointMatch[1];
      const point=await db.prepare("SELECT points.owner,points.chain_required,point_details.secret_price,EXISTS(SELECT 1 FROM secret_purchases WHERE point_id=points.id AND status!='released' AND sold_at IS NULL) AS reservation FROM "+annotatedPoints+' WHERE points.id=? AND deleted=0 AND '+visiblePoint+' AND '+chainVisible).bind(id,Date.now()).first();
      if(!point) fault(404,'Точка не найдена');
      if(action==='delete'){
        if(point.owner!==owner)fault(403,'Удалить точку может только автор');
        if(point.chain_required){
          if(point.reservation)fault(409,'Записка уже зарезервирована.');
          return json({invoice:mapInvoice(id,'withdraw',Date.now()+hour)});
        }
        const removed=await db.prepare("UPDATE points SET deleted=1,body=CASE WHEN ? IS NULL THEN body ELSE '' END WHERE id=? AND NOT EXISTS(SELECT 1 FROM secret_purchases WHERE point_id=points.id AND status!='released' AND sold_at IS NULL)")
          .bind(point.secret_price,id).run();
        if(!removed.meta.changes)fault(409,'Записка уже зарезервирована.');
        return json({ok:true});
      }
      if(point.owner===owner) fault(400,'Подтвердить свою точку нельзя');
      if(await db.prepare('SELECT 1 FROM votes WHERE point_id=? AND actor=?').bind(id,owner).first())
        return json({votes:(await db.prepare('SELECT votes FROM points WHERE id=?').bind(id).first()).votes});
      await rate(db,'vote:'+owner,30);
      await db.batch([db.prepare('INSERT OR IGNORE INTO votes(point_id,actor,created_at) VALUES(?,?,?)').bind(id,owner,Date.now()),db.prepare('UPDATE points SET votes=(SELECT COUNT(*) FROM votes WHERE point_id=?) WHERE id=?').bind(id,id)]);
      return json({votes:(await db.prepare('SELECT votes FROM points WHERE id=?').bind(id).first()).votes});
    }
    return json({error:'Не найдено'},404);
  } catch(e) { console.error('Noticoin API:',e.status||500,e.message);return json({error:e.status?e.message:'Сервис временно недоступен'},e.status||500); }
}
