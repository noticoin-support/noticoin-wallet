const keyFormat=/^[A-Za-z0-9_-]{563}$/;
const packetFormat=/^[A-Za-z0-9_-]{512}$/;
export const MAX_MAP_REQUEST_BYTES=64*1024;

function checkedKeys(keys) {
 if(!Array.isArray(keys)||keys.length<2||keys.length>32||new Set(keys).size!==keys.length||
    !keys.every(key=>typeof key==='string'&&keyFormat.test(key)))throw Error('Invalid offline note operator keys');
 return keys;
}

function checkedOperators(operators) {
 const keys=checkedKeys(operators.map(operator=>operator.key));
 const urls=new Set();
 for(const operator of operators){
  const url=new URL(operator.url);
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||
     (url.protocol!=='https:'&&!(url.protocol==='http:'&&url.hostname==='127.0.0.1'))||
     urls.has(url.origin)||! /^[a-f0-9]{64}$/.test(operator.token))throw Error('Invalid offline note operator endpoint');
  urls.add(url.origin);
 }
 return {keys,operators};
}

export function notePolicies(initial,future,withEndpoints=false) {
 const entries=JSON.parse(future||'[]');
 if(!Array.isArray(entries)||entries.length>32||(!initial&&entries.length))throw Error('Invalid offline note schedule');
 if(!initial)return [];
 const legacy=JSON.parse(initial);
 const values=withEndpoints?checkedOperators(legacy):{keys:checkedKeys(legacy)};
 if(values.keys.length!==3)throw Error('The initial offline note policy requires three operator keys');
 const policies=[{height:0,threshold:2,...values}];
 for(const entry of entries){
  const {height,threshold}=entry;
  const values=withEndpoints?checkedOperators(entry.operators):{keys:checkedKeys(entry.keys)};
  if(!Number.isSafeInteger(height)||height<200||height<=policies.at(-1).height||
     !Number.isInteger(threshold)||threshold<2||threshold>values.keys.length)throw Error('Invalid offline note epoch');
  policies.push({height,threshold,...values});
 }
 return policies;
}

export const notePolicyAt=(policies,height)=>policies?.findLast(policy=>policy.height<=height);
export function publicNotePolicy(policy) {
 if(!policy)return null;
 const {height,threshold,keys,registry}=policy;
 return {height,threshold,keys,...(registry?{registry:true}:{})};
}

export async function availableNoteOperators(operators,proxy) {
 const results=await Promise.allSettled(operators.map(async ({url,key},index)=>{
  if(proxy)return (await proxy(index,'health')).key===key;
  const response=await fetch(new URL('/health',url),{redirect:'error',signal:AbortSignal.timeout(2000)});
  return response.ok&&(await response.json()).key===key;
 }));
 return results.filter(result=>result.status==='fulfilled'&&result.value).length;
}

export async function releaseNote(operators,offer,transaction,order,proxy) {
 const deliveries=await Promise.allSettled(operators.map(async ({url,token},index)=>{
  const payload={index,offer,transaction,order};
  let packets;
  if(proxy)packets=await proxy(index,'release',payload);
  else{
   const response=await fetch(new URL('/release',url),{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},redirect:'error',
    body:JSON.stringify(payload),signal:AbortSignal.timeout(7000)
   });
   if(!response.ok)throw Error('Operator did not release the note');
   packets=await response.json();
  }
  if(!Array.isArray(packets)||packets.length!==offer.custody[index].length||!packets.every(packet=>packetFormat.test(packet)))
   throw Error('Invalid operator response');
  return {index,packets};
 }));
 return deliveries.filter(result=>result.status==='fulfilled').map(result=>result.value);
}
