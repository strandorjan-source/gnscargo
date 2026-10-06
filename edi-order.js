/* EDI preparation only. No network transport is enabled until the recipient's
 * integration, credentials and mapping have been agreed and verified.
 * The downloaded GNS format is input for that agreement, not an Opter API payload.
 */
'use strict';

function ediCarrierForOrder(order, registered) {
  const name = carrierNameKey(order.carrier_name);
  const byId = registered.find(row => String(row.id) === String(order.carrier_id));
  // A stale carrier_id must never select a different recipient after an edit.
  if (byId && carrierNameKey(byId.name) === name) return byId;
  const matches = registered.filter(row => name && carrierNameKey(row.name) === name);
  return matches.length === 1 ? matches[0] : null;
}

function carrierEdiSample(order, carrier, options = {}) {
  if (!carrier || !['opter', 'timpex'].includes(carrier.edi_system)) throw new Error('Velg EDI-system i transportørregisteret først.');
  const text = value => externalDocumentText(order, String(value ?? '')).trim();
  const number = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const stops = type => documentStops(order, type)
    .filter(stop => text(stop.name) || text(stop.address))
    .map((stop, index) => ({
      sequence: index + 1, name: text(stop.name), address: text(stop.address),
      planned_date: text(stop.planned_date) || null, planned_at: text(stop.planned_at) || null,
      contact_name: text(stop.contact_name),
      ...(type === 'delivery' ? { contact_phone: text(stop.phone) } : {}),
      goods: text(stop.goods), pallets: number(stop.pallets), net_weight_kg: number(stop.weight_kg),
      ...(type === 'pickup' ? { temperature: text(stop.temperature) } : {}),
      instructions: text(stop.instructions)
    }));
  // Explicit allowlist: no customer account, sales price, private notes,
  // pickup phones, user identities or Capacity reservation metadata.
  return {
    format: 'gns-cargo-edi-review', version: '1.0', purpose: 'mapping-review-only',
    recipient: { name: text(carrier.name), org_number: text(carrier.org_number), system: carrier.edi_system },
    order: {
      reference: text(documentRef(order)), updated_at: text(order.updated_at) || null,
      ordering_company: 'GNS Cargo AS', invoice_reference: text(documentRef(order)),
      agreed_carrier_freight: { amount: number(order.carrier_price), currency: 'NOK' },
      vehicle_registration: text(order.vehicle_registration), trailer_number: text(order.trailer_number),
      carrier_contact: text(order.carrier_contact), carrier_phone: text(order.carrier_phone),
      driver_name: text(order.driver_name), driver_phone: text(order.driver_phone),
      pickups: stops('pickup'),
      delivery_information_included: options.includeDelivery !== false,
      ...(options.includeDelivery !== false ? { deliveries: stops('delivery') } : {})
    }
  };
}

