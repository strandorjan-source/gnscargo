/* GNS transport documents. CMR field numbering follows IRU's 2007 model.
 * https://www.iru.org/resources/iru-library/iru-cmr-model-2007
 * The customer account and customer sales price are never used in carrier documents.
 */
'use strict';

const documentText = value => String(value ?? '').trim();
const documentRef = order => 'GNS-' + order.order_number;
const documentAmount = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
  ? 'Ikke oppgitt'
  : new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value)).replace(/[\u00a0\u202f]/g, ' ') + ' NOK';
const documentNumber = value => value === null || value === undefined || value === '' ? 'Ikke oppgitt' : new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 2 }).format(Number(value)).replace(/[\u00a0\u202f]/g, ' ');
const documentTime = (value, dateOnly) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('nb-NO', { timeZone: 'Europe/Oslo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : dateOnly ? dateOnly.split('-').reverse().join('.') + ' (klokkeslett ikke avtalt)' : 'Ikke oppgitt';
const pdfText = value => String(value ?? '').replace(/[\u00a0\u202f]/g, ' ').replace(/[–—]/g, '-').replace(/→/g, 'til').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

function documentStops(order, type) {
  const main = {
    id: 'main-' + type, stop_type: type, stop_sequence: 1,
    name: order[type + '_name'], address: order[type + '_address'], planned_at: order[type + '_at'], planned_date: type === 'pickup' ? order.pickup_date : null,
    contact_name: order[type + '_contact'], phone: order[type + '_phone'],
    goods: order.goods, pallets: order.pallets, weight_kg: order.weight_kg,
    temperature: order.temperature, instructions: order.instructions
  };
  const recorded = (order.stops || []).filter(stop => stop.stop_type === type).sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  const first = recorded.find(stop => Number(stop.stop_sequence) === 1);
  // The main order fields are authoritative for the first stop; older stop rows may be stale.
  return [{ ...first, ...main, id: first?.id || main.id }, ...recorded.filter(stop => Number(stop.stop_sequence) !== 1)];
}

function stopLines(stop, includeGoods = true) {
  const lines = [stop.name || 'Sted ikke oppgitt', stop.address || 'Adresse ikke oppgitt', 'Avtalt tid: ' + documentTime(stop.planned_at, stop.planned_date)];
  const externalPhone = stop.stop_type === 'pickup' ? '' : stop.phone;
  if (stop.contact_name || externalPhone) lines.push('Kontakt: ' + [stop.contact_name, externalPhone].filter(Boolean).join(' / '));
  if (includeGoods) {
    lines.push('Gods: ' + (stop.goods || 'Ikke oppgitt'));
    lines.push('Paller: ' + documentNumber(stop.pallets) + ' | Nettovekt: ' + documentNumber(stop.weight_kg) + ' kg');
    if (stop.stop_type === 'pickup' && stop.temperature) lines.push('Temperatur: ' + stop.temperature);
    if (stop.instructions) lines.push('Instruksjoner: ' + stop.instructions);
  }
  return lines;
}

// Scrub known internal pickup numbers even when copied into instructions/CMR text.
function externalDocumentText(order, value) {
  let text = String(value ?? '');
  const phones = [order.pickup_phone, ...(order.stops || []).filter(stop => stop.stop_type === 'pickup').map(stop => stop.phone)];
  for (const phone of phones) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 7) continue;
    const variants = [digits, ...(digits.length === 10 && digits.startsWith('47') ? [digits.slice(2)] : [])];
    for (const number of variants) {
      const pattern = '(?<![0-9])(?:\\+|00)?' + number.split('').join('[\\s().-]*') + '(?![0-9])';
      text = text.replace(new RegExp(pattern, 'g'), '');
    }
  }
  return text;
}

function carrierDocumentOptions() {
  return { includeDelivery: $('includeDelivery')?.checked !== false };
}

