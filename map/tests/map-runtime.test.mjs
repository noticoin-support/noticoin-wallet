import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
await import('../public/map-runtime.js');const {parseCoordinate,parseCoordinatePair,noteTerms,noteMatches,countryArea,noteSearchBounds,pixelRatio,pointUpdater,hoverHandler}=globalThis.NoticoinMapRuntime;
test('manual coordinate entry preserves zero, sign, decimal separators and map bounds',()=>{
 assert.equal(parseCoordinate('  −35,6595 ',85),-35.6595);
 assert.equal(parseCoordinate('0',85),0);
 assert.equal(parseCoordinate('180',180),180);
 for(const text of ['', '-', '1e1', 'NaN', '85.1', '12N', '30.5.4'])assert.equal(parseCoordinate(text,85),null);
 assert.deepEqual(parseCoordinatePair('35.659500, 139.701700'),{lat:35.6595,lng:139.7017});
 assert.deepEqual(parseCoordinatePair('−35,659500; 139,701700'),{lat:-35.6595,lng:139.7017});
 assert.deepEqual(parseCoordinatePair('0,0'),{lat:0,lng:0});
 assert.equal(parseCoordinatePair('45, -180.01'),null);
});
test('note searches require every keyword regardless of order or case',()=>{
 const terms=noteTerms('  FIXTURE   sunset 東京 ');
 assert.equal(noteMatches(terms,'東京 Sunset','The fixture text'),true);
 assert.equal(noteMatches(terms,'東京 Sunset'),false);
 assert.equal(noteMatches(noteTerms('ｎｏｔｅ'),'Note title'),true);
});
test('country areas use country polygons, including holes and the date line',()=>{
 const {countries}=JSON.parse(readFileSync(new URL('../public/atlas/country-boundaries.json',import.meta.url)));
 const japan=countryArea(countries.JP.polygons);
 assert.equal(japan.contains(139.6917,35.6895),true);
 assert.equal(japan.contains(126.978,37.5665),false);
 const southAfrica=countryArea(countries.ZA.polygons);
 assert.equal(southAfrica.contains(18.4241,-33.9249),true);
 assert.equal(southAfrica.contains(27.5144,-29.3167),false);
 const fiji=countryArea(countries.FJ.polygons);
 assert.ok(fiji.bounds[1][0]-fiji.bounds[0][0]<15);
 assert.ok(noteSearchBounds(fiji)[0]>noteSearchBounds(fiji)[2]);
 assert.deepEqual(noteSearchBounds(null),[-180,-85,180,85]);
 assert.equal(fiji.contains(178.4501,-18.1416),true);
});
test('resolution respects the pixel budget on a 4K display and software renderer',()=>{
 for(const [width,height,dpr] of [[3840,2160,2],[1920,1080,1.7],[1280,720,1]]){
  const ratio=pixelRatio(width,height,dpr,{software:true});assert.ok(ratio<=.8);assert.ok(width*height*ratio**2<=Math.max(900000,width*height*.25)+1);
 }
 assert.equal(pixelRatio(1280,720,2),1);
});
test('opening 100 points does not resubmit unchanged GeoJSON or rebuild clusters',()=>{
 let calls=0,data;const map={getSource:()=>({setData(value){calls++;data=value;}})},updater=pointUpdater(map,{message:{color:'#abc'}});
 const points=Array.from({length:2000},(_,i)=>({id:String(i),lng:i/20,lat:35,category:'message'}));
 assert.equal(updater.update(points),true);for(let i=0;i<100;i++)assert.equal(updater.update(points.map(p=>({...p,votes:i}))),false);assert.equal(calls,1);
 points[10].lng+=.1;updater.update(points);assert.equal(calls,2);updater.reset();updater.update(points);assert.equal(calls,3);
 points[10].displayPriceAtomic='1250000000';assert.equal(updater.update(points),false);
 points[10].title='Programs';assert.equal(updater.update(points),true);
 assert.equal(data.features[10].properties.title,'Programs');
 assert.equal(Object.hasOwn(data.features[10].properties,'price'),false);
 assert.equal(updater.update(points),false);
});
test('hover skips hit testing during movement and limits it to 10 times per second',()=>{
 let time=0,moving=true,queries=0;const canvas={style:{}},map={isMoving:()=>moving,getLayer:()=>true,getCanvas:()=>canvas,queryRenderedFeatures(){queries++;return[{}]}};
 const hover=hoverHandler(map,()=>false,()=>time);for(let i=0;i<100;i++){time=i;hover({point:{x:1,y:1}});}assert.equal(queries,0);
 moving=false;for(let i=0;i<1000;i++){time=i;hover({point:{x:1,y:1}});}assert.equal(queries,10);assert.equal(canvas.style.cursor,'pointer');
});
test('the fast globe has only a background and one raster layer; street details remain',()=>{
 const style=JSON.parse(readFileSync(new URL('../public/map-fast.json',import.meta.url)));const world=style.layers.filter(l=>(l.minzoom||0)<=1&&(!l.maxzoom||l.maxzoom>1));
 assert.deepEqual(world.map(l=>l.type),['background','raster']);assert.equal(style.projection.type,'globe');
 assert.ok(style.layers.some(l=>l.id==='highway_minor'));assert.ok(style.layers.some(l=>l.id==='highway_name_other'));
 for(const layer of style.layers){if(layer.source)assert.ok(style.sources[layer.source]);if(layer.maxzoom)assert.ok((layer.minzoom||0)<layer.maxzoom);}
});

