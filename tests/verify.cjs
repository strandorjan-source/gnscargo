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
let importedCalls=[];
records.capacity_vehicles=[];
function query(table){
 let action='select',payload,filters=[],sortKey,ascending=true,range=null,single=false;
 const q={select(){return q},order(key,opt={}){sortKey=key;ascending=opt.ascending!==false;return q},range(a,b){range=[a,b];return q},eq(k,v){filters.push([k,v]);return q},single(){single=true;return q},maybeSingle(){single=true;return q},insert(p){action='insert';payload=p;return q},update(p){action='update';payload=p;return q},
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
w.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{user:{id:'test-user',email:'qa@example.invalid'}}}}),onAuthStateChange:()=>{},signOut:async()=>{}},from:query,rpc:async(name,args)=>{assert.equal(name,'create_cargo_order_from_capacity');importedCalls.push(args);const data={...args.p_order,id:'capacity-created',order_number:987};records.orders.push(data);return{data:{id:data.id,order_number:data.order_number,reused:false},error:null};}})};
w.HTMLCanvasElement.prototype.getContext=()=>null;w.alert=()=>{};w.HTMLElement.prototype.scrollIntoView=function(){};
w.Blob=Blob;let downloadedBlob=null;
w.URL.createObjectURL=blob=>{downloadedBlob=blob;return 'blob:qa'};w.URL.revokeObjectURL=()=>{};
vm.runInContext(main,ctx);
vm.runInContext(fs.readFileSync(root+'/order-entry.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/control-tower.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/location-register.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/carrier-register.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(require.resolve('jspdf/dist/jspdf.umd.min.js'),'utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/transport-documents.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/send-order.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/edi-order.js','utf8'),ctx);
w.fetch = async () => ({ok:true,json:async()=>({service:'gns-capacity',configured:true})});
vm.runInContext(fs.readFileSync(root+'/capacity-order.js','utf8'),ctx);
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
 const exported = new w.ExcelJS.Workbook(); await exported.xlsx.load(new w.Uint8Array(await downloadedBlob.arrayBuffer())); const invoicing=exported.getWorksheet('Fakturagrunnlag');
 assert(invoicing.getCell('L4').value.includes('Inngående faktura fra transportør')); assert(invoicing.getCell('M4').value.includes('Til fakturering kunde'));
 const invoiceRows=[];invoicing.eachRow(row=>{if(row.getCell(1).value==='GNS-600')invoiceRows.push(row)});assert.equal(invoiceRows[0].getCell(12).value,35000);assert.equal(invoiceRows[0].getCell(13).value,46500);
 assert.notEqual(invoiceRows[0].getCell(12).fill.fgColor.argb,invoiceRows[0].getCell(13).fill.fgColor.argb);
 assert(invoicing.getCell('L9').value.formula.startsWith('SUBTOTAL(109,L5:'));assert(invoicing.getCell('M10').value.formula.startsWith('SUBTOTAL(109,M5:'));
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
 await verifyDocuments(); await verifySchedulingAndDispatch(); await verifyLocations(); await verifyCapacityTab(); dom.window.close();
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
 await verifyCarrierAndPrivacy();
 await verifyEdiPreparation();
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
 await verifyCapacityImport(d.getElementById('capacityFrame'));
 d.getElementById('app').classList.add('hidden');await tick();assert(!d.getElementById('capacityFrame'));
 console.log('PASS: Capacity tab lazy-loads existing same-origin app, preserves order drafts, keyboard navigation, retry, and removes account view on sign-out.');
}

async function verifyLocations() {
 records.profiles[0].role='superuser';await run('session()');
 assert(!d.getElementById('usersBtn').classList.contains('hidden'));
 d.getElementById('newLocationRegister').click();
 const form=d.getElementById('locationForm'),f=form.elements;
 f.name.value='Terminal Æ';f.location_type.value='both';f.address.value='Testveien 1';f.postal_code.value='0010';f.city.value='Oslo';f.contact_name.value='Terminalkontakt';f.phone.value='12345678';
 await form.onsubmit({preventDefault(){},target:form});
 assert.equal(records.locations.length,1);assert.equal(records.locations[0].postal_code,'0010');
 assert(d.getElementById('locationModal').classList.contains('hidden'));
 const pickup=d.querySelector('#form [name=pickup_name]');pickup.value='Terminal Æ';pickup.dispatchEvent(new w.Event('change'));
 assert.equal(d.querySelector('#form [name=pickup_address]').value,'Testveien 1, 0010, Oslo');
 const delivery=d.querySelector('#form [name=delivery_name]');delivery.value='Terminal Æ';delivery.dispatchEvent(new w.Event('change'));
 assert.equal(d.querySelector('#form [name=delivery_phone]').value,'12345678');
 d.getElementById('addPickup').click();await tick();
 const extra=d.querySelector('#extraPickups [data-k=name]');assert.equal(extra.getAttribute('list'),'pickupLocations');extra.value='Terminal Æ';extra.dispatchEvent(new w.Event('change'));
 assert.equal(extra.closest('.multiStop').querySelector('[data-k=contact_name]').value,'Terminalkontakt');
 // Distinguish types and prevent duplicate names. Failed saves keep the form open.
 d.getElementById('newLocationRegister').click();f.name.value='terminal æ';await form.onsubmit({preventDefault(){},target:form});
 assert.equal(records.locations.length,1);assert(d.getElementById('locationMessage').textContent.includes('finnes allerede'));
 f.name.value='Kun lossing';f.location_type.value='delivery';await form.onsubmit({preventDefault(){},target:form});
 assert(![...d.getElementById('pickupLocations').options].some(o=>o.value==='Kun lossing'));
 assert([...d.getElementById('deliveryLocations').options].some(o=>o.value==='Kun lossing'));
 const oldAddress=d.querySelector('#form [name=pickup_address]').value;
 d.querySelector('#locationRegister .edit-location[data-id="'+records.locations[0].id+'"]').click();f.address.value='Ny vei 2';await form.onsubmit({preventDefault(){},target:form});
 assert.equal(records.locations[0].address,'Ny vei 2');assert.equal(d.querySelector('#form [name=pickup_address]').value,oldAddress);
 assert.deepEqual(errors,[]);
 d.getElementById('deliveryLocationTab').click();assert(d.getElementById('pickupLocationPanel').classList.contains('hidden'));assert(!d.getElementById('deliveryLocationPanel').classList.contains('hidden'));
 assert(d.getElementById('deliveryLocationRegister').textContent.includes('Kun lossing'));assert(!d.getElementById('locationRegister').textContent.includes('Kun lossing'));
 d.getElementById('newDeliveryLocationRegister').click();assert.equal(f.location_type.value,'delivery');d.getElementById('closeLocation').click();
 d.getElementById('pickupLocationTab').click();d.getElementById('newLocationRegister').click();assert.equal(f.location_type.value,'pickup');d.getElementById('closeLocation').click();
 console.log('PASS: separate pickup/delivery tabs with independent defaults; superuser Cargo access; location pre-save/edit, type-specific suggestions, duplicate prevention, main pickup/delivery and extra-stop autofill; existing order addresses unchanged.');
}

async function verifyCarrierAndPrivacy() {
 d.getElementById('newCarrierRegister').click();
 const form=d.getElementById('carrierForm'), f=form.elements;
 f.name.value='QA Transport Æ';f.email.value='booking@example.invalid';f.phone.value='77665544';f.org_number.value='123456789';
 await form.onsubmit({preventDefault(){},target:form});assert.equal(records.carriers.length,1);
 const input=d.querySelector('#form [name=carrier_name]');input.value='QA Transport Æ';input.dispatchEvent(new w.Event('change'));
 assert.equal(d.querySelector('#form [name=carrier_email]').value,'booking@example.invalid');
 await run("editOrder('o1')");await tick();
 const edit=d.querySelector('#editForm [name=carrier_name]');assert.equal(edit.getAttribute('list'),'carrierList');edit.value='QA Transport Æ';edit.dispatchEvent(new w.Event('change'));assert.equal(d.querySelector('#editForm [name=carrier_email]').value,'booking@example.invalid');
 d.getElementById('newCarrierRegister').click();f.name.value='  qa transport æ ';await form.onsubmit({preventDefault(){},target:form});assert.equal(records.carriers.length,1);assert(d.getElementById('carrierMessage').textContent.includes('allerede'));
 d.getElementById('closeCarrier').click();d.querySelector('#carrierRegister .edit-carrier').click();f.email.value='new@example.invalid';await form.onsubmit({preventDefault(){},target:form});assert.equal(records.carriers[0].email,'new@example.invalid');assert.equal(d.querySelector('#editForm [name=carrier_email]').value,'booking@example.invalid');
 run("current={id:'privacy',order_number:999,pickup_name:'Pickup',pickup_phone:'+47 99887766',pickup_contact:'Contact',pickup_date:'2026-10-08',delivery_name:'Delivery',delivery_phone:'44556677',driver_phone:'33445566',carrier_price:40000,customer_price:60000,instructions:'Ring +47 99 88 77 66',stops:[{id:'extra',stop_type:'pickup',stop_sequence:2,name:'Extra',phone:'88776655',instructions:'Call 88-77-66-55'}]}");
 const email=run('carrierEmail(current,{includeDelivery:true}).body');assert(!/99.?88.?77.?66|88.?77.?66.?55/.test(email));assert(email.includes('44556677'));assert(email.includes('33445566'));
 for(const expression of ['makePdf(current).output()', 'makeCmr(current,{sender_instructions:"Call 99887766",other_details:"88 77 66 55"}).output()']) {
   const pdf=run(expression);assert(!pdf.includes('99887766'));assert(!pdf.includes('99 88 77 66'));assert(!pdf.includes('88776655'));assert(!pdf.includes('88 77 66 55'));
 }
 assert.equal(run('current.pickup_phone'),'+47 99887766');
 console.log('PASS: carrier pre-save/edit/duplicate and create/edit autofill; internal pickup numbers removed from email, PDFs and CMR including copied instructions; delivery/driver phones and stored internal values retained.');
}

async function verifyEdiPreparation() {
 const carrier=records.carriers[0];
 d.querySelector('#carrierRegister .edit-carrier').click();
 const form=d.getElementById('carrierForm');form.elements.edi_system.value='opter';
 await form.onsubmit({preventDefault(){},target:form});
 assert.equal(carrier.edi_system,'opter');assert(d.getElementById('carrierRegister').textContent.includes('Opter – ikke tilkoblet'));
 const order={...JSON.parse(run('JSON.stringify(current)')),carrier_id:carrier.id,carrier_name:carrier.name,vehicle_registration:'QA12345',trailer_number:'QA-T1',customer:'INTERNAL CUSTOMER',customer_reference:'INTERNAL REFERENCE',reservation_comment:'INTERNAL COMMENT',created_by_email:'PRIVATE EMAIL',carrier_contact:'Dispatch',carrier_phone:'12344321',updated_at:'2026-10-06T19:00:00Z'};
 const {stops,...stored}=order;records.orders.push(stored);records.order_stops.push(...stops.map(stop=>({...stop,order_id:order.id})));
 await w.openOrder(order.id);
 const before=mutations.length, orderBefore=JSON.stringify(records.orders);
 await d.getElementById('sendEdiBtn').onclick();
 assert(!d.getElementById('ediModal').classList.contains('hidden'));
 assert(d.getElementById('ediRecipient').textContent.includes(carrier.name));
 assert(d.getElementById('ediConnection').textContent.includes('Ingen ordre er sendt'));
 assert(d.getElementById('confirmSendEdi').disabled);
 const data=JSON.parse(d.getElementById('ediJson').textContent), text=JSON.stringify(data);
 assert.equal(data.order.reference,'GNS-999');assert.equal(data.order.agreed_carrier_freight.amount,40000);
 assert.equal(data.order.pickups.length,2);assert.equal(data.order.pickups[0].planned_at,null);assert.equal(data.order.pickups[0].planned_date,'2026-10-08');
 assert.equal(data.order.deliveries[0].contact_phone,'44556677');assert.equal(data.order.driver_phone,'33445566');
 for(const secret of ['99887766','99 88 77 66','88776655','88-77-66-55','60000','INTERNAL CUSTOMER','INTERNAL REFERENCE','INTERNAL COMMENT','PRIVATE EMAIL','pickup_phone','customer_price']) assert(!text.includes(secret),secret);
 assert(!('contact_phone' in data.order.pickups[0]));assert(!('temperature' in data.order.deliveries[0]));
 d.getElementById('downloadEdiSample').click();assert.deepEqual(JSON.parse(await downloadedBlob.text()),data);
 assert.equal(mutations.length,before);assert.equal(JSON.stringify(records.orders),orderBefore);
 d.getElementById('closeEdi').click();d.getElementById('includeDelivery').checked=false;
 await d.getElementById('sendEdiBtn').onclick();const hidden=JSON.parse(d.getElementById('ediJson').textContent);
 assert(!('deliveries' in hidden.order));assert.equal(hidden.order.delivery_information_included,false);assert(!JSON.stringify(hidden).includes('44556677'));
 // Re-read the saved order on every opening and reject a stale carrier id.
 stored.carrier_name='Another recipient';await d.getElementById('sendEdiBtn').onclick();
 assert(d.getElementById('downloadEdiSample').disabled);assert.equal(d.getElementById('ediJson').textContent,'');
 assert(d.getElementById('ediNextStep').textContent.includes('Lagre transportøren'));
 stored.carrier_name=carrier.name;await d.getElementById('sendEdiBtn').onclick();
 d.getElementById('app').classList.add('hidden');await tick();assert(d.getElementById('ediModal').classList.contains('hidden'));assert.equal(d.getElementById('ediJson').textContent,'');
 await run('session()');d.getElementById('includeDelivery').checked=true;
 assert.deepEqual(errors,[]);
 console.log('PASS: EDI carrier preference, fresh recipient validation, honest disconnected state, allowlisted sample, internal-phone and customer privacy, optional delivery, download without send/status changes, and sign-out cleanup.');
}

async function verifyCapacityImport(frame) {
 const form=d.getElementById('form'),f=form.elements;form.reset();await tick();
 const vehicle={id:'11111111-1111-4111-8111-111111111111',status:'Reservert',reserved_at:'2026-10-06T18:25:00.123Z',updated_at:'2026-10-06T18:25:00.123Z',carrier:'QA Transport Æ',contact:'Transport office',phone:'11223344',registration:'QA12345',trailer_number:'TRAILER123',location:'Oslo',available_at:'2026-10-08T21:30:00Z',reservation_comment:'Internal booking note'};
 records.capacity_vehicles=[vehicle];
 const data={type:'gns-capacity-new-order',vehicleId:vehicle.id,reservedAt:vehicle.reserved_at};
 w.dispatchEvent(new w.MessageEvent('message',{origin:'https://evil.invalid',source:frame.contentWindow,data}));await tick();assert.equal(f.vehicle_registration.value,'');
 w.dispatchEvent(new w.MessageEvent('message',{origin:w.location.origin,source:null,data}));await tick();assert.equal(f.vehicle_registration.value,'');
 w.dispatchEvent(new w.MessageEvent('message',{origin:w.location.origin,source:frame.contentWindow,data}));await tick();await tick();
 assert.equal(d.getElementById('cargoTab').getAttribute('aria-selected'),'true');assert.equal(f.vehicle_registration.value,'QA12345');assert.equal(f.trailer_number.value,'TRAILER123');assert.equal(f.carrier_contact.value,'Transport office');assert.equal(f.carrier_phone.value,'11223344');assert.equal(f.driver_name.value,'');assert.equal(f.driver_phone.value,'');assert.equal(f.pickup_name.value,'');assert.equal(f.pickup_date.value,'2026-10-08');assert.equal(f.pickup_time.value,'');assert(f.vehicle_registration.readOnly);assert.equal(f.carrier_email.value,'new@example.invalid');
 f.customer.value='New customer';f.pickup_name.value='Exact loading site';await form.onsubmit({preventDefault(){},target:form});
 assert.equal(importedCalls.length,1);assert.equal(importedCalls[0].p_vehicle_id,vehicle.id);assert.equal(importedCalls[0].p_reserved_at,vehicle.reserved_at);assert.equal(importedCalls[0].p_order.trailer_number,'TRAILER123');assert.equal(importedCalls[0].p_stops[0].name,'Exact loading site');assert.equal(run('capacityOrderImport'),null);assert(!w.location.search.includes('capacity_vehicle'));
 // A handoff must not silently replace a previous order draft.
 f.customer.value='KEEP CUSTOMER';f.pickup_name.value='KEEP PICKUP';f.vehicle_registration.value='KEEPREG';
 w.history.replaceState({},'',run("capacityRequestUrl('"+vehicle.id+"','"+vehicle.reserved_at+"')"));await run('loadCapacityOrderRequest()');
 assert.equal(f.vehicle_registration.value,'KEEPREG');assert.equal(f.customer.value,'KEEP CUSTOMER');assert(d.getElementById('capacityImportNotice').textContent.includes('påbegynt ordre'));
 [...d.querySelectorAll('#capacityImportNotice button')].find(b=>b.textContent.includes('Bruk bilen')).click();assert.equal(f.vehicle_registration.value,'QA12345');assert.equal(f.customer.value,'KEEP CUSTOMER');assert.equal(f.pickup_name.value,'KEEP PICKUP');
 form.reset();await tick();assert.equal(run('capacityOrderImport'),null);assert.equal(f.vehicle_registration.readOnly,false);
 console.log('PASS: trusted iframe handoff opens Cargo, safe field mapping/contact separation, date-only suggestion, blank required pickup, atomic create RPC, URL cleanup and existing draft preservation.');
}
