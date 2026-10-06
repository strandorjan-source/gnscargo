const {JSDOM, VirtualConsole} = require('jsdom');
const vm = require('vm');
const fs = require('fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(__dirname, 'output');
fs.mkdirSync(output, {recursive:true});
const html = fs.readFileSync(root+'/app.html','utf8');
const main = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const errors=[];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e=> {if (!e.message.includes('navigation')) errors.push(e.message)});
const dom=new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g,''),{url:'https://gns-qa.invalid',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
const w=dom.window, ctx=dom.getInternalVMContext();
const d=w.document;
const customer={id:'cust-a',name:'Testkunde ÆØÅ AS',org_number:'001234567',invoice_email:'faktura@example.invalid',postal_code:'0001',city:'Bodø'};
const records={
 customers:[customer], profiles:[{id:'test-user',full_name:'QA',email:'qa@example.invalid',role:'dispatcher'}],locations:[],carriers:[],order_stops:[],
 orders:[
 {id:'o1',order_number:600,customer:customer.name,customer_reference:'=1+1',created_at:'2026-09-30T22:30:00Z',pickup_at:'2026-10-01T23:30:00Z',delivery_at:'2026-10-02T10:00:00Z',pickup_name:'Test henting',delivery_name:'Test levering',goods:'Testgods',pallets:33,weight_kg:19800.5,customer_price:46500,carrier_price:35000,carrier_invoice_received:true,customer_invoice_sent:false},
 {id:'o2',order_number:601,customer:'Historisk Kunde AS',created_at:'2026-10-02T11:00:00Z',customer_price:0,carrier_invoice_received:false,customer_invoice_sent:false},
 {id:'o3',order_number:602,customer:customer.name,created_at:'2026-10-02T11:00:00Z',customer_price:null,carrier_invoice_received:true,customer_invoice_sent:false},
 {id:'o4',order_number:603,customer:customer.name,created_at:'2026-10-02T11:00:00Z',customer_price:20000,carrier_invoice_received:true,customer_invoice_sent:true},
 {id:'o5',order_number:604,customer:customer.name,created_at:'2026-09-30T10:00:00Z',customer_price:9000,carrier_invoice_received:true,customer_invoice_sent:false}
 ]
};
let failCustomer=false;let mutations=[];
function query(table){
 let action='select',payload,filters=[],sortKey,ascending=true,range=null,single=false;
 const q={select(){return q},order(key,opt={}){sortKey=key;ascending=opt.ascending!==false;return q},range(a,b){range=[a,b];return q},eq(k,v){filters.push([k,v]);return q},single(){single=true;return q},insert(p){action='insert';payload=p;return q},update(p){action='update';payload=p;return q},
 then(resolve,reject){try{
 if(action==='insert'){
   
   if(table==='customers'&&failCustomer)return Promise.resolve({data:null,error:{message:'Test lagringsfeil'}}).then(resolve,reject);
   let items=(Array.isArray(payload)?payload:[payload]).map(p=>({...p,id:p.id||'new-'+records[table].length}));records[table].push(...items);mutations.push({table,action});return Promise.resolve({data:single?items[0]:items,error:null}).then(resolve,reject);
 }
 let data=records[table].filter(r=>filters.every(([k,v])=>r[k]===v));
 if(action==='update'){data.forEach(r=>Object.assign(r,payload));mutations.push({table,action});}
 if(sortKey)data=[...data].sort((a,b)=>(a[sortKey]>b[sortKey]?1:a[sortKey]<b[sortKey]?-1:0)*(ascending?1:-1));
 if(range)data=data.slice(range[0],range[1]+1);
 return Promise.resolve({data:single?(data[0]||null):data.map(r=>({...r})),error:null}).then(resolve,reject);
 }catch(e){return Promise.reject(e).then(resolve,reject)}}};return q;
}
w.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{user:{id:'test-user',email:'qa@example.invalid'}}}}),onAuthStateChange:()=>{},signOut:async()=>{}},from:query})};
w.HTMLCanvasElement.prototype.getContext=()=>null;w.alert=()=>{};w.HTMLElement.prototype.scrollIntoView=function(){};
w.Blob=Blob;let downloadedBlob=null;
w.URL.createObjectURL=blob=>{downloadedBlob=blob;return 'blob:qa'};w.URL.revokeObjectURL=()=>{};
vm.runInContext(main,ctx);
vm.runInContext(fs.readFileSync(root+'/order-entry.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/control-tower.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(require.resolve('jspdf/dist/jspdf.umd.min.js'),'utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/transport-documents.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/send-order.js','utf8'),ctx);
w.fetch = async () => ({ok:true,json:async()=>({service:'gns-capacity',configured:true})});
vm.runInContext(fs.readFileSync(root+'/capacity-tab.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/vendor/exceljs-4.4.0.min.js','utf8'),ctx);
const tick=()=>new Promise(r=>setTimeout(r,30));
const run=code=>vm.runInContext(code,ctx);
async function submitCustomer(name){d.querySelector('#customerForm [name=name]').value=name;d.querySelector('#customerForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();}
(async()=>{
 await tick();
 assert(!d.getElementById('app').classList.contains('hidden'));
 assert(d.getElementById('customer').required);assert(d.getElementById('pickup_name').required);
 assert.equal(d.querySelector('#form [name=weight_kg]').required,false);
 assert.equal(d.getElementById('customer').closest('.customer-field').querySelector('.field-badge').textContent,'Obligatorisk');
 assert.equal(d.querySelector('#form [name=weight_kg]').closest('label').querySelector('.field-badge').textContent,'Valgfritt');
 // Search and keyboard selection include historical names without silently changing the reference.
 const input=d.getElementById('customer');input.value='testkunde';input.dispatchEvent(new w.Event('input'));
 assert.equal(d.querySelectorAll('#customer-options [role=option]').length,1);
 input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',cancelable:true}));
 input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',cancelable:true}));
 assert.equal(input.value,customer.name);
 assert.equal(d.querySelector('#form [name=customer_reference]').value,'');
 input.value='Historisk';input.dispatchEvent(new w.Event('input'));
 assert(d.getElementById('customer-options').textContent.includes('Historisk Kunde AS'));
 // Save a new customer, retain optional invoice details, and avoid duplicate names.
 run('openCustomerForm()');
 d.querySelector('#customerForm [name=invoice_email]').value='ny@example.invalid';
 await submitCustomer('Ny Testkunde AS');
 assert.equal(records.customers.length,2);assert.equal(input.value,'Ny Testkunde AS');
 assert(d.getElementById('customerModal').classList.contains('hidden'));
 assert.equal(records.customers[1].invoice_email,'ny@example.invalid');
 run('openCustomerForm()');await submitCustomer('  ny testkunde as  ');assert.equal(records.customers.length,2);
 // Network/database failure keeps the dialog and data available for retry.
 run('openCustomerForm()');failCustomer=true;await submitCustomer('Feiler Kunde AS');
 assert(!d.getElementById('customerModal').classList.contains('hidden'));
 assert(d.getElementById('customerMessage').textContent.includes('Test lagringsfeil'), d.getElementById('customerMessage').textContent + JSON.stringify(errors));
 assert.equal(d.getElementById('saveCustomer').disabled,false);
 failCustomer=false;await submitCustomer('Feiler Kunde AS');assert.equal(records.customers.length,3);
 // Dynamic edit and multistop fields receive the same legends.
 await w.editOrder('o1');await tick();
 assert(d.querySelector('#editForm [name=customer]').required);assert(d.querySelector('#editForm [name=pickup_name]').required);
 assert(d.querySelector('#editForm [name=weight_kg]').closest('label').textContent.includes('Valgfritt'));
 d.getElementById('addPickup').click();await tick();
 assert(d.querySelector('#extraPickups [data-k=weight_kg]').closest('label').textContent.includes('Valgfritt'));
 // Oslo month boundary, invoice states, customer filter and missing vs. zero price.
 assert.equal(run("reportOrders(orders,{month:'2026-10',scope:'unbilled',customer:''}).length"),3);
 assert.equal(run("reportOrders(orders,{month:'2026-10',scope:'billing',customer:''}).length"),2);
 assert.equal(run("reportOrders(orders,{month:'2026-10',scope:'done',customer:''}).length"),1);
 assert.equal(run("reportOrders(orders,{month:'2026-10',scope:'unbilled',customer:normalizeCustomer('Historisk Kunde AS')}).length"),1);
 assert.equal(run("hasPrice({customer_price:0})"),true);assert.equal(run("hasPrice({customer_price:null})"),false);
 // Full download flow generates an XLSX without changing invoice state.
 d.getElementById('month').value='2026-10';d.getElementById('reportScope').value='unbilled';
 const before=JSON.stringify(records.orders);const beforeMutations=mutations.length;
 await run('exportInvoiceExcel()');
 assert(downloadedBlob);assert.equal(JSON.stringify(records.orders),before);assert.equal(mutations.length,beforeMutations);
 fs.writeFileSync(output+'/verified-report.xlsx',Buffer.from(await downloadedBlob.arrayBuffer()));
 assert(d.getElementById('reportMessage').textContent.includes('3 ordre'));
 // Empty result gives an explicit message and no new download.
 downloadedBlob=null;d.getElementById('month').value='2025-01';await run('exportInvoiceExcel()');
 assert.equal(downloadedBlob,null);assert(d.getElementById('reportMessage').textContent.includes('Ingen ordre'));
 // Pagination beyond the standard Supabase page limit.
 const saved=records.orders;records.orders=Array.from({length:1005},(_,i)=>({id:String(i),order_number:i}));
 assert.equal((await run("fetchAllRows('orders','order_number')")).data.length,1005);records.orders=saved;
 assert.deepEqual(errors,[]);
 console.log('PASS: required/optional labels, customer suggestions and keyboard selection, customer save/duplicate/retry, dynamic edit/stops, report filters, Oslo date boundary, XLSX download, no invoice mutations, empty state, 1005-row pagination.');
 await verifyDocuments(); await verifySchedulingAndDispatch(); await verifyCapacityTab(); dom.window.close();
})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1});

async function verifyDocuments(){
 const order=records.orders[0];
 Object.assign(order,{customer:'PRIVATE_CUSTOMER_NEVER_PRINT',customer_reference:'PRIVATE_REFERENCE_NEVER_PRINT',customer_price:987654.32,carrier_price:32123.45,carrier_name:'Test Transport AS',carrier_email:'carrier@example.invalid',driver_name:'Sjåfør Test',driver_phone:'+47 12345678',vehicle_registration:'TEST123',pickup_name:'Test Slakteri Bodø',pickup_address:'Lastegata 10, 8001 Bodø, Norge',pickup_contact:'Lastekontakt',pickup_phone:'+47 10000000',delivery_name:'Test Terminal Oslo',delivery_address:'Lossegata 20, 0010 Oslo, Norge',delivery_contact:'Lossekontakt',delivery_phone:'+47 20000000',instructions:'Hold 0 til +2 grader. Kontroller plombe ved ankomst.',temperature:'0 til +2 °C',cmr_details:{}});
 records.order_stops=[
 {id:'p1',order_id:order.id,stop_type:'pickup',stop_sequence:1,name:'STALE_PICKUP_MUST_NOT_PRINT',address:'Old address'},
 {id:'d1',order_id:order.id,stop_type:'delivery',stop_sequence:1,name:'STALE_DELIVERY_MUST_NOT_PRINT'},
 {id:'p2',order_id:order.id,stop_type:'pickup',stop_sequence:2,name:'Ekstra Lastested',address:'Ekstraveien 4',contact_name:'Ekstra kontakt',phone:'87654321',goods:'Fiskekasser',pallets:2,weight_kg:1000,temperature:'0 til +2',instructions:'Ekstra lasteinstruksjon'},
 {id:'d2',order_id:order.id,stop_type:'delivery',stop_sequence:2,name:'Ekstra Lossested',address:'Lossing 8',goods:'Fiskekasser',pallets:2,weight_kg:1000}
 ];
 await w.openOrder(order.id);
 const sheet=d.getElementById('sheet').textContent;
 assert(sheet.includes('32 123,45 NOK'));assert(sheet.includes('GNS-600'));assert(sheet.includes('LASTESTED 2'));assert(sheet.includes('LOSSESTED 2'));assert(sheet.includes('Ekstra lasteinstruksjon'));
 assert(!sheet.includes('PRIVATE_'));assert(!sheet.includes('STALE_'));assert(!sheet.includes('987654'));
 const mail=run('carrierEmail(current)');assert(mail.body.includes('32 123,45 NOK'));assert(mail.body.includes('Bestiller: GNS Cargo AS'));assert(mail.body.includes('Ekstra Lossested'));assert(!mail.body.includes('PRIVATE_'));
 const pdf=run('makePdf(current)');fs.writeFileSync(output+'/transport-order.pdf',Buffer.from(pdf.output('arraybuffer')));
 // Missing amount stays unknown; a genuine zero remains an explicit zero.
 assert.equal(run('documentAmount(null)'),'Ikke oppgitt');assert.equal(run('documentAmount(0)'),'0,00 NOK');
 // A blank/whitespace pickup is rejected before persistence, including edit.
 const before=mutations.length;d.getElementById('customer').value='Test';d.getElementById('pickup_name').value='   ';
 d.getElementById('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(mutations.length,before);assert(d.getElementById('msg').textContent.toLowerCase().includes('hentested'));
 // Open CMR form, save route-specific facts and preserve them on reopening.
 await run('openCmrForm()');
 assert.equal(d.querySelector('#cmrForm [name=sender_name]').value,'Test Slakteri Bodø');
 assert.equal(d.querySelector('#cmrForm [name=gross_weight]').value,''); // Never substitute net weight.
 assert.equal(d.querySelector('#cmrForm [name=packages]').value,''); // Paller are not automatically kolli.
 const cmrValues={sender_name:'Test Avsender AS',sender_address:'Avsendergata 1, 8001 Bodø, Norge',consignee_name:'Test Mottaker AS',consignee_address:'Mottaksgata 2, Oslo, Norge',carrier_address:'Transportveien 3, 8006 Bodø, Norge',pickup_country:'Norge',delivery_country:'Norge',packages:'99',packing:'Isoporkasser på 33 paller',goods:'Fersk laks',gross_weight:'21000.75',volume:'45.5',issue_place:'Bodø',issue_country:'Norge',issue_date:'2026-10-06',marks:'PL-123',documents:'Lasteliste GNS-600',agreements:'Leveres til avtalt tid',reservations:'',other_details:'Plombe 4567',cash_on_delivery:'',supplementary_charges:''};
 for(const [key,value] of Object.entries(cmrValues)) d.querySelector('#cmrForm [name='+key+']').value=value;
 w.capturePdf=(filename,doc)=>{fs.writeFileSync(output+'/'+(filename.startsWith('CMR')?'cmr-generated.pdf':'email-order.pdf'),Buffer.from(doc.output('arraybuffer')))};
 run('const qaMakeCmr=makeCmr; makeCmr=(...args)=>{const doc=qaMakeCmr(...args);doc.save=name=>{window.capturePdf(name,doc);return doc};return doc}; const qaMakePdf=makePdf;makePdf=(...args)=>{const doc=qaMakePdf(...args);doc.save=name=>{window.capturePdf(name,doc);return doc};return doc};');
 d.getElementById('cmrForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
 assert(d.getElementById('cmrMessage').textContent.includes('lagret'),d.getElementById('cmrMessage').textContent);
 assert.equal(records.orders[0].cmr_details.routes['p1|d1'].gross_weight,'21000.75');
 await run('openCmrForm()');assert.equal(d.querySelector('#cmrForm [name=gross_weight]').value,'21000.75');
 d.getElementById('cmrPickup').value='1';d.getElementById('cmrPickup').dispatchEvent(new w.Event('change'));
 assert.equal(d.querySelector('#cmrForm [name=sender_name]').value,'Ekstra Lastested');assert.equal(d.querySelector('#cmrForm [name=gross_weight]').value,'');
 d.getElementById('cmrPickup').value='0';d.getElementById('cmrPickup').dispatchEvent(new w.Event('change'));
 assert.equal(d.querySelector('#cmrForm [name=gross_weight]').value,'21000.75');
 // Blank unconfirmed CMR keeps weight field blank and known net separately in box 18.
 const blankCmr=run('makeCmr(current,{},undefined,"carrier")');fs.writeFileSync(output+'/cmr-blank.pdf',Buffer.from(blankCmr.output('arraybuffer')));
 // Long text must move to labelled annexes rather than disappear or overlap signatures.
 w.longInstructions=('Lang instruksjon med ÆØÅ og detaljert lasteinformasjon. '.repeat(150))+'END_OF_LONG_INSTRUCTIONS';
 const longPdf=run('makePdf({...current,instructions:window.longInstructions})');fs.writeFileSync(output+'/transport-long.pdf',Buffer.from(longPdf.output('arraybuffer')));
 const longCmr=run('makeCmr(current,{sender_instructions:window.longInstructions},undefined,"carrier")');fs.writeFileSync(output+'/cmr-long.pdf',Buffer.from(longCmr.output('arraybuffer')));
 // Email handler works with lexical current and opens a draft containing the same details.
 await d.getElementById('sendOrderBtn').onclick();
 assert(!d.getElementById('carrierEmailModal').classList.contains('hidden'));
 assert(d.getElementById('carrierEmailText').value.includes('32 123,45 NOK'));
 assert(!d.getElementById('carrierEmailText').value.includes('PRIVATE_'));
 assert(d.getElementById('openCarrierEmail').href.startsWith('mailto:carrier%40example.invalid'));
 assert.equal(d.querySelectorAll('#sendOrderBtn').length,1);
 assert.deepEqual(errors,[]);
 console.log('PASS: mandatory pickup; shared screen/PDF/email carrier details; price privacy; all stops; unknown vs zero price; CMR gross/net separation; persisted per-route CMR fields; three copies; long-text annexes; email draft and PDF attachment.');
}

async function verifySchedulingAndDispatch() {
 const form=d.getElementById('form'), f=form.elements;
 form.reset();
 assert(f.pickup_date.required); assert(f.vehicle_registration.required); assert(!f.pickup_time.required);
 assert.equal(f.pickup_date.closest('label').querySelector('.field-badge').textContent,'Obligatorisk');
 assert.equal(f.pickup_time.closest('label').querySelector('.field-badge').textContent,'Valgfritt');
 f.customer.value='Date only customer';f.pickup_name.value='Pickup only';f.vehicle_registration.value='TEST123';
 const submit=()=>form.onsubmit({preventDefault(){},target:form});
 let count=mutations.length;await submit();assert.equal(mutations.length,count);assert(d.getElementById('msg').textContent.includes('Hentedato'));
 f.pickup_date.value='2026-10-08';f.vehicle_registration.value='   ';
 await submit();assert.equal(mutations.length,count);assert(d.getElementById('msg').textContent.includes('Registreringsnummer'));
 f.vehicle_registration.value='TEST123';f.carrier_email.value='carrier@example.invalid';
 d.getElementById('addPickup').click();
 const extra=d.querySelector('#extraPickups .multiStop');extra.querySelector('[data-k=name]').value='Extra pickup';
 await submit();assert.equal(mutations.length,count);assert(d.getElementById('msg').textContent.includes('Hentedato'));
 extra.querySelector('[data-k=planned_date]').value='2026-10-09';
 f.delivery_name.value='Destination UNIQUE';f.temperature.value='2 degrees';
 await submit();const created=records.orders.at(-1);created.order_number=999;
 assert.equal(created.pickup_date,'2026-10-08');assert.equal(created.pickup_at,null);assert(!('pickup_time' in created));
 const newStops=records.order_stops.filter(x=>x.order_id===created.id);
 assert.equal(newStops.find(x=>x.stop_type==='pickup').planned_date,'2026-10-08');
 assert.equal(newStops.find(x=>x.stop_sequence===2).planned_date,'2026-10-09');
 assert.equal(newStops.find(x=>x.stop_type==='delivery').temperature,null);
 // Clock time is interpreted consistently in Oslo, including midnight and winter.
 assert.equal(run("scheduledAt('2026-10-08','00:00')"),'2026-10-07T22:00:00.000Z');
 assert.equal(run("scheduledAt('2026-12-08','09:30')"),'2026-12-08T08:30:00.000Z');
 assert.throws(()=>run("scheduledAt('2026-03-29','02:30')"));
 // Existing exact timestamps and date-only entries round-trip through the edit form.
 await w.editOrder('o1');assert.equal(d.querySelector('#editForm [name=pickup_time]').value,'01:30');
 await w.editOrder(created.id);
 const edit=d.getElementById('editForm');assert.equal(edit.elements.pickup_date.value,'2026-10-08');assert.equal(edit.elements.pickup_time.value,'');
 assert.equal(d.querySelectorAll('#editStops [data-stop]').length,1);
 const extraEdit=d.querySelector('#editStops [data-k=planned_date]');assert(extraEdit.required);
 count=mutations.length;extraEdit.value='';await edit.onsubmit({preventDefault(){},target:edit});assert.equal(mutations.length,count);
 extraEdit.value='2026-10-10';edit.elements.pickup_time.value='08:15';
 await edit.onsubmit({preventDefault(){},target:edit});assert.equal(created.pickup_at,'2026-10-08T06:15:00.000Z');
 await w.editOrder(created.id);edit.elements.pickup_time.value='';await edit.onsubmit({preventDefault(){},target:edit});assert.equal(created.pickup_at,null);
 await w.openOrder(created.id);
 const sections=run('carrierDocumentSections(current)');
 assert(sections.find(x=>x.title==='LASTESTED 1').lines.some(x=>x.includes('08.10.2026 (klokkeslett ikke avtalt)')));
 assert(!sections.filter(x=>x.title.startsWith('LOSSESTED')).some(x=>x.lines.some(y=>y.includes('Temperatur:'))));
 // Hide destination in the preview, PDF and email (including subject), then send it separately.
 const toggle=d.getElementById('includeDelivery');toggle.checked=false;toggle.dispatchEvent(new w.Event('change'));
 assert(!d.getElementById('sheet').textContent.includes('Destination UNIQUE'));
 await d.getElementById('sendOrderBtn').onclick();
 assert(!d.getElementById('carrierEmailText').value.includes('Destination UNIQUE'));
 assert(!d.getElementById('carrierEmailSubject').textContent.includes('Destination UNIQUE'));
 const pickupPdf=run('makePdf(current)');fs.writeFileSync(output+'/pickup-only.pdf',Buffer.from(pickupPdf.output('arraybuffer')));
 await d.getElementById('sendDeliveryBtn').onclick();
 assert.equal(d.getElementById('carrierEmailTitle').textContent,'Send losseinfo');
 const body=d.getElementById('carrierEmailText').value;
 assert(body.includes('Destination UNIQUE'));assert(body.includes('GNS-999'));assert(!body.includes('Pickup only'));assert(!body.includes('LASTESTED'));assert(!body.includes('Temperatur:'));
 const deliveryPdf=run('makePdf(current,{deliveryOnly:true})');fs.writeFileSync(output+'/delivery-only.pdf',Buffer.from(deliveryPdf.output('arraybuffer')));
 const workbook=run('buildInvoiceWorkbook(window.ExcelJS,[current],[],{month:"",scope:"all"})');assert.equal(workbook.getWorksheet('Fakturagrunnlag').getCell('D5').value.toISOString(),'2026-10-08T00:00:00.000Z');
 assert.deepEqual(errors,[]);
 console.log('PASS: pickup date and registration required; optional time retained as null; extra stop validation; create/edit round-trip; Oslo DST/midnight; date-only Excel/PDF/email; pickup-only dispatch; separate delivery PDF/email; no delivery temperatures.');
}

async function verifyCapacityTab() {
 const cargo=d.getElementById('cargoTab'), capacity=d.getElementById('capacityTab');
 assert.equal(d.querySelectorAll('#capacityFrame').length,0);
 assert.equal(d.getElementById('cargoPanel').parentElement.id,'app');
 assert.equal(d.getElementById('capacityPanel').parentElement.id,'app');
 d.querySelector('#form [name=pickup_name]').value='Preserve unsaved order';
 capacity.click();await tick();
 assert.equal(capacity.getAttribute('aria-selected'),'true');
 const frame=d.getElementById('capacityFrame');assert(frame);assert.equal(frame.getAttribute('src'),'/capacity');
 frame.dispatchEvent(new w.Event('load'));
 assert(d.getElementById('cargoPanel').classList.contains('hidden'));
 cargo.click();capacity.click();await tick();assert.equal(d.getElementById('capacityFrame'),frame);
 assert.equal(d.querySelector('#form [name=pickup_name]').value,'Preserve unsaved order');
 capacity.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowLeft',cancelable:true}));assert.equal(cargo.getAttribute('aria-selected'),'true');
 // Explicit errors can be retried; a signed-out app discards the embedded session view.
 w.fetch=async()=>({ok:false});await d.getElementById('capacityRetry').onclick();
 assert(d.getElementById('capacityStatus').textContent.includes('kunne ikke lastes'));assert(!d.getElementById('capacityRetry').disabled);
 w.fetch=async()=>({ok:true,json:async()=>({service:'gns-capacity',configured:true})});capacity.click();await tick();assert(d.getElementById('capacityFrame'));
 d.getElementById('app').classList.add('hidden');await tick();assert(!d.getElementById('capacityFrame'));
 console.log('PASS: Capacity tab lazy-loads existing same-origin app, preserves order drafts, keyboard navigation, retry, and removes account view on sign-out.');
}
