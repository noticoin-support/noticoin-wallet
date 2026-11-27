const zoomWidth = (low, high) => ['interpolate', ['linear'], ['zoom'], 6, low, 17, high];
const source = (name, options) => ({source:'openmaptiles', 'source-layer':name, ...options});
const line = (id, layer, minzoom, color, width, filter) => source(layer, {
 id, type:'line', minzoom,
 ...(filter ? {filter} : {}),
 layout:{'line-cap':'round','line-join':'round'},
 paint:{'line-color':color,'line-width':width}
});
const byClass = classes => ['match',['get','class'],classes,true,false];
const venueIcon = ['case',
 ['match',['get','subclass'],['cafe','coffee_shop','coffee'],true,false],'venue-coffee',
 ['match',['get','subclass'],['bakery','deli','confectionery'],true,false],'venue-shop',
 ['match',['get','subclass'],['office','company','coworking_space','industrial'],true,false],'venue-office',
 ['match',['get','class'],
  ['cafe','coffee_shop'],'venue-coffee',
  ['restaurant','fast_food','food_court','bar','pub','ice_cream'],'venue-food',
  ['shop','grocery','supermarket','convenience','mall','marketplace','clothing_store','bakery'],'venue-shop',
  ['office','industrial','commercial','bank','town_hall','post'],'venue-office',
  ['hospital','doctor','doctors','pharmacy','clinic','dentist','medical'],'venue-medical',
  ['station','bus','bus_stop','railway','railway_station','ferry_terminal','airport','fuel','parking','bicycle'],'venue-transit',
  ['park','garden','playground','zoo','picnic_site'],'venue-park',
  ['school','college','university','library','kindergarten'],'venue-school',
  ['hotel','hostel','lodging','motel','guest_house'],'venue-hotel',
  ['museum','theatre','cinema','arts_centre','attraction','gallery','artwork'],'venue-art',
  'venue-building']];
const major = byClass(['motorway','trunk','primary','secondary']);
const local = byClass(['tertiary','minor','service','track','path']);
const placeName = ['coalesce',['get','name:latin'],['get','name_en'],['get','name']];
const buildingHeight = ['number',['get','render_height'],0];
const buildingBase = ['min',buildingHeight,['max',0,['number',['get','render_min_height'],0]]];
const buildingShape = {
 type:'fill-extrusion',
 filter:['all',['!=',['get','hide_3d'],true],['>',buildingHeight,0]],
 layout:{visibility:'none'}
};
const extrusion = {'fill-extrusion-height':buildingHeight,'fill-extrusion-base':buildingBase,'fill-extrusion-vertical-gradient':true};

const lightColors = {
 '#162e52':'#9eb9e3', '#152c47':'#b0c9ed', '#142b43':'#b7d0ee',
 '#617ca6':'#e2edf6', '#415779':'#dee9f2', '#202d46':'#e8edf4', '#202b41':'#eef1f7',
 '#879fc6':'#738fb8', '#667fa7':'#819bc0', '#4c6287':'#becfe0', '#162c46':'#aec8e6',
 '#1b3956':'#b4cfee', '#214439':'#c1ded0', '#244c40':'#cde6d8', '#40668b':'#83acd9',
 '#465574':'#c0cce1', '#35425e':'#ced7e8', '#536585':'#9eb1cf', '#a696c7':'#8775a5',
 '#121e31':'#b4c4df', '#8c9dbd':'#fff', '#514235':'#cba879', '#ccaa7d':'#ffe0a7',
 '#445673':'#c4d1e8', '#667ca7':'#a0b3d9', '#889bc6':'#8a9fc8',
 '#eef3ff':'#293959', '#111a30':'#f8fbff', '#c4d4ed':'#425578', '#121b2e':'#f7faff',
 '#a9e6f3':'#184f66', '#e4eaf9':'#253451'
};
const lighten = value => Array.isArray(value) ? value.map(lighten) : lightColors[value] ?? value;

