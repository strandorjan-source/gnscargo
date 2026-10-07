create or replace function private.cargo_revision() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if TG_OP='INSERT' then NEW.revision:=1; else
  NEW.revision:=OLD.revision+1;
  if NEW.created_by is distinct from OLD.created_by or NEW.created_by_name is distinct from OLD.created_by_name or NEW.created_by_email is distinct from OLD.created_by_email or NEW.created_at is distinct from OLD.created_at or NEW.create_request_id is distinct from OLD.create_request_id or NEW.order_number is distinct from OLD.order_number then raise exception 'Opphav og ordrenummer kan ikke endres.' using errcode='23514'; end if;
  if OLD.status='cancelled' and NEW.status is distinct from OLD.status then raise exception 'Kansellerte ordre kan ikke gjenåpnes gjennom vanlig redigering.' using errcode='23514'; end if;
 end if;
 if(TG_OP='INSERT' and NEW.assigned_to is not null) or(TG_OP='UPDATE' and NEW.assigned_to is distinct from OLD.assigned_to) then
  if NEW.assigned_to is not null and not exists(select 1 from public.cargo_staff_directory() d where d.id=NEW.assigned_to) then raise exception 'Velg en aktiv befrakter.' using errcode='23514'; end if;
 end if;
 if NEW.status='cancelled' and(TG_OP='INSERT' or OLD.status is distinct from NEW.status) then
  if nullif(btrim(NEW.cancellation_reason),'') is null then raise exception 'Kansellering krever begrunnelse.' using errcode='23514'; end if;
  NEW.cancelled_at:=clock_timestamp();NEW.cancelled_by:=auth.uid();
 elsif TG_OP='UPDATE' then
  if NEW.cancelled_at is distinct from OLD.cancelled_at or NEW.cancelled_by is distinct from OLD.cancelled_by or NEW.cancellation_reason is distinct from OLD.cancellation_reason then raise exception 'Kanselleringsopplysninger er låst.' using errcode='23514'; end if;
 end if;
 return NEW;
end $$;
create or replace function public.create_cargo_order_from_capacity_with_pricing(p_vehicle_id uuid,p_reserved_at timestamptz,p_vehicle_updated_at timestamptz,p_order jsonb,p_stops jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 result:=public.create_cargo_order_from_capacity(p_vehicle_id,p_reserved_at,p_vehicle_updated_at,p_order,p_stops);
 if coalesce((result->>'reused')::boolean,false) then return result; end if;
 update public.orders set customer_base_price=nullif(p_order->>'customer_base_price','')::numeric,customer_diesel_percent=coalesce(nullif(p_order->>'customer_diesel_percent','')::numeric,0),customer_price=nullif(p_order->>'customer_price','')::numeric,assigned_to=auth.uid() where id=(result->>'id')::uuid;
 if not found then raise exception 'Kundepris og ansvar kunne ikke lagres. Ordren er ikke opprettet.' using errcode='42501'; end if;
 return result;
end $$;
create function private.cargo_note_origin() returns trigger language plpgsql security invoker set search_path='' as $$ begin NEW.created_by:=auth.uid();NEW.created_at:=clock_timestamp();return NEW;end $$;
revoke all on function private.cargo_note_origin() from public,anon,authenticated;
create trigger note_origin before insert on public.order_notes for each row execute function private.cargo_note_origin();
notify pgrst,'reload schema';