function carrierDocumentSections(order, options = {}) {
  const deliveryOnly = options.deliveryOnly === true;
  const includeDelivery = deliveryOnly || options.includeDelivery !== false;
  return [
    { title: 'BESTILLER OG AVTALT FRAKT', lines: ['Bestiller: GNS Cargo AS', 'GNS-referanse: ' + documentRef(order), 'Avtalt fraktbeløp til transportør: ' + documentAmount(order.carrier_price), 'Faktura merkes med ' + documentRef(order)] },
    ...(!deliveryOnly ? documentStops(order, 'pickup').map((stop, i) => ({ title: 'LASTESTED ' + (i + 1), lines: stopLines(stop) })) : []),
    ...(includeDelivery ? documentStops(order, 'delivery').map((stop, i) => ({ title: 'LOSSESTED ' + (i + 1), lines: stopLines(stop) })) : [{ title: 'LOSSEINFORMASJON', lines: ['Losseopplysninger sendes separat.'] }]),
    { title: 'TRANSPORTØR OG BIL', lines: ['Transportør: ' + (order.carrier_name || 'Ikke oppgitt'), 'E-post: ' + (order.carrier_email || 'Ikke oppgitt'), ...(order.carrier_contact ? ['Transportørkontakt: ' + order.carrier_contact] : []), ...(order.carrier_phone ? ['Telefon transportørkontakt: ' + order.carrier_phone] : []), ...(order.trailer_number ? ['Trallenummer: ' + order.trailer_number] : []), 'Sjåfør: ' + (order.driver_name || 'Ikke oppgitt'), 'Sjåførtelefon: ' + (order.driver_phone || 'Ikke oppgitt'), 'Registreringsnummer: ' + (order.vehicle_registration || 'Ikke oppgitt')] }
  ].map(section => ({ ...section, lines: section.lines.map(line => externalDocumentText(order, line)) }));
}

function renderCarrierSheet(order, options = carrierDocumentOptions()) {
  $('sheet').innerHTML = '<div class="document-summary"><div><span>BESTILLER</span><strong>GNS Cargo AS</strong></div><div><span>GNS-REFERANSE</span><strong>' + esc(documentRef(order)) + '</strong></div><div><span>AVTALT FRAKT TIL TRANSPORTØR</span><strong>' + esc(documentAmount(order.carrier_price)) + '</strong></div></div>' +
    carrierDocumentSections(order, options).slice(1).map(section => '<section class="document-section"><h3>' + esc(section.title) + '</h3>' + section.lines.map(line => '<p>' + esc(line) + '</p>').join('') + '</section>').join('') +
    '<p class="muted">Faktura merkes med ' + esc(documentRef(order)) + '.</p>';
}

async function getDocumentOrder(id) {
  const [orderResult, stopResult] = await Promise.all([
    s.from('orders').select('*').eq('id', id).single(),
    s.from('order_stops').select('*').eq('order_id', id).order('stop_sequence')
  ]);
  if (orderResult.error || !orderResult.data) throw new Error('Ordren kunne ikke hentes. Oppdater ordrelisten.');
  if (stopResult.error) throw new Error('Stopplisten kunne ikke hentes: ' + stopResult.error.message);
  const index = orders.findIndex(row => row.id === id);
  if (index >= 0) orders[index] = orderResult.data;
  return { ...orderResult.data, stops: stopResult.data || [] };
}

window.openOrder = async id => {
  try {
    current = await getDocumentOrder(id);
    $('includeDelivery').checked = true;
    $('modalTitle').textContent = 'Transportordre / lasteliste';
    $('modalMeta').textContent = documentRef(current) + ' · Bestiller: GNS Cargo AS';
    renderCarrierSheet(current);
    $('deleteBtn').classList.toggle('hidden', !['admin', 'superuser'].includes(me?.role));
    $('modal').classList.remove('hidden');
  } catch (error) { note($('msg'), error.message, true); }
};

async function refreshDocumentOrder() {
  if (!current?.id) throw new Error('Åpne en ordre først.');
  current = await getDocumentOrder(current.id);
  renderCarrierSheet(current);
  return current;
}

