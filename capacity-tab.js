/* The same-origin Capacity route shares Supabase's session storage with Cargo.
 * Capacity keeps its own approval/role checks and database policies.
 * Its live deployment is reused so vehicles, reservations and updates stay in sync.
 */
(() => {
  const tabs = [$('cargoTab'), $('capacityTab')];
  const panels = [$('cargoPanel'), $('capacityPanel')];
  let frame = null;
  let request = 0;

  function showTab(index) {
    if (!me || $('app').classList.contains('hidden')) return;
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].classList.toggle('hidden', i !== index);
    });
    if (index === 1 && !frame) loadCapacity();
    if (index === 0 && frame) load();
  }

  async function loadCapacity() {
    if (!me || $('app').classList.contains('hidden')) return;
    const ticket = ++request;
    const status = $('capacityStatus');
    status.textContent = 'Laster GNS Capacity …'; status.classList.remove('hidden');
    $('capacityRetry').disabled = true;
    frame?.remove(); frame = null;
    try {
      const response = await fetch('/capacity/health', { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('Capacity svarte ikke.');
      const health = await response.json();
      if (health.service !== 'gns-capacity' || !health.configured) throw new Error('Capacity er ikke koblet til databasen.');
      if (ticket !== request || !me) return;
      const next = document.createElement('iframe');
      next.id = 'capacityFrame'; next.title = 'GNS Capacity – biler, kapasitet og reservasjoner';
      next.src = '/capacity';
      next.addEventListener('load', () => {
        if (ticket !== request) return;
        status.classList.add('hidden'); $('capacityRetry').disabled = false;
      });
      next.addEventListener('error', () => {
        if (ticket !== request) return;
        status.textContent = 'Capacity kunne ikke lastes. Trykk «Last inn på nytt».';
        status.classList.remove('hidden'); $('capacityRetry').disabled = false;
      });
      frame = next; $('capacityFrameHost').append(next);
    } catch (error) {
      if (ticket !== request) return;
      status.textContent = 'Capacity kunne ikke lastes. Prøv igjen, eller åpne Capacity i eget vindu.';
      $('capacityRetry').disabled = false;
    }
  }

  tabs.forEach((tab, index) => {
    tab.onclick = () => showTab(index);
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      showTab(next); tabs[next].focus();
    });
  });
  $('capacityRetry').onclick = loadCapacity;
  // Remove the embedded account view immediately when Cargo loses access.
  new MutationObserver(() => {
    if (!$('app').classList.contains('hidden')) return;
    ++request; frame?.remove(); frame = null;
    tabs[0].setAttribute('aria-selected', 'true'); tabs[0].tabIndex = 0;
    tabs[1].setAttribute('aria-selected', 'false'); tabs[1].tabIndex = -1;
    panels[0].classList.remove('hidden'); panels[1].classList.add('hidden');
    $('capacityRetry').disabled = false;
  }).observe($('app'), { attributes: true, attributeFilter: ['class'] });
})();