test('purchased notes notify without opening, reopen offline, and stay deleted after history sync',async()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const item={id:'receipt',pointId:'point',kind:'secret',title:'Shibuya',status:'confirmed',address:'invoice',amountAtomic:'100000000',
  readAvailable:true,readUntil:Date.now()+86400000};
 const body='First line\n<article>Second line</article>';
 const calls=[];
 const saved=new Map();
 const browserStorage=new Map();
 let clockOffset=0;
 class WalletDate extends Date { static now(){return Date.now()+clockOffset;} }
 let failRead=true;
 const startWallet=()=>{
  const elements=new Map(),openedNoteTexts=new Map();
  function element(text=''){
   return {textContent:text,children:[],dataset:{},hidden:true,open:false,
    get childElementCount(){return this.children.length},
    append(...children){this.children.push(...children)},replaceChildren(){this.children=[]},setAttribute(){},focus(){},
    showModal(){this.open=true},close(){this.open=false}};
  }
  const $=id=>{
   if(!elements.has(id))elements.set(id,element());
   return elements.get(id);
  };
  const wallet=runInNewContext(source.slice(source.indexOf('const pendingInvoices='),source.indexOf('function cityKey('))+
   '\n({syncPurchaseHistory,loadPurchaseIndex,readSecret,setInvoiceListPage,showDeferredReceipt})',{
    $,invoice:null,readList:key=>browserStorage.get(key)??[],storage(key,value){browserStorage.set(key,structuredClone(value));},
    Date:WalletDate,walletMap:true,nativeWallet:null,tr:text=>text,formatCoins:()=> '0.1',
    openedNoteTexts,applyNoteFilters(){},
    make:(tag,style,text)=>element(text),expiryDate:{format:()=> 'tomorrow'},document:{hidden:false,querySelector:()=>null},
    NoticoinMapIcons:{element:name=>element(name)},
    toast(){},
    privatePins:{
     async purchaseIndex(){return [...saved.values()];},
     async savePurchase(order,receipt){
      assert.equal(order.id,item.id);
      assert.equal(receipt.cipher,'sealed');
      const summary={id:order.id,pointId:order.pointId,title:order.title,amountAtomic:order.amountAtomic,paidAt:Date.now()};
      saved.set(order.id,summary);
      return summary;
     },
     async readPurchase(id){assert.equal(id,item.id);return saved.get(id)?.deleted?null:{body};},
     async deletePurchase(id){saved.set(id,{id,deleted:true});return true;},
    },
    async write(route,action,params){
     calls.push(action);
     if(action==='purchase-history')return {purchases:[{...item}],sales:[]};
     assert.equal(params.downloadOnly,true);
     if(failRead)throw Error('Temporary connection error');
     return {cipher:'sealed'};
    },
   });
  return {wallet,$,openedNoteTexts};
 };
 const first=startWallet();
 await first.wallet.syncPurchaseHistory();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(first.$('map-receipt-status').hidden,false);
 clockOffset=45000;
 first.wallet.showDeferredReceipt();
 assert.equal(first.$('map-receipt-status').hidden,false,'purchase notice never times out');
 const {wallet,$}=startWallet();
 await wallet.syncPurchaseHistory();
 assert.equal($('purchased-note-count').textContent,'1');
 assert.equal($('purchases-empty').hidden,true);
 assert.equal($('purchased-note').open,false);
 assert.equal($('map-receipt-status').hidden,false,'pending notice remains after relaunch');
 $('map-receipt-open').onclick();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal($('map-receipt-status').hidden,true);
 assert.equal($('purchased-note').open,true);
 assert.equal($('purchased-note-body').hidden,true);
 assert.equal($('retry-note').hidden,false);
 $('purchased-note').close();
 failRead=false;
 await wallet.syncPurchaseHistory();
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(saved.has(item.id),'the wallet archives confirmed notes in the background');
 assert.equal($('purchased-note').open,false);
 assert.equal($('map-receipt-status').hidden,true,'opening a note acknowledges the notice');
 await wallet.readSecret(item);
 assert.equal($('purchased-note-body').textContent,body);
 assert.equal($('retry-note').hidden,true);
 $('purchased-note').close();
 const before=calls.length;
 item.readUntil=Date.now()-1;
 failRead=true;
 browserStorage.set('noti.map.receipt-notices',[[item.id,'ready']]);
 const restarted=startWallet();
 await restarted.wallet.loadPurchaseIndex();
 assert.equal(restarted.$('map-receipt-status').hidden,false);
 restarted.$('map-receipt-close').onclick();
 assert.equal(restarted.$('map-receipt-status').hidden,true);
 restarted.wallet.showDeferredReceipt();
 assert.equal(restarted.$('map-receipt-status').hidden,true,'closing acknowledges the notice without deleting the note');
 restarted.$('invoice-list').showModal();
 restarted.wallet.setInvoiceListPage(true);
 assert.equal(restarted.$('invoice-overview').hidden,true);
 assert.equal(restarted.$('invoice-list-back').hidden,false);
 const row=restarted.$('purchased-notes').children[0];
 await row.children[0].onclick();
 assert.equal(restarted.$('purchased-note-body').textContent,body);
 assert.equal(restarted.openedNoteTexts.get(item.pointId),body);
 assert.equal(calls.length,before,'opening a saved copy must not contact the map server');
 assert.equal(restarted.$('invoice-list').open,true,'the purchases view stays open under the reader');
 assert.equal(restarted.$('purchased-note-back').hidden,false);
 restarted.$('purchased-note').close();
 await row.children[1].onclick();
 assert.equal(restarted.openedNoteTexts.has(item.pointId),false);
 assert.equal(restarted.$('purchases-empty').hidden,false);
 restarted.wallet.setInvoiceListPage(false);
 assert.equal(restarted.$('purchases-section').hidden,true);
 assert.equal(restarted.$('invoice-overview').hidden,false);
 const reopened=startWallet();
 await reopened.wallet.syncPurchaseHistory();
 assert.equal(reopened.$('purchased-note-count').hidden,true);
 assert.equal(saved.get(item.id).deleted,true);
});
