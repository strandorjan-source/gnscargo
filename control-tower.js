/* Order form, customer register and invoicing exports. Uses the existing user session/RLS. */
'use strict';

const normalizeCustomer = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('nb-NO');
const customerPickers = new Map();
let customerTarget = null;
let customerReturnFocus = null;
let excelLibraryPromise = null;

function customerChoices() {
  const choices = new Map();
  for (const customer of customers) {
    if (customer.name?.trim()) choices.set(normalizeCustomer(customer.name), { ...customer, saved: true });
  }
  for (const order of orders) {
    const key = normalizeCustomer(order.customer);
    if (key && !choices.has(key)) choices.set(key, { name: order.customer.trim(), saved: false });
  }
  return [...choices.values()].sort((a, b) => a.name.localeCompare(b.name, 'nb'));
}

function markFields(root) {
  root.querySelectorAll('label').forEach(label => {
    const input = label.querySelector('input, select, textarea');
    if (!input) return;
    if (label.classList.contains('marked-field')) {
      const badge = label.querySelector('.field-badge');
      const text = input.required ? 'Obligatorisk' : 'Valgfritt';
      if (badge && badge.textContent !== text) { badge.textContent = text; badge.className = 'field-badge ' + (input.required ? 'field-required' : 'field-optional'); }
      return;
    }
    const heading = document.createElement('span');
    heading.className = 'label-heading';
    const title = document.createElement('span');
    [...label.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).forEach(n => title.append(n));
    const badge = document.createElement('span');
    badge.className = 'field-badge ' + (input.required ? 'field-required' : 'field-optional');
    badge.textContent = input.required ? 'Obligatorisk' : 'Valgfritt';
    heading.append(title, badge);
    label.prepend(heading);
    label.classList.add('marked-field');
  });
}

function enhanceOrderFields() {
  const editCustomer = $('editForm').elements.customer;
  if (editCustomer) editCustomer.required = true;
  const editPickup = $('editForm').elements.pickup_name;
  if (editPickup) editPickup.required = true;
  for (const form of [$('form'), $('editForm')]) for (const key of ['pickup_date', 'vehicle_registration']) {
    if (form.elements[key]) form.elements[key].required = true;
  }
  $('extraPickups').querySelectorAll('[data-k=name]').forEach(input => { input.required = true; });
  $('editStops').querySelectorAll('[data-stop]').forEach(stop => {
    const name = stop.querySelector('[data-k=name]');
    const pickup = stop.querySelector('[data-k=stop_type]')?.value === 'pickup';
    if (name) name.required = pickup;
    const date = stop.querySelector('[data-k=planned_date]');
    if (date) date.required = pickup;
  });
  for (const form of [$('form'), $('editForm'), $('customerForm')]) {
    if (!form) continue;
    if (form.elements.carrier_price) { form.elements.carrier_price.step = '0.01'; form.elements.carrier_price.min = '0'; }
    markFields(form);
    const input = form.elements.customer;
    if (input && !input.dataset.customerPicker) installCustomerPicker(input);
  }
}