function makePdf(order, options = carrierDocumentOptions()) {
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const ref = documentRef(order), margin = 15, width = 180;
  let y = 0;
  function header() {
    doc.setFillColor(7, 27, 49); doc.rect(0, 0, 210, 36, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text('GNS CARGO AS', margin, 15);
    doc.setFontSize(11); doc.text(options.deliveryOnly ? 'LOSSEINFORMASJON' : 'TRANSPORTORDRE / LASTELISTE', margin, 24);
    doc.setFontSize(13); doc.text(ref, 195, 15, { align: 'right' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.text('Bestiller: GNS Cargo AS', margin, 31);
    doc.setTextColor(18, 32, 51); y = 45;
  }
  function newPage() { doc.addPage(); header(); }
  function heading(text) {
    if (y > 242) newPage();
    doc.setFillColor(233, 242, 250); doc.rect(margin, y, width, 9, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(pdfText(text), margin + 3, y + 6); y += 13;
  }
  function paragraph(text, bold = false) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 12 : 10);
    const lines = doc.splitTextToSize(pdfText(text), width - 6);
    for (const line of lines) {
      if (y > 272) newPage();
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 12 : 10);
      doc.text(line, margin + 3, y); y += bold ? 5.6 : 4.6;
    }
    y += 1;
  }
  header();
  carrierDocumentSections(order, options).forEach((section, index) => {
    let needed = 16;
    section.lines.forEach((line, i) => {
      const bold = index === 0 && i === 2;
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 12 : 10);
      needed += doc.splitTextToSize(pdfText(line), width - 6).length * (bold ? 5.6 : 4.6) + 1;
    });
    if (needed < 225 && y + needed > 274) newPage();
    heading(section.title);
    section.lines.forEach((line, i) => paragraph(line, index === 0 && i === 2));
    y += 3;
  });
  for (let page = 1; page <= doc.getNumberOfPages(); page++) {
    doc.setPage(page); doc.setDrawColor(210, 220, 230); doc.line(15, 282, 195, 282);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(85);
    doc.text('GNS Cargo AS | ' + ref + ' | Faktura merkes med GNS-referansen', 15, 288);
    doc.text('Side ' + page + ' / ' + doc.getNumberOfPages(), 195, 288, { align: 'right' });
  }
  return doc;
}

function carrierEmail(order, options = carrierDocumentOptions()) {
  const deliveryOnly = options.deliveryOnly === true;
  const title = deliveryOnly ? 'Losseinfo' : 'Transportordre';
  const route = deliveryOnly ? '' : ' - ' + (order.pickup_name || '') + (options.includeDelivery !== false && order.delivery_name ? ' til ' + order.delivery_name : '');
  return {
    subject: externalDocumentText(order, title + ' ' + documentRef(order) + route),
    body: ['Hei,', '', deliveryOnly ? 'Her er losseopplysningene til transportordre ' + documentRef(order) + '.' : 'GNS Cargo AS bestiller transport som beskrevet nedenfor.', '', ...carrierDocumentSections(order, options).flatMap(section => [section.title, ...section.lines, '']), 'Vedlegg: ' + (deliveryOnly ? 'Losseinformasjon' : 'Transportordre / lasteliste') + ' ' + documentRef(order) + '.', '', 'Vennlig hilsen', 'GNS Cargo AS'].join('\n')
  };
}

const cmrFields = [
  ['sender_name', '1 Avsender – navn'], ['sender_address', '1 Avsender – adresse og land', 'textarea'],
  ['consignee_name', '2 Mottaker – navn'], ['consignee_address', '2 Mottaker – adresse og land', 'textarea'],
  ['pickup_country', '3 Land ved lasting'], ['delivery_country', '4 Land ved lossing'], ['warehouse_hours', '4 Åpningstid losseplass'],
  ['sender_instructions', '5 Instruksjoner / tollopplysninger', 'textarea'],
  ['carrier_name', '6 Transportør – navn'], ['carrier_address', '6 Transportør – adresse og land', 'textarea'],
  ['successive_carriers', '7 Etterfølgende transportører', 'textarea'], ['reservations', '8 Transportørens forbehold', 'textarea'],
  ['documents', '9 Dokumenter vedlagt', 'textarea'], ['marks', '10 Merker / nummer'], ['packages', '11 Antall kolli', 'number'],
  ['packing', '12 Emballasjetype'], ['goods', '13 Varebeskrivelse', 'textarea'], ['gross_weight', '14 Bruttovekt (kg)', 'number'], ['volume', '15 Volum (m³)', 'number'],
  ['adr', 'ADR-opplysninger, dersom aktuelt', 'textarea'], ['agreements', '16 Særlige avtaler', 'textarea'],
  ['supplementary_charges', '17 Avtalte tillegg / avgifter', 'textarea'], ['other_details', '18 Øvrige opplysninger', 'textarea'],
  ['cash_on_delivery', '19 Etterkrav, dersom avtalt'], ['issue_place', '21 Utstedt sted'], ['issue_country', 'Utstedt i land'], ['issue_date', '21 Utstedt dato', 'date']
];
let cmrOrder = null;
let cmrWorkingRoutes = {};
let cmrActiveRoute = '';

