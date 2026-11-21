create extension if not exists pg_cron;
create schema poweroffice_http;
revoke all on schema poweroffice_http from public,anon,authenticated;
create extension http with schema poweroffice_http;

alter table public.poweroffice_exports
  add column provider_sent_at timestamptz,
  add column invoice_checked_at timestamptz;
create index poweroffice_pending_send_check on public.poweroffice_exports
  (invoice_checked_at asc nulls first, order_id)
  where environment='production' and provider_sent_at is null;

-- Apply the provider confirmation and order edit in the same transaction.
-- The normal order triggers handle revision conflicts and record the system edit.
create function private.mark_poweroffice_invoice_sent() returns trigger
language plpgsql security invoker set search_path='' as $$
declare
  target public.orders;
  new_revision bigint;
begin
  if new.environment <> 'production' or new.provider_sent_at is null
     or new.state not in ('invoiced','partially_paid','paid','overpaid')
     or nullif(new.invoice_id,'') is null or new.invoice_number !~ '^[1-9][0-9]*$'
     or new.invoice_number is null then return new; end if;
  select * into target from public.orders where id=new.order_id for update;
  if not found or target.status='cancelled' then return new; end if;
  if nullif(btrim(target.customer_invoice_number),'') is not null
     and btrim(target.customer_invoice_number) <> new.invoice_number then
    new.error_message := 'Fakturanummeret i Cargo avviker fra PowerOffice. Kontroller ordren.';
    return new;
  end if;
  if target.customer_invoice_sent and target.customer_invoice_number=new.invoice_number then return new; end if;
  update public.orders set customer_invoice_sent=true,
    customer_invoice_sent_at=case when target.customer_invoice_sent then coalesce(target.customer_invoice_sent_at,new.provider_sent_at) else new.provider_sent_at end,
    customer_invoice_number=new.invoice_number
    where id=target.id returning revision into new_revision;
  if new.source_revision=target.revision then new.source_revision:=new_revision; end if;
  return new;
end $$;
revoke all on function private.mark_poweroffice_invoice_sent() from public,anon,authenticated;
create trigger poweroffice_confirm_sent before update of provider_sent_at
  on public.poweroffice_exports for each row execute function private.mark_poweroffice_invoice_sent();

-- This credential can only request a provider lookup. It grants no database or invoice-creation rights.
select vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text, 'cargo_poweroffice_poll_token')
where not exists(select 1 from vault.secrets where name='cargo_poweroffice_poll_token');

create or replace function private.poweroffice_config() returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  select decrypted_secret::jsonb into result from vault.decrypted_secrets where name='cargo_poweroffice_config';
  return result || jsonb_build_object('pollToken',
    (select decrypted_secret from vault.decrypted_secrets where name='cargo_poweroffice_poll_token'));
end $$;

create function private.schedule_poweroffice_send_check() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  response poweroffice_http.http_response;
begin
  if not exists (
    select 1 from public.poweroffice_exports e join public.orders o on o.id=e.order_id
    where e.environment='production' and e.provider_sent_at is null
      and not o.customer_invoice_sent and o.status <> 'cancelled'
  ) then return null; end if;
  perform poweroffice_http.http_set_curlopt('CURLOPT_TIMEOUT_MS','80000');
  perform poweroffice_http.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS','5000');
  -- Send directly to the Cargo function, keeping the credential out of HTTP queues and cron command text.
  response := poweroffice_http.http(('POST',
    'https://lpovhfipxoeqqnfnipia.supabase.co/functions/v1/poweroffice',
    array[poweroffice_http.http_header('X-Cargo-Poll-Token',
      (select decrypted_secret from vault.decrypted_secrets where name='cargo_poweroffice_poll_token'))],
    'application/json','{"action":"pollSent"}')::poweroffice_http.http_request);
  if response.status<>200 then raise exception 'PowerOffice background check returned HTTP %',response.status; end if;
  return response.content::jsonb;
end $$;
revoke all on function private.schedule_poweroffice_send_check() from public,anon,authenticated,service_role;
select cron.schedule('cargo-poweroffice-sent','*/2 * * * *','select private.schedule_poweroffice_send_check()');
