'use strict';
// Explicit live demo test. Input JSON on hidden stdin; no credentials or tokens are saved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const url = 'https://lpovhfipxoeqqnfnipia.supabase.co';
const key = 'sb_publishable_7WEioWEeqiSNE1nSFXD8lg_zosjgsC_';
async function input() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('Ready for test configuration on hidden stdin.\n');
  return new Promise(resolve => { let text = ''; const read = data => { text += data; if (text.includes('\n')) { process.stdin.off('data', read); if (process.stdin.isTTY) process.stdin.setRawMode(false); process.stdin.pause(); resolve(JSON.parse(text.trim())); } }; process.stdin.on('data', read); process.stdin.resume(); });
}
(async () => {
  const cfg = await input();
  assert.equal(cfg.po.environment, 'demo');
  const { PowerOffice, field } = await import('../supabase/functions/poweroffice/core.mjs');
  const po = new PowerOffice(cfg.po);
  const request = async (path, body, token, method = 'POST') => {
    const r = await fetch(url + path, { method, headers: { apikey: key, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000) });
    const data = await r.json();
    if (!r.ok) throw new Error(`Cargo ${path.split('?')[0]} HTTP ${r.status}: ${data.error || data.message || 'Request failed'}`);
    return data;
  };
  const auth = await request('/auth/v1/token?grant_type=password', { email: cfg.tester.email, password: cfg.tester.password });
  const token = auth.access_token;
  console.log('PASS: authenticated temporary Cargo tester');
  const anonymous = await fetch(url + '/functions/v1/poweroffice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"options"}' });
  assert.equal(anonymous.status, 401);
  const secretDenied = await fetch(url + '/rest/v1/rpc/poweroffice_config', { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok([401, 403, 404].includes(secretDenied.status), 'User must never read PowerOffice secrets');
  console.log('PASS: anonymous function calls and authenticated secret reads blocked');
  const ref = 'GNS-INTEGRATION-TEST-20261012';
  let customer = (await po.list('/Customers?externalImportReference=' + ref))[0];
  if (!customer) customer = await po.request('/Customers', 'POST', { Name: 'GNS TEST – integrasjon (ikke fakturer)', ExternalImportReference: ref, IsPerson: false, InvoiceDeliveryType: 'Print', UseInvoiceFee: false, SendPaymentReminders: false, CurrencyCode: 'NOK' });
  async function product(code, name) {
    const found = (await po.list('/Products?codes=' + code))[0];
    return found || po.request('/Products', 'POST', { Code: code, Name: name, ProductType: 'Service', StandardSalesAccount: 3000, UnitOfMeasureCode: 'EA', UnitPrice: 0 });
  }
  const freight = await product('GNS-TEST-FRAKT', 'GNS test frakt');
  const diesel = await product('GNS-TEST-DIESEL', 'GNS test dieseltillegg');
  const order = await request('/rest/v1/rpc/save_cargo_order', {
    p_id: null, p_expected_revision: null, p_request_id: cfg.tester.orderId,
    p_order: { customer: 'GNS TEST – integrasjon (ikke fakturer)', customer_reference: 'TEST-POWERoffice-20261012', pickup_name: 'TEST Bodø', pickup_date: '2026-10-12', delivery_name: 'TEST Oslo', vehicle_registration: 'TEST-PO', customer_base_price: 40000, customer_diesel_percent: 9, customer_price: 43600, carrier_price: 35000, pickup_phone: 'INTERNAL-NOT-EXPORTED' },
    p_stops: [{ stop_type: 'pickup', stop_sequence: 1, name: 'TEST Bodø', planned_date: '2026-10-12' }]
  }, token);
  console.log('TEST_ORDER', JSON.stringify({ id: order.id, reference: order.reference, order_number: order.order_number }));
  const call = body => request('/functions/v1/poweroffice', body, token);
  const options = await call({ action: 'options' });
  assert.equal(options.environment, 'demo');
  assert.ok(options.customers.some(c => c.id === field(customer, 'Id')));
  console.log('PASS: deployed function reads demo customer and product selections');
  const dom = new JSDOM('<section><input id="month"><select id="reportScope"></select><select id="reportCustomer"></select><div id="reportSummary"></div></section>', { runScripts: 'outside-only' });
  const w = dom.window; let lastExport;
  const prelude = `const orders=${JSON.stringify([order])},customers=[];const $=id=>document.getElementById(id);const esc=v=>String(v??'').replaceAll('<','&lt;');const nok=v=>String(v);const fmt=v=>v||'—';const normalizeCustomer=v=>String(v||'').toLowerCase();const reportOrders=()=>orders;const reportLoadingDate=o=>o.pickup_date;const customerReportPricing=o=>({base:o.customer_base_price,diesel:o.customer_diesel_amount});function note(el,t){el.textContent=t;}`;
  w.s = { functions: { invoke: async (_, { body }) => { const data = await call(body); if (data.export) lastExport = data.export; return { data }; } }, from: () => {
    const q = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: await request('/rest/v1/poweroffice_exports?order_id=eq.' + order.id, undefined, token, 'GET') }) }; return q;
  } };
  w.eval(prelude + fs.readFileSync(require('node:path').join(__dirname, '../poweroffice.js'), 'utf8'));
  await w.document.getElementById('poConnect').onclick();
  w.document.getElementById('poOrder').value = order.id; w.document.getElementById('poOrder').onchange();
  w.document.getElementById('poCustomer').value = String(field(customer, 'Id'));
  w.document.getElementById('poFreight').value = String(field(freight, 'Id'));
  w.document.getElementById('poDiesel').value = String(field(diesel, 'Id'));
  await w.document.getElementById('poCreate').onclick();
  if (!lastExport) throw new Error(w.document.getElementById('poMessage').textContent);
  assert.equal(lastExport.state, 'draft');
  const remote = await po.request('/SalesOrders/' + lastExport.sales_order_id + '/Complete');
  assert.equal(field(remote, 'SalesOrderStatus'), 'Draft');
  assert.equal(field(remote, 'NetAmount'), 43600);
  const lines = field(remote, 'SalesOrderLines');
  assert.equal(lines.length, 2); assert.equal(field(lines[0], 'ProductUnitPrice'), 40000); assert.equal(field(lines[1], 'ProductUnitPrice'), 3600);
  assert.ok(!JSON.stringify(remote).includes('INTERNAL-NOT-EXPORTED'));
  const duplicate = await call({ action: 'create', orderId: order.id, expectedRevision: order.revision, customerId: field(customer, 'Id'), freightProductId: field(freight, 'Id'), dieselProductId: field(diesel, 'Id') });
  assert.equal(duplicate.alreadyExists, true); assert.equal(duplicate.export.sales_order_id, lastExport.sales_order_id);
  await w.document.getElementById('poSync').onclick();
  assert.match(w.document.getElementById('poHistory').textContent, /Utkast i PowerOffice/);
  const matches = await po.list('/SalesOrders?externalImportReferences=' + encodeURIComponent(lastExport.external_reference));
  assert.equal(matches.length, 1);
  console.log('PASS: Cargo UI handlers → deployed Edge Function → PowerOffice demo draft → Cargo database → UI status; duplicate request creates exactly one draft');
  console.log('RESULT', JSON.stringify({ orderId: order.id, draftId: lastExport.sales_order_id, draftNumber: lastExport.sales_order_number, net: field(remote, 'NetAmount'), total: field(remote, 'TotalAmount'), lineCount: lines.length, status: lastExport.state }));
  dom.window.close();
  await fetch(url + '/auth/v1/logout', { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + token } });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