function installCustomerPicker(input) {
  input.dataset.customerPicker = 'true';
  input.removeAttribute('list');
  input.autocomplete = 'off';
  input.id ||= 'editCustomer';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const label = input.closest('label');
  const field = document.createElement('div');
  field.className = 'customer-field marked-field';
  label.before(field);
  field.append(label);
  label.htmlFor = input.id;
  const wrap = document.createElement('div');
  wrap.className = 'customer-input-wrap';
  const entry = document.createElement('div');
  entry.className = 'customer-entry';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn white customer-toggle';
  toggle.textContent = '▾';
  toggle.setAttribute('aria-label', 'Vis kundeliste');
  const list = document.createElement('div');
  list.id = input.id + '-options';
  list.className = 'customer-options hidden';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Kunder');
  input.setAttribute('aria-controls', list.id);
  entry.append(input, toggle);
  wrap.append(entry, list);
  field.append(wrap);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn white customer-new';
  add.textContent = '+ Ny kunde / lagre kunde';
  add.onclick = () => openCustomerForm(input);
  const help = document.createElement('span');
  help.id = input.id + '-help';
  help.className = 'customer-help';
  help.textContent = 'Søk i lagrede kunder og kundenavn fra tidligere ordrer.';
  input.setAttribute('aria-describedby', help.id);
  field.append(add, help);
  let matches = [];
  let active = -1;
  function close() {
    list.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }
  function select(customer) {
    input.value = customer.name;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    help.textContent = customer.saved
      ? [customer.org_number && 'Org.nr ' + customer.org_number, customer.invoice_email || customer.email].filter(Boolean).join(' · ') || 'Kunden er lagret i kunderegisteret.'
      : 'Kunde fra tidligere ordre. Bruk «Ny kunde / lagre kunde» for å lagre kundedetaljer.';
    input.focus();
    close();
  }
  function render(showAll = false) {
    const query = showAll ? '' : normalizeCustomer(input.value);
    matches = customerChoices().filter(c => normalizeCustomer(c.name).includes(query) || (c.org_number || '').includes(query)).slice(0, 40);
    active = -1;
    input.removeAttribute('aria-activedescendant');
    list.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'customer-empty';
      empty.textContent = query ? 'Ingen treff. Legg til kunden med knappen nedenfor.' : 'Ingen kunder ennå. Legg til den første kunden nedenfor.';
      list.append(empty);
    }
    matches.forEach((customer, index) => {
      const option = document.createElement('div');
      option.className = 'customer-option';
      option.id = list.id + '-' + index;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      const title = document.createElement('strong');
      title.textContent = customer.name;
      const sub = document.createElement('small');
      sub.textContent = customer.saved ? [customer.org_number, customer.city, customer.invoice_email || customer.email].filter(Boolean).join(' · ') || 'Lagret kunde' : 'Fra tidligere ordre';
      option.append(title, sub);
      option.onmousedown = event => event.preventDefault();
      option.onclick = () => select(customer);
      list.append(option);
    });
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
  }
  input.addEventListener('input', () => render());
  input.addEventListener('focus', () => render());
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Enter' && active >= 0 && !list.classList.contains('hidden')) {
      event.preventDefault(); select(matches[active]); return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    if (list.classList.contains('hidden')) render();
    if (!matches.length) return;
    active = event.key === 'ArrowDown' ? (active + 1) % matches.length : (active <= 0 ? matches.length - 1 : active - 1);
    list.querySelectorAll('[role=option]').forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === active));
      if (index === active) { input.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); }
    });
  });
  field.addEventListener('focusout', event => { if (!field.contains(event.relatedTarget)) close(); });
  toggle.onmousedown = event => event.preventDefault();
  toggle.onclick = () => {
    if (!list.classList.contains('hidden')) { close(); return; }
    input.focus(); render(true);
  };
  customerPickers.set(input, { refresh: () => { if (!list.classList.contains('hidden')) render(); }, close });
}

function installCustomerForm() {
  const modal = document.createElement('div');
  modal.id = 'customerModal';
  modal.className = 'modal hidden';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'customerModalTitle');
  modal.innerHTML = `<div class="card"><div class="toolbar"><h2 id="customerModalTitle" style="margin:0">Ny kunde</h2><button class="btn white" id="closeCustomer" type="button">Lukk</button></div><p class="muted">Kunden lagres i kunderegisteret og kan velges på nye ordrer.</p><div id="customerMessage" role="status" aria-live="polite"></div><form id="customerForm"><div class="grid"><label>Kundenavn<input name="name" required maxlength="200" autocomplete="organization"></label><label>Organisasjonsnummer<input name="org_number" maxlength="40"></label><label>Faktura-e-post<input name="invoice_email" type="email" maxlength="254"></label><label>Adresse<input name="address" maxlength="300" autocomplete="street-address"></label><label>Postnummer<input name="postal_code" maxlength="20" autocomplete="postal-code"></label><label>Poststed<input name="city" maxlength="100" autocomplete="address-level2"></label><label>Kontaktperson<input name="contact_name" maxlength="200"></label><label>Telefon<input name="phone" type="tel" maxlength="50"></label><label>E-post<input name="email" type="email" maxlength="254"></label></div><label style="margin-top:12px">Merknad<textarea name="notes" maxlength="2000"></textarea></label><div class="actions" style="margin-top:16px"><button class="btn blue" id="saveCustomer" type="submit">Lagre og velg kunde</button><button class="btn white" id="cancelCustomer" type="button">Avbryt</button></div></form></div>`;
  document.body.append(modal);
  $('closeCustomer').onclick = $('cancelCustomer').onclick = closeCustomerForm;
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeCustomerForm(); }
    if (event.key !== 'Tab') return;
    const items = [...modal.querySelectorAll('input,textarea,button')].filter(el => !el.disabled);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  $('customerForm').onsubmit = saveCustomer;
}

