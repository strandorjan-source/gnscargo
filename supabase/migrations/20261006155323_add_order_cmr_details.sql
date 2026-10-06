-- Applied through Supabase's migration API; the filename uses the returned migration version.
-- Existing orders policies continue to limit access to admin/dispatcher.
alter table public.orders add column if not exists cmr_details jsonb not null default '{}'::jsonb;
comment on column public.orders.cmr_details is 'CMR form details per selected pickup/delivery route; existing order RLS applies.';
