const {JSDOM}=require('jsdom');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');const html=fs.readFileSync(path.join(root,'admin.html'),'utf8').replace(/<script[\s\S]*?<\/script>/g,'');
const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://qa.invalid'});const w=dom.window,d=w.document;const tick=()=>new Promise(r=>setTimeout(r,20));
let records=[{id:'admin',full_name:'Test Admin',email:'a@example.invalid',role:'admin'},{id:'pending',full_name:'Test New User',email:'b@example.invalid',role:'pending'}],calls=[],failure=false,confirmResult=true;
w.confirm=()=>confirmResult;
function from(){let filters=[],single=false;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},order(){return q},range(){return q},single(){single=true;return q},then(resolve,reject){const data=records.filter(r=>filters.every(([k,v])=>r[k]===v));return Promise.resolve({data:single?data[0]:data,error:null}).then(resolve,reject)}};return q;}
w.supabase={createClient:()=>({from,auth:{getSession:async()=>({data:{session:{user:{id:'admin'}}}}),onAuthStateChange(){}},rpc:async(name,p)=>{calls.push({name,p});if(failure)return{error:{message:'Test DB failure'}};const row=records.find(r=>r.id===p.target_user);if(p.action==='remove'){row.role='disabled';row.deleted_at='now';}else row.role=p.next_role;return{data:row,error:null}}})};
vm.runInContext(fs.readFileSync(path.join(root,'admin-users.js'),'utf8'),dom.getInternalVMContext());
(async()=>{
 await tick();assert(!d.getElementById('adminBox').classList.contains('hidden'));assert.equal(d.querySelectorAll('.row').length,2);
 assert(!d.querySelector('[data-user=admin] .remove-user'));
 const own=d.querySelector('[data-user=admin]');own.querySelector('select').value='superuser';
 confirmResult=false;await own.querySelector('.save-role').onclick();assert.equal(calls.length,0);
 confirmResult=true;await own.querySelector('.save-role').onclick();assert.equal(records[0].role,'superuser');assert(d.querySelector('[data-user=admin]').textContent.includes('Superbruker'));
 d.querySelector('[data-user=pending] .remove-user').click();assert(!d.getElementById('deleteUserModal').classList.contains('hidden'));assert.equal(d.getElementById('deleteUserName').textContent,'Test New User');
 d.getElementById('cancelDeleteUser').click();assert.equal(calls.length,1);
 d.querySelector('[data-user=pending] .remove-user').click();failure=true;await d.getElementById('confirmDeleteUser').onclick();assert(d.getElementById('deleteUserError').textContent.includes('Test DB failure'));assert(!d.getElementById('deleteUserModal').classList.contains('hidden'));
 failure=false;await d.getElementById('confirmDeleteUser').onclick();assert(!d.querySelector('[data-user=pending]'));assert(d.getElementById('adminMessage').textContent.includes('Historikken er beholdt'));
 records[0].role='dispatcher';await vm.runInContext('boot()',dom.getInternalVMContext());assert(d.getElementById('adminBox').classList.contains('hidden'));assert(!d.getElementById('denied').classList.contains('hidden'));
 console.log('PASS: administrator UI, self-superuser selection and confirmation, deletion/cancellation, failure recovery, hidden removed users and revoked access.');dom.window.close();
})().catch(error=>{console.error(error);dom.window.close();process.exitCode=1});