export function atlasStyle(detail = false, vectorWorld = false, origin = '', light = false, language = 'en') {
 const finish=light?'light':'dark';
 const buildingPattern = material => ['image','building-'+material+'-'+finish];
 const named = ['coalesce',['get',language==='zh'?'name:zh-Hans':'name:'+language],
  ['get','name:'+language],['get','name:en'],['get','name:latin'],['get','name_en'],['get','name'],''];
 const overview = vectorWorld ? [
  {id:'world-ocean',type:'background',paint:{'background-color':['interpolate',['linear'],['zoom'],0,'#162e52',5,'#152c47',10,'#142b43']}},
  {id:'world-land',type:'fill',source:'world-vectors','source-layer':'land',paint:{
   'fill-color':['interpolate',['linear'],['zoom'],0,'#617ca6',4,'#415779',9,'#202d46',13,'#202b41'],
   'fill-antialias':false
  }},
  {id:'world-borders',type:'line',source:'world-vectors','source-layer':'borders',maxzoom:11,paint:{
   'line-color':['interpolate',['linear'],['zoom'],0,'#879fc6',5,'#667fa7',10,'#4c6287'],
   'line-width':['interpolate',['linear'],['zoom'],0,.36,8,1.05]
  }}
 ] : [
  {id:'desktop-water',type:'background',paint:{'background-color':'#162c46'}},
  {id:'desktop-world',type:'raster',source:'world',paint:{
   'raster-saturation':-.38,'raster-brightness-min':light ? .36 : .04,'raster-brightness-max':light ? .94 : .49,'raster-fade-duration':0,
   'raster-opacity':['interpolate',['linear'],['zoom'],4,1,12,.18]
  }}
 ];
 const layers = [...overview,
  source('water',{id:'atlas-water',type:'fill',minzoom:7,paint:{'fill-color':'#1b3956'}}),
  source('landcover',{id:'atlas-green',type:'fill',minzoom:8,filter:byClass(['wood','grass']),paint:{'fill-color':'#214439','fill-opacity':.76}}),
  source('landuse',{id:'atlas-parks',type:'fill',minzoom:10,filter:byClass(['park','cemetery','recreation_ground']),paint:{'fill-color':'#244c40'}}),
  line('atlas-rivers','waterway',8,'#40668b',zoomWidth(.45,3.6)),
  source('building',{id:'atlas-buildings',type:'fill',minzoom:14,paint:{'fill-color':detail?'#465574':'#35425e','fill-outline-color':'#536585'}}),
  ...(detail?[line('atlas-rail','transportation',12,'#a696c7',zoomWidth(.5,2),byClass(['rail','transit']))]:[]),
  line('atlas-local-road-casing','transportation',11,'#121e31',zoomWidth(.55,5.9),local),
  line('atlas-local-road','transportation',11,'#8c9dbd',zoomWidth(.35,4.2),local),
  line('atlas-main-road-casing','transportation',7,'#514235',zoomWidth(1.2,9.8),major),
  line('atlas-main-road','transportation',7,'#ccaa7d',zoomWidth(.8,7.2),major),
  source('building',{
   ...buildingShape,id:'atlas-buildings-3d',minzoom:14,maxzoom:17,
   paint:{
    'fill-extrusion-color':['interpolate',['linear'],buildingHeight,0,'#445673',45,'#667ca7',180,'#889bc6'],
    ...extrusion
   }
  }),
  source('building',{
   ...buildingShape,id:'atlas-buildings-textured',minzoom:17,
   paint:{
    ...extrusion,
    'fill-extrusion-pattern':['step',buildingHeight,buildingPattern('brick'),16,buildingPattern('concrete'),42,buildingPattern('glass')]
   }
  }),
  source('place',{id:'atlas-places',type:'symbol',minzoom:5,filter:byClass(['city','town','village','suburb','neighbourhood']),
   layout:{'text-field':placeName,'text-font':['Noto Sans Regular'],'text-size':['interpolate',['linear'],['zoom'],5,11,14,15],'text-max-width':9},
   paint:{'text-color':'#eef3ff','text-halo-color':'#111a30','text-halo-width':1.45}}),
  source('transportation_name',{id:'atlas-street-names',type:'symbol',minzoom:13,
   layout:{'symbol-placement':'line','text-field':placeName,'text-font':['Noto Sans Regular'],'text-size':11,'symbol-spacing':300},
   paint:{'text-color':'#c4d4ed','text-halo-color':'#121b2e','text-halo-width':1.2}}),
  source('poi',{id:'atlas-venues',type:'symbol',minzoom:15,
   filter:['all',['!=',named,''],['!',byClass(['entrance','gate','lift_gate','bollard','cycle_barrier','waste_basket'])]],
   layout:{'symbol-sort-key':['number',['get','rank'],99],
    'icon-image':venueIcon,'icon-padding':3,
    'text-field':named,'text-font':['Noto Sans Regular'],
    'text-size':['interpolate',['linear'],['zoom'],15,11,19,14],
    'text-offset':[.6,0],'text-anchor':'left','text-padding':3,'text-max-width':13},
   paint:{'text-color':'#a9e6f3','text-halo-color':'#121b2e','text-halo-width':1.4}}),
  {id:'atlas-building-names',type:'symbol',source:'named-buildings',minzoom:16,
   layout:{'icon-image':'venue-building','icon-padding':3,'text-offset':[.65,0],'text-anchor':'left',
    'text-field':named,'text-font':['Noto Sans Regular'],'text-size':13,'text-padding':4,'text-max-width':13},
   paint:{'text-color':'#e4eaf9','text-halo-color':'#121b2e','text-halo-width':1.4}},
  {id:'atlas-traffic-signals',type:'symbol',source:'traffic-signals',minzoom:17,
   layout:{'icon-image':'traffic-signal','icon-anchor':'bottom','icon-padding':2,'icon-pitch-alignment':'viewport'},
   paint:{'icon-opacity':1}}
 ];
 return {
  version:8, name:'Noticoin Atlas', projection:{type:'globe'}, glyphs:origin+'/tiles/fonts/{fontstack}/{range}.pbf',
  sources:{
   ...(vectorWorld?{'world-vectors':{type:'vector',tiles:[origin+'/atlas/world/{z}/{x}/{y}.pbf'],maxzoom:6}}
    :{world:{type:'raster',tiles:[origin+'/world/{z}/{x}/{y}.png'],tileSize:256,maxzoom:2}}),
   openmaptiles:{type:'vector',tiles:[origin+'/street/{z}/{x}/{y}.pbf'],minzoom:7,maxzoom:14},
   'traffic-signals':{type:'geojson',data:origin+'/atlas/shibuya-signals.json',attribution:'© OpenStreetMap contributors (ODbL)'},
   'named-buildings':{type:'geojson',data:origin+'/atlas/shibuya-buildings.json',attribution:'© OpenStreetMap contributors (ODbL)'}
  },
  layers:light?layers.map(layer=>({...layer,paint:Object.fromEntries(Object.entries(layer.paint).map(([key,value])=>[key,lighten(value)]))})):layers
 };
}
