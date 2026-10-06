-- Non-secret recipient preference. Existing Cargo-only RLS remains authoritative.
alter table public.carriers add column edi_system text
  constraint carriers_edi_system_check check (edi_system in ('opter', 'timpex'));
comment on column public.carriers.edi_system is
  'Preferred receiving system; does not enable delivery. Endpoints and credentials must never be stored here.';
