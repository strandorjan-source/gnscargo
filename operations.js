/* Internal operations dashboard and follow-up. Never included in carrier documents. */
'use strict';
const cargoStatusLabels = { created: 'Opprettet', sent: 'Sendt – manuelt registrert', picked_up: 'Lastet / underveis', delivered: 'Levert', invoiced: 'Avsluttet', cancelled: 'Kansellert' };
const cargoIncidentLabels = { delay: 'Forsinkelse', damage: 'Skade', temperature: 'Temperaturavvik', other: 'Annet' };
let opsStaff = [], opsCarrierUsers = [], opsIncidents = [], opsDocuments = [], opsOrder = null;
let opsGeneration = 0, opsListPage = 0, opsHistoryPage = 0, opsRefreshBusy = false, opsRefreshAgain = false;
let opsBackFocus = null;
const opsPageSize = 30;
function cargoDay(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return value;
  const d = new Date(value); if (!Number.isFinite(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(x => [x.type,x.value]));
  return p.year + '-' + p.month + '-' + p.day;
}
function cargoNextDay(day) { return new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10); }
function cargoKnownPrice(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function cargoOperationFlags(order, incidents = [], documents = [], today = cargoDay(new Date())) {
  if (order.status === 'cancelled') return [{ text:'Kansellert', type:'good' }];
  const flags = [];
  const add = (test,text,type='') => { if(test) flags.push({text,type}); };
  const active = !['delivered','invoiced'].includes(order.status) && !order.customer_invoice_sent;
  add(active && (!order.carrier_name || !order.vehicle_registration),'Mangler bil / transportør','danger');
  add(active && !String(order.delivery_name || '').trim(),'Mangler lossested');
  add(!String(order.customer_reference || '').trim(),'Mangler kundereferanse');
  add(!cargoKnownPrice(order.customer_price),'Mangler kundepris');
  add(!cargoKnownPrice(order.carrier_price),'Mangler transportørpris');
  add(!order.assigned_to,'Ikke fordelt');
  add(active && !!cargoDay(order.pickup_date || order.pickup_at) && cargoDay(order.pickup_date || order.pickup_at)<today,'Tidligere lastedato – kontroller status');
  add(incidents.some(x=>x.order_id===order.id && x.status!=='resolved'),'Åpent avvik','danger');
  add(order.status==='delivered' && !order.customer_invoice_sent,'Levert – ikke fakturert');
  add(order.status==='delivered' && !documents.some(x=>x.order_id===order.id && x.status==='ready' && ['pod','cmr'].includes(x.category)),'Mangler leveringsbevis');
  return flags;
}
function cargoOperationsFilter(source, options, incidents = [], documents = []) {
  const today=options.today||cargoDay(new Date()),tomorrow=cargoNextDay(today);
  return source.filter(o=> {
    const day=cargoDay(o.pickup_date||o.pickup_at);
    if(options.period==='cancelled') { if(o.status!=='cancelled')return false; }
    else if(o.status==='cancelled')return false;
    if(options.period==='today' && day!==today)return false;
    if(options.period==='tomorrow' && day!==tomorrow)return false;
    if(options.period==='near' && day!==today && day!==tomorrow)return false;
    if(options.period==='unbilled' && !(o.status==='delivered'&&!o.customer_invoice_sent))return false;
    if(options.owner==='mine' && o.assigned_to!==options.userId)return false;
    if(options.owner==='unassigned' && o.assigned_to)return false;
    if(options.owner && !['mine','unassigned','all'].includes(options.owner) && o.assigned_to!==options.owner)return false;
    const q=(options.query||'').trim().toLocaleLowerCase('nb-NO');
    if(q && ![o.order_number,o.customer,o.customer_reference,o.pickup_name,o.delivery_name,o.carrier_name,o.vehicle_registration].some(v=>String(v||'').toLocaleLowerCase('nb-NO').includes(q)))return false;
    return !options.exceptions || cargoOperationFlags(o,incidents,documents,today).length>0;
  }).sort((a,b)=> {
    const score=o=>cargoOperationFlags(o,incidents,documents,today).reduce((n,f)=>n+(f.type==='danger'?10:1),0);
    return score(b)-score(a) || cargoDay(a.pickup_date||a.pickup_at).localeCompare(cargoDay(b.pickup_date||b.pickup_at)) || Number(a.order_number)-Number(b.order_number);
  });
}
function opsName(id) { return opsStaff.find(x=>x.id===id)?.name || (id?'Tidligere / annen bruker':'Ikke fordelt'); }
function opsChoices(list,selected,empty) { return '<option value="">'+esc(empty)+'</option>'+(selected&&!list.some(x=>x.id===selected)?'<option selected value="'+esc(selected)+'">Tidligere ansvarlig – velg ved behov en ny</option>':'')+list.map(x=>'<option value="'+esc(x.id)+'"'+(x.id===selected?' selected':'')+'>'+esc(x.name)+'</option>').join(''); }
function opsDate(value) { return value?new Intl.DateTimeFormat('nb-NO',{timeZone:'Europe/Oslo',dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'Ikke oppgitt'; }
function opsButton(text,action,kind='white') { const b=document.createElement('button');b.type='button';b.className='btn '+kind;b.textContent=text;b.onclick=action;return b; }
async function opsRun(button,fn) {
  if(button.disabled)return; button.disabled=true;
  try{await fn();}catch(e){note($('opsMessage'),e.message||'Handlingen kunne ikke fullføres.',true);}
  finally{button.disabled=false;}
}
async function opsRead(table,orderId,sort='created_at') {
  const rows=[];
  for(let offset=0;;offset+=500){let q=s.from(table).select('*').order(sort,{ascending:false}).order('id',{ascending:false}).range(offset,offset+499);if(orderId)q=q.eq('order_id',orderId);const result=await q;if(result.error)throw result.error;rows.push(...(result.data||[]));if((result.data||[]).length<500)return rows;}
}
function installOperations() {
  const panel=document.createElement('section');panel.id='operationsPanel';panel.className='panel';
  panel.innerHTML='<div class="ops-heading"><div><h2 style="margin:0">Arbeidsoversikt</h2><p class="muted">Lass som trenger oppfølging vises først. Alle datoer følger norsk tid.</p></div><button id="opsReload" class="btn white" type="button">Oppdater oversikten</button></div><div id="opsDashboardMessage" role="status"></div><div class="ops-filters"><label>Periode<select id="opsPeriod"><option value="near">I dag og i morgen</option><option value="today">I dag</option><option value="tomorrow">I morgen</option><option value="all">Alle ikke-kansellerte</option><option value="unbilled">Levert – ikke fakturert</option><option value="cancelled">Kansellerte</option></select></label><label>Ansvarlig<select id="opsOwner"><option value="all">Alle befraktere</option><option value="mine">Mine oppdrag</option><option value="unassigned">Ikke fordelt</option></select></label><label>Søk<input id="opsSearch" placeholder="Kunde, ref., sted eller bil"></label><label>Visning<select id="opsExceptions"><option value="all">Alle i utvalget</option><option value="exceptions">Kun oppfølgingspunkter</option></select></label></div><p id="opsCounts" class="ops-counts"></p><div id="opsList" class="ops-list"></div><div class="ops-pager"><button id="opsPrev" class="btn white" type="button">Forrige</button><span id="opsPage"></span><button id="opsNext" class="btn white" type="button">Neste</button></div>';
  $('cargoPanel').querySelector('.hero').after(panel);
  ['opsPeriod','opsOwner','opsExceptions'].forEach(id=>$(id).onchange=()=>{opsListPage=0;renderOperations();});
  $('opsSearch').oninput=()=>{opsListPage=0;renderOperations();};
  $('opsPrev').onclick=()=>{opsListPage--;renderOperations();};$('opsNext').onclick=()=>{opsListPage++;renderOperations();};
  $('opsReload').onclick=()=>load();
  const modal=document.createElement('div');modal.id='opsModal';modal.className='modal hidden';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','opsTitle');
  modal.innerHTML='<div class="card"><div class="ops-heading"><h2 id="opsTitle">Oppfølging</h2><button id="opsClose" type="button" class="btn white">Lukk</button></div><p class="ops-internal">Internt arbeidsområde. Notater, avvik og historikk sendes ikke med transportordre, PDF, CMR eller EDI. Dokumenter lastes ned separat.</p><div id="opsMessage" role="status" aria-live="polite"></div><div id="opsContent"></div></div>';
  document.body.append(modal);
  $('opsClose').onclick=closeOrderFollowup;
  modal.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();closeOrderFollowup();}
    if(e.key==='Tab'){const controls=[...modal.querySelectorAll('button,input,select,textarea,a')].filter(x=>!x.disabled && !x.closest('.hidden'));const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  });
  const button=opsButton('Oppfølging / dokumenter',()=>openOrderFollowup(current.id),'blue');button.id='orderFollowupBtn';$('editBtn').after(button);
  new MutationObserver(()=>{if($('app').classList.contains('hidden')){opsGeneration++;opsOrder=null;opsStaff=[];opsCarrierUsers=[];opsIncidents=[];opsDocuments=[];$('opsContent').replaceChildren();$('opsModal').classList.add('hidden');$('opsList').replaceChildren();}}).observe($('app'),{attributes:true,attributeFilter:['class']});
}
async function refreshOperations() {
  if(!me || !$('operationsPanel') || $('app').classList.contains('hidden'))return;
  if(opsRefreshBusy){opsRefreshAgain=true;return;}opsRefreshBusy=true;const userId=me.id;
  try{
    const [staff,incidents,documents]=await Promise.all([s.rpc('cargo_staff_directory'),opsRead('order_incidents'),opsRead('order_documents')]);
    if(!me || me.id!==userId)return;if(staff.error)throw staff.error;
    opsStaff=staff.data||[];opsIncidents=incidents;opsDocuments=documents;
    const selected=$('opsOwner').value;
    $('opsOwner').innerHTML='<option value="all">Alle befraktere</option><option value="mine">Mine oppdrag</option><option value="unassigned">Ikke fordelt</option>'+opsStaff.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('');
    if([...$('opsOwner').options].some(x=>x.value===selected))$('opsOwner').value=selected;
    note($('opsDashboardMessage'),'');renderOperations();
  }catch(e){note($('opsDashboardMessage'),'Oppfølgingsdata kunne ikke oppdateres. Oversikten kan være ufullstendig: '+e.message,true);renderOperations();}
  finally{opsRefreshBusy=false;if(opsRefreshAgain){opsRefreshAgain=false;refreshOperations();}}
}
function renderOperations() {
  if(!$('operationsPanel')||!me)return;
  const options={period:$('opsPeriod').value,owner:$('opsOwner').value,userId:me.id,query:$('opsSearch').value,exceptions:$('opsExceptions').value==='exceptions'};
  const list=cargoOperationsFilter(orders,options,opsIncidents,opsDocuments);
  opsListPage=Math.max(0,Math.min(opsListPage,Math.ceil(list.length/opsPageSize)-1));
  const first=opsListPage*opsPageSize;$('opsList').replaceChildren();
  for(const o of list.slice(first,first+opsPageSize)){
    const card=document.createElement('article');card.className='ops-row';
    const flags=cargoOperationFlags(o,opsIncidents,opsDocuments);
    card.innerHTML='<div><h3>#'+esc(o.order_number)+' · '+esc(o.customer)+'</h3><div>'+pickupOverviewDate(o)+'</div><div class="muted">'+esc(o.pickup_name||'Ukjent hentested')+' → '+esc(o.delivery_name||'Ukjent lossested')+'</div><div>Kundereferanse: '+esc(o.customer_reference||'Mangler')+'</div><div class="ops-badges">'+flags.map(f=>'<span class="ops-badge '+f.type+'">'+esc(f.text)+'</span>').join('')+'</div></div><div><b>'+esc(opsName(o.assigned_to))+'</b><p>'+esc(o.carrier_name||'Ingen transportør')+' · '+esc(o.vehicle_registration||'Ingen bil')+'</p><div>'+esc(cargoStatusLabels[o.status]||o.status)+'</div><small>Opprettet av '+esc(creator(o))+'</small></div><div class="ops-controls"></div>';
    card.querySelector('.ops-controls').append(opsButton('Oppfølging',()=>openOrderFollowup(o.id),'blue'),opsButton('Åpne ordre',()=>openOrder(o.id)));
    $('opsList').append(card);
  }
  if(!list.length)$('opsList').innerHTML='<div class="ops-empty">Ingen ordre i dette utvalget. Prøv «Alle ikke-kansellerte» eller en annen ansvarlig.</div>';
  $('opsCounts').textContent=list.length+' ordre · '+list.filter(o=>cargoOperationFlags(o,opsIncidents,opsDocuments).some(f=>f.type==='danger')).length+' med kritiske oppfølgingspunkter';
  $('opsPage').textContent='Side '+(opsListPage+1)+' av '+Math.max(1,Math.ceil(list.length/opsPageSize));$('opsPrev').disabled=opsListPage===0;$('opsNext').disabled=first+opsPageSize>=list.length;
}
function closeOrderFollowup() { opsGeneration++;opsOrder=null;$('opsModal').classList.add('hidden');$('opsContent').replaceChildren();opsBackFocus?.focus(); }
async function openOrderFollowup(id,keepMessage=false) {
  const ticket=++opsGeneration,userId=me?.id;opsBackFocus=document.activeElement;opsOrder=null;
  $('opsModal').classList.remove('hidden');$('opsContent').textContent='Henter ordren og oppfølgingen …';if(!keepMessage)note($('opsMessage'),'');$('opsClose').focus();
  try{
    const [snapshot,notes,incidents,documents,grants,staff,carriers]=await Promise.all([s.rpc('cargo_order_snapshot',{p_id:id}),opsRead('order_notes',id),opsRead('order_incidents',id),opsRead('order_documents',id),opsRead('order_upload_grants',id),s.rpc('cargo_staff_directory'),s.rpc('cargo_carrier_directory')]);
    if(ticket!==opsGeneration||!me||me.id!==userId)return;
    if(snapshot.error||staff.error||carriers.error)throw snapshot.error||staff.error||carriers.error;
    if(!snapshot.data)throw new Error('Ordren finnes ikke eller du mangler tilgang.');
    opsOrder=snapshot.data;opsStaff=staff.data||[];opsCarrierUsers=carriers.data||[];opsHistoryPage=0;
    $('opsTitle').textContent='Oppfølging · GNS-'+opsOrder.order_number;
    renderOrderFollowup(notes,incidents,documents,grants);
    await loadOrderHistory(ticket);
  }catch(e){if(ticket===opsGeneration){$('opsContent').replaceChildren();note($('opsMessage'),e.message,true);}}
}
function renderOrderFollowup(notes,incidents,documents,grants) {
  const o=opsOrder,cancelled=o.status==='cancelled';
  $('opsContent').innerHTML='<section class="ops-subsection"><h3>Ansvar og fremdrift</h3><p>Opprettet av '+esc(creator(o))+' · versjon '+esc(o.revision)+'</p><form id="opsAssignment"><div class="grid"><label>Ansvarlig befrakter<select name="assigned_to">'+opsChoices(opsStaff,o.assigned_to,'Ikke fordelt')+'</select></label><label>Oppdragsstatus<select name="status">'+Object.entries(cargoStatusLabels).filter(([k])=>k!=='cancelled'||cancelled).map(([k,v])=>'<option value="'+k+'"'+(k===o.status?' selected':'')+'>'+esc(v)+'</option>').join('')+'</select></label></div><p class="muted">Status registreres manuelt. «Sendt» er ikke en elektronisk mottakskvittering. Fakturastatus håndteres separat.</p><button type="submit" class="btn blue"'+(cancelled?' disabled':'')+'>Lagre ansvar og status</button></form></section><section class="ops-subsection"><h3>Interne notater</h3><div id="opsNotes"></div><form id="opsNoteForm"><label>Nytt internt notat<textarea name="body" required maxlength="10000"></textarea></label><button type="submit" class="btn white">Lagre internt notat</button></form></section><section class="ops-subsection"><h3>Avvik</h3><div id="opsIncidents"></div><form id="opsIncidentForm"><div class="grid"><label>Type<select name="category">'+Object.entries(cargoIncidentLabels).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('')+'</select></label><label>Hendelsen skjedde (norsk tid)<input name="happened_at" type="datetime-local" required></label><label>GNS fikk beskjed (norsk tid)<input name="notified_at" type="datetime-local" required></label><label>Ansvarlig<select name="assigned_to">'+opsChoices(opsStaff,o.assigned_to||me.id,'Ikke fordelt')+'</select></label></div><label>Beskrivelse<textarea name="description" required maxlength="10000"></textarea></label><button type="submit" class="btn white">Registrer avvik</button></form></section><section class="ops-subsection"><h3>Dokumentmappe</h3><p class="muted">PDF, JPG, PNG og WebP, maks. 20 MB per fil. Opplastede filer blir ikke automatisk sendt til kunde eller transportør.</p><div id="opsDocuments"></div><form id="opsUploadForm"><div class="grid"><label>Dokumenttype<select name="category">'+Object.entries(CargoDocuments.categories).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('')+'</select></label><label>Fil<input type="file" name="file" accept="application/pdf,image/jpeg,image/png,image/webp" required></label></div><button type="submit" class="btn white">Last opp dokument</button></form></section><section class="ops-subsection"><h3>Inviter transportør til å laste opp</h3><p class="muted">Velg riktig godkjent transportørbruker. Lenken gjelder kun denne ordren og krever innlogging med den valgte brukeren. Invitasjonen utløper etter 30 dager og kan trekkes tilbake.</p><form id="opsGrantForm"><label>Transportørbruker<select name="grantee_id" required>'+opsChoices(opsCarrierUsers,'','Velg mottaker')+'</select></label><button type="submit" class="btn white">Lag opplastingslenke</button></form><div id="opsGrants"></div></section><section class="ops-subsection"><h3>Endringshistorikk</h3><p class="muted">Automatisk historikk fra denne oppdateringen. Tidligere endringer kan ikke rekonstrueres. Notater og endringer kan ikke redigeres i historikken.</p><div id="opsHistory" class="ops-history"></div><button type="button" class="btn white" id="opsMoreHistory">Vis eldre hendelser</button></section><section class="ops-subsection"><h3>Kansellering</h3>'+(cancelled?'<p class="ops-internal">Kansellert: '+esc(o.cancellation_reason||'Ingen historisk begrunnelse')+'</p>':'<form id="opsCancelForm"><label>Begrunnelse<textarea id="cancelReason" name="reason" maxlength="2000" required></textarea></label><p class="muted">Ordren og dokumentasjonen beholdes. En eventuell bilreservasjon i Capacity må frigjøres separat. Transportøren blir ikke varslet automatisk.</p><button class="btn red" type="submit">Kanseller ordre</button></form>')+'</section>';
  $('opsAssignment').onsubmit=e=>{e.preventDefault();const form=e.target,data=Object.fromEntries(new FormData(form)),snapshot=opsOrder;opsRun(form.querySelector('button'),async()=>{await patchCargoOrder(snapshot,{assigned_to:data.assigned_to||null,status:data.status});await load();await openOrderFollowup(snapshot.id);note($('opsMessage'),'Ansvar og status er oppdatert.');});};
  $('opsNoteForm').onsubmit=e=>{e.preventDefault();const form=e.target,id=opsOrder.id,body=form.elements.body.value.trim();opsRun(form.querySelector('button'),async()=>{const r=await s.from('order_notes').insert({order_id:id,body});if(r.error)throw r.error;await openOrderFollowup(id);note($('opsMessage'),'Internt notat er lagret.');});};
  $('opsNotes').innerHTML=notes.map(n=>'<div class="ops-entry"><small>'+esc(opsDate(n.created_at))+' · '+esc(opsName(n.created_by))+'</small><p>'+esc(n.body)+'</p></div>').join('')||'<p class="muted">Ingen interne notater.</p>';
  const now=osloDateTime(new Date());$('opsIncidentForm').elements.happened_at.value=now;$('opsIncidentForm').elements.notified_at.value=now;
  $('opsIncidentForm').onsubmit=e=>{e.preventDefault();const form=e.target,id=opsOrder.id,v=Object.fromEntries(new FormData(form));opsRun(form.querySelector('button'),async()=>{for(const k of ['happened_at','notified_at']){const[date,time]=v[k].split('T');v[k]=scheduledAt(date,time);}v.assigned_to||=null;const r=await s.from('order_incidents').insert({...v,order_id:id});if(r.error)throw r.error;await load();await openOrderFollowup(id);note($('opsMessage'),'Avviket er registrert.');});};
  for(const incident of incidents){
    const item=document.createElement('div');item.className='ops-entry';
    item.innerHTML='<b>'+esc(cargoIncidentLabels[incident.category])+' · '+esc({open:'Åpent',in_progress:'Under behandling',resolved:'Løst'}[incident.status])+'</b><p>'+esc(incident.description)+'</p><small>Skjedde '+esc(opsDate(incident.happened_at))+' · varslet GNS '+esc(opsDate(incident.notified_at))+' · '+esc(opsName(incident.assigned_to))+'</small><p>'+esc(incident.resolution||'')+'</p>';
    if(incident.status!=='resolved'){
      const form=document.createElement('form');form.innerHTML='<div class="grid"><label>Status<select name="status"><option value="in_progress">Under behandling</option><option value="resolved">Løst</option></select></label><label>Ansvarlig<select name="assigned_to">'+opsChoices(opsStaff,incident.assigned_to,'Ikke fordelt')+'</select></label></div><label>Tiltak / løsning<textarea name="resolution" maxlength="10000"></textarea></label><button type="submit" class="btn white">Oppdater avvik</button>';
      form.onsubmit=e=>{e.preventDefault();const v=Object.fromEntries(new FormData(form)),id=opsOrder.id;opsRun(form.querySelector('button'),async()=>{if(v.status==='resolved'&&!v.resolution.trim())throw new Error('Beskriv løsningen før avviket lukkes.');v.assigned_to||=null;const r=await s.from('order_incidents').update(v).eq('id',incident.id).eq('revision',incident.revision).select('id').maybeSingle();if(r.error)throw r.error;if(!r.data)throw new Error('Avviket er endret av en kollega. Åpne oppfølgingen på nytt.');await load();await openOrderFollowup(id);});};item.append(form);
    }
    $('opsIncidents').append(item);
  }
  if(!incidents.length)$('opsIncidents').textContent='Ingen registrerte avvik.';
  for(const doc of documents){
    const row=document.createElement('div');row.className='ops-entry';row.innerHTML='<b>'+esc(CargoDocuments.categories[doc.category])+'</b> · '+esc(doc.filename)+'<br><small>'+esc(opsDate(doc.created_at))+' · '+(Number(doc.byte_size)/1024/1024).toFixed(2)+' MB · '+esc({pending:'Ufullført registrering',ready:'Registrert',withdrawn:'Trukket tilbake'}[doc.status])+'</small><div class="ops-controls"></div>';
    const buttons=row.querySelector('.ops-controls');
    if(doc.status==='ready')buttons.append(opsButton('Last ned',function(){opsRun(this,()=>CargoDocuments.download(s,doc));}));
    if(doc.status==='pending'&&doc.uploaded_by===me.id)buttons.append(opsButton('Fullfør registrering',function(){opsRun(this,async()=>{await CargoDocuments.finish(s,doc.id);await openOrderFollowup(o.id);});}));
    if(doc.status!=='withdrawn')buttons.append(opsButton('Trekk tilbake',function(){opsRun(this,async()=>{if(!confirm('Trekk tilbake dokumentet? Filen beholdes, men kan ikke lastes ned fra appen.'))return;const r=await s.from('order_documents').update({status:'withdrawn'}).eq('id',doc.id);if(r.error)throw r.error;await load();await openOrderFollowup(o.id);});}));
    $('opsDocuments').append(row);
  }
  if(!documents.length)$('opsDocuments').textContent='Ingen dokumenter ennå.';
  $('opsUploadForm').onsubmit=e=>{e.preventDefault();const form=e.target,id=opsOrder.id,file=form.elements.file.files[0],category=form.elements.category.value;opsRun(form.querySelector('button'),async()=>{try{await CargoDocuments.upload(s,id,file,category);}catch(error){await openOrderFollowup(id);throw error;}await load();await openOrderFollowup(id);note($('opsMessage'),'Dokumentet er lagret og knyttet til ordren.');});};
  $('opsGrantForm').onsubmit=e=>{e.preventDefault();const form=e.target,id=opsOrder.id;opsRun(form.querySelector('button'),async()=>{const r=await s.from('order_upload_grants').insert({order_id:id,grantee_id:form.elements.grantee_id.value}).select('id').single();if(r.error)throw r.error;await openOrderFollowup(id);note($('opsMessage'),'Lenken er klar nedenfor. Den er ikke sendt automatisk.');});};
  for(const grant of grants){const row=document.createElement('div');row.className='ops-entry';row.innerHTML='<b>'+esc(opsCarrierUsers.find(x=>x.id===grant.grantee_id)?.name||'Tidligere transportørbruker')+'</b><p>'+esc(grant.revoked_at?'Tilgang trukket tilbake':'Utløper '+opsDate(grant.expires_at))+'</p>';
    if(!grant.revoked_at && new Date(grant.expires_at)>new Date()){
      const input=document.createElement('input');input.className='ops-link';input.readOnly=true;input.setAttribute('aria-label','Opplastingslenke');input.value=new URL('/carrier-documents.html?grant='+encodeURIComponent(grant.id),location.origin).href;row.append(input);
      row.append(opsButton('Kopier lenke',async()=>{try{await navigator.clipboard.writeText(input.value);note($('opsMessage'),'Opplastingslenken er kopiert.');}catch{input.select();note($('opsMessage'),'Lenken er markert. Bruk Kopier i nettleseren.');}}),opsButton('Trekk tilbake tilgang',function(){opsRun(this,async()=>{const r=await s.from('order_upload_grants').update({revoked_at:new Date().toISOString()}).eq('id',grant.id);if(r.error)throw r.error;await openOrderFollowup(o.id);});}));
    }$('opsGrants').append(row);
  }
  $('opsMoreHistory').onclick=()=>{opsHistoryPage++;loadOrderHistory(opsGeneration);};
  if($('opsCancelForm'))$('opsCancelForm').onsubmit=e=>{e.preventDefault();const form=e.target,snapshot=opsOrder;opsRun(form.querySelector('button'),async()=>{const reason=form.elements.reason.value.trim();if(!reason)throw new Error('Skriv en begrunnelse.');if(!confirm('Kanseller GNS-'+snapshot.order_number+'? Historikken beholdes. Eventuell bilreservasjon må frigjøres separat.'))return;await patchCargoOrder(snapshot,{status:'cancelled',cancellation_reason:reason});await load();await openOrderFollowup(snapshot.id);note($('opsMessage'),'Ordren er kansellert. Husk eventuell varsling og frigivelse i Capacity.');});};
}
const opsFieldLabels={assigned_to:'Ansvarlig befrakter',status:'Status',carrier_price:'Avtalt transportørpris',customer_price:'Totalpris til kunde',customer_base_price:'Fraktsum til kunde',customer_diesel_percent:'Dieseltillegg (%)',customer_reference:'Kundereferanse',pickup_name:'Hentested',delivery_name:'Lossested',pickup_date:'Hentedato',vehicle_registration:'Registreringsnummer',instructions:'Instruksjoner til transportør',body:'Internt notat',description:'Beskrivelse',resolution:'Tiltak / løsning',cancellation_reason:'Begrunnelse for kansellering',carrier_name:'Transportør',filename:'Filnavn',category:'Type',grantee_id:'Invitert transportørbruker',revoked_at:'Tilgang trukket tilbake',cmr_details:'CMR-opplysninger'};
async function loadOrderHistory(ticket) {
  if(!opsOrder)return;const id=opsOrder.id,offset=opsHistoryPage*50,button=$('opsMoreHistory');button.disabled=true;
  try{
    const r=await s.from('order_activity').select('*').eq('order_id',id).order('id',{ascending:false}).range(offset,offset+49);if(r.error)throw r.error;
    if(ticket!==opsGeneration||!opsOrder||opsOrder.id!==id)return;
    for(const event of r.data||[]){const entry=document.createElement('details');const title=document.createElement('summary');title.textContent=opsDate(event.occurred_at)+' · '+event.actor_name+' · '+({orders:'Ordre',order_stops:'Stopp',order_notes:'Internt notat',order_incidents:'Avvik',order_documents:'Dokument',order_upload_grants:'Opplastingstilgang'}[event.entity]||'Endring')+' '+({INSERT:'opprettet',UPDATE:'endret',DELETE:'fjernet'}[event.action]||'');entry.append(title);
      for(const[key,value]of Object.entries(event.changes||{})){if(['id','order_id','storage_path','sha256','created_by','uploaded_by'].includes(key))continue;const change=document.createElement('div');change.className='ops-change';const label=document.createElement('b');label.textContent=opsFieldLabels[key]||key;const text=document.createElement('span');const describe=v=>v==null?'—':key==='assigned_to'?opsName(v):typeof v==='object'?JSON.stringify(v):String(v);text.textContent=describe(value.before)+' → '+describe(value.after);change.append(label,text);entry.append(change);} $('opsHistory').append(entry);
    }
    button.classList.toggle('hidden',(r.data||[]).length<50);if(!offset&&!r.data?.length)$('opsHistory').textContent='Ingen historikk registrert etter oppdateringen.';
  }catch(e){if(ticket===opsGeneration){opsHistoryPage=Math.max(0,opsHistoryPage-1);note($('opsMessage'),'Historikken kunne ikke hentes: '+e.message,true);}}
  finally{button.disabled=false;}
}
installOperations();
refreshOperations();
