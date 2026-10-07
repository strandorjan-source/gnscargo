'use strict';
const {JSDOM,VirtualConsole}=require('jsdom'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(root+'/app.html','utf8');
const vc=new VirtualConsole(),errors=[];vc.on('jsdomError',e=>{if(!e.message.includes('navigation'))errors.push(e.message);});
const dom=new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g,''),{url:'https://qa.invalid',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window,d=w.document,ctx=dom.getInternalVMContext();
const today='2026-10-07';let currentSession={user:{id:'staff-a',email:'staff@example.invalid'}};
const db={profiles:[{id:'staff-a',full_name:'Befrakter A',email:'staff@example.invalid',role:'dispatcher'}],customers:[],carriers:[],locations:[],order_stops:[],order_notes:[],order_incidents:[],order_documents:[],order_upload_grants:[],order_activity:[],capacity_vehicles:[],orders:[
 {id:'order-a',order_number:801,revision:1,status:'created',customer:'Customer A',customer_reference:'REF A',assigned_to:'staff-a',pickup_name:'Pickup',pickup_date:today,delivery_name:'Delivery',vehicle_registration:'TEST123',carrier_name:'Carrier A',customer_price:43600,customer_base_price:40000,customer_diesel_percent:9,customer_diesel_amount:3600,carrier_price:35000,created_by:'staff-a',created_by_name:'Creator A',created_at:today+'T10:00:00Z'},
 {id:'order-b',order_number:802,revision:1,status:'created',customer:'Customer B',pickup_name:'Pickup B',pickup_date:'2026-10-08',assigned_to:'staff-b',created_at:today+'T10:00:00Z'},
 {id:'order-c',order_number:803,revision:1,status:'delivered',customer:'Customer C',pickup_date:today,customer_invoice_sent:false},
 {id:'order-d',order_number:804,revision:1,status:'cancelled',customer:'Cancelled',pickup_date:today}
]};
const calls=[],files=new Map();let failNotes=false;
function query(table){let action='read',payload,filters=[],single=false,range=null;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},order(){return q},range(a,b){range=[a,b];return q},single(){single=true;return q},maybeSingle(){single=true;return q},insert(p){action='insert';payload=p;return q},update(p){action='update';payload=p;return q},then(resolve,reject){try{
 let rows=db[table]||[];
 if(action==='insert'){
  if(table==='order_notes'&&failNotes)return Promise.resolve({data:null,error:{message:'Simulert lagringsfeil'}}).then(resolve,reject);
  const row={id:'new-'+table+'-'+rows.length,created_at:today+'T12:00:00Z',created_by:'staff-a',uploaded_by:'staff-a',revision:1,...payload};
  if(table==='order_documents')row.status='pending';if(table==='order_incidents')row.status='open';if(table==='order_upload_grants')row.expires_at='2099-01-01T00:00:00Z';rows.push(row);db[table]=rows;calls.push({table,action,payload});return Promise.resolve({data:single?{...row}:[{...row}],error:null}).then(resolve,reject);
 }
 rows=rows.filter(row=>filters.every(([k,v])=>row[k]===v));
 if(action==='update'){
  if(table==='order_documents'&&payload.status==='ready'&&rows.some(row=>!files.has(row.storage_path)))return Promise.resolve({data:null,error:{message:'Filen mangler'}}).then(resolve,reject);
  rows.forEach(row=>Object.assign(row,payload,{revision:(row.revision||0)+1}));calls.push({table,action,payload});
 }
 if(range)rows=rows.slice(range[0],range[1]+1);return Promise.resolve({data:single?(rows[0]?{...rows[0]}:null):rows.map(row=>({...row})),error:null}).then(resolve,reject);
 }catch(e){return Promise.reject(e).then(resolve,reject)}}};return q;}
