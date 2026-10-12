'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
(async () => {
  const { pricing, draftPayload, invoiceState } = await import('../supabase/functions/poweroffice/core.mjs');
  const { handleRequest } = await import('../supabase/functions/poweroffice/handler.mjs');
  const order = { id: '00000000-0000-4000-8000-000000000123', order_number: 800123, revision: 1, reference: 'GNS-TEST', customer: 'Testkunde', customer_reference: 'KUNDEREF', pickup_date: '2026-10-12', pickup_name: 'TEST Bodø', delivery_name: 'TEST Oslo', customer_base_price: 40000, customer_diesel_percent: 9, customer_diesel_amount: 3600, customer_price: 43600, carrier_price: 35000, pickup_phone: 'INTERNAL PHONE', instructions: 'PRIVATE' };
  const selection = { customerId: 10, freightProductId: 20, dieselProductId: 21 };
  const payload = draftPayload(order, selection, 'demo');
  assert.equal(payload.SalesOrderStatus, 'Draft'); assert.equal(payload.SalesOrderLines.length, 2);
  assert.equal(payload.SalesOrderLines[0].ProductUnitPrice, 40000); assert.equal(payload.SalesOrderLines[1].ProductUnitPrice, 3600);
  assert.equal(payload.CustomerReference, 'KUNDEREF'); assert.equal(payload.SalesOrderDate, '2026-10-12');
  assert.ok(!JSON.stringify(payload).includes('35000')); assert.ok(!JSON.stringify(payload).includes('PRIVATE')); assert.ok(!JSON.stringify(payload).includes('INTERNAL PHONE'));
  assert.throws(() => draftPayload({ ...order, customer_invoice_sent: true }, selection, 'demo'));
  assert.throws(() => draftPayload({ ...order, status: 'cancelled' }, selection, 'demo'));
  assert.throws(() => pricing({ ...order, customer_price: 43601 }));
  assert.throws(() => pricing({ ...order, customer_base_price: null }));
  assert.equal(pricing({ customer_price: 100, customer_diesel_percent: 0 }).base, 100);
  assert.equal(pricing({ customer_price: 0.06, customer_base_price: 0.05, customer_diesel_percent: 10, customer_diesel_amount: 0.01 }).diesel, 0.01);
  for (const [balance, total, state] of [[null, 100, 'invoiced'], [100, 100, 'invoiced'], [30, 100, 'partially_paid'], [0, 100, 'paid'], [-5, 100, 'overpaid']]) assert.equal(invoiceState({ Balance: balance, TotalPostedAmount: total, InvoiceNo: 1 }).state, state);
  assert.equal(invoiceState({ IsReversed: true, Balance: 0, InvoiceNo: 1 }).state, 'reversed');
  let exported, draft, count = 0, role = 'dispatcher', validUser = true, simulateLostResponse = false;
  const config = { environment: 'demo', applicationKey: 'dummy', clientKey: 'dummy', subscriptionKey: 'dummy' };
  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url); const p = u.pathname; const body = init.body ? JSON.parse(init.body === 'grant_type=client_credentials' ? '{}' : init.body) : {};
    if (p === '/auth/v1/user') return ok({ id: 'staff' }, validUser ? 200 : 401);
    if (p.endsWith('/rpc/current_user_role')) return ok(role);
    if (p.endsWith('/rpc/poweroffice_config')) return ok(config);
    if (p.endsWith('/orders')) return ok([order]);
    if (p.endsWith('/poweroffice_exports')) { if (init.method === 'PATCH') Object.assign(exported, body); return ok(exported ? [exported] : []); }
    if (p.endsWith('/rpc/poweroffice_claim_export')) {
      if (exported?.state === 'creating') return ok({ claimed: false });
      exported ||= { order_id: order.id, environment: 'demo', state: 'creating', payload: body.p_snapshot, external_reference: body.p_snapshot.ExternalImportReference, source_revision: 1 };
      exported.state = 'creating'; return ok({ claimed: true, row: exported });
    }
    if (p.endsWith('/OAuth/Token')) return ok({ access_token: 'fake-token' });
    if (p.endsWith('/OutgoingInvoices')) return ok([]);
    if (p.endsWith('/SalesOrders')) return ok(draft ? [draft] : []);
    if (p.endsWith('/SalesOrders/Complete')) {
      count++; draft = { Id: 'PO-DRAFT', SalesOrderNo: 123, NetAmount: 43600, ...body };
      if (simulateLostResponse) { simulateLostResponse = false; throw new Error('network interrupted after provider accepted'); }
      return ok(draft, 201);
    }
    if (/\/(Products|Customers)\/\d+$/.test(p)) return ok({ Id: Number(p.split('/').at(-1)) });
    throw new Error('Unexpected request ' + url);
  };
  const invoke = async (body, auth = 'Bearer TEST') => {
    const r = await handleRequest(new Request('https://cargo.invalid', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { url: 'https://db.invalid', anonKey: 'anon', serviceKey: 'service' }, fakeFetch);
    return { status: r.status, data: await r.json() };
  };
  const create = { action: 'create', orderId: order.id, expectedRevision: 1, ...selection, customer_price: 1 };
  assert.equal((await invoke(create, '')).status, 401);
  validUser = false; assert.equal((await invoke(create)).status, 401); validUser = true;
  role = 'carrier'; assert.equal((await invoke(create)).status, 403); role = 'dispatcher';
  assert.equal((await invoke({ ...create, expectedRevision: 99 })).status, 409);
  simulateLostResponse = true;
  assert.equal((await invoke(create)).status, 502); assert.equal(exported.state, 'uncertain'); assert.equal(count, 1);
  assert.equal((await invoke(create)).status, 200); assert.equal(exported.state, 'draft'); assert.equal(count, 1);
  assert.equal(exported.payload.SalesOrderLines[0].ProductUnitPrice, 40000, 'Browser price cannot override database price');
  assert.equal((await invoke(create)).data.alreadyExists, true); assert.equal(count, 1);
  assert.equal((await invoke({ action: 'sync', orderId: order.id })).data.export.state, 'draft');

  // Real DOM event handlers with the same module shipped to Cargo.
  const dom = new JSDOM('<section><input id="month"><select id="reportScope"></select><select id="reportCustomer"></select><div id="reportSummary"></div></section>', { runScripts: 'outside-only' });
  const w = dom.window; let calls = [];
  const prelude = `const orders=${JSON.stringify([order])}, customers=[]; const $=id=>document.getElementById(id); const esc=v=>String(v??'').replaceAll('<','&lt;'); const nok=v=>String(v); const fmt=v=>v||'—'; const normalizeCustomer=v=>String(v||'').toLowerCase(); const reportOrders=()=>orders; const reportLoadingDate=o=>o.pickup_date; const customerReportPricing=o=>({base:o.customer_base_price,diesel:o.customer_diesel_amount}); function note(el,t){el.textContent=t;}`;
  w.s = { functions: { invoke: async (_, { body }) => {
    calls.push(body);
    return { data: body.action === 'options' ? { environment: 'demo', customers: [{ id: 10, number: 1, name: 'Testkunde' }], products: [{ id: 20, code: 'F', name: 'Frakt' }, { id: 21, code: 'D', name: 'Diesel' }] } : { export: exported } };
  } }, from: () => { const q = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: calls.some(x => x.action === 'create') ? [exported] : [] }) }; return q; } };
  w.eval(prelude + fs.readFileSync(path.join(root, 'poweroffice.js'), 'utf8'));
  await w.document.getElementById('poConnect').onclick();
  assert.match(w.document.getElementById('poEnvironment').textContent, /TESTMILJØ/);
  w.document.getElementById('poOrder').value = order.id; w.document.getElementById('poOrder').onchange();
  assert.equal(w.document.getElementById('poCustomer').value, '10');
  w.document.getElementById('poFreight').value = '20'; w.document.getElementById('poDiesel').value = '21';
  await w.document.getElementById('poCreate').onclick();
  assert.equal(calls.at(-1).orderId, order.id); assert.ok(w.document.getElementById('poCreate').disabled);
  await w.document.getElementById('poSync').onclick(); assert.equal(calls.at(-1).action, 'sync');
  dom.window.close();
  console.log('PASS: PowerOffice pricing/privacy, draft-only payload, authorization, stale revisions, idempotency after lost response, invoice states and Cargo DOM flow');
})().catch(error => { console.error(error); process.exit(1); });