function openCustomerForm(input = $('customer')) {
  if (!me || !['admin', 'dispatcher'].includes(me.role)) return;
  customerTarget = input;
  customerReturnFocus = document.activeElement;
  customerPickers.forEach(picker => picker.close());
  $('customerForm').reset();
  $('customerForm').elements.name.value = input?.value.trim() || '';
  note($('customerMessage'), '');
  $('customerModal').classList.remove('hidden');
  $('customerForm').elements.name.focus();
}

function closeCustomerForm() {
  if ($('saveCustomer').disabled) return;
  $('customerModal').classList.add('hidden');
  customerReturnFocus?.focus();
}

async function saveCustomer(event) {
  event.preventDefault();
  const button = $('saveCustomer');
  if (button.disabled || !me || !['admin', 'dispatcher'].includes(me.role)) return;
  const values = Object.fromEntries([...new FormData(event.target)].map(([key, value]) => [key, value.trim() || null]));
  if (!values.name) { note($('customerMessage'), 'Skriv inn kundenavn.', true); return; }
  button.disabled = true;
  button.textContent = 'Lagrer…';
  try {
    const latest = await fetchAllRows('customers', 'id');
    if (latest.error) throw latest.error;
    customers = latest.data;
    const existing = customers.find(c => normalizeCustomer(c.name) === normalizeCustomer(values.name) || (values.org_number && c.org_number && c.org_number.replace(/\s/g, '') === values.org_number.replace(/\s/g, '')));
    let customer = existing;
    if (!customer) {
      const { data, error } = await s.from('customers').insert(values).select('*').single();
      if (error) throw error;
      customer = data;
      customers.push(customer);
    }
    if (customerTarget) { customerTarget.value = customer.name; customerTarget.dispatchEvent(new Event('change', { bubbles: true })); }
    await loadRegisters();
    refreshOrderTools();
    button.disabled = false;
    closeCustomerForm();
    note($('msg'), existing ? 'Kunden finnes allerede og er valgt: ' + customer.name : 'Kunden er lagret og valgt: ' + customer.name);
  } catch (error) {
    note($('customerMessage'), 'Kunden kunne ikke lagres: ' + (error.message || 'Prøv igjen.'), true);
  } finally {
    button.disabled = false;
    button.textContent = 'Lagre og velg kunde';
  }
}

function osloDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function reportOrders(source = orders, options = reportOptions()) {
  return source.filter(order => {
    if (options.month && !osloDate(order.created_at).startsWith(options.month)) return false;
    if (options.customer && normalizeCustomer(order.customer) !== options.customer) return false;
    if (options.scope === 'unbilled') return !order.customer_invoice_sent;
    if (options.scope === 'billing') return order.carrier_invoice_received && !order.customer_invoice_sent;
    if (options.scope === 'done') return !!order.customer_invoice_sent;
    return true;
  }).sort((a, b) => String(a.customer || '').localeCompare(String(b.customer || ''), 'nb') || Number(a.order_number) - Number(b.order_number));
}

function reportOptions() {
  return { month: $('month').value, scope: $('reportScope').value, customer: $('reportCustomer').value };
}

function hasPrice(order) { return order.customer_price !== null && order.customer_price !== undefined && order.customer_price !== '' && Number.isFinite(Number(order.customer_price)); }