async function rpc(name,args){calls.push({rpc:name,args});
 if(name==='cargo_staff_directory')return{data:[{id:'staff-a',name:'Befrakter A'},{id:'staff-b',name:'Befrakter B'}]};
 if(name==='cargo_carrier_directory')return{data:[{id:'carrier-a',name:'Carrier A'}]};
 if(name==='cargo_order_snapshot'){const row=db.orders.find(o=>o.id===args.p_id);return{data:row?{...row,stops:db.order_stops.filter(st=>st.order_id===row.id).map(st=>({...st}))}:null};}
 if(name==='save_cargo_order'){
  const row=db.orders.find(o=>o.id===args.p_id);if(!row||row.revision!==args.p_expected_revision)return{error:{code:'40001',message:'Ordren er endret av en annen bruker.'}};
  Object.assign(row,args.p_order,{revision:row.revision+1});return{data:{...row}};
 }
 throw new Error('Unexpected RPC '+name);
}
const client={from:query,rpc,auth:{getSession:async()=>({data:{session:currentSession}}),onAuthStateChange(){},signOut:async()=>{}},storage:{from(bucket){assert.equal(bucket,'cargo-order-documents');return{upload:async(p,bytes,options)=>{assert.equal(options.upsert,false);files.set(p,bytes);return{data:{path:p}};},download:async p=>({data:new Blob([files.get(p)])})};}}};
w.supabase={createClient:()=>client};w.structuredClone=structuredClone;Object.defineProperty(w,'crypto',{value:webcrypto});w.TextDecoder=TextDecoder;w.TextEncoder=TextEncoder;w.Blob=Blob;w.alert=()=>{};w.confirm=()=>true;w.HTMLElement.prototype.scrollIntoView=function(){};w.URL.createObjectURL=()=> 'blob:qa';w.URL.revokeObjectURL=()=>{};
const run=code=>vm.runInContext(code,ctx),tick=()=>new Promise(r=>setTimeout(r,35));
run(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
for(const file of ['document-upload.js','order-entry.js','control-tower.js','operations.js'])run(fs.readFileSync(root+'/'+file,'utf8'));
async function submit(form){form.dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));await tick();await tick();}
(async()=>{await tick();await tick();
 const flags=run("cargoOperationFlags(orders[1], [], [], '2026-10-07')");assert(flags.some(f=>f.text==='Mangler kundepris'));assert(flags.some(f=>f.text==='Mangler bil / transportør'));assert(!run('cargoKnownPrice(null)'));assert(run('cargoKnownPrice(0)'));
 assert.equal(run("cargoOperationsFilter(orders,{today:'2026-10-07',period:'near',owner:'mine',userId:'staff-a'},[],[]).length"),1);
 assert.equal(run("cargoOperationsFilter(orders,{today:'2026-10-07',period:'cancelled'},[],[]).length"),1);
 assert.equal(run("cargoOperationsFilter(orders,{today:'2026-10-07',period:'unbilled'},[],[])[0].id"),'order-c');
 assert.equal(run("cargoNextDay('2026-12-31')"),'2027-01-01');
 assert.equal(run("cargoNextDay('2026-03-29')"),'2026-03-30');
 d.getElementById('opsPeriod').value='all';d.getElementById('opsPeriod').dispatchEvent(new w.Event('change'));assert(d.getElementById('opsList').textContent.includes('Befrakter A'));assert(!d.getElementById('opsList').textContent.includes('Cancelled'));
 await run("openOrderFollowup('order-a')");assert(d.getElementById('opsContent').textContent.includes('Creator A'));assert.equal(d.querySelector('#opsAssignment [name=assigned_to]').value,'staff-a');
 // Reassignment preserves the immutable creator field.
 d.querySelector('#opsAssignment [name=assigned_to]').value='staff-b';await submit(d.getElementById('opsAssignment'));assert.equal(db.orders[0].assigned_to,'staff-b');assert.equal(db.orders[0].created_by_name,'Creator A');
 // Stale modal cannot overwrite a colleague. User's unsaved choice remains visible.
 db.orders[0].revision++;d.querySelector('#opsAssignment [name=status]').value='delivered';await submit(d.getElementById('opsAssignment'));assert.equal(db.orders[0].status,'created');assert(d.getElementById('opsMessage').textContent.includes('annen bruker'));assert.equal(d.querySelector('#opsAssignment [name=status]').value,'delivered');
 await run("openOrderFollowup('order-a')");
 failNotes=true;d.querySelector('#opsNoteForm textarea').value='PRIVATE INTERNAL TEXT';await submit(d.getElementById('opsNoteForm'));assert.equal(d.querySelector('#opsNoteForm textarea').value,'PRIVATE INTERNAL TEXT');assert(!calls.some(c=>c.args?.p_order?.instructions==='PRIVATE INTERNAL TEXT'));
 failNotes=false;await submit(d.getElementById('opsNoteForm'));assert.equal(db.order_notes[0].body,'PRIVATE INTERNAL TEXT');assert(d.getElementById('opsNotes').textContent.includes('PRIVATE INTERNAL TEXT'));assert(!d.getElementById('sheet').textContent.includes('PRIVATE INTERNAL TEXT'));
 d.querySelector('#opsIncidentForm [name=description]').value='Delayed pickup';await submit(d.getElementById('opsIncidentForm'));assert.equal(db.order_incidents[0].category,'delay');assert.equal(db.order_incidents[0].status,'open');
 const incidentForm=d.querySelector('#opsIncidents form');incidentForm.elements.status.value='resolved';await submit(incidentForm);assert.equal(db.order_incidents[0].status,'open');assert(d.getElementById('opsMessage').textContent.includes('Beskriv løsningen'));incidentForm.elements.resolution.value='Customer informed, new delivery arranged';await submit(incidentForm);assert.equal(db.order_incidents[0].status,'resolved');
 d.querySelector('#opsGrantForm select').value='carrier-a';await submit(d.getElementById('opsGrantForm'));assert.equal(db.order_upload_grants[0].order_id,'order-a');assert.equal(db.order_upload_grants[0].grantee_id,'carrier-a');assert(d.querySelector('#opsGrants input').value.includes('/carrier-documents.html?grant='));
 // Upload validates content, unique path, and waits for finalization, not just Storage acceptance.
 const bytes=new TextEncoder().encode('%PDF-1.7\nTest fixture only\n%%EOF');w.testFile={name:'proof.pdf',size:bytes.byteLength,arrayBuffer:async()=>bytes.buffer};
 const doc=await run("CargoDocuments.upload(s,'order-a',window.testFile,'pod')");assert.equal(doc.status,'ready');assert.equal(doc.byte_size,bytes.byteLength);assert.equal(doc.sha256,await run('CargoDocuments.digest(new TextEncoder().encode("%PDF-1.7\\nTest fixture only\\n%%EOF"))'));
 assert.throws(()=>run('CargoDocuments.fileType(new TextEncoder().encode("<html>not a PDF</html>"))'));
 await assert.rejects(()=>run("CargoDocuments.upload(s,'order-a',{size:30000000},'pod')"));
 await run("openOrderFollowup('order-a')");assert(d.getElementById('opsDocuments').textContent.includes('proof.pdf'));
 // Cancellation uses reason + revision and never calls DELETE.
 d.querySelector('#opsCancelForm textarea').value='Customer cancelled';await submit(d.getElementById('opsCancelForm'));assert.equal(db.orders[0].status,'cancelled');assert.equal(db.orders[0].cancellation_reason,'Customer cancelled');assert.equal(db.order_notes.length,1);assert.equal(db.order_documents.length,1);assert(!calls.some(c=>c.action==='delete'));
 // Sign-out removes internal content and invalidates pending modal results.
 run("me=null;$('app').classList.add('hidden')");await tick();assert(d.getElementById('opsModal').classList.contains('hidden'));assert.equal(d.getElementById('opsContent').textContent,'');assert.equal(d.getElementById('opsList').textContent,'');
 assert.deepEqual(errors,[]);console.log('PASS: dashboard dates/mine/exceptions, dispatcher reassignment, stale-write rejection, internal notes/retry, incident resolution, carrier invitation, document upload/finalize/content checks, cancellation/history retention, logout cleanup.');
 dom.window.close();
})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1;});
