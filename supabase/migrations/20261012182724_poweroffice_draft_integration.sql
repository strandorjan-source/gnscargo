-- API secrets live in Vault, never in migrations or browser assets.
create table public.poweroffice_exports (
  order_id uuid not null references public.orders(id) on delete restrict,
  environment text not null check (environment in ('demo','production')),
  external_reference text not null unique,
  state text not null check (state in ('creating','draft','invoiced','paid','partially_paid','overpaid','reversed','uncertain','missing')),
  payload jsonb not null,
  source_revision bigint not null,
  created_by uuid not null references public.profiles(id),
  sales_order_id text, sales_order_number bigint,
  invoice_id text, invoice_number text, balance numeric(18,2), invoice_total numeric(18,2),
  invoice_date date, due_date date, error_message text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(), last_synced_at timestamptz,
  primary key (order_id, environment)
);
alter table public.poweroffice_exports enable row level security;
revoke all on public.poweroffice_exports from public,anon,authenticated;
grant select on public.poweroffice_exports to authenticated;
grant all on public.poweroffice_exports to service_role;
create policy poweroffice_staff_read on public.poweroffice_exports for select to authenticated
using (public.current_user_role() in ('admin','dispatcher'));

create function private.poweroffice_config() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  select decrypted_secret::jsonb into result from vault.decrypted_secrets where name='cargo_poweroffice_config';
  return result;
end $$;
revoke all on function private.poweroffice_config() from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.poweroffice_config() to service_role;
create function public.poweroffice_config() returns jsonb language sql security invoker set search_path='' as $$select private.poweroffice_config()$$;
revoke all on function public.poweroffice_config() from public,anon,authenticated;
grant execute on function public.poweroffice_config() to service_role;

create function public.poweroffice_claim_export(p_order_id uuid,p_environment text,p_user_id uuid,p_revision bigint,p_snapshot jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare current_order public.orders; item public.poweroffice_exports; claimed boolean:=false;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles where id=p_user_id and deleted_at is null and role in ('admin','dispatcher','superuser')) then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into current_order from public.orders where id=p_order_id for update;
  if not found or current_order.revision<>p_revision or current_order.status='cancelled' or current_order.customer_invoice_sent then raise exception 'Order changed' using errcode='40001'; end if;
  insert into public.poweroffice_exports(order_id,environment,external_reference,state,payload,source_revision,created_by)
    values(p_order_id,p_environment,'GNS-'||p_environment||'-'||p_order_id,'creating',p_snapshot,p_revision,p_user_id)
    on conflict(order_id,environment) do nothing returning * into item;
  if found then claimed:=true;
  else
    select * into item from public.poweroffice_exports where order_id=p_order_id and environment=p_environment for update;
    if item.state in ('uncertain','missing') or (item.state='creating' and item.updated_at<clock_timestamp()-interval '2 minutes') then
      -- Preserve the original snapshot on retries: the provider may have accepted it already.
      update public.poweroffice_exports set state='creating',updated_at=clock_timestamp() where order_id=p_order_id and environment=p_environment returning * into item;
      claimed:=true;
    end if;
  end if;
  return jsonb_build_object('claimed',claimed,'row',to_jsonb(item));
end $$;
revoke all on function public.poweroffice_claim_export(uuid,text,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.poweroffice_claim_export(uuid,text,uuid,bigint,jsonb) to service_role;
