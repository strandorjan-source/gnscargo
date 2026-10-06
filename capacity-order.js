'use strict';
let capacityOrderImport = null, capacityImportBusy = false;
const capacityLockedFields = ['carrier_name', 'carrier_contact', 'carrier_phone', 'vehicle_registration', 'trailer_number'];
const capacityNotice = document.createElement('div'); capacityNotice.id = 'capacityImportNotice'; capacityNotice.className = 'notice hidden'; capacityNotice.setAttribute('role', 'status');
$('form').before(capacityNotice);
function clearCapacityOrderImport() {
  capacityOrderImport = null;
  capacityLockedFields.forEach(key => { if ($('form').elements[key]) $('form').elements[key].readOnly = false; });
  capacityNotice.replaceChildren(); capacityNotice.classList.add('hidden');
  const url = new URL(location.href); url.searchParams.delete('capacity_vehicle'); url.searchParams.delete('capacity_reservation'); history.replaceState({}, '', url);
}
function capacityRequestUrl(vehicleId, reservedAt) {
  const url = new URL('/app-fixed.html', location.origin); url.searchParams.set('capacity_vehicle', vehicleId); url.searchParams.set('capacity_reservation', reservedAt); return url;
}
function capacityInfoLine(text) { const p = document.createElement('p'); p.textContent = text; return p; }
function applyCapacityVehicle(vehicle, registered, keepDraft) {
  const form = $('form');
  if (!keepDraft) form.reset();
  capacityOrderImport = { id: vehicle.id, reservedAt: vehicle.reserved_at, updatedAt: vehicle.updated_at };
  history.replaceState({}, '', capacityRequestUrl(vehicle.id, vehicle.reserved_at));
  for (const [field, value] of Object.entries({ carrier_name: vehicle.carrier, carrier_email: registered?.email || '',
    carrier_contact: vehicle.contact || '', carrier_phone: vehicle.phone || '', vehicle_registration: vehicle.registration, trailer_number: vehicle.trailer_number || '' })) form.elements[field].value = value;
  if (!form.elements.pickup_date.value) form.elements.pickup_date.value = osloDateTime(vehicle.available_at).slice(0, 10);
  capacityLockedFields.forEach(key => { form.elements[key].readOnly = true; });
  capacityNotice.replaceChildren(capacityInfoLine('Ny ordre fra reservert bil: ' + vehicle.registration + ' · ' + vehicle.carrier),
    capacityInfoLine('Bilen er meldt ledig i ' + vehicle.location + ' fra ' + osloDateTime(vehicle.available_at).replace('T', ' kl. ') + '. Kontroller hentedato og fyll inn kunde og nøyaktig lastested.'),
    capacityInfoLine('Transportørens kontakt er ført i egne kontaktfelt. Sjåfør fylles inn separat. Ordren kobles til reservasjonen når du trykker «Opprett ordre».'));
  if (vehicle.reservation_comment) capacityNotice.append(capacityInfoLine('Reservasjonskommentar (internt i ordreskjemaet): ' + vehicle.reservation_comment));
  const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'btn white'; reload.textContent = 'Hent bilopplysninger på nytt';
  reload.onclick = () => loadCapacityOrderRequest(true); capacityNotice.append(reload);
  capacityNotice.classList.remove('hidden'); form.scrollIntoView({ behavior: 'smooth', block: 'start' }); form.elements.customer.focus();
}
async function loadCapacityOrderRequest(force = false) {
  if (!me || capacityImportBusy || $('app').classList.contains('hidden')) return;
  const params = new URL(location.href).searchParams, id = params.get('capacity_vehicle'), reservedAt = params.get('capacity_reservation');
  if (!id || !reservedAt || (!force && capacityOrderImport?.id === id && capacityOrderImport.reservedAt === reservedAt)) return;
  if (!force && capacityNotice.dataset.pending === id + reservedAt) return;
  const importingUser = me.id;
  capacityImportBusy = true;
  try {
    const result = await s.from('capacity_vehicles').select('id,status,reserved_at,reserved_order_id,updated_at,deleted_at,carrier,contact,phone,registration,trailer_number,location,available_at,reservation_comment').eq('id', id).maybeSingle();
    if (result.error) throw result.error;
    if (!me || me.id !== importingUser || $('app').classList.contains('hidden')) return;
    const vehicle = result.data;
    if (!vehicle || vehicle.status !== 'Reservert' || vehicle.deleted_at || new Date(vehicle.reserved_at).getTime() !== new Date(reservedAt).getTime()) throw new Error('Reservasjonen er ikke lenger aktiv. Gå til Capacity og kontroller bilen.');
    if (vehicle.reserved_order_id) {
      clearCapacityOrderImport(); await load(); await openOrder(vehicle.reserved_order_id); return;
    }
    const registered = carriers.find(row => carrierNameKey(row.name) === carrierNameKey(vehicle.carrier));
    const form = $('form');
    const hasDraft = [...new FormData(form)].some(([, value]) => String(value).trim()) || extraStops.length > 0;
    const sameImport = capacityOrderImport?.id === id && capacityOrderImport.reservedAt === reservedAt;
    if (hasDraft && !sameImport) {
      capacityNotice.dataset.pending = id + reservedAt;
      capacityNotice.replaceChildren(capacityInfoLine('Du har en påbegynt ordre. Vil du bruke ' + vehicle.registration + ' fra ' + vehicle.carrier + ' på denne ordren? Kunde og lasteopplysninger beholdes.'));
      const use = document.createElement('button'); use.type = 'button'; use.className = 'btn blue'; use.textContent = 'Bruk bilen på påbegynt ordre';
      use.onclick = () => { delete capacityNotice.dataset.pending; applyCapacityVehicle(vehicle, registered, true); };
      const separate = document.createElement('a'); separate.className = 'btn white'; separate.textContent = 'Åpne ny ordre i egen fane'; separate.href = capacityRequestUrl(id, reservedAt); separate.target = '_blank'; separate.rel = 'noopener';
      capacityNotice.append(use, document.createTextNode(' '), separate); capacityNotice.classList.remove('hidden');
    } else { delete capacityNotice.dataset.pending; applyCapacityVehicle(vehicle, registered, sameImport); }
  } catch (error) {
    capacityNotice.replaceChildren(capacityInfoLine(error.message || 'Bilopplysningene kunne ikke hentes.'));
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn white'; retry.textContent = 'Prøv igjen'; retry.onclick = () => loadCapacityOrderRequest(true); capacityNotice.append(retry); capacityNotice.classList.remove('hidden');
  } finally { capacityImportBusy = false; }
}
async function saveCapacityCargoOrder(order, stops) {
  const imported = capacityOrderImport;
  if (!imported) throw new Error('Bilens reservasjon mangler. Hent bilen fra Capacity på nytt.');
  const { data, error } = await s.rpc('create_cargo_order_from_capacity', { p_vehicle_id: imported.id, p_reserved_at: imported.reservedAt,
    p_vehicle_updated_at: imported.updatedAt, p_order: order, p_stops: stops });
  if (error) throw error;
  return data;
}
$('form').addEventListener('reset', () => { delete capacityNotice.dataset.pending; clearCapacityOrderImport(); });
new MutationObserver(() => {
  if ($('app').classList.contains('hidden') && capacityOrderImport) $('form').reset();
}).observe($('app'), { attributes: true, attributeFilter: ['class'] });
loadCapacityOrderRequest();
