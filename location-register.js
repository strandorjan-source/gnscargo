'use strict';
let locationTarget = null, locationEditId = null, locationReturnFocus = null;
const locationNameKey = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('nb-NO');
const locationTypes = { pickup: 'Lastested', delivery: 'Lossested', both: 'Laste- og lossested' };

function locationAddress(place) { return [place.address, place.postal_code, place.city].filter(Boolean).join(', '); }

function fillLocation(input, place) {
  input.value = place.name;
  const form = input.form;
  if (input.name === 'pickup_name' || input.name === 'delivery_name') {
    const prefix = input.name.split('_')[0];
    form.elements[prefix + '_address'].value = locationAddress(place);
    form.elements[prefix + '_contact'].value = place.contact_name || '';
    form.elements[prefix + '_phone'].value = place.phone || '';
    if (place.instructions && !form.elements.instructions.value) form.elements.instructions.value = place.instructions;
  } else {
    const stop = input.closest('.multiStop');
    for (const [key, value] of Object.entries({ address: locationAddress(place), contact_name: place.contact_name, phone: place.phone, instructions: place.instructions })) {
      const field = stop.querySelector('[data-k="' + key + '"]'); if (field) field.value = value || '';
    }
  }
}

function installLocationInputs() {
  for (const form of [$('form'), $('editForm')]) {
    form.querySelectorAll('[name=pickup_name],[name=delivery_name],[data-k=name]').forEach(input => {
      const row = input.closest('.multiStop');
      const type = input.name ? input.name.split('_')[0] : row.querySelector('[data-k=stop_type]')?.value || extraStops.find(item => item.el === row)?.type || 'pickup';
      input.setAttribute('list', type === 'pickup' ? 'pickupLocations' : 'deliveryLocations');
      input.dataset.locationType = type;
      if (input.dataset.locationPicker) return;
      input.dataset.locationPicker = 'true';
      const choose = () => {
        const place = locations.find(place => locationNameKey(place.name) === locationNameKey(input.value));
        if (place) fillLocation(input, place);
      };
      input.addEventListener('change', choose);
      const add = document.createElement('button'); add.type = 'button'; add.className = 'btn white location-new';
      add.textContent = '+ Nytt / lagre sted'; add.onclick = event => { event.preventDefault(); openLocationForm(input); };
      input.after(add);
    });
  }
}

function refreshLocationTools() {
  for (const type of ['pickup', 'delivery']) {
    const list = $(type === 'pickup' ? 'pickupLocations' : 'deliveryLocations');
    if (!list) return;
    list.replaceChildren(...locations.filter(place => !place.location_type || place.location_type === 'both' || place.location_type === type)
      .map(place => new Option(locationAddress(place), place.name)));
  }
  $('locationRegister').innerHTML = locations.map(place => '<div class="registerItem"><div class="toolbar"><b>' + esc(place.name) + '</b><button type="button" class="btn white edit-location" data-id="' + esc(place.id) + '">Rediger</button></div><div class="muted">' + esc(locationTypes[place.location_type] || locationTypes.both) + '</div><div class="muted">' + esc(locationAddress(place)) + '</div><div class="muted">' + esc([place.contact_name, place.phone].filter(Boolean).join(' · ')) + '</div></div>').join('') || '<div class="muted">Ingen steder ennå. Forhåndslagre laste- og lossesteder med knappen ovenfor.</div>';
  $('locationRegister').querySelectorAll('.edit-location').forEach(button => button.onclick = () => openLocationForm(null, locations.find(place => place.id === button.dataset.id)));
  installLocationInputs();
}

