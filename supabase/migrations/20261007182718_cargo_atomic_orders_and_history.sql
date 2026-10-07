-- Additive rollout: old clients continue reading orders. No historical data is rewritten.
alter table public.orders
 add column assigned_to uuid references public.profiles(id) on delete set null,
 add column revision bigint not null default 1,
 add column create_request_id uuid unique,
 add column cancellation_reason text,
 add column cancelled_at timestamptz,
 add column cancelled_by uuid;
create index orders_assigned_pickup on public.orders(assigned_to,pickup_date);

-- Only the narrow staff directory is exposed, not the entire profile register.
create function private.cargo_staff_directory() returns table(id uuid,name text)
language sql stable security definer set search_path='' as $$
 select p.id,coalesce(nullif(p.full_name,''),p.email,'Bruker') from public.profiles p
 where auth.uid() is not null and public.current_user_role() in ('admin','dispatcher')
 and p.deleted_at is null and p.role in ('admin','dispatcher','superuser')
$$;
revoke all on function private.cargo_staff_directory() from public,anon;
grant execute on function private.cargo_staff_directory() to authenticated;
create function public.cargo_staff_directory() returns table(id uuid,name text)
language sql stable security invoker set search_path='' as $$ select * from private.cargo_staff_directory() $$;
revoke all on function public.cargo_staff_directory() from public,anon;
grant execute on function public.cargo_staff_directory() to authenticated;

create table public.order_activity(
 id bigint generated always as identity primary key,
 order_id uuid not null references public.orders(id) on delete restrict,
 entity text not null, entity_id uuid, action text not null,
 actor_id uuid, actor_name text not null, occurred_at timestamptz not null default clock_timestamp(),
 changes jsonb not null default '{}'
);
alter table public.order_activity enable row level security;
revoke all on public.order_activity from anon,authenticated;
grant select on public.order_activity to authenticated;
create policy activity_staff_read on public.order_activity for select to authenticated using (public.current_user_role() in ('admin','dispatcher'));
create index activity_order_time on public.order_activity(order_id,occurred_at desc);

-- Append-only history: callers cannot insert, edit or remove history themselves.
create function private.cargo_audit() returns trigger language plpgsql security definer set search_path='' as $$
declare b jsonb:='{}'; a jsonb:='{}'; d jsonb; oid uuid; eid uuid; who text;
begin
 if TG_OP<>'INSERT' then b:=to_jsonb(OLD); end if;
 if TG_OP<>'DELETE' then a:=to_jsonb(NEW); end if;
 oid:=case when TG_TABLE_NAME='orders' then coalesce(a->>'id',b->>'id')::uuid else coalesce(a->>'order_id',b->>'order_id')::uuid end;
 eid:=coalesce(a->>'id',b->>'id')::uuid;
 select jsonb_object_agg(k,jsonb_build_object('before',b->k,'after',a->k)) into d
 from (select jsonb_object_keys(a||b) k) f where a->k is distinct from b->k and k not in ('updated_at','revision','create_request_id');
 if d is null then return coalesce(NEW,OLD); end if;
 select coalesce(nullif(p.full_name,''),p.email,'Bruker') into who from public.profiles p where p.id=auth.uid();
 if who is null then select coalesce(nullif(p.full_name,''),p.email,'Transportør') into who from public.capacity_profiles p where p.user_id=auth.uid(); end if;
 insert into public.order_activity(order_id,entity,entity_id,action,actor_id,actor_name,changes)
 values(oid,TG_TABLE_NAME,eid,TG_OP,auth.uid(),coalesce(who,case when auth.uid() is null then 'System' else 'Bruker' end),d);
 return coalesce(NEW,OLD);
end $$;
revoke all on function private.cargo_audit() from public,anon,authenticated;
create trigger cargo_orders_audit after insert or update on public.orders for each row execute function private.cargo_audit();
create trigger cargo_stops_audit after insert or update or delete on public.order_stops for each row execute function private.cargo_audit();

