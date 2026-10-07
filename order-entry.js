/* Order entry: pickup date is required, while the clock time may remain unknown. */
'use strict';
let editingOrderSnapshot = null, newOrderRequestId = null;

async function patchCargoOrder(order, values) {
  const { data, error } = await s.rpc('save_cargo_order', { p_id: order.id, p_expected_revision: order.revision, p_request_id: null, p_order: values, p_stops: null });
  if (error) throw error;
  return data;
}


function osloDateTime(value) {
  if (!value) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
}

function scheduledAt(date, time) {
  if (!date && time) throw new Error('Fyll inn dato når du oppgir klokkeslett.');
  if (!date || !time) return null;
  const wanted = date + 'T' + time;
  const wall = Date.parse(wanted + ':00Z');
  let instant = wall;
  for (let i = 0; i < 3; i++) {
    const difference = wall - Date.parse(osloDateTime(instant) + ':00Z');
    if (!difference) return new Date(instant).toISOString();
    instant += difference;
  }
  throw new Error('Klokkeslettet finnes ikke på denne datoen ved overgang til sommertid. Velg et annet tidspunkt.');
}

function readOrderForm(form) {
  const values = Object.fromEntries(new FormData(form));
  for (const [key, label] of [['customer', 'Kunde'], ['pickup_name', 'Hentested'], ['pickup_date', 'Hentedato'], ['vehicle_registration', 'Registreringsnummer']]) {
    values[key] = String(values[key] || '').trim();
    if (!values[key]) throw new Error(label + ' må fylles ut.');
  }
  values.pickup_at = scheduledAt(values.pickup_date, values.pickup_time);
  delete values.pickup_time;
  values.delivery_at = values.delivery_at ? new Date(values.delivery_at).toISOString() : null;
  const pricing = calculateCustomerPricing(values.customer_price, values.customer_diesel_percent);
  // The database generates the amount; send only the editable inputs and total.
  delete pricing.customer_diesel_amount;
  Object.assign(values, pricing);
  for (const key of ['pallets', 'weight_kg', 'carrier_price']) values[key] = values[key] === '' ? null : Number(values[key]);
  values.carrier_id = carriers.find(carrier => String(carrier.name).trim().toLocaleLowerCase('nb-NO') === String(values.carrier_name || '').trim().toLocaleLowerCase('nb-NO'))?.id || null;
  return values;
}

function stopFields(type, stop = {}) {
  const dateTime = osloDateTime(stop.planned_at);
  const fields = [
    ['name', 'Sted', 'text', stop.name, type === 'pickup'], ['address', 'Adresse', 'text', stop.address],
    ['planned_date', type === 'pickup' ? 'Hentedato' : 'Leveringsdato', 'date', stop.planned_date || dateTime.slice(0, 10), type === 'pickup'],
    ['planned_time', 'Klokkeslett', 'time', dateTime.slice(11, 16)],
    ['contact_name', 'Kontakt', 'text', stop.contact_name], ['phone', type === 'pickup' ? 'Mobilnr – kun internt' : 'Telefon', 'tel', stop.phone],
    ['goods', 'Gods', 'text', stop.goods], ['pallets', 'Paller', 'number', stop.pallets], ['weight_kg', 'Netto kg', 'number', stop.weight_kg],
    ...(type === 'pickup' ? [['temperature', 'Temperatur', 'text', stop.temperature]] : []),
    ['instructions', 'Instruksjoner', 'text', stop.instructions]
  ];
  return fields.map(([key, label, inputType, value, required]) => '<label>' + label + '<input data-k="' + key + '" type="' + inputType + '" value="' + esc(value ?? '') + '"' + (required ? ' required' : '') + (key === 'weight_kg' ? ' step="0.1"' : '') + (key === 'name' ? ' list="locationList"' : '') + '></label>').join('');
}

function stopCard(type) {
  const el = document.createElement('div');
  el.className = 'multiStop';
  el.innerHTML = '<div class="toolbar"><b>' + (type === 'pickup' ? 'Ekstra henting' : 'Ekstra levering') + '</b><button type="button" class="btn red removeStop">Fjern</button></div><div class="multiStopGrid">' + stopFields(type) + '</div>';
  const item = { type, el };
  extraStops.push(item);
  el.querySelector('.removeStop').onclick = () => { extraStops = extraStops.filter(x => x !== item); el.remove(); totals(); };
  el.querySelectorAll('input').forEach(input => input.oninput = totals);
  return el;
}

