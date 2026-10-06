const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const cargo=path.resolve(__dirname,'..');
const cap=process.env.CAPACITY_CHECKOUT || path.resolve(cargo,'..','gns-capacity-test');
const req=require('module').createRequire(cap+'/package.json');
const {JSDOM}=require(cargo+'/tests/node_modules/jsdom');
const {transformSync}=req('next/dist/compiled/babel/core');
const cache=cap+'/node_modules/.cache/cargo-booking';fs.mkdirSync(cache,{recursive:true});
for(const name of fs.readdirSync(cap+'/app').filter(x=>x.endsWith('.js')&&!['layout.js'].includes(x))){
 let source=fs.readFileSync(cap+'/app/'+name,'utf8').replace(/from '(\.\.?\/[^']+)'/g,(m,p)=>{
   if(p.startsWith('../lib/'))return "from 'file://"+cap+'/'+p.slice(3)+"'";
   return "from './"+p.slice(2)+".mjs'";
 }).replace("from '@supabase/supabase-js'","from './mock-client.mjs'");
 const out=transformSync(source,{filename:name,presets:[[req.resolve('next/babel'),{'preset-env':{modules:false,targets:{node:'24'}},'preset-react':{runtime:'automatic'},'transform-runtime':{helpers:false}}]]});
 fs.writeFileSync(cache+'/'+name.replace('.js','.mjs'),out.code);
}
fs.writeFileSync(cache+'/mock-client.mjs','export const createClient = () => globalThis.__supabase;');
const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.invalid/'});
Object.assign(global,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
global.requestAnimationFrame=fn=>setTimeout(fn,0);
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false};
process.env.NEXT_PUBLIC_SUPABASE_URL='https://qa.supabase.co';process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='test';
const {act,createElement}=req('react');const {createRoot}=req('react-dom/client');
const vehicle={id:'v1',owner_user_id:'owner',carrier:'Transport QA',contact:'Contact',phone:'12345678',registration:'QA12345',location:'Oslo',loading_region:'Sør-Norge',available_at:'2026-10-08T10:00:00Z',vehicle_type:'Termo',door_type:'Bakdører',status:'Ledig',updated_at:'2026-10-06T10:00:00Z'};
const order={id:'o1',order_number:600,customer:'Internal Customer',pickup_name:'Pickup',delivery_name:'Delivery',pickup_date:'2026-10-08',carrier_name:'Old carrier',vehicle_registration:'OLD123',status:'created',updated_at:'2026-10-06T10:00:00Z'};
let calls=[],failBooking=false,failOrders=false;
function query(table){let single=false,operation='read',payload;
 const q={select(fields){if(table==='orders')assert(!fields.includes('phone')&&!fields.includes('*'));return q},order(){return q},range(){return q},eq(){return q},is(){return q},maybeSingle(){single=true;return q},update(p){operation='update';payload=p;return q},then(resolve,reject){
  if(table==='orders'&&failOrders)return Promise.resolve({error:{message:'Henting feilet'}}).then(resolve,reject);
  if(operation==='update'){assert.equal(table,'capacity_vehicles');Object.assign(vehicle,payload,{reserved_order_id:null});calls.push({type:'release',payload});}
  const rows=table==='capacity_vehicle_overview'?[{...vehicle}]:table==='orders'?[{...order}]:[];
  return Promise.resolve({data:single?{id:vehicle.id}:rows,error:null}).then(resolve,reject);
 }};return q;
}
global.__supabase={auth:{getSession:async()=>({data:{session:{user:{id:'staff',email:'qa@example.invalid'}}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:query,
 rpc:async(name,args)=>{
  if(name==='platform_current_access')return{data:{id:'staff',role:'superuser',full_name:'QA',email:'qa@example.invalid'}};
  if(name==='capacity_platform_users')return{data:[]};
  assert.equal(name,'reserve_capacity_for_order');calls.push({type:'booking',args});
  if(failBooking)return{error:{message:'Ordren er endret. Hent lassene på nytt og velg ordren igjen.'}};
  Object.assign(vehicle,{status:'Reservert',reserved_order_id:args.p_order_id,reservation_comment:'GNS-600',reserved_at:new Date().toISOString(),reserved_by_name:'QA'});return{data:vehicle.id};
 },channel(){const q={on(){return q},subscribe(){return q}};return q},removeChannel(){}};
const tick=()=>new Promise(r=>setTimeout(r,30));
const click=async text=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);assert(b,'Button '+text+'; page='+document.body.textContent.slice(0,1400));await act(async()=>{b.click();await tick()})};
(async()=>{
 const {default:Page}=await import('file://'+cache+'/page.mjs');const root=createRoot(document.getElementById('root'));
 await act(async()=>{root.render(createElement(Page));await tick()});
 await click('Reserver');assert(document.body.textContent.includes('Hent lass fra GNS Cargo'));
 let select=document.querySelector('.cargo-order-picker select');assert(select);assert(select.textContent.includes('GNS-600'));
 await act(async()=>{select.value='o1';select.dispatchEvent(new window.Event('change',{bubbles:true}));await tick()});
 assert(document.body.textContent.includes('Ordren oppdateres med Transport QA og reg.nr QA12345'));assert(document.body.textContent.includes('Dette erstattes.'));
 failBooking=true;await click('Bekreft reservasjon');assert(document.querySelector('dialog'));assert(document.body.textContent.includes('Ordren er endret'));assert.equal(vehicle.status,'Ledig');
 failBooking=false;await click('Bekreft reservasjon');assert(!document.querySelector('dialog'));assert.equal(calls.at(-1).args.p_order_id,'o1');assert.equal(calls.at(-1).args.p_vehicle_id,'v1');assert.equal(calls.at(-1).args.p_order_updated_at,order.updated_at);
 const reserved=[...document.querySelectorAll('button')].find(b=>b.id==='tab-reserved');await act(async()=>{reserved.click();await tick()});
 await click('Frigi');assert(document.body.textContent.includes('Ordrekoblingen fjernes'));await click('Bekreft frigivelse');assert.equal(vehicle.status,'Ledig');assert.equal(vehicle.reserved_order_id,null);
 const available=document.getElementById('tab-available');await act(async()=>{available.click();await tick()});failOrders=true;await click('Reserver');assert(document.body.textContent.includes('Henting feilet'));assert(document.querySelector('.cargo-order-picker button'));
 failOrders=false;await click('Hent lass på nytt');assert(document.querySelector('.cargo-order-picker select').textContent.includes('GNS-600'));
 await act(async()=>root.unmount());dom.window.close();
 console.log('PASS: rendered Capacity UI loads safe order fields, selects Cargo load, shows replacement summary, blocks stale booking, submits atomic RPC, releases and retries loading errors.');
})().catch(error=>{console.error(error);process.exit(1)});
