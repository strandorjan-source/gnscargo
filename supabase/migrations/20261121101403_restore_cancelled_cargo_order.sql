-- Keep ordinary edits locked on cancelled orders. Only the restore transaction
-- opens a scoped transition for its own order; the existing audit trigger logs it.
create or replace function private.cargo_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  restoring boolean := false;
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
  else
    new.revision := old.revision + 1;
    if new.created_by is distinct from old.created_by
       or new.created_by_name is distinct from old.created_by_name
       or new.created_by_email is distinct from old.created_by_email
       or new.created_at is distinct from old.created_at
       or new.create_request_id is distinct from old.create_request_id
       or new.order_number is distinct from old.order_number then
      raise exception 'Opphav og ordrenummer kan ikke endres.' using errcode='23514';
    end if;
    restoring := old.status = 'cancelled' and new.status is distinct from old.status;
    if restoring and (
      current_setting('cargo.restore_order_id', true) is distinct from old.id::text
      or auth.uid() is null or coalesce(public.current_user_role(),'') not in ('admin','dispatcher')
    ) then
      raise exception 'Bruk Gjenopprett ordre for en kansellert ordre.' using errcode='23514';
    end if;
  end if;
  if new.assigned_to is not null and (tg_op='INSERT' or new.assigned_to is distinct from old.assigned_to)
     and not exists(select 1 from public.cargo_staff_directory() d where d.id=new.assigned_to) then
    raise exception 'Velg en aktiv befrakter.' using errcode='23514';
  end if;
  if restoring then
    new.cancellation_reason := null;
    new.cancelled_at := null;
    new.cancelled_by := null;
  elsif new.status='cancelled' and (tg_op='INSERT' or old.status is distinct from new.status) then
    if nullif(btrim(new.cancellation_reason),'') is null then
      raise exception 'Kansellering krever begrunnelse.' using errcode='23514';
    end if;
    new.cancelled_at := clock_timestamp();
    new.cancelled_by := auth.uid();
  elsif tg_op='UPDATE' and (new.cancelled_at is distinct from old.cancelled_at
     or new.cancelled_by is distinct from old.cancelled_by or new.cancellation_reason is distinct from old.cancellation_reason) then
    raise exception 'Kanselleringsopplysninger er låst.' using errcode='23514';
  end if;
  return new;
end $$;

create function public.restore_cargo_order(p_id uuid, p_expected_revision bigint)
returns text language plpgsql security invoker
set search_path = '' as $$
declare
  target public.orders%rowtype;
  previous_status text;
  previous_guard text := current_setting('cargo.restore_order_id', true);
begin
  if auth.uid() is null or coalesce(public.current_user_role(),'') not in ('admin','dispatcher') then
    raise exception 'Ingen tilgang til å gjenopprette ordre.' using errcode='42501';
  end if;
  select * into target from public.orders where id=p_id for update;
  if not found then
    raise exception 'Ordren finnes ikke eller du mangler tilgang.' using errcode='42501';
  end if;
  if target.revision is distinct from p_expected_revision then
    raise exception 'Ordren er endret. Oppdater oversikten og prøv igjen.' using errcode='40001';
  end if;
  if target.status is distinct from 'cancelled' then
    raise exception 'Bare kansellerte ordre kan gjenopprettes.' using errcode='23514';
  end if;
  select changes #>> '{status,before}' into previous_status from public.order_activity
    where order_id=p_id and entity='orders' and changes #>> '{status,after}'='cancelled'
    order by id desc limit 1;
  if previous_status is null or previous_status not in ('created','sent','picked_up','delivered','invoiced') then
    previous_status := case when target.customer_invoice_sent then 'invoiced' else 'created' end;
  end if;
  perform set_config('cargo.restore_order_id', p_id::text, true);
  update public.orders set status=previous_status where id=p_id;
  if not found then raise exception 'Ingen tilgang til å gjenopprette ordre.' using errcode='42501'; end if;
  perform set_config('cargo.restore_order_id', coalesce(previous_guard,''), true);
  return previous_status;
end $$;
revoke all on function public.restore_cargo_order(uuid,bigint) from public, anon;
grant execute on function public.restore_cargo_order(uuid,bigint) to authenticated;
notify pgrst, 'reload schema';
