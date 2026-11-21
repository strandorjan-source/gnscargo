import { confirmedSendTime, field, invoiceState } from './core.mjs';

// Rotate through outstanding Cargo exports, including ones whose POST response was lost.
// Invoice IDs survive conversion from a draft. The external reference also covers lost responses.
export async function pollSentInvoices(po, db) {
  const batchSize = 30;
  const checkedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 120000).toISOString();
  const rows = await db('poweroffice_exports?select=order_id,environment,external_reference,sales_order_id,invoice_id,payload,updated_at,orders!inner(customer_invoice_sent,status)' +
    '&environment=eq.production&provider_sent_at=is.null&orders.customer_invoice_sent=eq.false&orders.status=neq.cancelled' +
    '&or=(state.neq.creating,updated_at.lt.' + encodeURIComponent(staleBefore) + ')' +
    '&order=invoice_checked_at.asc.nullsfirst,order_id.asc&limit=' + batchSize);
  if (!rows.length) return { checked: 0, confirmed: 0 };

  const refs = rows.map(row => row.external_reference);
  const invoices = await po.list('/OutgoingInvoices?onlyCreatedByCurrentIntegration=true&externalImportReferences=' + encodeURIComponent(refs.join(',')));
  const ids = rows.map(row => row.invoice_id || row.sales_order_id).filter(Boolean);
  if (ids.length) invoices.push(...await po.list('/OutgoingInvoices?invoiceIds=' + encodeURIComponent(ids.join(','))));
  const unique = [...new Map(invoices.map(invoice => [field(invoice, 'Id'), invoice])).values()];
  let confirmed = 0;
  let writeError;
  for (const row of rows) {
    const matches = unique.filter(invoice => confirmedSendTime(invoice, row));
    if (matches.length !== 1) continue;
    const filter = 'order_id=eq.' + row.order_id + '&environment=eq.production&provider_sent_at=is.null&updated_at=eq.' + encodeURIComponent(row.updated_at);
    try {
      const updated = await db('poweroffice_exports?' + filter, 'PATCH', {
        ...invoiceState(matches[0], row), last_synced_at: checkedAt, updated_at: checkedAt, error_message: null
      });
      confirmed += updated.length;
    } catch (error) {
      writeError = error;
    }
  }
  await db('poweroffice_exports?environment=eq.production&order_id=in.(' + rows.map(row => row.order_id).join(',') + ')',
    'PATCH', { invoice_checked_at: checkedAt });
  if (writeError) throw writeError;
  return { checked: rows.length, confirmed };
}
