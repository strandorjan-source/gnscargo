-- Ordinary carrier_price is preserved. Diesel is a separate agreed surcharge.
ALTER TABLE public.orders
  ADD COLUMN carrier_diesel_percent numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN carrier_diesel_amount numeric GENERATED ALWAYS AS
    (round(coalesce(carrier_price,0) * carrier_diesel_percent / 100,2)) STORED,
  ADD COLUMN carrier_total_price numeric GENERATED ALWAYS AS
    (carrier_price + round(coalesce(carrier_price,0) * carrier_diesel_percent / 100,2)) STORED,
  ADD CONSTRAINT orders_carrier_diesel_percent_range CHECK (carrier_diesel_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT orders_carrier_diesel_requires_base CHECK
    (carrier_diesel_percent = 0 OR (carrier_price IS NOT NULL AND carrier_price BETWEEN 0 AND 9999999999.99));
COMMENT ON COLUMN public.orders.carrier_price IS 'Ordinary agreed carrier freight, excluding carrier diesel surcharge. Never replace with payable total.';
COMMENT ON COLUMN public.orders.carrier_diesel_percent IS 'Separately agreed carrier diesel percentage of ordinary carrier_price. Independent of customer diesel.';
COMMENT ON COLUMN public.orders.carrier_total_price IS 'Ordinary carrier_price plus carrier diesel, before any VAT. Read-only generated value.';
DO $migration$
DECLARE definition text; needle text;
BEGIN
  definition := pg_get_functiondef('public.save_cargo_order(uuid,bigint,uuid,jsonb,jsonb)'::regprocedure);
  needle := '''carrier_price'',''customer_price''';
  IF position(needle IN definition) = 0 THEN RAISE EXCEPTION 'Unexpected save_cargo_order definition; migration stopped.'; END IF;
  definition := replace(definition, needle, '''carrier_price'',''carrier_diesel_percent'',''customer_price''');
  EXECUTE definition;
  definition := pg_get_functiondef('public.create_cargo_order_from_capacity_with_pricing(uuid,timestamptz,timestamptz,jsonb,jsonb)'::regprocedure);
  needle := 'update public.orders set customer_base_price=';
  IF position(needle IN definition) = 0 THEN RAISE EXCEPTION 'Unexpected Capacity pricing function; migration stopped.'; END IF;
  definition := replace(definition, needle, 'update public.orders set carrier_diesel_percent=coalesce(nullif(p_order->>''carrier_diesel_percent'','''')::numeric,0),customer_base_price=');
  EXECUTE definition;
END $migration$;
NOTIFY pgrst, 'reload schema';