function openLocationForm(input = null, place = null) {
  if (!me || !['admin', 'dispatcher', 'superuser'].includes(me.role)) return;
  locationTarget = input; locationEditId = place?.id || null; locationReturnFocus = document.activeElement;
  const form = $('locationForm'); form.reset();
  $('locationTitle').textContent = place ? 'Rediger sted' : 'Nytt laste-/lossested';
  if (place) for (const [key, value] of Object.entries(place)) { if (form.elements[key]) form.elements[key].value = value ?? ''; }
  else {
    form.elements.name.value = input?.value.trim() || '';
    form.elements.location_type.value = input?.dataset.locationType || 'both';
    if (input?.name) {
      const prefix = input.name.split('_')[0], source = input.form.elements;
      form.elements.address.value = source[prefix + '_address'].value;
      form.elements.contact_name.value = source[prefix + '_contact'].value;
      form.elements.phone.value = source[prefix + '_phone'].value;
    } else if (input) {
      const stop = input.closest('.multiStop');
      for (const key of ['address', 'contact_name', 'phone', 'instructions']) form.elements[key].value = stop.querySelector('[data-k="' + key + '"]')?.value || '';
    }
  }
  note($('locationMessage'), ''); $('locationModal').classList.remove('hidden'); form.elements.name.focus();
}

function closeLocationForm() {
  if ($('saveLocation').disabled) return;
  $('locationModal').classList.add('hidden'); locationReturnFocus?.focus();
}

function installLocationForm() {
  const modal = document.createElement('div'); modal.id = 'locationModal'; modal.className = 'modal hidden';
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'locationTitle');
  modal.innerHTML = '<div class="card"><div class="toolbar"><h2 id="locationTitle">Nytt laste-/lossested</h2><button type="button" class="btn white" id="closeLocation">Lukk</button></div><p class="muted">Forhåndslagrede steder kan velges ved henting, lossing og ekstra stopp. Endringer i registeret endrer ikke tidligere ordrer.</p><div id="locationMessage" role="status"></div><form id="locationForm"><div class="grid"><label>Stedsnavn<input name="name" required maxlength="200"></label><label>Brukes som<select name="location_type" required><option value="both">Laste- og lossested</option><option value="pickup">Lastested</option><option value="delivery">Lossested</option></select></label><label>Adresse<input name="address" maxlength="300"></label><label>Postnummer<input name="postal_code" maxlength="20"></label><label>Poststed<input name="city" maxlength="100"></label><label>Kontaktperson<input name="contact_name" maxlength="200"></label><label>Telefon<input name="phone" type="tel" maxlength="50"></label><label>E-post<input name="email" type="email" maxlength="254"></label></div><label style="margin-top:12px">Stedsinstruksjoner<textarea name="instructions" maxlength="4000"></textarea></label><div class="actions" style="margin-top:14px"><button type="submit" id="saveLocation" class="btn blue">Lagre sted</button><button type="button" id="cancelLocation" class="btn white">Avbryt</button></div></form></div>';
  document.body.append(modal);
  $('closeLocation').onclick = $('cancelLocation').onclick = closeLocationForm;
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeLocationForm();
    if (event.key === 'Tab') {
      const fields = [...modal.querySelectorAll('input,select,textarea,button')].filter(field => !field.disabled);
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0].focus(); }
    }
  });
  $('locationForm').onsubmit = async event => {
    event.preventDefault(); const button = $('saveLocation'); if (button.disabled) return;
    const values = Object.fromEntries([...new FormData(event.target)].map(([key, value]) => [key, value.trim() || null]));
    if (!values.name) { note($('locationMessage'), 'Fyll inn stedsnavn.', true); return; }
    if (!event.target.reportValidity()) return;
    button.disabled = true;
    try {
      const latest = await s.from('locations').select('*').order('name'); if (latest.error) throw latest.error;
      if (latest.data.some(place => place.id !== locationEditId && locationNameKey(place.name) === locationNameKey(values.name))) throw new Error('Et sted med dette navnet finnes allerede. Velg det fra listen eller rediger det i registeret.');
      const query = locationEditId ? s.from('locations').update({ ...values, updated_at: new Date().toISOString() }).eq('id', locationEditId) : s.from('locations').insert(values);
      const { data, error } = await query.select('*').single(); if (error) throw error;
      await loadRegisters(); if (locationTarget?.isConnected) fillLocation(locationTarget, data);
      button.disabled = false; closeLocationForm();
    } catch (error) { note($('locationMessage'), error.message || 'Stedet kunne ikke lagres.', true); }
    finally { button.disabled = false; }
  };
  markFields($('locationForm'));
}

installLocationForm();
$('newLocationRegister').onclick = () => openLocationForm();
$('editStops').addEventListener('change', installLocationInputs);
refreshLocationTools();