function cmrRouteKey(pickup, delivery) { return pickup.id + '|' + delivery.id; }
function cmrRoute() {
  return { pickup: documentStops(cmrOrder, 'pickup')[Number($('cmrPickup').value)], delivery: documentStops(cmrOrder, 'delivery')[Number($('cmrDelivery').value)] };
}
function cmrDefaults(order, pickup, delivery) {
  return { sender_name: pickup.name || '', sender_address: pickup.address || '', consignee_name: delivery.name || '', consignee_address: delivery.address || '',
    sender_instructions: pickup.instructions || order.instructions || '', carrier_name: order.carrier_name || '', goods: pickup.goods || order.goods || '',
    issue_date: osloDate(new Date()) };
}
function readCmrFields() { return Object.fromEntries(cmrFields.map(([key]) => [key, $('cmrForm').elements[key].value.trim()])); }
function setCmrRoute() {
  if (cmrActiveRoute) cmrWorkingRoutes[cmrActiveRoute] = readCmrFields();
  const { pickup, delivery } = cmrRoute();
  cmrActiveRoute = cmrRouteKey(pickup, delivery);
  const values = { ...cmrDefaults(cmrOrder, pickup, delivery), ...cmrWorkingRoutes[cmrActiveRoute] };
  cmrFields.forEach(([key]) => { $('cmrForm').elements[key].value = values[key] ?? ''; });
  $('cmrRouteInfo').textContent = 'Gjelder ' + (pickup.name || 'valgt lastested') + ' → ' + (delivery.name || 'valgt lossested') + '. Nettovekt fra ordren: ' + documentNumber(pickup.weight_kg) + ' kg. Bruttovekt og kolli fylles ut separat.';
}

function installCmrForm() {
  const modal = document.createElement('div');
  modal.id = 'cmrModal'; modal.className = 'modal hidden'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'cmrTitle');
  modal.innerHTML = '<div class="card"><div class="toolbar"><h2 id="cmrTitle">CMR-fraktbrev</h2><button type="button" class="btn white" id="closeCmr">Lukk</button></div><p>Bestiller: <b>GNS Cargo AS</b>. Kontroller avsender og mottaker; forslagene er hentet fra laste- og lossestedet. Felter som står tomme må kompletteres der de er relevante før signering.</p><div class="grid"><label>Lastested<select id="cmrPickup"></select></label><label>Lossested<select id="cmrDelivery"></select></label><label>Eksemplarer<select id="cmrCopies"><option value="all">Alle tre originaleksemplarer</option><option value="sender">Avsender</option><option value="consignee">Mottaker</option><option value="carrier">Transportør</option></select></label></div><p id="cmrRouteInfo" class="notice"></p><div id="cmrMessage" role="status" aria-live="polite"></div><form id="cmrForm"><div class="grid">' + cmrFields.map(([key, label, type = 'text']) => '<label>' + esc(label) + (type === 'textarea' ? '<textarea name="' + key + '" maxlength="4000"></textarea>' : '<input name="' + key + '" type="' + type + '"' + (type === 'number' ? ' min="0" step="' + (key === 'packages' ? '1' : '0.01') + '"' : ' maxlength="500"') + '>') + '</label>').join('') + '</div><p class="muted">Ett CMR gjelder den valgte forsendelsen. Ved flere leveringer kan du velge neste laste-/lossested og lage et eget fraktbrev. Opplysningene lagres på ordren.</p><div class="actions"><button type="submit" class="btn blue" id="saveCmr">Lagre og last ned CMR</button></div></form></div>';
  document.body.append(modal);
  $('closeCmr').onclick = closeCmrForm;
  $('cmrPickup').onchange = $('cmrDelivery').onchange = setCmrRoute;
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeCmrForm(); }
    if (event.key === 'Tab') {
      const fields = [...modal.querySelectorAll('button,input,select,textarea')].filter(el => !el.disabled);
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0].focus(); }
    }
  });
  $('cmrForm').onsubmit = async event => {
    event.preventDefault();
    const button = $('saveCmr'); if (button.disabled) return;
    button.disabled = true; button.textContent = 'Lagrer CMR…'; note($('cmrMessage'), '');
    try {
      cmrWorkingRoutes[cmrActiveRoute] = readCmrFields();
      const details = { ...cmrOrder.cmr_details, routes: cmrWorkingRoutes };
      const data = await patchCargoOrder(cmrOrder, { cmr_details: details });
      cmrOrder.revision = data.revision;
      cmrOrder.cmr_details = details;
      const row = orders.find(order => order.id === cmrOrder.id); if (row) { row.cmr_details = details; row.revision = data.revision; }
      if (current?.id === cmrOrder.id) { current.cmr_details = details; current.revision = data.revision; }
      const route = cmrRoute();
      makeCmr(cmrOrder, cmrWorkingRoutes[cmrActiveRoute], route, $('cmrCopies').value).save('CMR-' + documentRef(cmrOrder) + '-L' + (Number($('cmrPickup').value) + 1) + '-D' + (Number($('cmrDelivery').value) + 1) + '.pdf');
      note($('cmrMessage'), 'CMR-opplysningene er lagret og PDF-en er lastet ned.');
    } catch (error) { note($('cmrMessage'), 'CMR kunne ikke opprettes: ' + error.message, true); }
    finally { button.disabled = false; button.textContent = 'Lagre og last ned CMR'; }
  };
}

