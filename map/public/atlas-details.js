'use strict';

(() => {
 const palettes = {
  dark: {
   brick: ['#735d5e', '#594951', '#354253', '#778798', '#514a58', '#625865'],
   concrete: ['#667186', '#7f8a9a', '#364861', '#7894ae', '#777e8b', '#68717f'],
   glass: ['#45637e', '#7490a5', '#34516f', '#819bb5', '#526d81', '#657f90']
  },
  light: {
   brick: ['#c4a198', '#ad8983', '#758b9a', '#bed0de', '#a28d90', '#b09c9f'],
   concrete: ['#bac6d2', '#d7dfe7', '#738a9d', '#b7cadb', '#c1c5c9', '#aaafb6'],
   glass: ['#91b4ca', '#d1e2ec', '#779db8', '#b4d5e7', '#8da5b2', '#a3b9c6']
  }
 };

 function image(width, height, draw) {
  const canvas=document.createElement('canvas');
  canvas.width=width;
  canvas.height=height;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  draw(context);
  return context.getImageData(0,0,width,height);
 }

 function drawFacade(painter, material, wall, trim, glass, reflection) {
  painter.fillStyle=wall;
  painter.fillRect(0,0,64,64);
  painter.fillStyle=trim;
  if(material==='brick'){
   for(let y=0;y<64;y+=8){
    painter.fillRect(0,y,64,1);
    for(let x=y%16;x<64;x+=16)painter.fillRect(x,y,1,8);
   }
  }
  const windowWidth=material==='glass'?26:18;
  const windowHeight=material==='concrete'?14:24;
  for(let y=0;y<64;y+=32){
   painter.fillStyle=trim;
   if(material!=='brick')painter.fillRect(0,y,64,material==='glass'?2:3);
   for(let x=0;x<64;x+=32){
    const left=x+(32-windowWidth)/2;
    const top=y+(32-windowHeight)/2;
    painter.fillStyle=trim;
    painter.fillRect(left-1,top-1,windowWidth+2,windowHeight+2);
    painter.fillStyle=glass;
    painter.fillRect(left,top,windowWidth,windowHeight);
    painter.fillStyle=reflection;
    painter.fillRect(left+1,top+2,windowWidth-2,2);
    if(material!=='brick')painter.fillRect(left+windowWidth/2,top,1,windowHeight);
   }
  }
 }

 function drawRoof(painter, material, surface, seam) {
  painter.fillStyle=surface;
  painter.fillRect(0,0,64,64);
  painter.fillStyle=seam;
  if(material==='glass'){
   for(let x=5;x<64;x+=8)painter.fillRect(x,0,1,64);
  }else if(material==='concrete'){
   for(let y=8;y<64;y+=32){
    painter.fillRect(0,y,64,1);
    for(let x=y===8?12:28;x<64;x+=32)painter.fillRect(x,y,1,32);
   }
   // Continue the staggered joint from the bottom at the top of the repeat.
   painter.fillRect(28,0,1,8);
   painter.fillRect(60,0,1,8);
  }else{
   for(let y=6;y<64;y+=16)painter.fillRect(0,y,64,1);
  }
  if(material==='glass')return;
  painter.globalAlpha=.32;
  for(let index=0;index<96;index++){
   const x=(index*43+Math.floor(index/11)*9)%64;
   const y=(index*37+Math.floor(index/13)*3)%64;
   painter.fillRect(x,y,1,1);
  }
 }

 function buildingPattern(material, [wall, trim, glass, reflection, roof, seam]) {
  return image(128,64,painter=>{
   // Clip the left half so the last wall row cannot spill into the roof texture.
   painter.save();
   painter.beginPath();
   painter.rect(0,0,64,64);
   painter.clip();
   drawFacade(painter,material,wall,trim,glass,reflection);
   painter.restore();
   painter.translate(64,0);
   drawRoof(painter,material,roof,seam);
  });
 }

 function trafficSignal() {
  return image(22,40,painter=>{
   painter.fillStyle='#15233b';
   painter.fillRect(9,28,4,12);
   painter.fillStyle='#f4f5fa';
   painter.fillRect(1,0,20,31);
   painter.fillStyle='#172137';
   painter.fillRect(2,1,18,29);
   for(const [y,color] of [[6,'#ff655d'],[15,'#ffe576'],[24,'#77dc9a']]){
    painter.beginPath();
    painter.fillStyle=color;
    painter.arc(11,y+1,3.6,0,Math.PI*2);
    painter.fill();
   }
  });
 }

 const venueSymbols={
  coffee:['#a05435','coffee'],
  food:['#ad5148','utensils'],
  shop:['#7756a8','shopping-bag'],
  office:['#2c6498','briefcase-business'],
  medical:['#a54467','heart-pulse'],
  transit:['#2b689e','train-front'],
  park:['#297446','trees'],
  school:['#387483','graduation-cap'],
  hotel:['#72569c','bed-double'],
  art:['#94539c','palette'],
  building:['#26768a','building-2']
 };

 function venueSymbol(color,glyph) {
  return image(36,36,painter=>{
   painter.scale(1.5,1.5);
   painter.beginPath();
   painter.roundRect(1,1,22,22,6);
   painter.fillStyle=color;
   painter.fill();
   painter.strokeStyle='#eaf4ff';
   painter.lineWidth=1.2;
   painter.stroke();
   NoticoinMapIcons.draw(painter,glyph,3,3,18);
  });
 }

 function install(map) {
  for(const [theme,materials] of Object.entries(palettes)){
   for(const [material,palette] of Object.entries(materials)){
    const id='building-'+material+'-'+theme;
    if(!map.hasImage(id))map.addImage(id,buildingPattern(material,palette),{pixelRatio:4});
   }
  }
  if(!map.hasImage('traffic-signal'))map.addImage('traffic-signal',trafficSignal(),{pixelRatio:2});
  for(const [type,[color,glyph]] of Object.entries(venueSymbols)){
   if(!map.hasImage('venue-'+type))map.addImage('venue-'+type,venueSymbol(color,glyph),{pixelRatio:2});
  }
 }

 globalThis.NoticoinAtlasDetails={install};
})();
