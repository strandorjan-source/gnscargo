'use strict';
(() => {
  const client=window.supabase.createClient('https://lpovhfipxoeqqnfnipia.supabase.co','sb_publishable_7WEioWEeqiSNE1nSFXD8lg_zosjgsC_');
  const $=id=>document.getElementById(id);const grant=new URL(location.href).searchParams.get('grant');let context=null,generation=0,busy=false;
  const message=text=>{$('message').textContent=text;};
  async function refresh() {
    const epoch=++generation;context=null;$('uploadPanel').classList.add('hidden');$('documents').replaceChildren();
    const session=await client.auth.getSession();if(epoch!==generation)return;
    if(!session.data.session){$('loginPanel').classList.remove('hidden');$('logout').classList.add('hidden');message('Logg inn for å bruke invitasjonen.');return;}
    $('loginPanel').classList.add('hidden');$('logout').classList.remove('hidden');
    if(!grant||!/^[a-f0-9-]{36}$/i.test(grant)){message('Invitasjonslenken mangler eller er ugyldig. Be GNS om en ny lenke.');return;}
    const result=await client.rpc('cargo_upload_context',{p_grant:grant});if(epoch!==generation)return;
    if(result.error||!result.data){message('Denne brukeren har ikke tilgang, eller invitasjonen er utløpt eller trukket tilbake. Kontakt GNS Cargo.');return;}
    context=result.data;$('orderReference').textContent=context.reference;$('expiry').textContent='Invitasjonen utløper '+new Intl.DateTimeFormat('nb-NO',{timeZone:'Europe/Oslo',dateStyle:'short',timeStyle:'short'}).format(new Date(context.expires_at));$('uploadPanel').classList.remove('hidden');message('Du kan nå laste opp dokumenter til '+context.reference+'.');await documents(epoch);
  }
  async function documents(epoch=generation){if(!context)return;const rows=[];for(let from=0;;from+=200){const r=await client.from('order_documents').select('*').eq('order_id',context.order_id).order('created_at',{ascending:false}).range(from,from+199);if(r.error){message(r.error.message);return;}rows.push(...(r.data||[]));if(r.data.length<200)break;}if(epoch!==generation||!context)return;$('documents').replaceChildren();
    for(const row of rows){const box=document.createElement('div');box.className='document';const title=document.createElement('b');title.textContent=row.filename;const text=document.createElement('p');text.textContent=CargoDocuments.categories[row.category]+' · '+({pending:'Ufullført registrering',ready:'Registrert hos GNS',withdrawn:'Trukket tilbake'}[row.status]);box.append(title,text);
      if(['ready','pending'].includes(row.status)){const button=document.createElement('button');button.type='button';button.textContent=row.status==='ready'?'Last ned egen fil':'Fullfør registrering';button.onclick=()=>action(button,async()=>{if(row.status==='ready')await CargoDocuments.download(client,row);else{await CargoDocuments.finish(client,row.id);message('Dokumentet er ferdig registrert.');await documents();}});box.append(button);}$('documents').append(box);
    }if(!rows.length)$('documents').textContent='Ingen dokumenter lastet opp ennå.';
  }
  async function action(button,fn){if(busy)return;busy=true;button.disabled=true;try{await fn();}catch(e){message(e.message||'Handlingen kunne ikke fullføres.');}finally{busy=false;button.disabled=false;}}
  $('loginForm').onsubmit=e=>{e.preventDefault();const form=e.target;action(form.querySelector('button'),async()=>{const r=await client.auth.signInWithPassword({email:form.elements.email.value.trim(),password:form.elements.password.value});if(r.error)throw r.error;form.elements.password.value='';await refresh();});};
  $('uploadForm').onsubmit=e=>{e.preventDefault();const form=e.target;action(form.querySelector('button'),async()=>{if(!context)throw new Error('Kontroller invitasjonen først.');const id=context.order_id;try{await CargoDocuments.upload(client,id,form.elements.file.files[0],form.elements.category.value);}catch(e){await documents();throw e;}form.elements.file.value='';message('Dokumentet er registrert hos GNS Cargo.');await documents();});};
  $('logout').onclick=()=>action($('logout'),async()=>{generation++;context=null;$('documents').replaceChildren();$('uploadPanel').classList.add('hidden');await client.auth.signOut();await refresh();});
  client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){generation++;context=null;$('uploadPanel').classList.add('hidden');$('documents').replaceChildren();$('loginPanel').classList.remove('hidden');message('Du er logget ut.');}});
  refresh().catch(e=>message(e.message));
})();
