-- Customer price remains the total for existing margin and invoice reporting.
-- Legacy orders retain their recorded price and receive no automatic surcharge.
alter table public.orders
  add column customer_base_price numeric(12,2),
  add column customer_diesel_percent numeric(5,2) not null default 0,
  add column customer_diesel_amount numeric generated always as
    (round(coalesce(customer_base_price,0) * customer_diesel_percent / 100,2)) stored,
  add constraint orders_customer_diesel_percent_range check (customer_diesel_percent between 0 and 100),
  add constraint orders_customer_base_price_range check (customer_base_price is null or customer_base_price between 0 and 9999999999.99),
  add constraint orders_customer_pricing_consistent check (
    (customer_base_price is null and customer_diesel_percent = 0)
    or
    (customer_base_price is not null and customer_price is not null
     and customer_price = customer_base_price + round(customer_base_price * customer_diesel_percent / 100,2))
  );
comment on column public.orders.customer_base_price is 'Customer freight before diesel surcharge, NOK. NULL on legacy orders; customer_price then remains the recorded total.';
comment on column public.orders.customer_diesel_percent is 'Optional diesel surcharge as percent of customer_base_price. Zero means no surcharge.';
comment on column public.orders.customer_diesel_amount is 'Diesel surcharge in NOK, rounded to two decimals by the database.';

-- Reuse the existing authorized/idempotent Capacity operation. Persist the
-- breakdown in the same transaction, without changing its access checks.
create function public.create_cargo_order_from_capacity_with_pricing(
  p_vehicle_id uuid,
  p_reserved_at timestamptz,
  p_vehicle_updated_at timestamptz,
  p_order jsonb,
  p_stops jsonb default '[]'::jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  result := public.create_cargo_order_from_capacity(
    p_vehicle_id,p_reserved_at,p_vehicle_updated_at,p_order,p_stops
  );
  if coalesce((result->>'reused')::boolean,false) then return result; end if;
  update public.orders set
    customer_base_price = nullif(p_order->>'customer_base_price','')::numeric,
    customer_diesel_percent = coalesce(nullif(p_order->>'customer_diesel_percent','')::numeric,0),
    customer_price = nullif(p_order->>'customer_price','')::numeric
  where id = (result->>'id')::uuid;
  if not found then
    raise exception 'Kundeprisen kunne ikke lagres. Ordren er ikke opprettet.' using errcode='42501';
  end if;
  return result;
end;
$$;
revoke all on function public.create_cargo_order_from_capacity_with_pricing(uuid,timestamptz,timestamptz,jsonb,jsonb) from public,anon;
grant execute on function public.create_cargo_order_from_capacity_with_pricing(uuid,timestamptz,timestamptz,jsonb,jsonb) to authenticated;