function readStopForm(el, type) {
  const get = key => el.querySelector('[data-k="' + key + '"]')?.value.trim() || '';
  const name = get('name'), date = get('planned_date');
  if (type === 'pickup' && !name) throw new Error('Fyll inn navn på alle ekstra hentesteder, eller fjern tomme stopp.');
  if (type === 'pickup' && !date) throw new Error('Hentedato må fylles ut på alle ekstra hentesteder.');
  if (!name) throw new Error('Fyll inn sted på ekstra levering, eller fjern det tomme stoppet.');
  return { stop_type: type, name, address: get('address'), contact_name: get('contact_name'), phone: get('phone'),
    planned_date: date || null, planned_at: scheduledAt(date, get('planned_time')), goods: get('goods'),
    pallets: get('pallets') ? Number(get('pallets')) : null, weight_kg: get('weight_kg') ? Number(get('weight_kg')) : null,
    temperature: type === 'pickup' ? get('temperature') : null, instructions: get('instructions') };
}

function primaryStop(order, type) {
  return { stop_type: type, stop_sequence: 1, name: order[type + '_name'], address: order[type + '_address'],
    contact_name: order[type + '_contact'], phone: order[type + '_phone'], planned_at: order[type + '_at'],
    planned_date: type === 'pickup' ? order.pickup_date : null, goods: order.goods, pallets: order.pallets,
    weight_kg: order.weight_kg, temperature: type === 'pickup' ? order.temperature : null, instructions: order.instructions };
}

$('form').onsubmit = async event => {
  event.preventDefault();
  const form = event.target, button = form.querySelector('[type=submit]');
  if (button.disabled) return;
  let order, stops;
  try {
    order = readOrderForm(form);
    stops = ['pickup', 'delivery'].flatMap(type => [
      ...(order[type + '_name'] ? [primaryStop(order, type)] : []),
      ...extraStops.filter(item => item.type === type).map((item, index) => ({ ...readStopForm(item.el, type), stop_sequence: index + 2 }))
    ]);
  } catch (error) { note($('msg'), error.message, true); return; }
  if (!form.reportValidity()) return;
  button.disabled = true;
  try {
    // Creator, responsible dispatcher and history are assigned by the database.
    if (typeof capacityOrderImport !== 'undefined' && capacityOrderImport) {
      const data = await saveCapacityCargoOrder(order, stops);
      if (data.reused) { note($('msg'), 'Reservasjonen er allerede koblet til ordre #' + data.order_number + '. Det er ikke opprettet en ekstra ordre. Åpne den eksisterende ordren for å gjøre endringer.', true); await load(); return; }
      form.reset(); await load();
      note($('msg'), 'Ordre #' + data.order_number + ' opprettet og koblet til den reserverte bilen i Capacity.'); return;
    }
    newOrderRequestId ||= crypto.randomUUID();
    const { data, error } = await s.rpc('save_cargo_order', {
      p_id: null, p_expected_revision: null, p_request_id: newOrderRequestId, p_order: order, p_stops: stops
    });
    if (error) throw error;
    note($('msg'), data.reused ? 'Ordre #' + data.order_number + ' var allerede lagret. Ingen dobbeltordre er opprettet. Åpne ordren for eventuelle videre endringer.' : 'Ordre #' + data.order_number + ' og alle stopp er lagret.');
    form.reset();
    await load();
  } catch (error) { note($('msg'), error.message, true); }
  finally { button.disabled = false; }
};

$('form').addEventListener('reset', () => {
  newOrderRequestId = null;
  extraStops = []; $('extraPickups').replaceChildren(); $('extraDeliveries').replaceChildren();
  setTimeout(totals, 0);
});