function updateReportSummary() {
  const list = reportOrders();
  const total = list.reduce((sum, order) => sum + Number(order.customer_price || 0), 0);
  const missing = list.filter(order => !hasPrice(order)).length;
  $('reportSummary').textContent = list.length + ' ordre · Sum registrert salgspris: ' + nok(total) + (missing ? ' · ' + missing + ' ordre mangler salgspris.' : '') + (list.length ? '' : ' Velg et annet utvalg eller en annen måned.');
}

function refreshOrderTools() {
  customerPickers.forEach((picker, input) => {
    if (!input.isConnected) customerPickers.delete(input); else picker.refresh();
  });
  const selected = $('reportCustomer').value;
  $('reportCustomer').replaceChildren(new Option('Alle kunder', ''));
  customerChoices().forEach(c => $('reportCustomer').add(new Option(c.name, normalizeCustomer(c.name))));
  if ([...$('reportCustomer').options].some(option => option.value === selected)) $('reportCustomer').value = selected;
  updateReportSummary();
}

function loadExcelLibrary() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!excelLibraryPromise) excelLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/exceljs-4.4.0.min.js';
    script.onload = () => { if (window.ExcelJS) resolve(window.ExcelJS); else { excelLibraryPromise = null; reject(new Error('Excel-modulen kunne ikke lastes.')); } };
    script.onerror = () => { script.remove(); excelLibraryPromise = null; reject(new Error('Excel-modulen kunne ikke lastes. Prøv igjen.')); };
    document.head.append(script);
  });
  return excelLibraryPromise;
}

function dateCell(value) {
  const date = osloDate(value);
  return date ? new Date(date + 'T00:00:00Z') : null;
}

function buildInvoiceWorkbook(ExcelJS, list, register, options) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GNS Cargo AS';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Fakturagrunnlag');
  const headings = ['GNS-referanse', 'Kunde', 'Kundereferanse', 'Hentedato', 'Leveringsdato', 'Hentested', 'Leveringssted', 'Gods', 'Paller', 'Nettovekt (kg)', 'Salgspris (NOK)', 'Fakturastatus'];
  const scopeLabels = { unbilled: 'Ikke fakturert', billing: 'Til fakturering – transportørfaktura mottatt', all: 'Alle ordre', done: 'Ferdig fakturert' };
  const missing = list.filter(order => !hasPrice(order)).length;
  sheet.mergeCells('A1:L1');
  sheet.getCell('A1').value = 'GNS CARGO AS – FAKTURAGRUNNLAG';
  sheet.getRow(1).height = 30;
  sheet.getCell('A1').font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FF071B31' } };
  sheet.mergeCells('A2:L2');
  sheet.getCell('A2').value = 'Opprettet måned: ' + (options.month || 'Alle') + ' | ' + scopeLabels[options.scope] + ' | ' + list.length + ' ordre | Lastet ned ' + osloDate(new Date());
  sheet.mergeCells('A3:L3');
  sheet.getCell('A3').value = 'Salgspris hentes fra ordren. Mva beregnes i fakturasystemet.' + (missing ? ' ' + missing + ' ordre mangler salgspris – kontroller de gule feltene.' : '');
  sheet.getCell('A3').font = { italic: true, color: { argb: missing ? 'FF805600' : 'FF536273' }, size: 11 };
  sheet.getRow(4).values = headings;
  const priceFormat = '#,##0.00 "NOK"';
  list.forEach(order => {
    const row = sheet.addRow([
      'GNS-' + order.order_number, order.customer || '', order.customer_reference || '', dateCell(order.pickup_date || order.pickup_at), dateCell(order.delivery_at),
      order.pickup_name || '', order.delivery_name || '', order.goods || '', order.pallets == null ? null : Number(order.pallets),
      order.weight_kg == null ? null : Number(order.weight_kg), hasPrice(order) ? Number(order.customer_price) : null,
      order.customer_invoice_sent ? 'Fakturert' : order.carrier_invoice_received ? 'Til fakturering' : 'Venter transportørfaktura'
    ]);
    row.getCell(4).numFmt = row.getCell(5).numFmt = 'dd.mm.yyyy';
    row.getCell(9).numFmt = '0';
    row.getCell(10).numFmt = '#,##0.0';
    row.getCell(11).numFmt = priceFormat;
    row.height = 32;
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { name: 'Calibri', size: 11 };
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (row.number % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F6FB' } };
    });
    if (!hasPrice(order)) row.getCell(11).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE6A3' } };
  });
  const lastDataRow = list.length + 4;
  const totalRow = sheet.getRow(lastDataRow + 2);
  totalRow.getCell(2).value = 'SUM SALGSPRIS';
  totalRow.getCell(11).value = { formula: `SUBTOTAL(109,K5:K${lastDataRow})`, result: list.reduce((sum, o) => sum + Number(o.customer_price || 0), 0) };
  totalRow.getCell(11).numFmt = priceFormat;
  totalRow.font = { bold: true, name: 'Calibri', size: 12 };
  [20, 30, 24, 15, 15, 27, 27, 23, 11, 18, 21, 30].forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  styleReportSheet(sheet, 4, 12, lastDataRow);

  const customerSheet = workbook.addWorksheet('Kundedetaljer');
  customerSheet.addRow(['Kunde', 'Organisasjonsnummer', 'Faktura-e-post', 'Adresse', 'Postnummer', 'Poststed', 'Kontaktperson', 'Telefon', 'E-post']);
  const usedNames = new Map();
  list.forEach(order => usedNames.set(normalizeCustomer(order.customer), order.customer || ''));
  [...usedNames].forEach(([key, name]) => {
    const customer = register.find(c => normalizeCustomer(c.name) === key) || {};
    customerSheet.addRow([name, customer.org_number || '', customer.invoice_email || '', customer.address || '', customer.postal_code || '', customer.city || '', customer.contact_name || '', customer.phone || '', customer.email || '']);
  });
  [32, 24, 36, 38, 16, 22, 28, 22, 36].forEach((width, i) => { customerSheet.getColumn(i + 1).width = width; });
  customerSheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.eachCell(cell => { cell.font = { name: 'Calibri', size: 11 }; cell.alignment = { wrapText: true, vertical: 'middle' }; });
  });
  styleReportSheet(customerSheet, 1, 9, usedNames.size + 1);
  return workbook;
}