create function private.cargo_revision() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if TG_OP='INSERT' then NEW.revision:=1; else NEW.revision:=OLD.revision+1; end if;
 if (TG_OP='INSERT' and NEW.assigned_to is not null) or (TG_OP='UPDATE' and NEW.assigned_to is distinct from OLD.assigned_to) then
  if NEW.assigned_to is not null and not exists(select 1 from public.cargo_staff_directory() d where d.id=NEW.assigned_to) then
   raise exception 'Velg en aktiv befrakter.' using errcode='23514';
  end if;
 end if;
 if NEW.status='cancelled' and (TG_OP='INSERT' or OLD.status is distinct from NEW.status) then
  if nullif(btrim(NEW.cancellation_reason),'') is null then raise exception 'Kansellering krever begrunnelse.' using errcode='23514'; end if;
  NEW.cancelled_at:=clock_timestamp(); NEW.cancelled_by:=auth.uid();
 end if;
 return NEW;
end $$;
revoke all on function private.cargo_revision() from public,anon,authenticated;
create trigger cargo_orders_revision before insert or update on public.orders for each row execute function private.cargo_revision();
-- Direct stop changes also invalidate any editor's snapshot.
create function private.cargo_stop_revision() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if TG_OP='UPDATE' and OLD.order_id<>NEW.order_id then raise exception 'Stopp kan ikke flyttes til en annen ordre.' using errcode='23514'; end if;
 update public.orders set updated_at=clock_timestamp() where id=coalesce(NEW.order_id,OLD.order_id);
 return coalesce(NEW,OLD);
end $$;
revoke all on function private.cargo_stop_revision() from public,anon,authenticated;
create trigger cargo_stop_revision before insert or update or delete on public.order_stops for each row execute function private.cargo_stop_revision();

