/* Carrier pricing: the agreed freight is ALWAYS the ordinary price, without diesel.
 * The carrier percentage is independent of the customer's percentage.
 * Keep the integration here so the existing synchronous document/send entry point
 * installs the fields before an order can be created, edited or dispatched.
 */
'use strict';
function calculateCarrierPricing(baseValue, percentValue) {
  const units = (value, label, optional = false) => {
    const text = String(value ?? '').trim().replace(',', '.');
    if (!text) return optional ? null : 0n;
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(label + ' må være et positivt tall med høyst to desimaler.');
    const [whole, fraction = ''] = text.split('.');
    const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (result > 999999999999n) throw new Error(label + ' er for stort.');
    return result;
  };
  const base = units(baseValue, 'Ordinær fraktpris til transportør', true);
  const percent = units(percentValue, 'Dieseltillegg til transportør');
  if (percent > 10000n) throw new Error('Dieseltillegget til transportør må være mellom 0 og 100 %.');
  if (base === null && percent > 0n) throw new Error('Fyll inn ordinær fraktpris til transportør før du legger til dieseltillegg.');
  const diesel = base === null ? 0n : (base * percent + 5000n) / 10000n;
  return { base: base === null ? null : Number(base) / 100, percent: Number(percent) / 100,
    diesel: Number(diesel) / 100, total: base === null ? null : Number(base + diesel) / 100 };
}
function carrierPricingLines(order) {
  const price = calculateCarrierPricing(order.carrier_price, order.carrier_diesel_percent);
  return [
    'Ordinær avtalt fraktpris (uten diesel): ' + documentAmount(price.base),
    'Avtalt dieseltillegg: ' + documentNumber(price.percent) + ' % av ordinær fraktpris = ' + documentAmount(price.diesel) + ' i tillegg',
    'Sum transportøren kan fakturere, før eventuell mva: ' + documentAmount(price.total),
    price.percent === 0 ? 'Ingen dieseltillegg er avtalt på denne ordren.' : 'Dieseltillegget kommer i tillegg til ordinær fraktpris og skal spesifiseres separat på fakturaen.'
  ];
}
function installCarrierPricing(form, order = null) {
  const base = form?.elements.carrier_price;
  if (!base || form.elements.carrier_diesel_percent) return;
  const label = base.closest('label');
  const heading = label.querySelector('.label-heading > span') || [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (heading) heading.textContent = 'Ordinær fraktpris til transportør, uten diesel (NOK)';
  base.min = '0'; base.step = '0.01';
  const percentLabel = document.createElement('label');
  percentLabel.textContent = 'Dieseltillegg til transportør (%)';
  const percent = document.createElement('input');
  percent.name = 'carrier_diesel_percent'; percent.type = 'text'; percent.inputMode = 'decimal';
  percent.placeholder = '0'; percent.autocomplete = 'off'; percent.maxLength = 6;
  percent.id = form.id + '-carrier-diesel-percent';
  // An empty new field must not make Capacity think there is an unsaved draft.
  percent.defaultValue = order?.carrier_diesel_percent ? String(order.carrier_diesel_percent) : '';
  const help = document.createElement('small'); help.id = form.id + '-carrier-diesel-help'; help.className = 'customer-help';
  help.textContent = 'Kommer i tillegg til ordinær fraktpris. Gjelder transportøren, ikke kunden. Tomt felt eller 0 = uten dieseltillegg.';
  percent.setAttribute('aria-describedby', help.id); percentLabel.append(percent, help);
  const summary = document.createElement('div'); summary.className = 'notice carrier-pricing-summary';
  summary.style.gridColumn = '1 / -1'; summary.style.margin = '0'; summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
  label.after(percentLabel, summary);
  const refresh = () => {
    percent.setCustomValidity('');
    try {
      const price = calculateCarrierPricing(base.value, percent.value);
      summary.classList.remove('error');
      summary.textContent = price.base === null ? 'Transportørpris er ikke oppgitt.' :
        'Ordinær frakt: ' + documentAmount(price.base) + ' + diesel: ' + documentAmount(price.diesel) +
        ' = kan faktureres av transportør: ' + documentAmount(price.total) + ' (før eventuell mva).';
    } catch (error) { percent.setCustomValidity(error.message); summary.classList.add('error'); summary.textContent = error.message; }
  };
  base.addEventListener('input', refresh); percent.addEventListener('input', refresh);
  base.addEventListener('change', refresh); percent.addEventListener('change', refresh);
  if (form.id === 'form') form.addEventListener('reset', () => setTimeout(refresh, 0));
  refresh();
}

/* Register with the existing form, document and report extension points. */
(() => {
  const read = readOrderForm;
  readOrderForm = function(form) {
    const price = calculateCarrierPricing(form.elements.carrier_price.value, form.elements.carrier_diesel_percent?.value);
    const values = read(form);
    // Generated amount/total are read-only database columns, never submitted.
    values.carrier_price = price.base; values.carrier_diesel_percent = price.percent;
    return values;
  };
  const install = installCustomerPricing;
  installCustomerPricing = function(form, order = null) { install(form, order); installCarrierPricing(form, order); };
  installCarrierPricing($('form'));

  const sections = carrierDocumentSections;
  carrierDocumentSections = function(order, options = {}) {
    const result = sections(order, options);
    const first = result[0];
    first.lines = [...first.lines.slice(0, 2), ...carrierPricingLines(order), ...first.lines.slice(3)];
    return result;
  };
  const sheet = renderCarrierSheet;
  renderCarrierSheet = function(order, ...args) {
    sheet(order, ...args);
    const block = document.createElement('section'); block.className = 'document-section carrier-freight-breakdown';
    const title = document.createElement('h3'); title.textContent = 'AVTALT FRAKT OG DIESELTILLEGG'; block.append(title);
    carrierPricingLines(order).forEach(line => { const p = document.createElement('p'); p.textContent = line; block.append(p); });
    $('sheet').querySelector('.document-summary').after(block);
  };
  const cmr = makeCmr;
  makeCmr = function(order, fields = {}, ...args) {
    const price = calculateCarrierPricing(order.carrier_price, order.carrier_diesel_percent);
    if (!price.percent) return cmr(order, fields, ...args);
    const lines = ['Ordinær frakt ovenfor er uten diesel.', ...carrierPricingLines(order).slice(1, 3)];
    return cmr(order, { ...fields, supplementary_charges: [fields.supplementary_charges, ...lines].filter(Boolean).join('\n') }, ...args);
  };

  // Margin is based on the payable carrier amount, without changing carrier_price.
  const margin = order => Number(order.customer_price || 0) - (calculateCarrierPricing(order.carrier_price, order.carrier_diesel_percent).total || 0);
  const originalStats = stats;
  stats = function(...args) { originalStats(...args); $('sMargin').textContent = nok(orders.filter(order => order.status !== 'cancelled').reduce((sum, order) => sum + margin(order), 0)); };
  const originalRender = render;
  render = function(...args) {
    originalRender(...args);
    const list = filtered();
    [...$('rows').querySelectorAll('tr')].forEach((row, index) => { if (list[index] && row.cells[7]) row.cells[7].textContent = nok(margin(list[index])); });
    [...$('mobileOrders').querySelectorAll('.orderCard')].forEach((card, index) => {
      const cell = [...card.children].find(el => el.textContent.startsWith('Margin: '));
      if (cell && list[index]) cell.textContent = 'Margin: ' + nok(margin(list[index]));
    });
  };

  const workbook = buildInvoiceWorkbook;
  buildInvoiceWorkbook = function(ExcelJS, list, register, options) {
    const result = workbook(ExcelJS, list, register, options), sheet = result.getWorksheet('Fakturagrunnlag');
    const prices = list.map(order => calculateCarrierPricing(order.carrier_price, order.carrier_diesel_percent));
    const headings = ['Dieseltillegg til transportør (%)', 'Dieseltillegg til transportør (NOK)', 'Sum inngående transportørfaktura inkl. diesel (NOK)'];
    sheet.getCell('L4').value = 'Inngående faktura fra transportør – ordinær frakt uten diesel (NOK)';
    sheet.getCell('A3').value += ' Transportørens diesel er separat i R–S; T viser ordinær frakt + diesel som transportøren kan fakturere. Kundens dieselprosent brukes ikke til transportøren.';
    sheet.getRow(3).height = 70;
    headings.forEach((heading, index) => {
      const column = index + 18, cell = sheet.getRow(4).getCell(column); cell.value = heading;
      cell.style = { ...sheet.getCell('L4').style }; sheet.getColumn(column).width = index === 2 ? 36 : 27;
    });
    prices.forEach((price, index) => {
      const row = sheet.getRow(index + 5);
      [price.percent / 100, price.diesel, price.total].forEach((value, offset) => {
        const cell = row.getCell(18 + offset); cell.value = value;
        cell.font = { name: 'Calibri', size: 11, bold: offset === 2 };
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: value === null ? 'FFFFE6A3' : 'FFEAF3FC' } };
        cell.numFmt = offset === 0 ? '0.00%' : '#,##0.00 "NOK"';
      });
    });
    const last = list.length + 4;
    sheet.getRow(last + 2).getCell(2).value = 'SUM ORDINÆR FRAKT FRA TRANSPORTØR UTEN DIESEL';
    [[6, 19, 'S', 'diesel', 'SUM DIESELTILLEGG TIL TRANSPORTØR'], [7, 20, 'T', 'total', 'SUM INNGÅENDE TRANSPORTØRFAKTURA INKL. DIESEL']].forEach(([offset, column, letter, key, label]) => {
      const row = sheet.getRow(last + offset); sheet.mergeCells(`B${row.number}:K${row.number}`); row.getCell(2).value = label;
      row.getCell(column).value = list.length ? { formula: `SUBTOTAL(109,${letter}5:${letter}${last})`, result: sumReportAmounts(prices.map(price => price[key])) } : 0;
      row.getCell(column).numFmt = '#,##0.00 "NOK"'; row.getCell(column).alignment = { horizontal: 'right' };
      row.font = { bold: true, name: 'Calibri', size: 12, color: { argb: 'FF235781' } };
    });
    sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, last), column: 20 } };
    return result;
  };
  if (orders.length) { stats(); render(); }
})();

