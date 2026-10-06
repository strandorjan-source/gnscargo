/* Opens an email draft. Sending remains a user action in their email client. */
(() => {
  const pdfButton = document.getElementById('pdfBtn');
  if (!pdfButton || document.getElementById('sendOrderBtn')) return;
  const button = document.createElement('button');
  button.id = 'sendOrderBtn'; button.type = 'button'; button.className = 'btn green'; button.textContent = 'Send ordre';
  pdfButton.insertAdjacentElement('afterend', button);
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const order = await refreshDocumentOrder();
      const email = String(order.carrier_email || '').trim();
      if (!email) throw new Error('Transportørens e-post mangler. Velg «Endre ordre» og fyll den inn.');
      const message = carrierEmail(order);
      makePdf(order).save('GNS-Transportordre-Lasteliste-' + order.order_number + '.pdf');
      const modal = document.getElementById('carrierEmailModal');
      document.getElementById('carrierEmailRecipient').textContent = email;
      document.getElementById('carrierEmailSubject').textContent = message.subject;
      document.getElementById('carrierEmailText').value = message.body;
      document.getElementById('openCarrierEmail').href = 'mailto:' + encodeURIComponent(email) + '?subject=' + encodeURIComponent(message.subject) + '&body=' + encodeURIComponent(message.body);
      document.getElementById('carrierEmailStatus').textContent = '';
      modal.classList.remove('hidden');
      document.getElementById('openCarrierEmail').focus();
    } catch (error) { alert(error.message || 'Ordren kunne ikke klargjøres.'); }
    finally { button.disabled = false; }
  };
  const modal = document.createElement('div');
  modal.id = 'carrierEmailModal'; modal.className = 'modal hidden'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'carrierEmailTitle');
  modal.innerHTML = '<div class="card"><div class="toolbar"><h2 id="carrierEmailTitle">Send transportordre</h2><button type="button" class="btn white" id="closeCarrierEmail">Lukk</button></div><p>PDF-en er lastet ned. Legg den ved e-posten før du sender.</p><p><b>Til:</b> <span id="carrierEmailRecipient"></span></p><p><b>Emne:</b> <span id="carrierEmailSubject"></span></p><label>E-posttekst<textarea id="carrierEmailText" readonly style="min-height:300px"></textarea></label><div class="actions" style="margin-top:14px"><a class="btn blue" id="openCarrierEmail" style="text-decoration:none">Åpne e-post</a><button type="button" class="btn white" id="copyCarrierEmail">Kopier tekst</button></div><p id="carrierEmailStatus" role="status" class="muted"></p></div>';
  document.body.append(modal);
  const close = () => { modal.classList.add('hidden'); button.focus(); };
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
