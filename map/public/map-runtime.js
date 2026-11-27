'use strict';
(() => {
  const decimalPattern = '[+-]?(?:\\d+(?:[.,]\\d+)?|[.,]\\d+)';
  const singleCoordinate = new RegExp('^'+decimalPattern+'$');
  const coordinatePair = new RegExp('^('+decimalPattern+')(?:\\s*[,;]\\s*|\\s+)('+decimalPattern+')$');
  const normalizeMinus = text=>text.trim().replaceAll('−','-');
  function parseCoordinate(text,maximum) {
    const decimal=normalizeMinus(text);
    if(!singleCoordinate.test(decimal))return null;
    const value=Number(decimal.replace(',','.'));
    return Math.abs(value)<=maximum?value:null;
  }
  function parseCoordinatePair(text) {
    const match=normalizeMinus(text).match(coordinatePair);
    if(!match)return null;
    const lat=parseCoordinate(match[1],85),lng=parseCoordinate(match[2],180);
    return lat===null||lng===null?null:{lat,lng};
  }
  const searchText=text=>text.normalize('NFKC').toLowerCase();
  function noteTerms(query) {
    return searchText(query.trim()).split(/\s+/u).filter(Boolean);
  }
  function noteMatches(terms,title,body='') {
    if(!terms.length)return true;
    const text=searchText(title+' '+body);
    return terms.every(term=>text.includes(term));
  }
  function inRing(lng,lat,ring) {
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const [x0,y0]=ring[j],[x1,y1]=ring[i];
      if((y0>lat)!==(y1>lat)&&lng<(x1-x0)*(lat-y0)/(y1-y0)+x0)inside=!inside;
    }
    return inside;
  }
  function countryArea(polygons) {
    let west=180,south=90,east=-180,north=-90;
    let wrapWest=360,wrapEast=0;
    const areas=polygons.map(([exterior,...holes])=>{
      let left=180,bottom=90,right=-180,top=-90;
      for(const [lng,lat] of exterior){
        left=Math.min(left,lng);right=Math.max(right,lng);
        bottom=Math.min(bottom,lat);top=Math.max(top,lat);
        const wrapped=lng<0?lng+360:lng;
        wrapWest=Math.min(wrapWest,wrapped);wrapEast=Math.max(wrapEast,wrapped);
      }
      west=Math.min(west,left);east=Math.max(east,right);
      south=Math.min(south,bottom);north=Math.max(north,top);
      return {left,bottom,right,top,exterior,holes};
    });
    const wraps=wrapEast-wrapWest<east-west;
    return {
      bounds:[[wraps?wrapWest:west,Math.max(-85,south)],[wraps?wrapEast:east,Math.min(85,north)]],
      contains(lng,lat){
        return areas.some(({left,bottom,right,top,exterior,holes})=>
          left<=lng&&lng<=right&&bottom<=lat&&lat<=top&&inRing(lng,lat,exterior)&&!holes.some(ring=>inRing(lng,lat,ring)));
      }
    };
  }
  function noteSearchBounds(area) {
    if(!area)return [-180,-85,180,85];
    const [[west,south],[east,north]]=area.bounds;
    return [west>180?west-360:west,south,east>180?east-360:east,north];
  }
  function pixelRatio(width,height,dpr=1,{software=false,detail=false}={}) {
    const ceiling=detail?1.5:software?.8:1;
    const budget=detail?2400000:software?900000:1500000;
    return Math.max(.5,Math.min(dpr,ceiling,Math.sqrt(budget/Math.max(1,width*height))));
  }
  function rendererIsSoftware() {
    let gl;
    try {
      const canvas=document.createElement('canvas');gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
      if(!gl)return true;
      const info=gl.getExtension('WEBGL_debug_renderer_info');
      const renderer=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
      return /swiftshader|llvmpipe|softpipe|software|virtualbox|basic render|vmware|svga/i.test(renderer||'');
    }catch{return true;}finally{gl?.getExtension('WEBGL_lose_context')?.loseContext();}
  }
  // Selection and viewport UI changes do not change point geometry. Avoid
  // sending identical GeoJSON through workers and rebuilding every cluster.
  function pointUpdater(map,colors) {
    let previous='';
    return {
      reset(){previous='';},
      update(points){
        const signature=JSON.stringify(points.map(p=>[p.id,p.lng,p.lat,p.category,p.title,p.icon,p.isPrivate]));
        if(signature===previous)return false;
        const source=map.getSource('noticoin-points');if(!source)return false;
        source.setData({type:'FeatureCollection',features:points.map(p=>({
          type:'Feature',geometry:{type:'Point',coordinates:[p.lng,p.lat]},
          properties:{id:p.id,category:p.category,title:p.title??'',icon:p.isPrivate?'private':p.icon&&p.icon!=='default'?p.icon:p.category,
            color:colors[p.category].color}
        }))});
        previous=signature;return true;
      }
    };
  }
  function hoverHandler(map,isPlacing,now=()=>performance.now(),interactiveLayers=['points','clusters']) {
    let checked=-Infinity,cursor='';
    return event=>{
      if(isPlacing()||map.isMoving())return;
      const time=now();if(time-checked<100)return;checked=time;
      const layers=interactiveLayers.filter(id=>map.getLayer(id));
      const next=layers.length&&map.queryRenderedFeatures(event.point,{layers}).length?'pointer':'';
      if(next!==cursor){cursor=next;map.getCanvas().style.cursor=next;}
    };
  }
  // Listen to actual rendered frames; never create a continuous animation loop.
  function adaptiveResolution(map,{software=false,detail=false,onChange=()=>{}}={}) {
    let cap=Infinity,frames=0,total=0,last=0,warmup=2;
    const resize=()=>{
      const bounds=map.getContainer().getBoundingClientRect();
      const ratio=Math.min(cap,pixelRatio(bounds.width,bounds.height,globalThis.devicePixelRatio||1,{software,detail}));
      if(Math.abs(map.getPixelRatio()-ratio)>.02)map.setPixelRatio(ratio);
    };
    const start=()=>{frames=0;total=0;last=0;warmup=2;};
    const frame=()=>{
      if(!map.isMoving()||document.hidden){last=0;return;}
      const time=performance.now();
      if(last&&warmup<=0){total+=time-last;frames++;}else warmup--;
      last=time;
      if(frames>=6&&total>=700){
        if(total/frames>42&&map.getPixelRatio()>.55){cap=Math.max(.5,map.getPixelRatio()*.8);resize();onChange(cap);}
        frames=0;total=0;warmup=2;
      }
    };
    map.on('movestart',start);map.on('render',frame);globalThis.addEventListener('resize',resize);resize();
    return {setDetail(value){detail=value;cap=Infinity;start();resize();},destroy(){map.off('movestart',start);map.off('render',frame);globalThis.removeEventListener('resize',resize);}};
  }
  globalThis.NoticoinMapRuntime={parseCoordinate,parseCoordinatePair,noteTerms,noteMatches,countryArea,noteSearchBounds,pixelRatio,rendererIsSoftware,pointUpdater,hoverHandler,adaptiveResolution};
})();