function styleReportSheet(sheet, headerRow, columns, lastRow) {
  sheet.getRow(headerRow).height = 32;
  sheet.getRow(headerRow).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF071B31' } };
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastRow, column: columns } };
  sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headerRow}:${headerRow}` };
}

async function exportInvoiceExcel() {
  const button = $('invoiceExcel');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Lager Excel…';
  note($('reportMessage'), '');
  const options = reportOptions();
  try {
    const [ExcelJS, orderResult, customerResult] = await Promise.all([loadExcelLibrary(), fetchAllRows('orders', 'order_number'), fetchAllRows('customers', 'id')]);
    if (orderResult.error) throw orderResult.error;
    if (customerResult.error) throw customerResult.error;
    const list = reportOrders(orderResult.data, options);
    if (!list.length) { note($('reportMessage'), 'Ingen ordre i dette utvalget. Velg en annen måned, kunde eller status.'); return; }
    const workbook = buildInvoiceWorkbook(ExcelJS, list, customerResult.data, options);
    const bytes = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'GNS_Fakturagrunnlag_' + (options.month || 'alle-maneder') + '_' + options.scope + '.xlsx';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    note($('reportMessage'), 'Excel-rapporten er lastet ned med ' + list.length + ' ordre. Fakturastatus er uendret.');
  } catch (error) {
    note($('reportMessage'), 'Rapporten kunne ikke lastes ned: ' + (error.message || 'Prøv igjen.'), true);
  } finally {
    button.disabled = false;
    button.textContent = 'Last ned Excel';
  }
}

installCustomerForm();
enhanceOrderFields();
for (const form of [$('form'), $('editForm')]) new MutationObserver(enhanceOrderFields).observe(form, { childList: true, subtree: true });
$('editStops').addEventListener('change', enhanceOrderFields);
$('newCustomerRegister').onclick = () => openCustomerForm($('customer'));
['month', 'reportScope', 'reportCustomer'].forEach(id => $(id).addEventListener('change', updateReportSummary));
$('invoiceExcel').onclick = exportInvoiceExcel;
refreshOrderTools();