window.editOrder = async id => {
  const { data: order, error } = await s.rpc('cargo_order_snapshot', { p_id: id });
  if (error || !order) { alert('Ordren kunne ikke hentes: ' + (error?.message || 'Ingen tilgang.')); return; }
  if (order.status === 'cancelled') { alert('Ordren er kansellert. Bruk Oppfølging for å lese historikken.'); return; }
  editingOrderSnapshot = structuredClone(order);
  current = { ...order, stops: order.stops || [] };
  const pickupDateTime = osloDateTime(current.pickup_at);
  const values = { ...current, pickup_date: current.pickup_date || pickupDateTime.slice(0, 10), pickup_time: pickupDateTime.slice(11, 16), delivery_at: local(current.delivery_at) };
  const fields = [['customer', 'Kunde'], ['customer_reference', 'Kundereferanse'], ['goods', 'Gods'], ['pallets', 'Paller', 'number'], ['weight_kg', 'Netto vekt kg', 'number'], ['temperature', 'Temperatur'],
    ['pickup_name', 'Hentested'], ['pickup_address', 'Henteadresse'], ['pickup_date', 'Hentedato', 'date'], ['pickup_time', 'Klokkeslett', 'time'], ['pickup_contact', 'Kontakt hentested'], ['pickup_phone', 'Mobilnr hentested – kun internt', 'tel'],
    ['delivery_name', 'Leveringssted'], ['delivery_address', 'Leveringsadresse'], ['delivery_at', 'Leveringstid', 'datetime-local'], ['delivery_contact', 'Kontakt levering'], ['delivery_phone', 'Telefon levering'],
    ['carrier_name', 'Transportør'], ['carrier_email', 'Transportør e-post', 'email'], ['carrier_contact', 'Transportørkontakt'], ['carrier_phone', 'Telefon transportørkontakt', 'tel'], ['trailer_number', 'Trallenummer'], ['driver_name', 'Sjåfør'], ['driver_phone', 'Sjåfør telefon'], ['vehicle_registration', 'Reg.nr'],
    ['carrier_price', 'Avtalt frakt til transportør (NOK)', 'number'], ['customer_price', 'Salgspris', 'number'], ['instructions', 'Instruksjoner']];
  $('editFields').innerHTML = fields.map(([key, label, type = 'text']) => '<label>' + label + '<input name="' + key + '" type="' + type + '" value="' + esc(values[key] ?? '') + '"' + (['customer', 'pickup_name', 'pickup_date', 'vehicle_registration'].includes(key) ? ' required' : '') + (['weight_kg', 'carrier_price', 'customer_price'].includes(key) ? ' step="0.01"' : '') + '></label>').join('');
  installCustomerPricing($('editForm'), current);
  // First stops use the main fields above, so users enter each pickup date only once.
  $('editStops').innerHTML = current.stops.filter(stop => Number(stop.stop_sequence) !== 1).map(stop => '<div class="multiStop" data-stop="' + esc(stop.id) + '"><div class="multiStopGrid"><label>Type<select data-k="stop_type"><option value="pickup"' + (stop.stop_type === 'pickup' ? ' selected' : '') + '>Henting</option><option value="delivery"' + (stop.stop_type === 'delivery' ? ' selected' : '') + '>Levering</option></select></label><div class="stop-fields">' + stopFields(stop.stop_type, stop) + '</div></div></div>').join('');
  $('editModal').classList.remove('hidden');
  enhanceOrderFields();
};

$('editStops').addEventListener('change', event => {
  if (event.target.dataset.k !== 'stop_type') return;
  const el = event.target.closest('[data-stop]'), type = event.target.value;
  const date = el.querySelector('[data-k=planned_date]');
  date.required = type === 'pickup';
  el.querySelector('[data-k=name]').required = type === 'pickup';
  const temp = el.querySelector('[data-k=temperature]');
  if (type === 'delivery') temp?.closest('label').remove();
  else if (!temp) {
    const label = document.createElement('label'); label.innerHTML = 'Temperatur<input data-k="temperature">';
    el.querySelector('.stop-fields').append(label);
  }
  markFields(el);
});

