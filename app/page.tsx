'use client';

import { FormEvent, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type Order = {
  id: string;
  order_number: number;
  customer: string;
  pickup_name: string | null;
  delivery_name: string | null;
  carrier_name: string | null;
  carrier_price: number | null;
  customer_price: number | null;
  status: string;
  created_at: string;
};

const emptyForm = {
  customer: '', pickup_name: '', pickup_address: '', pickup_at: '',
  delivery_name: '', delivery_address: '', delivery_at: '', goods: '',
  pallets: '', weight_kg: '', temperature: '', carrier_name: '', carrier_email: '',
  driver_name: '', driver_phone: '', vehicle_registration: '', carrier_price: '',
  customer_price: '', instructions: ''
};

export default function Home() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  async function loadOrders() {
    setLoading(true);
    const { data, error } = await supabase.from('orders').select('id,order_number,customer,pickup_name,delivery_name,carrier_name,carrier_price,customer_price,status,created_at').order('order_number', { ascending: false });
    if (error) setMessage('Kunne ikke hente ordre: ' + error.message);
    else setOrders((data || []) as Order[]);
    setLoading(false);
  }

  useEffect(() => { loadOrders(); }, []);

  async function createOrder(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setMessage('');
    const payload = {
      ...form,
      pallets: form.pallets ? Number(form.pallets) : null,
      weight_kg: form.weight_kg ? Number(form.weight_kg) : null,
      carrier_price: form.carrier_price ? Number(form.carrier_price) : null,
      customer_price: form.customer_price ? Number(form.customer_price) : null,
      pickup_at: form.pickup_at ? new Date(form.pickup_at).toISOString() : null,
      delivery_at: form.delivery_at ? new Date(form.delivery_at).toISOString() : null,
      status: 'created'
    };
    const { data, error } = await supabase.from('orders').insert(payload).select('order_number').single();
    if (error) setMessage('Ordren kunne ikke lagres: ' + error.message);
    else {
      setMessage(`Ordre #${data.order_number} er opprettet.`);
      setForm(emptyForm); setShowForm(false); await loadOrders();
    }
    setSaving(false);
  }

  const margin = (o: Order) => (o.customer_price || 0) - (o.carrier_price || 0);
  const nok = (v: number | null) => new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(v || 0);

  return <main>
    <header className="topbar"><div><div className="brand">GNS <span>CARGO</span></div><div className="subtitle">Ordre & transportstyring</div></div><button className="primary" onClick={() => setShowForm(!showForm)}>{showForm ? 'Lukk' : '+ Ny ordre'}</button></header>
    <section className="hero"><div><p className="eyebrow">CONTROL TOWER</p><h1>Transportoversikt</h1><p>Opprett, fordel og følg transportordre fra ett sted.</p></div><div className="stats"><div><b>{orders.length}</b><span>Ordre</span></div><div><b>{orders.filter(o=>o.status==='created').length}</b><span>Nye</span></div><div><b>{nok(orders.reduce((s,o)=>s+margin(o),0))}</b><span>Bruttomargin</span></div></div></section>
    {message && <div className="notice">{message}</div>}
    {showForm && <form className="orderForm" onSubmit={createOrder}>
      <h2>Ny transportordre</h2><p className="muted">Ordrenummer tildeles automatisk ved lagring.</p>
      <div className="grid">
        <label>Kunde<input required value={form.customer} onChange={e=>setForm({...form,customer:e.target.value})}/></label>
        <label>Gods<input value={form.goods} onChange={e=>setForm({...form,goods:e.target.value})} placeholder="F.eks. fersk laks"/></label>
        <label>Hentested<input value={form.pickup_name} onChange={e=>setForm({...form,pickup_name:e.target.value})}/></label>
        <label>Henteadresse<input value={form.pickup_address} onChange={e=>setForm({...form,pickup_address:e.target.value})}/></label>
        <label>Hentetid<input type="datetime-local" value={form.pickup_at} onChange={e=>setForm({...form,pickup_at:e.target.value})}/></label>
        <label>Leveringssted<input value={form.delivery_name} onChange={e=>setForm({...form,delivery_name:e.target.value})}/></label>
        <label>Leveringsadresse<input value={form.delivery_address} onChange={e=>setForm({...form,delivery_address:e.target.value})}/></label>
        <label>Leveringstid<input type="datetime-local" value={form.delivery_at} onChange={e=>setForm({...form,delivery_at:e.target.value})}/></label>
        <label>Paller<input type="number" value={form.pallets} onChange={e=>setForm({...form,pallets:e.target.value})}/></label>
        <label>Vekt kg<input type="number" value={form.weight_kg} onChange={e=>setForm({...form,weight_kg:e.target.value})}/></label>
        <label>Temperatur<input value={form.temperature} onChange={e=>setForm({...form,temperature:e.target.value})} placeholder="0–4 °C"/></label>
        <label>Transportør<input value={form.carrier_name} onChange={e=>setForm({...form,carrier_name:e.target.value})}/></label>
        <label>Transportør e-post<input type="email" value={form.carrier_email} onChange={e=>setForm({...form,carrier_email:e.target.value})}/></label>
        <label>Sjåfør<input value={form.driver_name} onChange={e=>setForm({...form,driver_name:e.target.value})}/></label>
        <label>Sjåfør telefon<input value={form.driver_phone} onChange={e=>setForm({...form,driver_phone:e.target.value})}/></label>
        <label>Registreringsnummer<input value={form.vehicle_registration} onChange={e=>setForm({...form,vehicle_registration:e.target.value})}/></label>
        <label>Innkjøpspris<input type="number" value={form.carrier_price} onChange={e=>setForm({...form,carrier_price:e.target.value})}/></label>
        <label>Salgspris<input type="number" value={form.customer_price} onChange={e=>setForm({...form,customer_price:e.target.value})}/></label>
      </div>
      <label>Instruksjoner<textarea value={form.instructions} onChange={e=>setForm({...form,instructions:e.target.value})}/></label>
      <button className="primary" disabled={saving}>{saving ? 'Lagrer…' : 'Opprett ordre'}</button>
    </form>}
    <section className="panel"><div className="panelHead"><div><h2>Ordre</h2><p>Seneste transportordre</p></div><button className="secondary" onClick={loadOrders}>Oppdater</button></div>
      {loading ? <p className="empty">Henter ordre…</p> : orders.length===0 ? <p className="empty">Ingen ordre ennå. Opprett den første ordren.</p> : <div className="tableWrap"><table><thead><tr><th>Ordre</th><th>Kunde</th><th>Rute</th><th>Transportør</th><th>Status</th><th>Margin</th></tr></thead><tbody>{orders.map(o=><tr key={o.id}><td><b>#{o.order_number}</b></td><td>{o.customer}</td><td>{o.pickup_name || '—'} <span className="arrow">→</span> {o.delivery_name || '—'}</td><td>{o.carrier_name || 'Ikke tildelt'}</td><td><span className="status">{o.status}</span></td><td>{nok(margin(o))}</td></tr>)}</tbody></table></div>}
    </section>
  </main>;
}
