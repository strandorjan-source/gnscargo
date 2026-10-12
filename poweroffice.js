'use strict';
// Uses the signed-in Cargo session. API credentials are only available on the server.
const powerOffice = { options: null, exports: [], busy: false };
const powerOfficeLabels = { creating: 'Overføring pågår', draft: 'Utkast i PowerOffice', invoiced: 'Fakturert', paid: 'Betalt', partially_paid: 'Delvis betalt', overpaid: 'Til gode', reversed: 'Reversert', uncertain: 'Må kontrolleres', missing: 'Ikke funnet i PowerOffice' };

function installPowerOffice() {
  const panel = document.createElement('details');
  panel.id = 'powerOfficePanel';
  panel.innerHTML = '<summary><strong>PowerOffice – fakturautkast og betaling</strong></summary>' +
    '<p id="poEnvironment" class="muted">Last inn tilkoblingen for å se miljø, kunder og produkter.</p>' +
    '<button id="poConnect" type="button" class="btn white">Last inn PowerOffice</button>' +
    '<div id="poControls" class="hidden"><p>Velg en ordre fra rapportutvalget ovenfor. Frakt og diesel overføres som separate linjer. Kontroller kunde og produkter før overføring; produktene i PowerOffice bestemmer MVA. Utkastet kontrolleres og sendes manuelt i PowerOffice.</p>' +
    '<div class="report-controls"><label>Cargo-ordre<select id="poOrder"><option value="">Velg ordre</option></select></label>' +
    '<label>Kunde i PowerOffice<select id="poCustomer"><option value="">Velg kunde</option></select></label>' +
    '<label>Produkt for frakt<select id="poFreight"><option value="">Velg produkt</option></select></label>' +
    '<label>Produkt for dieseltillegg<select id="poDiesel"><option value="">Velg produkt</option></select></label></div>' +
    '<p id="poPreview"></p><div class="actions"><button id="poCreate" type="button" class="btn blue">Opprett fakturautkast</button>' +
    '<button id="poSync" type="button" class="btn white">Hent status fra PowerOffice</button></div></div>' +
    '<div id="poMessage" role="status" aria-live="polite"></div><div id="poHistory" style="overflow:auto"></div>';
  $('reportSummary').parentElement.append(panel);
  $('poConnect').onclick = async () => poAction(async () => {
    powerOffice.options = await poCall({ action: 'options' });
    const options = powerOffice.options;
    $('poEnvironment').textContent = options.environment === 'demo' ? 'TESTMILJØ – dette lager testutkast i PowerOffice-demo. Ingen ekte fakturaer opprettes.' : 'PowerOffice – produksjon. Utkast sendes manuelt fra PowerOffice.';
    $('poControls').classList.remove('hidden');
    $('poCustomer').replaceChildren(new Option('Velg kunde', ''));
    options.customers.forEach(c => $('poCustomer').add(new Option(`${c.number} · ${c.name}${c.org ? ' · ' + c.org : ''}`, c.id)));
    for (const id of ['poFreight', 'poDiesel']) {
      $(id).replaceChildren(new Option('Velg produkt', ''));
      options.products.forEach(p => $(id).add(new Option(`${p.code} · ${p.name}${p.account ? ' · konto ' + p.account : ''}`, p.id)));
    }
    await poLoadExports(); refreshPowerOffice();
  });
  $('poOrder').onchange = () => { poMatchCustomer(); poPreview(); };
  $('poCustomer').onchange = poPreview;
  $('poCreate').onclick = async () => poAction(async () => {
    const order = orders.find(o => o.id === $('poOrder').value);
    if (!order) throw new Error('Velg en Cargo-ordre.');
    const data = await poCall({ action: 'create', orderId: order.id, expectedRevision: order.revision, customerId: Number($('poCustomer').value), freightProductId: Number($('poFreight').value), dieselProductId: Number($('poDiesel').value) });
    await poLoadExports(); refreshPowerOffice();
    note($('poMessage'), data.export.error_message || (data.alreadyExists ? 'Ordren er allerede overført. Eksisterende utkast/status er hentet.' : 'Fakturautkast opprettet i PowerOffice. Kontroller utkastet der før fakturering.'), !!data.export.error_message);
  });
  $('poSync').onclick = async () => poAction(async () => {
    if (!$('poOrder').value) throw new Error('Velg en Cargo-ordre.');
    const result = await poCall({ action: 'sync', orderId: $('poOrder').value });
    await poLoadExports(); refreshPowerOffice();
    note($('poMessage'), result.export.error_message || 'Status er oppdatert fra PowerOffice.', !!result.export.error_message);
  });
  ['month', 'reportScope', 'reportCustomer'].forEach(id => $(id).addEventListener('change', refreshPowerOffice));
  s.auth?.onAuthStateChange((event) => {
    if (event !== 'SIGNED_OUT') return;
    powerOffice.options = null; powerOffice.exports = [];
    $('poControls').classList.add('hidden'); $('poHistory').replaceChildren();
    $('poMessage').replaceChildren(); $('powerOfficePanel').open = false;
    for (const id of ['poOrder','poCustomer','poFreight','poDiesel']) $(id).replaceChildren(new Option('Velg', ''));
  });
}
async function poCall(body) {
  const { data, error } = await s.functions.invoke('poweroffice', { body });
  if (error) {
    let message = 'Kunne ikke kontakte PowerOffice. Prøv igjen.';
    try { message = (await error.context.json()).error || message; } catch { /* Keep the safe fallback. */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
async function poAction(action) {
  if (powerOffice.busy) return;
  powerOffice.busy = true; $('powerOfficePanel').querySelectorAll('button,select').forEach(el => el.disabled = true);
  note($('poMessage'), 'Arbeider …');
  try { await action(); if ($('poMessage').textContent === 'Arbeider …') note($('poMessage'), 'PowerOffice er tilkoblet.'); }
  catch (e) { note($('poMessage'), e.message, true); }
  finally { powerOffice.busy = false; $('powerOfficePanel').querySelectorAll('button,select').forEach(el => el.disabled = false); poPreview(); }
}
async function poLoadExports() {
  const { data, error } = await s.from('poweroffice_exports').select('order_id,environment,state,sales_order_number,invoice_number,balance,invoice_total,source_revision,error_message,last_synced_at').eq('environment', powerOffice.options.environment).order('updated_at', { ascending: false }).limit(200);
  if (error) throw new Error('Kunne ikke hente overføringsstatus fra Cargo.');
  powerOffice.exports = data || [];
}
function refreshPowerOffice() {
  if (!powerOffice.options || !$('poOrder')) return;
  const selected = $('poOrder').value;
  $('poOrder').replaceChildren(new Option('Velg ordre', ''));
  for (const o of reportOrders()) $('poOrder').add(new Option(`${o.reference || o.order_number} · ${o.customer || ''} · ${reportLoadingDate(o)} · ${nok(o.customer_price)}`, o.id));
  if ([...$('poOrder').options].some(o => o.value === selected)) $('poOrder').value = selected;
  const visible = new Set(reportOrders().map(o => o.id));
  const rows = powerOffice.exports.filter(x => visible.has(x.order_id));
  $('poHistory').innerHTML = rows.length ? '<table><thead><tr><th>Ordre</th><th>Status</th><th>PO-ordre</th><th>Faktura</th><th>Restbeløp</th><th>Sist hentet</th></tr></thead><tbody>' + rows.map(x => {
    const order = orders.find(o => o.id === x.order_id);
    const changed = order && Number(order.revision) !== Number(x.source_revision);
    return '<tr><td>' + esc(order?.reference || order?.order_number) + '</td><td>' + esc(powerOfficeLabels[x.state] || x.state) + (changed ? '<br><small>Ordren er endret etter overføring. Kontroller utkastet.</small>' : '') + (x.error_message ? '<br><small>' + esc(x.error_message) + '</small>' : '') + '</td><td>' + esc(x.sales_order_number || '—') + '</td><td>' + esc(x.invoice_number || '—') + '</td><td>' + (x.balance == null ? '—' : esc(nok(x.balance))) + '</td><td>' + esc(fmt(x.last_synced_at)) + '</td></tr>';
  }).join('') + '</tbody></table>' : '<p class="muted">Ingen overførte ordre i dette rapportutvalget.</p>';
  poPreview();
}
function poMatchCustomer() {
  const order = orders.find(o => o.id === $('poOrder').value);
  const local = customers.find(c => normalizeCustomer(c.name) === normalizeCustomer(order?.customer));
  const normalizeOrg = value => String(value || '').replace(/\D/g, '');
  let matches = powerOffice.options.customers.filter(c => local?.org_number && normalizeOrg(c.org) === normalizeOrg(local.org_number));
  if (!matches.length) matches = powerOffice.options.customers.filter(c => normalizeCustomer(c.name) === normalizeCustomer(order?.customer));
  $('poCustomer').value = matches.length === 1 ? String(matches[0].id) : '';
}
function poPreview() {
  if (!$('poOrder')) return;
  const order = orders.find(o => o.id === $('poOrder').value);
  const exported = powerOffice.exports.find(x => x.order_id === order?.id);
  $('poCreate').disabled = powerOffice.busy || !order || order.status === 'cancelled' || order.customer_invoice_sent || !!exported;
  $('poSync').disabled = powerOffice.busy || !exported;
  // Uncertain transfers can only be retried with the original immutable payload.
  if (exported && ['uncertain', 'missing'].includes(exported.state) && !powerOffice.busy) $('poCreate').disabled = false;
  $('poPreview').textContent = order ? `Frakt: ${nok(customerReportPricing(order).base)} · Diesel: ${nok(customerReportPricing(order).diesel)} · Til kunde: ${nok(order.customer_price)} ekskl. MVA. ${exported ? powerOfficeLabels[exported.state] || exported.state : ''}` : '';
}
installPowerOffice();
