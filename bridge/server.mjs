import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {walletClient,localEndpoint,parseExact} from './rpc.mjs';
import {publishFundReport} from './fund-report.mjs';
import {requestNoteOperator} from './operator-transport.mjs';
import {noticoinEnvironment} from '../map/server/environment.mjs';
const env=noticoinEnvironment(process.env);
const tokens={legacy:env.NOTICOIN_BRIDGE_TOKEN||'',fund:env.NOTICOIN_FUND_BRIDGE_TOKEN||''};
const registry=env.NOTI_NOTE_REGISTRY==='1';
if(!tokens.legacy&&!tokens.fund)throw Error('Configure at least one Noticoin bridge token');
if(Object.values(tokens).some(token=>token&&token.length<40)||tokens.legacy===tokens.fund)throw Error('Use distinct bridge tokens of at least 40 random characters');
const fundAddress=env.NOTICOIN_FUND_ADDRESS;
if(tokens.fund&&(!/^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(fundAddress||'')||!env.NOTICOIN_FUND_WALLET_URL))throw Error('Set the dedicated Noticoin fund wallet URL and primary address');
if(env.NOTICOIN_FUND_REPORT_FILE&&!tokens.fund)throw Error('The fund report requires a dedicated fund wallet');
const network=env.NOTICOIN_NETWORK||'mainnet';
const manifest=JSON.parse(readFileSync(new URL('../chain/NOTICOIN_NETWORK.json',import.meta.url),'utf8'));
const expected=manifest.networks.find(n=>n.name===network);
if(!expected?.genesisHash)throw Error('Verified genesisHash missing for '+network);
const daemon=localEndpoint(env.NOTICOIN_DAEMON_URL||'http://127.0.0.1:19081','Daemon RPC');
const legacyUrl=env.NOTICOIN_WALLET_URL||'http://127.0.0.1:19083';
if(tokens.legacy&&tokens.fund&&localEndpoint(legacyUrl,'Legacy wallet').port===localEndpoint(env.NOTICOIN_FUND_WALLET_URL,'Fund wallet').port)throw Error('The fund requires a separate wallet RPC port');
const wallets={
  legacy:tokens.legacy?walletClient({url:legacyUrl,username:env.NOTICOIN_WALLET_USER,password:env.NOTICOIN_WALLET_PASSWORD}):null,
  fund:tokens.fund?walletClient({url:env.NOTICOIN_FUND_WALLET_URL,username:env.NOTICOIN_FUND_WALLET_USER,password:env.NOTICOIN_FUND_WALLET_PASSWORD}):null,
};
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
const authorized=(value,token)=>{const a=Buffer.from(value||''),b=Buffer.from('Bearer '+token);return !!token&&a.length===b.length&&timingSafeEqual(a,b);};
const daemonReads=new Map();
function daemonCall(method,params={}) {
  const key=JSON.stringify([method,params]);
  if(!daemonReads.has(key)){
    const pending=(async()=>{
      const response=await fetch(new URL('/json_rpc',daemon),{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:'noticoin',method,params}),signal:AbortSignal.timeout(10000)});
      const data=parseExact(await response.text());
      if(!response.ok||data.error||!data.result)throw Error('Daemon unavailable');
      return data.result;
    })().finally(()=>daemonReads.delete(key));
    daemonReads.set(key,pending);
  }
  return daemonReads.get(key);
}
async function daemonTransaction(txid) {
  const response=await fetch(new URL('/get_transactions',daemon),{
    method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),
    body:JSON.stringify({txs_hashes:[txid],decode_as_json:true,prune:true}),
  });
  const result=parseExact(await response.text());
  if(!response.ok||result.status!=='OK')throw Error('Could not check the chain transaction');
  return result.txs?.find(value=>value.tx_hash===txid);
}
const refreshes=new Map();
function refreshWallet(role){
  if(!refreshes.has(role))refreshes.set(role,wallets[role]('refresh').finally(()=>refreshes.delete(role)));
  return refreshes.get(role);
}
async function verifiedDaemon() {
  const [info,genesis]=await Promise.all([daemonCall('get_info'),daemonCall('get_block_header_by_height',{height:0})]);
  const isolatedRegtest=env.NOTICOIN_ALLOW_ISOLATED_DEV==='1'&&info.nettype==='fakechain'&&network==='mainnet';
  if(genesis.block_header?.hash!==expected.genesisHash||(info.nettype!==network&&!isolatedRegtest))throw Error('Wrong blockchain: refusing payment verification');
  if(info.busy_syncing||Number(info.target_height)>Number(info.height)||
     ((!info.synchronized||info.offline)&&env.NOTICOIN_ALLOW_ISOLATED_DEV!=='1'))throw Error('Daemon has not synchronized with peers');
  return info;
}
async function synchronized(role) {
  const wallet=wallets[role];
  let [info,height]=await Promise.all([verifiedDaemon(),wallet('get_height')]);
  if(Number(height.height)<Number(info.height)){
    await refreshWallet(role);
    [info,height]=await Promise.all([verifiedDaemon(),wallet('get_height')]);
  }
  if(Number(height.height)!==Number(info.height))throw Error('Wallet or daemon is not synchronized');
  if(tokens.fund){
    const {address}=await wallet('get_address',{account_index:0,address_index:[0]});
    if(!address||(address===fundAddress)!==(role==='fund'))throw Error('Wrong wallet for payment role');
  }
  return info;
}
// Serialize address creation and store, so an invoice never escapes before its
// subaddress has been persisted to the wallet file.
let queue=Promise.resolve();
const serial=fn=>{const next=queue.then(fn,fn);queue=next.catch(()=>{});return next;};
async function dispatch(role,method,params) {
  const wallet=wallets[role];
  if(registry&&role==='fund'&&['note_registry_roster','note_registration_status','note_operator_request'].includes(method)){
    const info=await synchronized(role);
    if(method==='note_registration_status'){
      if(typeof params.txid!=='string'||!/^[a-f0-9]{64}$/.test(params.txid))throw Error('Invalid registration transaction');
      const tx=await daemonTransaction(params.txid);
      return {found:!!tx&&!tx.double_spend_seen};
    }
    const height=params.height??0;
    if(!Number.isSafeInteger(height)||height<0)throw Error('Invalid note operator roster height');
    const roster=await daemonCall('get_note_operator_roster',{height});
    if(roster.status!=='OK')throw Error('Note operator roster unavailable');
    if(method==='note_registry_roster')return {...roster,network:info.nettype};
    if(!Number.isInteger(params.index)||!roster.operators?.[params.index]||
       (params.operation==='release'&&params.payload?.index!==params.index))
      throw Error('Operator is outside of the registered roster');
    return requestNoteOperator(roster.operators[params.index].url,info.nettype,params.operation,params.payload);
  }
  if(method==='note_chain_height'&&role==='fund'){
    const {height}=await synchronized(role);
    return {height:Number(height)-1};
  }
  if(method==='check_anchor'&&role==='fund'){
    if(typeof params.txid!=='string'||!/^[a-f0-9]{64}$/.test(params.txid)||
       typeof params.record!=='string'||!/^4e544d50010[12][a-f0-9]{224}$/.test(params.record))
      throw Error('Invalid map record');
    const info=await verifiedDaemon();
    const tx=await daemonTransaction(params.txid);
    if(!tx||tx.double_spend_seen)return {found:false};
    const extra=JSON.parse(tx.as_json).extra;
    const matches=Array.isArray(extra)&&Buffer.from(extra).includes(Buffer.from('0276'+params.record,'hex'));
    return {found:true,matches,confirmations:tx.in_pool?0:Math.max(0,Number(info.height)-Number(tx.block_height)),
      blockHeight:tx.in_pool?null:Number(tx.block_height)};
  }
  if(method==='create_address'){
    if(params.account_index!==0||typeof params.label!=='string'||params.label.length>100)throw Error('Invalid address request');
    await synchronized(role);
    return serial(async()=>{const address=await wallet('create_address',{account_index:0,count:1,label:params.label});await wallet('store');return address;});
  }
  if(method==='get_transfers'){
    if(params.account_index!==0||!Array.isArray(params.subaddr_indices)||params.subaddr_indices.length!==1||!Number.isSafeInteger(params.subaddr_indices[0])||params.subaddr_indices[0]<1)throw Error('Invalid invoice subaddress');
    await synchronized(role);
    if(params.expected_address!==undefined){
      if(typeof params.expected_address!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(params.expected_address))throw Error('Invalid invoice address');
      const result=await wallet('get_address_index',{address:params.expected_address}).catch(error=>{
        if(error.rpcCode!==-2)throw error;
        return {};
      });
      if(result.index?.major!==0||result.index.minor!==params.subaddr_indices[0])
        return {matchesAddress:false,in:[],pool:[]};
    }
    const result=await wallet('get_transfers',{in:true,pool:true,account_index:0,subaddr_indices:params.subaddr_indices});
    return {in:result.in||[],pool:result.pool||[]};
  }
  if(method==='check_tx_proof'&&role==='legacy'){
    if(typeof params.txid!=='string'||!/^[a-f0-9]{64}$/.test(params.txid)||typeof params.address!=='string'||
       !/^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(params.address)||typeof params.message!=='string'||
       !/^noti-note-v2:[a-f0-9-]{36}:[a-f0-9-]{36}:(?:noti|\x6b\x6f\x6b\x6f)-recipient-v1\.[A-Za-z0-9_-]{563}$/.test(params.message)||
       typeof params.signature!=='string'||!/^OutProofV[12][1-9A-HJ-NP-Za-km-z]{16,4000}$/.test(params.signature))throw Error('Invalid payment proof');
    await synchronized(role);
    const proof=await wallet('check_tx_proof',params);
    const tx=proof.good&&!proof.in_pool?await daemonTransaction(params.txid):null;
    const unlockedOutput=!!(tx&&!tx.in_pool&&!tx.double_spend_seen&&JSON.parse(tx.as_json).unlock_time===0);
    return {good:proof.good,received:String(proof.received??0),in_pool:proof.in_pool,confirmations:proof.confirmations??0,unlockedOutput};
  }
  throw Error('RPC method is not permitted');
}
// All operators can independently request the same proof. Coalesce only
// concurrent reads on this bridge; the next poll checks the chain again.
const verifications=new Map();
function verifyOnChain(role,method,params){
  if(!['check_anchor','check_tx_proof','note_chain_height','note_registry_roster'].includes(method))return dispatch(role,method,params);
  const key=JSON.stringify([role,method,params]);
  if(!verifications.has(key))verifications.set(key,dispatch(role,method,params).finally(()=>verifications.delete(key)));
  return verifications.get(key);
}
createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/health'){json(res,200,{service:'noticoin-wallet-bridge',network});return;}
  if(req.url!=='/rpc'||req.method!=='POST'){json(res,404,{error:'Not found'});return;}
  const role=Object.keys(tokens).find(key=>authorized(req.headers.authorization,tokens[key]));
  if(!role){json(res,403,{error:'Forbidden'});return;}
  try{
    let body='';for await(const chunk of req){body+=chunk;if(body.length>(registry?70*1024:8000)){json(res,413,{error:'Request too large'});return;}}
    const value=JSON.parse(body);
    if((value.wallet??'legacy')!==role){json(res,403,{error:'Forbidden'});return;}
    const result=await verifyOnChain(role,value.method,value.params||{});json(res,200,{result});
  }catch(e){console.error('Noticoin bridge:',e.message,e.cause?.code??'');json(res,503,{error:'Wallet verification unavailable'});}
}).listen(Number(env.NOTICOIN_BRIDGE_PORT||8788),'127.0.0.1',()=>console.log('Noticoin wallet bridge on loopback port '+(env.NOTICOIN_BRIDGE_PORT||8788)));
const failedReconciliations=new Set();
async function reconcileWallet(role){
  try{
    const url=new URL('/api/internal/reconcile',env.NOTICOIN_MAP_URL);
    if(url.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(url.hostname))throw Error('Map needs HTTPS');
    url.searchParams.set('wallet',role);
    const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+tokens[role]},signal:AbortSignal.timeout(25000)});
    if(!response.ok)throw Error('Map reconciliation HTTP '+response.status);
    if(failedReconciliations.delete(role))console.log('Noticoin map payment checks restored for '+role);
  }catch(e){if(!failedReconciliations.has(role))console.error(role+': '+e.message);failedReconciliations.add(role);}
}
let polling=false;
async function reconcile(){
  if(polling||!env.NOTICOIN_MAP_URL)return;
  polling=true;
  try{await Promise.all(Object.keys(wallets).filter(role=>wallets[role]).map(reconcileWallet));}
  finally{polling=false;}
}
let publishing=false,reportFailed=false;
async function report(){
  if(publishing)return;
  publishing=true;
  try{
    const info=await synchronized('fund');
    await publishFundReport(env.NOTICOIN_FUND_REPORT_FILE,wallets.fund,{
      network:info.nettype,height:Number(info.height)-1,confirmations:manifest.spendableAgeBlocks,accountAddress:fundAddress,
    },env.NOTICOIN_FUND_PURPOSES_FILE);
    if(reportFailed)console.log('Noticoin fund report publication restored');
    reportFailed=false;
  }catch(e){if(!reportFailed)console.error('Noticoin fund report: '+e.message);reportFailed=true;}
  finally{publishing=false;}
}
setInterval(reconcile,15000).unref();reconcile();
if(env.NOTICOIN_FUND_REPORT_FILE){setInterval(report,30000).unref();report();}
