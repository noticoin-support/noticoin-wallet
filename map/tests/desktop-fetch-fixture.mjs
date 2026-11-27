const original=globalThis.fetch;
let metadataCount=0;
globalThis.fetch=async(input,options)=>{
 const url=String(input);
 if(!url.startsWith('https://tiles.openfreemap.org/'))return original(input,options);
 if(process.env.NOTICOIN_TEST_OFFLINE==='1')throw Error('Offline fixture');
 if(url.endsWith('/planet')){
  const version=metadataCount++===0?'20261101':'20261108';
  return new Response(JSON.stringify({tiles:['https://tiles.openfreemap.org/planet/'+version+'/{z}/{x}/{y}.pbf']}));
 }
 if(url.includes('/20261101/')&&url.endsWith('/1614.pbf'))return new Response('',{status:410});
 return new Response(new Uint8Array([1,2,3,4]));
};
