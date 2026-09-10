export default function Home() {
  return (
    <main>
      <header className="topbar">
        <div>
          <div className="brand">GNS <span>CARGO</span></div>
          <div className="subtitle">Ordre & transportstyring</div>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">CONTROL TOWER</p>
          <h1>GNS Cargo Ordre</h1>
          <p>Systemet er koblet til GitHub og klart for videre oppsett mot Supabase.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panelHead">
          <div>
            <h2>Systemstatus</h2>
            <p>Første stabile versjon</p>
          </div>
        </div>
        <div className="notice">GitHub → Vercel er koblet. Neste steg er ordreflyt og Supabase.</div>
      </section>
    </main>
  );
}