create function public.save_cargo_order(p_id uuid,p_expected_revision bigint,p_request_id uuid,p_order jsonb,p_stops jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare before_row public.orders%rowtype; saved public.orders%rowtype; draft public.orders%rowtype; fields text; assignments text; x jsonb; st public.order_stops%rowtype; stop_ids uuid[]:='{}';
 allowed text[]:=array['customer','customer_reference','pickup_name','pickup_address','pickup_contact','pickup_phone','pickup_date','pickup_at','delivery_name','delivery_address','delivery_contact','delivery_phone','delivery_at','goods','pallets','weight_kg','temperature','instructions','carrier_id','carrier_name','carrier_email','driver_name','driver_phone','vehicle_registration','carrier_price','customer_price','carrier_contact','carrier_phone','trailer_number','customer_base_price','customer_diesel_percent','assigned_to','status','cancellation_reason','cmr_details','carrier_invoice_received','carrier_invoice_received_at','customer_invoice_sent','customer_invoice_sent_at','carrier_invoice_number','customer_invoice_number'];
begin
 if auth.uid() is null or coalesce(public.current_user_role(),'') not in ('admin','dispatcher') then raise exception 'Ingen tilgang.' using errcode='42501'; end if;
 if jsonb_typeof(p_order) is distinct from 'object' or p_order='{}'::jsonb or exists(select 1 from jsonb_object_keys(p_order) k where not k=any(allowed)) then raise exception 'Ugyldige ordrefelt.' using errcode='23514'; end if;
 if p_id is null then
  if p_request_id is null or p_stops is null then raise exception 'Forespørsels-ID og stopp kreves.' using errcode='23514'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  select * into saved from public.orders where create_request_id=p_request_id;
  if found then
   if saved.created_by<>auth.uid() then raise exception 'Forespørsels-ID er i bruk.' using errcode='42501'; end if;
   return to_jsonb(saved)||jsonb_build_object('reused',true);
  end if;
  if not (p_order ? 'assigned_to') then p_order:=p_order||jsonb_build_object('assigned_to',auth.uid()); end if;
  p_order:=p_order||jsonb_build_object('status','created');
 else
  select * into before_row from public.orders where id=p_id for update;
  if not found then raise exception 'Ordren finnes ikke eller du mangler tilgang.' using errcode='42501'; end if;
  if p_expected_revision is null or before_row.revision<>p_expected_revision then raise exception 'Ordren er endret av en annen bruker. Lukk redigering og hent siste versjon før du lagrer. Dine endringer er ikke overskrevet.' using errcode='40001'; end if;
  if before_row.status='cancelled' then raise exception 'Ordren er kansellert. Historikken kan fortsatt leses.' using errcode='23514'; end if;
 end if;
 draft:=jsonb_populate_record(before_row,p_order);
 if p_stops is not null then
  if jsonb_typeof(p_stops)<>'array' or jsonb_array_length(p_stops)>100 then raise exception 'Ugyldige stopp.' using errcode='23514'; end if;
  if nullif(btrim(draft.customer),'') is null or nullif(btrim(draft.pickup_name),'') is null or draft.pickup_date is null or nullif(btrim(draft.vehicle_registration),'') is null then raise exception 'Kunde, hentested, dato og registreringsnummer må fylles ut.' using errcode='23514'; end if;
  if not exists(select 1 from jsonb_array_elements(p_stops) z where z->>'stop_type'='pickup' and (z->>'stop_sequence')::int=1) then raise exception 'Primært hentested mangler.' using errcode='23514'; end if;
  if exists(select 1 from jsonb_array_elements(p_stops) z group by z->>'stop_type',z->>'stop_sequence' having count(*)>1) then raise exception 'To stopp har samme rekkefølge.' using errcode='23514'; end if;
 end if;
 select string_agg(format('%I',k),','),string_agg(format('%I = d.%I',k,k),',') into fields,assignments from jsonb_object_keys(p_order) k;
 if p_id is null then
  execute format('insert into public.orders(%s,create_request_id) select %s,$2 from jsonb_populate_record(null::public.orders,$1) d returning *',fields,fields) into saved using p_order,p_request_id;
 else
  execute format('update public.orders o set %s from jsonb_populate_record(null::public.orders,$1) d where o.id=$2 returning o.*',assignments) into saved using p_order,p_id;
 end if;
 if p_stops is not null then
  for x in select value from jsonb_array_elements(p_stops) loop
   st:=jsonb_populate_record(null::public.order_stops,x);
   if st.stop_type is null or st.stop_type not in ('pickup','delivery') or st.stop_sequence is null or st.stop_sequence<1 or nullif(btrim(st.name),'') is null or (st.stop_type='pickup' and st.planned_date is null) then raise exception 'Kontroller navn, dato og rekkefølge på alle stopp.' using errcode='23514'; end if;
   if st.id is not null and not exists(select 1 from public.order_stops os where os.id=st.id and os.order_id=saved.id) then raise exception 'Stoppet tilhører ikke denne ordren.' using errcode='42501'; end if;
   if st.id is null then select os.id into st.id from public.order_stops os where os.order_id=saved.id and os.stop_type=st.stop_type and os.stop_sequence=st.stop_sequence order by os.created_at limit 1; end if;
   st.id:=coalesce(st.id,gen_random_uuid());
   insert into public.order_stops(id,order_id,stop_type,stop_sequence,name,address,contact_name,phone,planned_at,planned_date,goods,pallets,weight_kg,temperature,instructions,customer_reference)
   values(st.id,saved.id,st.stop_type,st.stop_sequence,st.name,st.address,st.contact_name,st.phone,st.planned_at,st.planned_date,st.goods,st.pallets,st.weight_kg,case when st.stop_type='pickup' then st.temperature end,st.instructions,st.customer_reference)
   on conflict(id) do update set stop_type=excluded.stop_type,stop_sequence=excluded.stop_sequence,name=excluded.name,address=excluded.address,contact_name=excluded.contact_name,phone=excluded.phone,planned_at=excluded.planned_at,planned_date=excluded.planned_date,goods=excluded.goods,pallets=excluded.pallets,weight_kg=excluded.weight_kg,temperature=excluded.temperature,instructions=excluded.instructions,customer_reference=excluded.customer_reference,updated_at=clock_timestamp();
   stop_ids:=array_append(stop_ids,st.id);
  end loop;
  delete from public.order_stops where order_id=saved.id and not(id=any(stop_ids));
 end if;
 select * into saved from public.orders where id=saved.id;
 return to_jsonb(saved)||jsonb_build_object('reused',false);
end $$;
revoke all on function public.save_cargo_order(uuid,bigint,uuid,jsonb,jsonb) from public,anon;
grant execute on function public.save_cargo_order(uuid,bigint,uuid,jsonb,jsonb) to authenticated;
-- Historical records are retained; privileged maintenance remains outside the app.
-- Orders cannot be removed once related append-only history exists (FK RESTRICT).

create function public.cargo_order_snapshot(p_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 select to_jsonb(o)||jsonb_build_object('stops',coalesce((select jsonb_agg(to_jsonb(st) order by st.stop_type,st.stop_sequence) from public.order_stops st where st.order_id=o.id),'[]'::jsonb)) from public.orders o where o.id=p_id
$$;
revoke all on function public.cargo_order_snapshot(uuid) from public,anon;
grant execute on function public.cargo_order_snapshot(uuid) to authenticated;

revoke execute on function public.set_order_creator_snapshot() from public,anon,authenticated;
