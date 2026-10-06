'use strict';
let carrierTarget = null, carrierEditId = null, carrierReturnFocus = null;
const carrierEdiLabel = system => ({opter: 'Opter – ikke tilkoblet', timpex: 'Timpex – ikke tilkoblet'}[system] || 'EDI er ikke valgt');
const carrierNameKey = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('nb-NO');
function fillCarrier(input, carrier) {
  input.value = carrier.name;
  input.form.elements.carrier_email.value = carrier.email || '';
}
function installCarrierInputs() {
  for (const form of [$('form'), $('editForm')]) {
    const input = form.elements.carrier_name;
    if (!input || input.dataset.carrierPicker) continue;
    input.dataset.carrierPicker = 'true'; input.setAttribute('list', 'carrierList');
    input.addEventListener('change', () => {
      const carrier = carriers.find(row => carrierNameKey(row.name) === carrierNameKey(input.value));
      if (carrier) fillCarrier(input, carrier);
    });
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn white';
    button.textContent = '+ Ny / lagre transportør'; button.onclick = () => openCarrierForm(input); input.after(button);
  }
}
function refreshCarrierTools() {
  $('carrierList').replaceChildren(...carriers.map(row => new Option([row.org_number, row.email].filter(Boolean).join(' · '), row.name)));
  $('carrierRegister').innerHTML = carriers.map(row => '<div class="registerItem"><div class="toolbar"><b>' + esc(row.name) + '</b><button type="button" class="btn white edit-carrier" data-id="' + esc(row.id) + '">Rediger</button></div><div class="muted">' + esc([row.org_number, row.phone, row.email, carrierEdiLabel(row.edi_system)].filter(Boolean).join(' · ')) + '</div></div>').join('') || '<div class="muted">Ingen transportører ennå. Bruk «Ny transportør» for å lagre dem på forhånd.</div>';
  $('carrierRegister').querySelectorAll('.edit-carrier').forEach(button => button.onclick = () => openCarrierForm(null, carriers.find(row => String(row.id) === button.dataset.id)));
  installCarrierInputs();
}
function openCarrierForm(input = null, carrier = null) {
  if (!me || !['admin', 'dispatcher', 'superuser'].includes(me.role)) return;
  carrierTarget = input; carrierEditId = carrier?.id ?? null; carrierReturnFocus = document.activeElement;
  const form = $('carrierForm'); form.reset();
  $('carrierTitle').textContent = carrier ? 'Rediger transportør' : 'Ny transportør';
  if (carrier) for (const [key, value] of Object.entries(carrier)) { if (form.elements[key]) form.elements[key].value = value ?? ''; }
  else { form.elements.name.value = input?.value.trim() || ''; form.elements.email.value = input?.form.elements.carrier_email.value || ''; }
  note($('carrierMessage'), ''); $('carrierModal').classList.remove('hidden'); form.elements.name.focus();
}
function closeCarrierForm() {
  if ($('saveCarrier').disabled) return;
  $('carrierModal').classList.add('hidden'); carrierReturnFocus?.focus();
}
function installCarrierForm() {
  const modal = document.createElement('div'); modal.id = 'carrierModal'; modal.className = 'modal hidden';
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'carrierTitle');
  modal.innerHTML = '<div class="card"><div class="toolbar"><h2 id="carrierTitle">Ny transportør</h2><button type="button" class="btn white" id="closeCarrier">Lukk</button></div><p class="muted">Lagre transportører på forhånd og velg dem på nye eller eksisterende ordrer. E-post fylles ut automatisk. Registerendringer endrer ikke tidligere ordrer.</p><div id="carrierMessage" role="status"></div><form id="carrierForm"><div class="grid"><label>Transportørnavn<input name="name" required maxlength="200" autocomplete="organization"></label><label>Organisasjonsnummer<input name="org_number" maxlength="40"></label><label>E-post for transportordre<input name="email" type="email" maxlength="254"></label><label>Telefon<input name="phone" type="tel" maxlength="50"></label><label>EDI-system<select name="edi_system"><option value="">Ikke valgt</option><option value="opter">Opter</option><option value="timpex">Timpex</option></select></label></div><p class="muted">Valg av EDI-system klargjør testgrunnlaget. Sending må aktiveres etter avtale med mottakeren. API-nøkler skal ikke legges i dette registeret.</p><label style="margin-top:12px">Interne merknader<textarea name="notes" maxlength="2000"></textarea></label><div class="actions" style="margin-top:14px"><button type="submit" id="saveCarrier" class="btn blue">Lagre transportør</button><button type="button" id="cancelCarrier" class="btn white">Avbryt</button></div></form></div>';
  document.body.append(modal); $('closeCarrier').onclick = $('cancelCarrier').onclick = closeCarrierForm;
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeCarrierForm();
    if (event.key === 'Tab') {
      const fields = [...modal.querySelectorAll('input,textarea,button')].filter(field => !field.disabled);
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0].focus(); }
    }
  });
  $('carrierForm').onsubmit = async event => {
    event.preventDefault(); const button = $('saveCarrier'); if (button.disabled) return;
    const values = Object.fromEntries([...new FormData(event.target)].map(([key, value]) => [key, value.trim() || null]));
    if (!values.name) { note($('carrierMessage'), 'Fyll inn transportørnavn.', true); return; }
    if (!event.target.reportValidity()) return;
    button.disabled = true;
    try {
      const latest = await s.from('carriers').select('*').order('name'); if (latest.error) throw latest.error;
      if (latest.data.some(row => row.id !== carrierEditId && (carrierNameKey(row.name) === carrierNameKey(values.name) || (values.org_number && String(row.org_number || '').replace(/\s/g, '') === values.org_number.replace(/\s/g, ''))))) throw new Error('Transportøren finnes allerede. Velg den fra listen eller rediger registeroppføringen.');
      const query = carrierEditId !== null ? s.from('carriers').update(values).eq('id', carrierEditId) : s.from('carriers').insert(values);
      const { data, error } = await query.select('*').single(); if (error) throw error;
      await loadRegisters(); if (carrierTarget?.isConnected) fillCarrier(carrierTarget, data);
      button.disabled = false; closeCarrierForm();
    } catch (error) { note($('carrierMessage'), error.code === '23505' ? 'Transportøren finnes allerede. Oppdater registeret og velg den fra listen.' : error.message || 'Transportøren kunne ikke lagres.', true); }
    finally { button.disabled = false; }
  };
  markFields($('carrierForm'));
}
installCarrierForm(); $('newCarrierRegister').onclick = () => openCarrierForm(); refreshCarrierTools();
