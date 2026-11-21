// Shared by the deployed function and the integration tests. No credentials in source.
export class IntegrationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const field = (o, key) => o?.[key] ?? o?.[key[0].toLowerCase() + key.slice(1)];
export const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
export function pricing(order) {
  const value = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  if (!value(order.customer_price) || Number(order.customer_price) < 0) throw new IntegrationError('Ordren mangler gyldig salgspris.');
  const percent = Number(order.customer_diesel_percent || 0);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new IntegrationError('Ugyldig dieselprosent.');
  const base = value(order.customer_base_price) ? money(order.customer_base_price) : (percent === 0 ? money(order.customer_price) : NaN);
  if (!Number.isFinite(base) || base < 0) throw new IntegrationError('Ordren mangler ordinær fraktpris.');
  // Match Cargo and PostgreSQL: multiply integer øre by basis points, then round half up.
  const cents = BigInt(Math.round(base * 100));
  const basisPoints = BigInt(Math.round(percent * 100));
  const diesel = Number((cents * basisPoints + 5000n) / 10000n) / 100;
  if (Math.abs(money(base + diesel) - money(order.customer_price)) > 0.001 ||
      (value(order.customer_diesel_amount) && Math.abs(money(order.customer_diesel_amount) - diesel) > 0.001)) {
    throw new IntegrationError('Frakt, diesel og total stemmer ikke. Lagre prisene på ordren på nytt.');
  }
  return { base, percent, diesel, total: money(base + diesel) };
}
export function withCustomerReference(payload, reference) {
  const lines = payload.SalesOrderLines.filter(line => !(line.LineType === 'Text' && line.Description?.startsWith('Kundereferanse: ')));
  lines.push({ LineType: 'Text', Description: 'Kundereferanse: ' + reference, SortOrder: lines.length + 1 });
  const draft = { ...payload, SalesOrderLines: lines };
  delete draft.CustomerReference;
  return draft;
}
export function draftPayload(order, selection, environment) {
  if (order.status === 'cancelled') throw new IntegrationError('En kansellert ordre kan ikke overføres.');
  if (order.customer_invoice_sent) throw new IntegrationError('Ordren er allerede markert fakturert.');
  if (!order.pickup_date && !order.pickup_at) throw new IntegrationError('Ordren mangler lastedato.');
  for (const k of ['customerId', 'freightProductId']) if (!Number.isSafeInteger(selection[k]) || selection[k] <= 0) throw new IntegrationError('Velg kunde og fraktprodukt i PowerOffice.');
  const customerReference = String(order.customer_reference ?? '').trim();
  if (!customerReference) throw new IntegrationError('Legg inn kundereferansen på Cargo-ordren før du oppretter fakturautkast.');
  const p = pricing(order);
  if (p.diesel && (!Number.isSafeInteger(selection.dieselProductId) || selection.dieselProductId <= 0)) throw new IntegrationError('Velg produkt for dieseltillegget.');
  const date = order.pickup_date || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(new Date(order.pickup_at));
  const ref = `GNS-${environment === 'production' ? 'prod' : environment}-${order.id}`;
  const route = [order.pickup_name, order.delivery_name].filter(Boolean).join(' → ');
  const lines = [{ ProductId: selection.freightProductId, Quantity: 1, ProductUnitPrice: p.base, Allowance: 0, SortOrder: 1, LineType: 'Normal', Description: `Frakt ${order.reference || order.order_number} · ${date} · ${route}`.slice(0, 250) }];
  if (p.diesel) lines.push({ ProductId: selection.dieselProductId, Quantity: 1, ProductUnitPrice: p.diesel, Allowance: 0, SortOrder: 2, LineType: 'Normal', Description: `Dieseltillegg ${p.percent} % av kr ${p.base.toFixed(2)}` });
  return withCustomerReference({ CustomerId: selection.customerId, CurrencyCode: 'NOK', SalesOrderStatus: 'Draft', SalesOrderDate: date, ExternalImportReference: ref, ImportedOrderNo: Number(order.order_number), SalesOrderLines: lines }, customerReference);
}
export function invoiceState(invoice) {
  const rawBalance = field(invoice, 'Balance'), rawTotal = field(invoice, 'TotalPostedAmount');
  const balance = rawBalance == null ? null : money(rawBalance);
  const total = rawTotal == null ? null : money(rawTotal);
  return {
    state: field(invoice, 'IsReversed') ? 'reversed' : balance === null ? 'invoiced' : balance < 0 ? 'overpaid' : balance === 0 ? 'paid' : total !== null && total > balance ? 'partially_paid' : 'invoiced',
    invoice_id: field(invoice, 'Id'), invoice_number: String(field(invoice, 'InvoiceNo')),
    balance, invoice_total: total, invoice_date: field(invoice, 'VoucherDate'), due_date: field(invoice, 'DueDate')
  };
}
export class PowerOffice {
  constructor(config, fetcher = fetch) {
    if (!['demo', 'production'].includes(config.environment)) throw new IntegrationError('PowerOffice-miljø er ikke konfigurert.', 503);
    this.config = config; this.fetcher = fetcher;
    this.base = `https://goapi.poweroffice.net/${config.environment === 'demo' ? 'demo/' : ''}v2`;
  }
  async request(path, method = 'GET', data) {
    if (!this.token) {
      const res = await this.fetcher(`https://goapi.poweroffice.net/${this.config.environment === 'demo' ? 'Demo/' : ''}OAuth/Token`, {
        method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Ocp-Apim-Subscription-Key': this.config.subscriptionKey, Authorization: `Basic ${btoa(`${this.config.applicationKey}:${this.config.clientKey}`)}` }, body: 'grant_type=client_credentials'
      });
      if (!res.ok) throw new IntegrationError(`PowerOffice-innlogging feilet (HTTP ${res.status}).`, 502);
      this.token = (await res.json()).access_token;
      if (!this.token) throw new IntegrationError('PowerOffice ga ingen tilgang.', 502);
    }
    const res = await this.fetcher(this.base + path, { method, signal: AbortSignal.timeout(25000), headers: { Authorization: `Bearer ${this.token}`, 'Ocp-Apim-Subscription-Key': this.config.subscriptionKey, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    if (res.status === 400 && method === 'POST' && path === '/SalesOrders/Complete') {
      const problem = await res.json().catch(() => null);
      const errors = field(problem, 'Errors');
      const messages = errors && typeof errors === 'object' ? Object.values(errors).flat() : [];
      let detail = field(problem, 'Detail');
      if (typeof detail === 'string' && detail.trimStart().startsWith('[')) {
        try {
          const validators = JSON.parse(detail);
          if (Array.isArray(validators)) messages.push(...validators.map(item => field(item, 'ErrorMessage')));
        } catch { /* Use the title if the provider did not return a validator array. */ }
        detail = '';
      }
      const details = [...messages, detail, field(problem, 'Title')]
        .filter(value => typeof value === 'string' && value.trim() && !/[<>]/.test(value))
        .map(value => value.replace(/\s+/g, ' ').trim());
      const reason = [...new Set(details)].join(' ').slice(0, 320);
      if (reason) throw new IntegrationError('PowerOffice avviste utkastet. ' + reason, 400);
    }
    if (!res.ok) throw new IntegrationError(`PowerOffice avviste ${method} ${path.split('?')[0]} (HTTP ${res.status}). Kontroller kunde, produkter og API-rettigheter.`, 502);
    return res.status === 204 ? null : res.json();
  }
  async list(path) {
    const rows = [];
    for (let page = 1; page <= 50; page++) {
      const data = await this.request(`${path}${path.includes('?') ? '&' : '?'}PageNumber=${page}&PageSize=200`);
      if (data === null) return rows; // PowerOffice returns 204 when no rows match.
      if (!Array.isArray(data)) throw new IntegrationError('Uventet svar fra PowerOffice.', 502);
      rows.push(...data); if (data.length < 200) return rows;
    }
    throw new IntegrationError('For mange treff i PowerOffice. Avgrens utvalget.', 502);
  }
  async findExport(existing) {
    const q = `externalImportReferences=${encodeURIComponent(existing.external_reference)}&onlyCreatedByCurrentIntegration=true`;
    const invoices = await this.list('/OutgoingInvoices?' + q);
    if (invoices.length > 1) throw new IntegrationError('Flere fakturaer har samme Cargo-referanse. Kontroller PowerOffice.', 409);
    if (invoices.length) return { invoice: invoices[0] };
    if (existing.invoice_id || existing.invoice_number) {
      const filter = existing.invoice_id ? 'invoiceIds=' + encodeURIComponent(existing.invoice_id) : 'invoiceNos=' + encodeURIComponent(existing.invoice_number);
      const saved = await this.list('/OutgoingInvoices?' + filter);
      if (saved.length === 1 && String(field(saved[0], 'InvoiceNo')) === String(existing.invoice_number)) return { invoice: saved[0] };
      throw new IntegrationError('Cargo har allerede registrert en faktura. Kontroller fakturanummeret i PowerOffice.', 409);
    }
    const drafts = await this.list('/SalesOrders?' + q);
    if (drafts.length > 1) throw new IntegrationError('Flere utkast har samme Cargo-referanse. Kontroller PowerOffice.', 409);
    if (drafts.length) return { draft: drafts[0] };
    if (!existing.sales_order_number) return null;
    const number = encodeURIComponent(existing.sales_order_number);
    const [byInvoice, byOrder] = await Promise.all([
      this.list('/OutgoingInvoices?orderNos=' + number), this.list('/SalesOrders?salesOrderNos=' + number)
    ]);
    if (!byInvoice.length && !byOrder.length) return null;
    if (byInvoice.length === 1 && String(field(byInvoice[0], 'OrderNo')) === String(existing.sales_order_number) &&
        String(field(byInvoice[0], 'CustomerId')) === String(existing.payload.CustomerId)) return { invoice: byInvoice[0] };
    if (!byInvoice.length && byOrder.length === 1 && String(field(byOrder[0], 'Id')) === String(existing.sales_order_id)) return { draft: byOrder[0] };
    throw new IntegrationError('Ordrenummeret har et annet treff i PowerOffice. Kontroller det før ny overføring.', 409);
  }
}
