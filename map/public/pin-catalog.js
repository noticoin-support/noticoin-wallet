'use strict';

// Each amount is in atomic units. The category icon and basic alternatives are free.
const notiExtendedPrice = '600000000';
const notiSaleWeekPrice = '200000000';
globalThis.NotiPinCatalog = Object.freeze({
 extendedPrice: notiExtendedPrice,
 saleWeekPrice: notiSaleWeekPrice,
 publicationBase(mode, selling, {priceAtomic = notiExtendedPrice, saleWeekPriceAtomic = notiSaleWeekPrice} = {}) {
  return BigInt(mode === 'paid' ? priceAtomic : selling ? saleWeekPriceAtomic : '0');
 },
 icons: Object.freeze({
  default: {label:'По категории', price:'0'},
  coffee: {label:'Кофе', glyph:'coffee', color:'#8a4e36', highlight:'#ffd0a5', price:'0'},
  trees: {label:'Деревья', glyph:'trees', color:'#276648', highlight:'#8ef2a9', price:'0'},
  camera: {label:'Камера', glyph:'camera', color:'#755da2', highlight:'#ead0ff', price:'0'},
  flag: {label:'Флаг', glyph:'flag', color:'#874957', highlight:'#ffc4cf', price:'0'},
  compass: {label:'Компас', glyph:'compass', color:'#2b6d87', highlight:'#a8f0fc', price:'50000000'},
  mountain: {label:'Горы', glyph:'mountain', color:'#4d6488', highlight:'#c4d7ff', price:'50000000'},
  heart: {label:'Сердце', glyph:'heart', color:'#ab455f', highlight:'#ffc0da', price:'50000000'},
  star: {label:'Звезда', glyph:'star', color:'#94540b', highlight:'#ffe784', price:'50000000'},
  sparkles: {label:'Искры', glyph:'sparkles', color:'#775278', highlight:'#ffd2ed', price:'100000000'},
  diamond: {label:'Бриллиант', glyph:'gem', color:'#2b649f', highlight:'#86f2ff', price:'100000000'},
  crown: {label:'Корона', glyph:'crown', color:'#8e2e9a', highlight:'#fdc1f4', price:'180000000'},
  'pulse-beacon': {label:'Пульсирующий маяк', glyph:'radio', color:'#086775', highlight:'#4efce1', price:'250000000', pulse:true},
  'pulse-bolt': {label:'Мигающая молния', glyph:'zap', color:'#9c4d0e', highlight:'#ffcc72', price:'350000000', pulse:true},
  'pulse-crown': {label:'Мигающая корона', glyph:'crown', color:'#6822a9', highlight:'#eab3ff', price:'450000000', pulse:true}
 })
});
