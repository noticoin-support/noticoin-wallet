import {createPrivateKey,createPublicKey,generateKeyPairSync,sign} from 'node:crypto';
import {readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {walletClient} from '../../bridge/rpc.mjs';

const networkCodes={mainnet:0,testnet:1,stagenet:2,fakechain:3};

export function registrationRecord(signer,{network,expires,key,url}) {
 const endpoint=Buffer.from(url,'ascii');
 if(!Object.hasOwn(networkCodes,network)||!Number.isSafeInteger(expires)||expires<1||
    !/^[A-Za-z0-9_-]{563}$/.test(key)||!endpoint.length||endpoint.length>126||endpoint.toString('ascii')!==url)
  throw Error('Invalid operator registration');
 const header=Buffer.alloc(9);
 header[0]=networkCodes[network];
 header.writeBigUInt64LE(BigInt(expires),1);
 const identity=createPublicKey(signer).export({type:'spki',format:'der'}).subarray(-32);
 const record=Buffer.concat([header,identity,Buffer.from(key,'ascii'),Buffer.from([endpoint.length]),endpoint]);
 const signature=sign(null,Buffer.concat([Buffer.from('Noticoin note operator v1\0'),record]),signer);
 return Buffer.concat([record,signature]).toString('hex');
}

async function signingKey(file) {
 try{return createPrivateKey(await readFile(file));}
 catch(error){
  if(error.code!=='ENOENT')throw error;
  const {privateKey}=generateKeyPairSync('ed25519');
  await writeFile(file,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
  return privateKey;
 }
}

export async function startRegistration({data,key,roster,registrationStatus}) {
 const address=new URL(process.env.NOTI_NOTE_OPERATOR_URL);
 if(address.username||address.password||address.href!==address.origin+'/'||address.origin.length>126)
  throw Error('Use the operator service origin without a path');
 const wallet=walletClient({
  url:process.env.NOTI_NOTE_REGISTRATION_WALLET_URL,
  username:process.env.NOTI_NOTE_REGISTRATION_WALLET_USER,
  password:process.env.NOTI_NOTE_REGISTRATION_WALLET_PASSWORD,
 });
 const accountIndex=Number(process.env.NOTI_NOTE_REGISTRATION_ACCOUNT||0);
 if(!Number.isInteger(accountIndex)||accountIndex<0)throw Error('Invalid operator registration account');
 const signer=await signingKey(path.join(data,'registration.pem'));
 const file=path.join(data,'registration.json');
 let state;
 try{state=JSON.parse(await readFile(file,'utf8'));}
 catch(error){if(error.code!=='ENOENT')throw error;}

 let running=false,problem='';
 async function tick(){
  if(running)return;
  running=true;
  try{
   const {network,height,lease_blocks:lease}=await roster();
   if(address.protocol!=='https:'&&!(network==='fakechain'&&address.protocol==='http:'&&address.hostname==='127.0.0.1'))
    throw Error('Operator registration requires HTTPS');
   const renew=height+Math.floor(lease/2);
   if(!state||state.expires<=renew){
    const expires=height+lease-2;
    const {address:destination}=await wallet('get_address',{account_index:accountIndex});
    if(!destination)throw Error('Registration address is unavailable');
    const record=registrationRecord(signer,{network,expires,key,url:address.origin});
    const tx=await wallet('transfer',{destinations:[{address:destination,amount:1}],account_index:accountIndex,
     priority:1,note_operator_record:record,do_not_relay:true,get_tx_metadata:true});
    if(!tx.tx_metadata||!tx.tx_hash)throw Error('The wallet RPC does not support note operator registration');
    const pending={expires,txid:tx.tx_hash,metadata:tx.tx_metadata};
    await writeFile(file+'.tmp',JSON.stringify(pending),{mode:0o600});
    await rename(file+'.tmp',file);
    state=pending;
   }
   if(!await registrationStatus(state.txid)){
    const tx=await wallet('relay_tx',{hex:state.metadata});
    console.log('Noti operator registration submitted: '+tx.tx_hash);
   }
   problem='';
  }catch(error){
   if(problem!==error.message)console.error('Noti operator registration:',error.message);
   problem=error.message;
  }finally{running=false;}
 }
 await tick();
 setInterval(tick,2000).unref();
}
