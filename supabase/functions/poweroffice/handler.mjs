import { IntegrationError, PowerOffice, draftPayload, field, invoiceState, money, withCustomerReference } from './core.mjs';

const draftMismatch = 'Utkastet er opprettet, men sum i PowerOffice avviker. Kontroller utkastet før fakturering.';
function draftState(draft, existing) {
  const id = field(draft, 'Id');
  if (!id) throw new IntegrationError('Uventet svar fra PowerOffice. Oppdater status før ny prøve.', 502);
  const expected = money(existing.payload.SalesOrderLines.filter(line => line.LineType !== 'Text').reduce((sum, line) => sum + line.ProductUnitPrice * line.Quantity, 0));
  const net = field(draft, 'NetAmount');
  const mismatch = net == null ? existing.error_message === draftMismatch : money(net) !== expected;
  return { state: 'draft', sales_order_id: id, sales_order_number: field(draft, 'SalesOrderNo'), error_message: mismatch ? draftMismatch : null };
}

export async function handleRequest(request, env, fetcher = fetch) {
  const origin = request.headers.get('Origin');
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (origin === 'https://gnscargo.vercel.app') headers['Access-Control-Allow-Origin'] = origin;
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
  if (origin && origin !== 'https://gnscargo.vercel.app') return reply({ error: 'Ukjent avsender.' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply({ error: 'Bruk POST.' }, 405);
  let claimed = null, db;
  try {
    const auth = request.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) throw new IntegrationError('Logg inn i Cargo.', 401);
    const userResult = await fetcher(env.url + '/auth/v1/user', { headers: { apikey: env.anonKey, Authorization: auth }, signal: AbortSignal.timeout(10000) });
    if (!userResult.ok) throw new IntegrationError('Logg inn i Cargo på nytt.', 401);
    const user = await userResult.json();
    const userDb = async (path, method = 'GET', body) => {
      const r = await fetcher(env.url + '/rest/v1/' + path, { method, headers: { apikey: env.anonKey, Authorization: auth, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new IntegrationError('Ingen tilgang til Cargo-data.', 403); return r.json();
    };
    const role = await userDb('rpc/current_user_role', 'POST', {});
    if (!['admin', 'dispatcher'].includes(role)) throw new IntegrationError('Kun godkjente Cargo-medarbeidere kan bruke PowerOffice.', 403);
    db = async (path, method = 'GET', body) => {
      const r = await fetcher(env.url + '/rest/v1/' + path, { method, headers: { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new IntegrationError('Kunne ikke lagre PowerOffice-status i Cargo.', 503);
      const text = await r.text(); return text ? JSON.parse(text) : null;
    };
    const body = await request.json();
    if (!['options', 'create', 'sync'].includes(body.action)) throw new IntegrationError('Ukjent handling.');
    const config = await db('rpc/poweroffice_config', 'POST', {});
    if (!config?.applicationKey || !config?.clientKey || !config?.subscriptionKey) throw new IntegrationError('PowerOffice er ikke konfigurert.', 503);
    const po = new PowerOffice(config, fetcher);
    if (body.action === 'options') {
      const [customers, products] = await Promise.all([po.list('/Customers'), po.list('/Products?isArchived=false')]);
      return reply({ environment: config.environment,
        customers: customers.filter(c => !field(c, 'IsArchived')).map(c => ({ id: field(c, 'Id'), number: field(c, 'Number'), name: field(c, 'Name'), org: field(c, 'OrganizationNumber') })),
        products: products.map(p => ({ id: field(p, 'Id'), code: field(p, 'Code'), name: field(p, 'Name'), account: field(p, 'StandardSalesAccount') })) });
    }
    // Older Cargo tabs were deployed while the integration was demo-only.
    if ((body.expectedEnvironment ?? 'demo') !== config.environment) {
      throw new IntegrationError('PowerOffice-miljøet er endret. Oppdater siden og last inn PowerOffice på nytt.', 409);
    }
    if (!/^[0-9a-f-]{36}$/i.test(body.orderId || '')) throw new IntegrationError('Ugyldig ordre.');
    const visibleOrders = await userDb(`orders?id=eq.${body.orderId}&select=*`);
    const order = visibleOrders[0];
    if (!order) throw new IntegrationError('Ordren finnes ikke eller er utilgjengelig.', 404);
    const query = `order_id=eq.${order.id}&environment=eq.${config.environment}`;
    const save = async (values, condition = '') => {
      const [row] = await db(`poweroffice_exports?${query}${condition}`, 'PATCH', { ...values, updated_at: new Date().toISOString() });
      if (!row) throw new IntegrationError('Overføringen har endret seg. Hent status på nytt.', 409);
      return row;
    };
    let existing = (await db(`poweroffice_exports?${query}`))[0];
    if (body.action === 'sync') {
      if (!existing) throw new IntegrationError('Ordren er ikke overført.');
      if (existing.state === 'creating' && Date.now() - Date.parse(existing.updated_at) < 120000) throw new IntegrationError('Overføringen pågår. Prøv igjen om litt.', 409);
      const found = await po.findExport(existing);
      const values = found?.invoice ? invoiceState(found.invoice) : found?.draft ? draftState(found.draft, existing) : { state: 'missing', error_message: null };
      const condition = '&state=eq.' + existing.state + '&updated_at=eq.' + encodeURIComponent(existing.updated_at);
      return reply({ export: await save({ error_message: null, ...values, last_synced_at: new Date().toISOString() }, condition) });
    }
    if (existing && ['draft', 'invoiced', 'paid', 'partially_paid', 'overpaid', 'reversed'].includes(existing.state)) return reply({ export: existing, alreadyExists: true });
    if (Number(body.expectedRevision) !== Number(order.revision)) throw new IntegrationError('Ordren ble endret. Oppdater Cargo og prøv igjen.', 409);
    const selection = { customerId: Number(body.customerId), freightProductId: Number(body.freightProductId), dieselProductId: Number(body.dieselProductId) };
    const payload = draftPayload(order, selection, config.environment);
    const [customer, freight, diesel] = await Promise.all([
      po.request(`/Customers/${selection.customerId}`), po.request(`/Products/${selection.freightProductId}`),
      payload.SalesOrderLines.filter(line => line.LineType === 'Normal').length > 1 ? po.request(`/Products/${selection.dieselProductId}`) : Promise.resolve(null)
    ]);
    if (field(customer, 'IsArchived') || field(customer, 'JobStop') || field(freight, 'IsArchived') || (diesel && field(diesel, 'IsArchived'))) throw new IntegrationError('Kunden eller produktet er sperret i PowerOffice.');
    if (field(customer, 'CurrencyCode') && field(customer, 'CurrencyCode') !== 'NOK') throw new IntegrationError('Denne versjonen støtter fakturagrunnlag i NOK.');
    const confirmedMissing = existing?.state === 'missing' && !!existing.last_synced_at;
    const claim = await db('rpc/poweroffice_claim_export', 'POST', { p_order_id: order.id, p_environment: config.environment, p_user_id: user.id, p_revision: order.revision, p_snapshot: payload });
    if (!claim?.claimed) throw new IntegrationError('Overføringen pågår eller finnes allerede. Oppdater status.', 409);
    claimed = query;
    existing = claim.row;
    const found = await po.findExport(existing);
    let values;
    if (found?.invoice) values = invoiceState(found.invoice);
    else {
      if (!found?.draft && existing.sales_order_id) {
        if (!confirmedMissing) throw new IntegrationError('Hent status fra PowerOffice før du oppretter et nytt utkast.', 409);
        const replacement = { ...payload, ExternalImportReference: existing.external_reference };
        existing = await save({ payload: replacement, source_revision: order.revision, error_message: null });
      }
      if (!found?.draft && existing.payload.CustomerId !== selection.customerId) {
        throw new IntegrationError('Tidligere overføring gjelder en annen kunde. Kontroller den i PowerOffice før nytt utkast.', 409);
      }
      const referenceLine = payload.SalesOrderLines.at(-1);
      if (!found?.draft && ('CustomerReference' in existing.payload || !existing.payload.SalesOrderLines.some(line => line.LineType === 'Text' && line.Description === referenceLine.Description))) {
        if (!confirmedMissing) throw new IntegrationError('Kundereferansen er endret. Hent status fra PowerOffice før nytt forsøk.', 409);
        existing = await save({ payload: withCustomerReference(existing.payload, String(order.customer_reference).trim()) });
      }
      const draft = found?.draft || await po.request('/SalesOrders/Complete', 'POST', existing.payload);
      values = draftState(draft, existing);
    }
    const result = await save({ error_message: null, ...values, last_synced_at: new Date().toISOString() });
    claimed = null;
    return reply({ export: result, alreadyExists: !!found });
  } catch (error) {
    const message = error instanceof IntegrationError ? error.message : 'Tilkoblingen ble avbrutt. Oppdater status før du prøver på nytt.';
    if (claimed && db) {
      try { await db(`poweroffice_exports?${claimed}`, 'PATCH', { state: 'uncertain', error_message: message, updated_at: new Date().toISOString() }); } catch { /* Keep the lock for reconciliation after timeout. */ }
    }
    return reply({ error: message }, error instanceof IntegrationError ? error.status : 502);
  }
}