function closeCmrForm() {
  if ($('saveCmr').disabled) return;
  $('cmrModal').classList.add('hidden'); $('cmrBtn').focus();
}
async function openCmrForm() {
  try {
    cmrOrder = await refreshDocumentOrder();
    cmrWorkingRoutes = JSON.parse(JSON.stringify(cmrOrder.cmr_details?.routes || {})); cmrActiveRoute = '';
    for (const [id, type] of [['cmrPickup', 'pickup'], ['cmrDelivery', 'delivery']]) {
      $(id).replaceChildren(...documentStops(cmrOrder, type).map((stop, i) => new Option((i + 1) + '. ' + (stop.name || 'Ikke oppgitt'), i)));
    }
    $('cmrTitle').textContent = 'CMR-fraktbrev · ' + documentRef(cmrOrder);
    note($('cmrMessage'), ''); setCmrRoute(); $('cmrModal').classList.remove('hidden'); $('cmrPickup').focus();
  } catch (error) { alert(error.message); }
}

function makeCmr(order, fields = {}, route = {}, copies = 'all') {
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const pickup = route.pickup || documentStops(order, 'pickup')[0], delivery = route.delivery || documentStops(order, 'delivery')[0];
  const values = { ...cmrDefaults(order, pickup, delivery), ...fields };
  const ref = documentRef(order);
  const allCopies = [
    { id: 'sender', label: '1 AVSENDER / SENDER', color: [170, 37, 37] },
    { id: 'consignee', label: '2 MOTTAKER / CONSIGNEE', color: [34, 86, 164] },
    { id: 'carrier', label: '3 TRANSPORTØR / CARRIER', color: [26, 115, 67] }
  ];
  const selected = copies === 'all' ? allCopies : allCopies.filter(copy => copy.id === copies);
  if (!selected.length) throw new Error('Velg CMR-eksemplar.');
  selected.forEach((copy, copyIndex) => {
    if (copyIndex) doc.addPage();
    const annex = [];
    function box(number, label, x, y, width, height, content = '') {
      content = externalDocumentText(order, content);
      doc.setDrawColor(...copy.color); doc.setLineWidth(.3); doc.rect(x, y, width, height);
      doc.setTextColor(...copy.color); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text(String(number), x + 1.5, y + 4);
      doc.setFontSize(6.8);
      const cargo = number >= 10 && number <= 15;
      const labels = doc.splitTextToSize(pdfText(label), width - (cargo ? 5 : 11));
      if (cargo) doc.text(labels, x + width / 2, y + 8, { align: 'center', lineHeightFactor: 1.05 });
      else doc.text(labels, x + 8, y + 3.5, { lineHeightFactor: 1.05 });
      const bodyY = y + (cargo ? Math.max(16, labels.length * 2.6 + 11) : Math.max(9, labels.length * 2.6 + 3));
      doc.setTextColor(20); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.2);
      let lines = doc.splitTextToSize(pdfText(content), width - 5);
      const capacity = Math.max(1, Math.floor((y + height - 2 - bodyY) / 3.5) + 1);
      if (lines.length > capacity) {
        annex.push({ title: String(number) + ' ' + label, text: content });
        lines = [...lines.slice(0, Math.max(0, capacity - 1)), 'Se vedlegg / See annex'];
      }
      if (content) doc.text(lines, x + 2.5, bodyY, { lineHeightFactor: 1.2 });
    }
    doc.setTextColor(...copy.color); doc.setFont('helvetica', 'bold'); doc.setFontSize(24); doc.text('CMR', 10, 15);
    doc.setFontSize(10); doc.text('INTERNASJONALT FRAKTBREV', 40, 10); doc.text('INTERNATIONAL CONSIGNMENT NOTE', 40, 15);
    doc.setFontSize(13); doc.text(ref, 200, 23, { align: 'right' });
    doc.setFontSize(8); doc.text(copy.label, 10, 23);
    doc.setTextColor(30); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text('Bestiller / Transport ordered by: GNS Cargo AS', 10, 28);
    doc.text('Utstedt i / Country: ' + pdfText(values.issue_country || '____________'), 200, 28, { align: 'right' });
    box(1, 'Avsender: navn, adresse, land / Sender', 10, 31, 95, 25, [values.sender_name, values.sender_address].filter(Boolean).join('\n'));
    box(2, 'Mottaker: navn, adresse, land / Consignee', 10, 56, 95, 25, [values.consignee_name, values.consignee_address].filter(Boolean).join('\n'));
    box(3, 'LASTESTED / Taking over the goods', 10, 81, 95, 25, [pickup.name, pickup.address, values.pickup_country, 'Dato/tid: ' + documentTime(pickup.planned_at, pickup.planned_date), 'Ankomst: ________ Avgang: ________'].filter(Boolean).join('\n'));
    box(4, 'LOSSESTED / Delivery of the goods', 10, 106, 95, 23, [delivery.name, delivery.address, values.delivery_country, values.warehouse_hours && 'Åpningstid: ' + values.warehouse_hours].filter(Boolean).join('\n'));
    box(5, 'Avsenderinstruksjoner / Sender instructions', 10, 129, 95, 25, [values.sender_instructions, pickup.temperature && 'Temperatur: ' + pickup.temperature].filter(Boolean).join('\n'));
    box(6, 'Transportør: navn, adresse, land / Carrier', 105, 31, 95, 25, [values.carrier_name, values.carrier_address].filter(Boolean).join('\n'));
    box(7, 'Etterfølgende transportører / Successive carriers', 105, 56, 95, 25, values.successive_carriers);
    box(8, 'Transportørens forbehold / Carrier reservations', 105, 81, 95, 39, values.reservations);
    box(9, 'Vedlagte dokumenter / Documents attached', 105, 120, 95, 34, values.documents);
    const columns = [
      [10, 'Merker / nr.\nMarks / Nos', 22, values.marks], [11, 'Antall kolli\nPackages', 20, values.packages],
      [12, 'Emballasje\nPacking', 25, values.packing], [13, 'Varebeskrivelse / Nature of goods', 73, [values.goods, values.adr && 'ADR: ' + values.adr].filter(Boolean).join('\n')],
      [14, 'Bruttovekt kg\nGross kg', 25, values.gross_weight], [15, 'Volum m3\nVolume m3', 25, values.volume]
    ];
    let x = 10; columns.forEach(([number, label, width, content]) => { box(number, label, x, 154, width, 36, content); x += width; });
    box(16, 'Særlige avtaler / Special agreements', 10, 190, 95, 28, [values.agreements, (delivery.planned_at || delivery.planned_date) && 'Avtalt levering: ' + documentTime(delivery.planned_at, delivery.planned_date)].filter(Boolean).join('\n'));
    box(17, 'Frakt og kostnader / Carriage charges', 105, 190, 95, 39, ['Avtalt frakt til transportør: ' + documentAmount(order.carrier_price), 'Gjelder hele transportordre ' + ref, 'Bestiller / Betaler: GNS Cargo AS', values.supplementary_charges, 'Faktura merkes: ' + ref].filter(Boolean).join('\n'));
    box(18, 'Øvrige opplysninger / Other particulars', 10, 218, 95, 20, ['Reg.nr: ' + (order.vehicle_registration || '________'), ...(order.trailer_number ? ['Tralle: ' + order.trailer_number] : []), 'Netto: ' + documentNumber(pickup.weight_kg) + ' kg | Paller: ' + documentNumber(pickup.pallets), values.other_details].filter(Boolean).join('\n'));
    box(19, 'Etterkrav / Cash on delivery', 105, 229, 95, 9, '');
    if (values.cash_on_delivery) { annex.push({ title: '19 Etterkrav / Cash on delivery', text: values.cash_on_delivery }); doc.setTextColor(20); doc.setFontSize(7); doc.text('Se vedlegg / See annex', 150, 236); }
    doc.setDrawColor(...copy.color); doc.rect(10, 238, 190, 11); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...copy.color); doc.text('20', 11.5, 242);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(20);
    doc.text('Transporten er underlagt CMR-konvensjonen uavhengig av eventuelle motstridende avtalevilkår.', 19, 242.5);
    doc.text('This international road carriage is governed by the CMR Convention, irrespective of any inconsistent terms.', 19, 246);
    doc.setDrawColor(...copy.color); doc.rect(10, 249, 190, 9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...copy.color); doc.setFontSize(8); doc.text('21', 11.5, 254);
    doc.setTextColor(20); doc.setFont('helvetica', 'normal');
    const issueText = 'Utstedt sted / Established in: ' + (values.issue_place || '________________') + ' | Dato / Date: ' + (values.issue_date || '________________');
    const issueLines = doc.splitTextToSize(pdfText(issueText), 177);
    if (issueLines.length > 1) { annex.push({ title: '21 Utstedt / Established', text: issueText }); doc.text('Se vedlegg / See annex', 19, 254); } else doc.text(issueLines, 19, 254);
    box(22, 'Avsenders signatur/stempel / Sender signature/stamp', 10, 258, 63.33, 24);
    box(23, 'Transportørens signatur/stempel / Carrier signature/stamp', 73.33, 258, 63.34, 24);
    box(24, 'Mottatt / Received - mottakers signatur/stempel', 136.67, 258, 63.33, 24, 'Sted: __________ Dato: __________\nAnkomst: _______ Avgang: _______');
    doc.setTextColor(...copy.color); doc.setFontSize(7); doc.text(ref + ' | ' + copy.label, 10, 287);
    doc.text('GNS Cargo AS - feltstruktur etter IRU 2007', 200, 287, { align: 'right' });
    if (annex.length) {
      let y = 0;
      function annexPage() {
        doc.addPage(); doc.setTextColor(...copy.color); doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text('CMR VEDLEGG / ANNEX - ' + ref, 12, 15);
        doc.setFontSize(9); doc.text(copy.label, 12, 22); y = 32;
      }
      annexPage();
      annex.forEach(item => {
        doc.setFontSize(9); doc.setFont('helvetica', 'bold');
        const titleLines = doc.splitTextToSize(pdfText(item.title), 182);
        if (y + titleLines.length * 4 > 265) annexPage();
        doc.setTextColor(...copy.color); doc.text(titleLines, 12, y); y += titleLines.length * 4 + 2;
        doc.setTextColor(20); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
        const lines = doc.splitTextToSize(pdfText(item.text), 182);
        lines.forEach(line => { if (y > 280) { annexPage(); doc.setTextColor(20); doc.setFont('helvetica', 'normal'); doc.setFontSize(9); } doc.text(line, 12, y); y += 4.2; });
        y += 6;
      });
    }
  });
  doc.setProperties({ title: 'CMR ' + ref, author: 'GNS Cargo AS', subject: 'International consignment note' });
  return doc;
}

installCmrForm();
$('includeDelivery').addEventListener('change', () => { if (current) renderCarrierSheet(current); });
$('pdfBtn').onclick = async () => { try { const order = await refreshDocumentOrder(); makePdf(order).save('GNS-Transportordre-Lasteliste-' + order.order_number + '.pdf'); } catch (error) { alert(error.message); } };
$('cmrBtn').onclick = openCmrForm;
