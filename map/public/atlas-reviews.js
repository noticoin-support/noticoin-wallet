'use strict';

(() => {
 const byId = id => document.getElementById(id);
 const language = document.documentElement.lang;
 const number = new Intl.NumberFormat(language, {maximumFractionDigits:1});
 const date = new Intl.DateTimeFormat(language, {dateStyle:'medium'});
 const starsText = rating => '★'.repeat(rating)+'☆'.repeat(5-rating);

 function textElement(tag, className, text) {
  const element=document.createElement(tag);
  if(className)element.className=className;
  element.textContent=text;
  return element;
 }

 function placeName(feature) {
  const fields=feature.properties||{};
  return fields[language==='zh'?'name:zh-Hans':'name:'+language]||fields['name:'+language]||
   fields['name:en']||fields['name:latin']||fields.name_en||fields.name||'';
 }

 async function placeKey(feature,building,anchor) {
  const id=feature.id;
  if((typeof id==='string'||Number.isSafeInteger(id))&&/^[1-9]\d{0,15}$/.test(String(id)))return (building?'building-':'omt-')+id;
  const coordinates=anchor.map(value=>value.toFixed(5));
  const name=feature.properties?.name||placeName(feature);
  const source=JSON.stringify([name.normalize('NFKC').toLowerCase(),coordinates]);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
  return (building?'building-':'geo-')+Array.from(new Uint8Array(digest).subarray(0,16),value=>value.toString(16).padStart(2,'0')).join('');
 }

 function hasAuthorKey() {
  try{return !!localStorage.getItem('noticoin.identity')}catch{return false}
 }

 function create({api,write,tr,notice,compose,showNote,formatCoins,configureCoordinateButton}) {
  const dialog=byId('venue-dialog');
  const form=byId('venue-form');
  const title=byId('venue-title');
  const summary=byId('venue-summary');
  const list=byId('venue-reviews');
  const comment=byId('venue-comment');
  const status=byId('venue-status');
  const submit=byId('venue-submit');
  const addNote=byId('venue-add-note');
  const copyButton=byId('copy-venue-coordinates');
  const notes=byId('venue-notes');
  const choices=[];
  let current;

  configureCoordinateButton(copyButton,()=>current?.place?.location);
  addNote.onclick=()=>{
   if(!current?.place)return;
   const place=current.place;
   dialog.close();
   compose(place);
  };

  async function loadNotes(place,signal) {
   try{
    const data=await api('/api/points?venue='+place.id,{signal});
    if(signal.aborted)return;
    notes.replaceChildren();
    for(const point of data.points.slice(0,12)){
     const button=textElement('button','place-note',point.title);
     button.type='button';
     if(point.secretPriceAtomic){
      const price=textElement('small','place-note-price',formatCoins(point.secretPriceAtomic)+' Noticoin');
      price.prepend(NoticoinMapIcons.element('lock-keyhole'));
      button.append(price);
     }
     button.onclick=()=>{dialog.close();showNote(point)};
     notes.append(button);
    }
    if(!data.points.length)notes.append(textElement('p','small-note',tr('Заметок пока нет')));
   }catch(error){
    if(!signal.aborted)notes.textContent=error.message;
   }
  }

  function mark(rating) {
   for(const [index,{input,label}] of choices.entries()){
    label.dataset.selected=String(index<rating);
    input.checked=index+1===rating;
   }
  }

  for(let rating=1;rating<=5;rating++){
   const label=document.createElement('label');
   const input=document.createElement('input');
   input.type='radio';
   input.name='rating';
   input.value=rating;
   input.setAttribute('aria-label',tr('Оценка %1 из 5').replace('%1',number.format(rating)));
   const symbol=textElement('span','','★');
   symbol.setAttribute('aria-hidden','true');
   label.append(input,symbol);
   byId('venue-stars').append(label);
   choices.push({input,label});
  }

  function render(data) {
   summary.textContent=data.count?('★ '+number.format(data.average)+'  ·  '+tr('Отзывы: %1').replace('%1',number.format(data.count))):tr('Отзывов пока нет');
   list.replaceChildren();
   for(const review of data.reviews){
    const article=document.createElement('article');
    const heading=document.createElement('header');
    const rating=textElement('span','venue-review-stars',starsText(review.rating));
    rating.setAttribute('aria-label',tr('Оценка %1 из 5').replace('%1',number.format(review.rating)));
    heading.append(rating,textElement('time','small-note',date.format(new Date(review.updatedAt))));
    article.append(heading);
    if(review.body)article.append(textElement('p','',review.body));
    list.append(article);
   }
  }

  form.addEventListener('change',event=>{
   if(event.target.name==='rating')mark(Number(event.target.value));
  });
  form.addEventListener('submit',async event=>{
   event.preventDefault();
   const target=current;
   if(!target?.venue||submit.disabled)return;
   const rating=Number(new FormData(form).get('rating'));
   if(!rating){
    await notice(tr('Отзыв о заведении'),tr('Выберите от 1 до 5 звёзд.'));
    return;
   }
   submit.disabled=true;
   status.textContent='';
   try{
    const data=await write(target.path,'review',{venue:target.venue,rating,body:comment.value},target.abort.signal);
    if(current!==target||target.abort.signal.aborted)return;
    render(data);
    status.textContent=tr('Отзыв сохранён');
   }catch(error){
    if(!target.abort.signal.aborted)await notice(tr('Не удалось сохранить отзыв'),error.message);
   }finally{if(current===target)submit.disabled=false}
  });
  dialog.addEventListener('close',()=>{
   current?.abort.abort();
   current=undefined;
  });

  return {
   async open(feature,{building=false,coordinates,anchor=coordinates}={}) {
    const name=placeName(feature)||(building&&tr('Здание'));
    if(!name)return;
    const pin=feature.geometry?.type==='Point'?feature.geometry.coordinates:coordinates;
    if(!pin)return;
    current?.abort.abort();
    const target=current={abort:new AbortController()};
    const signal=target.abort.signal;
    title.textContent=name;
    addNote.disabled=true;
    copyButton.disabled=true;
    notes.textContent=tr('Загружаем заметки…');
    summary.hidden=building;
    summary.textContent=tr('Загружаем отзывы…');
    list.replaceChildren();
    status.textContent='';
    form.hidden=true;
    submit.disabled=false;
    comment.value='';
    mark(0);
    if(!dialog.open)dialog.showModal();
    try{
     target.venue=await placeKey(feature,building,feature.geometry?.type==='Point'?pin:anchor);
     if(signal.aborted)return;
     target.place={id:target.venue,name,location:pin};
     addNote.disabled=false;
     copyButton.disabled=false;
     void loadNotes(target.place,signal);
     if(building)return;
     target.path='/api/venues/'+target.venue+'/reviews';
     const [data,own]=await Promise.all([
      api(target.path,{signal}),
      hasAuthorKey()?write(target.path+'/mine','read-review',{venue:target.venue},signal):{review:null}
     ]);
     if(signal.aborted)return;
     render(data);
     if(own.review){
      mark(own.review.rating);
      comment.value=own.review.body;
     }
     form.hidden=false;
    }catch(error){
     if(!signal.aborted){
      if(!target.place)notes.textContent=error.message;
      if(!building)summary.textContent=error.message;
     }
    }
   }
  };
 }

 globalThis.NoticoinAtlasReviews={create};
})();