(() => {
  const anchor = $('sendDeliveryBtn') || $('pdfBtn');
  if (!anchor || $('sendEdiBtn')) return;
  const button = document.createElement('button');
  button.id = 'sendEdiBtn'; button.type = 'button'; button.className = 'btn white';
  button.textContent = 'Send EDI til transportør'; anchor.after(button);
  const modal = document.createElement('div');
  modal.id = 'ediModal'; modal.className = 'modal hidden'; modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'ediTitle');
  modal.innerHTML = '<div class="card"><div class="toolbar"><h2 id="ediTitle">EDI til transportør</h2><button type="button" class="btn white" id="closeEdi">Lukk</button></div><p id="ediRecipient"></p><p class="notice" id="ediConnection" role="status"></p><p id="ediNextStep"></p><p class="muted">Mobilnummer på lastesteder og salgspris til kunde er utelatt. Valget «Ta med lossested» gjelder også her.</p><div id="ediPreview"></div><details id="ediTechnical"><summary>Teknisk testgrunnlag</summary><p>GNS Cargo-format for godkjenning av feltmapping hos mottakeren. Filen kan ikke brukes direkte mot Opters API uten avtalt mapping.</p><pre id="ediJson" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details><div class="actions" style="margin-top:14px"><button type="button" class="btn blue" disabled style="opacity:.55;cursor:not-allowed" aria-describedby="ediConnection" id="confirmSendEdi">Send EDI – ikke tilkoblet</button><button type="button" class="btn white" id="downloadEdiSample">Last ned testgrunnlag</button></div><p class="muted" id="ediDownloadStatus" role="status"></p></div>';
  document.body.append(modal);
  let sample = null, owner = null, orderId = null, request = 0;
  const allowed = () => me && ['admin', 'dispatcher', 'superuser'].includes(me.role);
  const clear = () => {
    request++; sample = null; owner = null; orderId = null;
    modal.classList.add('hidden'); $('ediPreview').replaceChildren(); $('ediJson').textContent = '';
    $('ediRecipient').textContent = ''; $('ediDownloadStatus').textContent = '';
  };
  const close = () => { clear(); button.focus(); };
  $('closeEdi').onclick = close;
  button.onclick = async () => {
    if (button.disabled || !allowed() || !current?.id) return;
    clear(); const token = request, user = me.id, id = current.id;
    const options = carrierDocumentOptions(); button.disabled = true;
    try {
      const [order, result] = await Promise.all([getDocumentOrder(id), s.from('carriers').select('*').order('name')]);
      if (result.error) throw new Error('Transportørregisteret kunne ikke hentes. Prøv igjen.');
      if (token !== request || !allowed() || me.id !== user || current?.id !== id) return;
      const carrier = ediCarrierForOrder(order, result.data || []);
      owner = user; orderId = id;
      const system = { opter: 'Opter', timpex: 'Timpex' }[carrier?.edi_system];
      $('ediRecipient').textContent = 'Mottaker: ' + (carrier?.name || order.carrier_name || 'Transportør mangler') + (system ? ' · ' + system : '');
      $('ediConnection').textContent = 'Ikke tilkoblet. Ingen ordre er sendt.';
      $('ediNextStep').textContent = !carrier
        ? 'Lagre transportøren i registeret med samme navn som på ordren, og velg EDI-system.'
        : !system ? 'Velg Opter eller Timpex under «Rediger» i transportørregisteret.'
        : 'For å aktivere sending må mottakeren eller systemleverandøren gi oss API-adresse, sikker tilgang og godkjent oppsett for GNS Cargo. Testgrunnlaget kan brukes til å avklare hvilke opplysninger de skal motta.';
      sample = system ? carrierEdiSample(order, carrier, options) : null;
      $('downloadEdiSample').disabled = !sample;
      $('ediTechnical').classList.toggle('hidden', !sample);
      $('ediJson').textContent = sample ? JSON.stringify(sample, null, 2) : '';
      $('ediPreview').innerHTML = carrierDocumentSections(order, options).map(section => '<section class="document-section"><h3>' + esc(section.title) + '</h3>' + section.lines.map(line => '<p>' + esc(line) + '</p>').join('') + '</section>').join('');
      modal.classList.remove('hidden'); $('closeEdi').focus();
    } catch (error) { if (token === request && allowed()) alert(error.message || 'EDI-grunnlaget kunne ikke klargjøres.'); }
    finally { button.disabled = false; }
  };
  $('downloadEdiSample').onclick = () => {
    if (!sample || !allowed() || me.id !== owner || current?.id !== orderId) { clear(); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url;
    link.download = 'GNS-EDI-testgrunnlag-' + String(sample.order.reference).replace(/[^a-zA-Z0-9_-]/g, '') + '.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('ediDownloadStatus').textContent = 'Testgrunnlaget er lastet ned. Ingen ordre er sendt, og ordrestatus er uendret.';
  };
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      const fields = [...modal.querySelectorAll('button:not(:disabled),summary')].filter(field => !field.closest('.hidden'));
      const first = fields[0], last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  new MutationObserver(() => { if ($('app').classList.contains('hidden')) clear(); }).observe($('app'), { attributes: true, attributeFilter: ['class'] });
})();
