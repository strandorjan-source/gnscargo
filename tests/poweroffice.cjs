'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
(async () => {
  const { pricing, draftPayload, invoiceState, PowerOffice } = await import('../supabase/functions/poweroffice/core.mjs');
  const { handleRequest } = await import('../supabase/functions/poweroffice/handler.mjs');
  const order = { id: '00000000-0000-4000-8000-000000000123', order_number: 800123, revision: 1, reference: 'GNS-TEST', carrier_invoice_received: false, customer: 'Testkunde', customer_reference: 'KUNDEREF', pickup_date: '2026-10-12', pickup_name: 'TEST Bodø', delivery_name: 'TEST Oslo', customer_base_price: 40000, customer_diesel_percent: 9, customer_diesel_amount: 3600, customer_price: 43600, carrier_price: 35000, pickup_phone: 'INTERNAL PHONE', instructions: 'PRIVATE' };
  const selection = { customerId: 10, freightProductId: 20, dieselProductId: 21 };
  const payload = draftPayload(order, selection, 'demo');
  assert.equal(payload.ExternalImportReference, 'GNS-demo-' + order.id);
  const productionRef = draftPayload(order, selection, 'production').ExternalImportReference;
  assert.equal(productionRef, 'GNS-prod-' + order.id);
  assert(productionRef.length <= 50);
  assert.equal(payload.SalesOrderStatus, 'Draft'); assert.equal(payload.SalesOrderLines.length, 2);
  assert.equal(payload.SalesOrderLines[0].ProductUnitPrice, 40000); assert.equal(payload.SalesOrderLines[1].ProductUnitPrice, 3600);
  assert.equal(payload.CustomerReference, 'KUNDEREF'); assert.equal(payload.SalesOrderDate, '2026-10-12');
  for (const ref of [null, undefined, '', '  \t']) {
    assert.throws(() => draftPayload({ ...order, customer_reference: ref }, selection, 'production'), /kundereferans/i);
  }
  const longRef = 'PO-' + '7'.repeat(101);
  assert.equal(draftPayload({ ...order, customer_reference: '  ' + longRef + '  ' }, selection, 'production').CustomerReference, longRef);
  assert.ok(!JSON.stringify(payload).includes('35000')); assert.ok(!JSON.stringify(payload).includes('PRIVATE')); assert.ok(!JSON.stringify(payload).includes('INTERNAL PHONE'));
  assert.throws(() => draftPayload({ ...order, customer_invoice_sent: true }, selection, 'demo'));
  assert.throws(() => draftPayload({ ...order, status: 'cancelled' }, selection, 'demo'));
  assert.throws(() => pricing({ ...order, customer_price: 43601 }));
  assert.throws(() => pricing({ ...order, customer_base_price: null }));
  assert.equal(pricing({ customer_price: 100, customer_diesel_percent: 0 }).base, 100);
  assert.equal(pricing({ customer_price: 0.06, customer_base_price: 0.05, customer_diesel_percent: 10, customer_diesel_amount: 0.01 }).diesel, 0.01);
  assert.equal(pricing({ customer_base_price:32008.50, customer_diesel_percent:7, customer_diesel_amount:2240.60, customer_price:34249.10 }).total,34249.10);
  for (const [balance, total, state] of [[null, 100, 'invoiced'], [100, 100, 'invoiced'], [30, 100, 'partially_paid'], [0, 100, 'paid'], [-5, 100, 'overpaid']]) assert.equal(invoiceState({ Balance: balance, TotalPostedAmount: total, InvoiceNo: 1 }).state, state);
  assert.equal(invoiceState({ IsReversed: true, Balance: 0, InvoiceNo: 1 }).state, 'reversed');
  let exported, draft, count = 0, role = 'dispatcher', validUser = true, simulateLostResponse = false;
  const config = { environment: 'demo', applicationKey: 'dummy', clientKey: 'dummy', subscriptionKey: 'dummy' };
  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const rejected = new PowerOffice(config, async () => ok({ title: 'Validation failed', errors: { Reference: ['Reference too long.'] } }, 400));
  rejected.token = 'fixture';
  await assert.rejects(() => rejected.request('/SalesOrders/Complete', 'POST', {}), /Reference too long/);
  const nestedError = new PowerOffice(config, async () => ok({ detail: JSON.stringify([{ ErrorMessage: 'Maximum 50 characters.', AttemptedValue: 'PRIVATE FIXTURE' }]) }, 400));
  nestedError.token = 'fixture';
  await assert.rejects(() => nestedError.request('/SalesOrders/Complete', 'POST', {}), error => error.message.includes('Maximum 50') && !error.message.includes('PRIVATE'));
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
  config.environment = 'production';
  assert.equal((await invoke(create)).status, 409);
  assert.equal((await invoke({ ...create, expectedEnvironment: 'demo' })).status, 409);
  assert.equal((await invoke({ action: 'sync', orderId: order.id })).status, 409);
  assert.equal(count, 0);
  config.environment = 'demo';
  assert.equal((await invoke({ ...create, expectedEnvironment: 'production' })).status, 409);
  order.customer_reference = '   ';
  assert.equal((await invoke({ ...create, CustomerReference: 'BROWSER-OVERRIDE' })).status, 400);
  assert.equal(count, 0);
  assert.equal(exported, undefined);
  order.customer_reference = 'KUNDEREF';
  simulateLostResponse = true;
  assert.equal((await invoke(create)).status, 502); assert.equal(exported.state, 'uncertain'); assert.equal(count, 1);
  assert.equal((await invoke(create)).status, 200); assert.equal(exported.state, 'draft'); assert.equal(count, 1);
  assert.equal(exported.payload.SalesOrderLines[0].ProductUnitPrice, 40000, 'Browser price cannot override database price');
  assert.equal((await invoke(create)).data.alreadyExists, true); assert.equal(count, 1);
  assert.equal((await invoke({ action: 'sync', orderId: order.id })).data.export.state, 'draft');

  draft.NetAmount = 43599;
  const sync = async () => (await invoke({ action:'sync',orderId:order.id })).data.export;
  const warning=(await sync()).error_message;assert.match(warning,/avviker/);
  delete draft.NetAmount;assert.equal((await sync()).error_message,warning);
  draft.NetAmount=43599;assert.equal((await sync()).error_message,warning);
  draft.NetAmount=43600;assert.equal((await sync()).error_message,null);

  const originalDraft=draft;
  draft=null;exported.state='uncertain';
  assert.equal((await invoke({...create,customerId:11})).status,409);
  assert.equal(count,1);
  draft=originalDraft;await sync();

  // A former failed snapshot may be missing its buyer reference. Reconcile
  // first, then replace just the reference before retrying the same export.
  draft = null;
  exported.state = 'uncertain';
  exported.payload.CustomerReference = '';
  const initialExternalRef = exported.external_reference;
  assert.equal((await invoke(create)).status, 409);
  assert.equal(count, 1);
  assert.equal((await sync()).state, 'missing');
  assert.equal((await invoke(create)).status, 200);
  assert.equal(draft.CustomerReference, 'KUNDEREF');
  assert.equal(exported.payload.CustomerReference, 'KUNDEREF');
  assert.equal(exported.external_reference, initialExternalRef);
  assert.equal(count, 2);

  // Real DOM event handlers with the same module shipped to Cargo.
  const dom = new JSDOM('<section><input id="month"><select id="reportScope"><option value="billing">Til fakturering</option></select><select id="reportCustomer"></select><div id="reportSummary"></div></section>', { runScripts: 'outside-only' });
  const w = dom.window; let calls = [];
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.testOrders=[{...order},{...order,id:'zz-older',order_number:800099}];
  const prior=Array.from({length:205},(_,i)=>({...exported,order_id:'prior-'+String(i).padStart(3,'0')}));
  prior.push({...exported,order_id:'zz-older'});
  const prelude = `const orders=window.testOrders, customers=[]; const $=id=>document.getElementById(id); const esc=v=>String(v??'').replaceAll('<','&lt;'); const nok=v=>String(v); const fmt=v=>v||'—'; const normalizeCustomer=v=>String(v||'').toLowerCase(); const reportOrders=()=>orders; const readyForCustomerInvoice=o=>!o.customer_invoice_sent && o.status!=="cancelled"; function updateReportSummary(){} const reportLoadingDate=o=>o.pickup_date; const customerReportPricing=o=>({base:o.customer_base_price,diesel:o.customer_diesel_amount}); function note(el,t){el.textContent=t;}`;
  w.s = { functions: { invoke: async (_, { body }) => {
    calls.push(body);
    return { data: body.action === 'options' ? { environment: 'demo', customers: [{ id: 10, number: 1, name: 'Testkunde' }, {id:11, number:2, name:'Ny kunde'}], products: [{ id: 20, code: 'F', name: 'Frakt' }, { id: 21, code: 'D', name: 'Diesel' }] } : { export: exported } };
  } }, from: () => {
    let after='', limit=0;
    const q={select:()=>q,eq:()=>q,order:()=>q,limit:n=>{limit=n;return q;},gt:(_,value)=>{after=value;return q;},
      then:resolve=>{const rows=calls.some(x=>x.action==='create')?[exported,...prior]:prior;
        resolve({data:rows.filter(row=>row.order_id>after).slice(0,limit)});}};
    return q;
  } };
  w.eval(prelude + fs.readFileSync(path.join(root, 'poweroffice.js'), 'utf8'));
  await w.openBillingDraft(order.id);
  assert.equal(w.document.getElementById('poOrder').value, order.id);
  assert.equal(w.document.getElementById('reportScope').value, 'billing');
  assert.deepEqual(calls.map(c=>c.action), ['options']);
  assert.match(w.document.getElementById('poEnvironment').textContent, /TESTMILJØ/);
  w.document.getElementById('poOrder').value = order.id; w.document.getElementById('poOrder').onchange();
  assert.equal(w.document.getElementById('poCustomer').value, '10');
  w.document.getElementById('poFreight').value = '20'; w.document.getElementById('poDiesel').value = '21';
  const chooseOrder=id=>{const select=w.document.getElementById('poOrder');select.value=id;select.onchange();};
  chooseOrder('zz-older');
  assert.equal(w.document.getElementById('poSync').disabled,false);
  assert.equal(w.document.getElementById('poCreate').disabled,true);
  chooseOrder(order.id);
  const referenceDetails=w.document.getElementById('poReference');
  assert.match(referenceDetails.textContent,/Kundereferanse: KUNDEREF/);
  w.testOrders[0].customer_reference='  ';w.refreshPowerOffice();
  assert(w.document.getElementById('poCreate').disabled);assert.match(referenceDetails.textContent,/Kundereferanse mangler/);
  w.testOrders[0].customer_reference='PO-007';w.refreshPowerOffice();
  assert.equal(w.document.getElementById('poCreate').disabled,false);assert.match(referenceDetails.textContent,/PO-007/);
  const buyer=w.document.getElementById('poCustomer');
  buyer.value='11';w.refreshPowerOffice();assert.equal(buyer.value,'11','same buyer preserves a manual selection');
  buyer.value='10';w.testOrders[0].customer='Ukjent kunde';w.testOrders[0].revision++;
  w.refreshPowerOffice();assert.equal(buyer.value,'');assert(w.document.getElementById('poCreate').disabled);
  w.testOrders[0].customer='Ny kunde';w.testOrders[0].revision++;w.refreshPowerOffice();
  assert.equal(buyer.value,'11');
  await w.document.getElementById('poCreate').onclick();
  assert.equal(calls.at(-1).expectedEnvironment,'demo');assert.equal(calls.at(-1).customerId,11);assert.equal(calls.at(-1).expectedRevision,3);
  assert.equal(calls.at(-1).orderId, order.id); assert.ok(w.document.getElementById('poCreate').disabled);
  await w.document.getElementById('poSync').onclick(); assert.equal(calls.at(-1).action, 'sync');assert.equal(calls.at(-1).expectedEnvironment,'demo');
  dom.window.close();
  console.log('PASS: PowerOffice pricing/privacy, draft-only payload, authorization, stale revisions, idempotency after lost response, invoice states and Cargo DOM flow');
})().catch(error => { console.error(error); process.exit(1); });