/* Opens an email draft. Sending remains a user action in their email client. */
(() => {
  const pdfButton = document.getElementById('pdfBtn');
  if (!pdfButton || document.getElementById('sendOrderBtn')) return;
  const button = document.createElement('button');
  button.id = 'sendOrderBtn'; button.type = 'button'; button.className = 'btn green'; button.textContent = 'Send ordre';
  pdfButton.insertAdjacentElement('afterend', button);
  const deliveryButton = document.createElement('button');
  deliveryButton.id = 'sendDeliveryBtn'; deliveryButton.type = 'button'; deliveryButton.className = 'btn white'; deliveryButton.textContent = 'Send losseinfo';
  button.insertAdjacentElement('afterend', deliveryButton);
  let returnButton = button;
  async function prepareEmail(deliveryOnly = false) {
    const activeButton = deliveryOnly ? deliveryButton : button;
    if (activeButton.disabled) return;
    activeButton.disabled = true;
    const options = deliveryOnly ? { deliveryOnly: true } : carrierDocumentOptions();
    try {
      const order = await refreshDocumentOrder();
      if (deliveryOnly && !documentStops(order, 'delivery').some(stop => String(stop.name || '').trim() || String(stop.address || '').trim())) throw new Error('Lossested mangler. Velg «Endre ordre» og legg inn losseopplysningene først.');
      const email = String(order.carrier_email || '').trim();
      if (!email) throw new Error('Transportørens e-post mangler. Velg «Endre ordre» og fyll den inn.');
      const message = carrierEmail(order, options);
      makePdf(order, options).save((deliveryOnly ? 'GNS-Losseinformasjon-' : 'GNS-Transportordre-Lasteliste-') + order.order_number + '.pdf');
      const modal = document.getElementById('carrierEmailModal');
      document.getElementById('carrierEmailTitle').textContent = deliveryOnly ? 'Send losseinfo' : 'Send transportordre';
      returnButton = activeButton;
      document.getElementById('carrierEmailRecipient').textContent = email;
      document.getElementById('carrierEmailSubject').textContent = message.subject;
      document.getElementById('carrierEmailText').value = message.body;
      document.getElementById('openCarrierEmail').href = 'mailto:' + encodeURIComponent(email) + '?subject=' + encodeURIComponent(message.subject) + '&body=' + encodeURIComponent(message.body);
      document.getElementById('carrierEmailStatus').textContent = '';
      modal.classList.remove('hidden');
      document.getElementById('openCarrierEmail').focus();
    } catch (error) { alert(error.message || 'Ordren kunne ikke klargjøres.'); }
    finally { activeButton.disabled = false; }
  }
  button.onclick = () => prepareEmail(false);
  deliveryButton.onclick = () => prepareEmail(true);
  const modal = document.createElement('div');
  modal.id = 'carrierEmailModal'; modal.className = 'modal hidden'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'carrierEmailTitle');
  modal.innerHTML = '<div class="card"><div class="toolbar"><h2 id="carrierEmailTitle">Send transportordre</h2><button type="button" class="btn white" id="closeCarrierEmail">Lukk</button></div><p>PDF-en er lastet ned. Legg den ved e-posten før du sender.</p><p><b>Til:</b> <span id="carrierEmailRecipient"></span></p><p><b>Emne:</b> <span id="carrierEmailSubject"></span></p><label>E-posttekst<textarea id="carrierEmailText" readonly style="min-height:300px"></textarea></label><div class="actions" style="margin-top:14px"><a class="btn blue" id="openCarrierEmail" style="text-decoration:none">Åpne e-post</a><button type="button" class="btn white" id="copyCarrierEmail">Kopier tekst</button></div><p id="carrierEmailStatus" role="status" class="muted"></p></div>';
  document.body.append(modal);
  const close = () => { modal.classList.add('hidden'); returnButton.focus(); };
  document.getElementById('closeCarrierEmail').onclick = close;
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      const fields = [...modal.querySelectorAll('button,a,textarea')];
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0].focus(); }
    }
  });
  document.getElementById('copyCarrierEmail').onclick = async () => {
    const text = document.getElementById('carrierEmailText');
    try { await navigator.clipboard.writeText(text.value); document.getElementById('carrierEmailStatus').textContent = 'E-postteksten er kopiert.'; }
    catch { text.focus(); text.select(); document.getElementById('carrierEmailStatus').textContent = 'Teksten er markert. Bruk Kopier i nettleseren.'; }
  };
})();
