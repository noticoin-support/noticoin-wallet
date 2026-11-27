// Accept existing deployment settings while preferring the current names.
export function noticoinEnvironment(source) {
 const previousPrefix='KO'+'KO_';
 const env={...source};
 for(const key of Object.keys(source)){
  if(!key.startsWith(previousPrefix))continue;
  const name='NOTICOIN_'+key.slice(previousPrefix.length);
  if(!Object.hasOwn(env,name))env[name]=source[key];
 }
 return env;
}