$('editForm').onsubmit = async event => {
  event.preventDefault();
  const form = event.target, button = form.querySelector('[type=submit]');
  if (button.disabled) return;
  let values, updates;
  try {
    values = readOrderForm(form);
    updates = [...$('editStops').querySelectorAll('[data-stop]')].map(el => ({ id: el.dataset.stop, values: readStopForm(el, el.querySelector('[data-k=stop_type]').value) }));
    // Keep all stop IDs and non-form fields from the same immutable edit snapshot.
    if (!editingOrderSnapshot) throw new Error('Åpne ordren på nytt før lagring.');
  } catch (error) { alert(error.message); return; }
  if (!form.reportValidity()) return;
  button.disabled = true;
  try {
    const snapshot = editingOrderSnapshot;
    const stops = ['pickup', 'delivery'].flatMap(type => {
      const existing = snapshot.stops.find(stop => stop.stop_type === type && Number(stop.stop_sequence) === 1);
      return values[type + '_name'] ? [{ ...existing, ...primaryStop(values, type), ...(existing ? { id: existing.id } : {}) }] : [];
    });
    const nextSequence = { pickup: 2, delivery: 2 };
    for (const update of updates) {
      const existing = snapshot.stops.find(stop => stop.id === update.id);
      if (!existing) throw new Error('Stoppet er endret. Hent ordren på nytt.');
      stops.push({ ...existing, ...update.values, stop_sequence: nextSequence[update.values.stop_type]++ });
    }
    const { error } = await s.rpc('save_cargo_order', { p_id: snapshot.id, p_expected_revision: snapshot.revision,
      p_request_id: null, p_order: values, p_stops: stops });
    if (error) throw error;
    editingOrderSnapshot = null;
    $('editModal').classList.add('hidden'); await load(); alert('Ordren er oppdatert.');
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; }
};
/* Customer prices are stored as total; the base and percentage stay separate for editing. */
function pricingUnits(value, label, optional = false) {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!text) return optional ? null : 0n;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(label + ' må være et positivt tall med høyst to desimaler.');
  const [whole, fraction = ''] = text.split('.');
  const units = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (units > 999999999999n) throw new Error(label + ' er for stort.');
  return units;
}

function calculateCustomerPricing(baseValue, percentValue) {
  const base = pricingUnits(baseValue, 'Fraktsum til kunde', true);
  const percent = pricingUnits(percentValue, 'Dieseltillegg');
  if (percent > 10000n) throw new Error('Dieseltillegget må være mellom 0 og 100 %.');
  if (base === null && percent > 0n) throw new Error('Fyll inn fraktsum til kunde før du legger til dieseltillegg.');
  // Integer cents and basis points avoid binary floating-point rounding errors.
  const diesel = base === null ? 0n : (base * percent + 5000n) / 10000n;
  return {
    customer_base_price: base === null ? null : Number(base) / 100,
    customer_diesel_percent: Number(percent) / 100,
    customer_diesel_amount: Number(diesel) / 100,
    customer_price: base === null ? null : Number(base + diesel) / 100
  };
}

function installCustomerPricing(form, order = null) {
  const base = form.elements.customer_price;
  if (!base || base.dataset.dieselPricing) return;
  base.dataset.dieselPricing = 'true';
  base.min = '0'; base.step = '0.01';
  if (order) base.value = order.customer_base_price ?? order.customer_price ?? '';
  const label = base.closest('label');
  const heading = label.querySelector('.label-heading > span') || [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (heading) heading.textContent = 'Fraktsum til kunde (NOK)';
  const percentLabel = document.createElement('label');
  percentLabel.textContent = 'Dieseltillegg (%)';
  const percent = document.createElement('input');
  percent.name = 'customer_diesel_percent';
  percent.type = 'text'; percent.inputMode = 'decimal'; percent.placeholder = '0';
  percent.autocomplete = 'off'; percent.maxLength = 6;
  percent.id = form.id + '-diesel-percent';
  // Leave an unused surcharge empty, so Capacity does not detect a phantom draft.
  percent.defaultValue = order?.customer_diesel_percent ? String(order.customer_diesel_percent) : '';
  const help = document.createElement('small');
  help.id = form.id + '-diesel-help'; help.className = 'customer-help';
  help.textContent = 'Prosent av fraktsummen. Tomt felt eller 0 = uten tillegg.';
  percent.setAttribute('aria-describedby', help.id);
  percentLabel.append(percent, help);
  const summary = document.createElement('div');
  summary.className = 'notice customer-pricing-summary';
  summary.style.gridColumn = '1 / -1'; summary.style.margin = '0';
  summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
  label.after(percentLabel, summary);
  const money = value => new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const refresh = () => {
    percent.setCustomValidity('');
    try {
      const price = calculateCustomerPricing(base.value, percent.value);
      summary.classList.remove('error');
      summary.textContent = price.customer_price === null ? 'Kundepris er ikke oppgitt.' : 'Dieseltillegg: ' + money(price.customer_diesel_amount) + ' · Totalpris til kunde: ' + money(price.customer_price) + ' (før eventuell mva).';
    } catch (error) {
      percent.setCustomValidity(error.message);
      summary.classList.add('error'); summary.textContent = error.message;
    }
  };
  base.addEventListener('input', refresh); percent.addEventListener('input', refresh);
  if (form.id === 'form') form.addEventListener('reset', () => setTimeout(refresh, 0));
  refresh();
}

installCustomerPricing($('form'));
