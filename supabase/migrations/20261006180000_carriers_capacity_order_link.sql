-- Internal registers and atomic linking of a Capacity reservation to a Cargo order.
create unique index carriers_name_normalized_key on public.carriers
  (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));
create unique index carriers_org_normalized_key on public.carriers
  (regexp_replace(btrim(org_number), '\s+', '', 'g')) where nullif(btrim(org_number),'') is not null;
alter table public.capacity_vehicles add column reserved_order_id uuid references public.orders(id) on delete restrict;
create unique index capacity_one_active_vehicle_per_order on public.capacity_vehicles(reserved_order_id)
  where status='Reservert' and deleted_at is null and reserved_order_id is not null;

-- Runs after the existing reservation guard; does not bypass either system's RLS.
create function private.link_capacity_order() returns trigger
language plpgsql security invoker set search_path='' as $$
declare cargo public.orders%rowtype; registered public.carriers%rowtype;
begin
 if TG_OP='INSERT' then
   if NEW.reserved_order_id is not null then raise exception 'Nye biler kan ikke ha en ordrekobling.' using errcode='23514'; end if;
   return NEW;
 end if;
 if NEW.status='Ledig' then NEW.reserved_order_id:=null; end if;
 if NEW.reserved_order_id is not distinct from OLD.reserved_order_id then return NEW; end if;
 if NEW.status='Ledig' and OLD.status='Reservert' then return NEW; end if;
 if auth.uid() is null or coalesce(private.capacity_current_role(),'') not in ('admin','dispatcher')
   or coalesce(public.current_user_role(),'') not in ('admin','dispatcher') then
   raise exception 'Du trenger tilgang til både GNS Cargo og Capacity for å koble ordre.' using errcode='42501';
 end if;
 if OLD.status<>'Ledig' or NEW.status<>'Reservert' or NEW.deleted_at is not null or NEW.reserved_order_id is null then
   raise exception 'Ordre velges når en ledig bil reserveres. Frigi bilen før du endrer koblingen.' using errcode='23514';
 end if;
 select * into cargo from public.orders where id=NEW.reserved_order_id for update;
 if not found then raise exception 'Ordren finnes ikke, eller du mangler tilgang.' using errcode='42501'; end if;
 if cargo.customer_invoice_sent or cargo.status in ('completed','cancelled','canceled','delivered') then
   raise exception 'Ordren er avsluttet eller fakturert. Velg et aktivt lass.' using errcode='23514';
 end if;
 select * into registered from public.carriers
   where lower(regexp_replace(btrim(name),'\s+',' ','g'))=lower(regexp_replace(btrim(NEW.carrier),'\s+',' ','g')) limit 1;
 update public.orders set carrier_id=registered.id, carrier_name=NEW.carrier,
   carrier_email=coalesce(registered.email,case when lower(btrim(carrier_name))=lower(btrim(NEW.carrier)) then carrier_email end),
   vehicle_registration=NEW.registration, updated_at=clock_timestamp()
 where id=cargo.id;
 if not found then raise exception 'Ordren kunne ikke oppdateres.' using errcode='42501'; end if;
 -- Only the GNS reference is copied to the carrier-visible reservation.
 NEW.reservation_comment:=concat('GNS-',cargo.order_number,case when nullif(btrim(NEW.reservation_comment),'') is not null then E'\n'||btrim(NEW.reservation_comment) end);
 return NEW;
end;
$$;
revoke all on function private.link_capacity_order() from public,anon;
create trigger link_capacity_order before insert or update on public.capacity_vehicles
 for each row execute function private.link_capacity_order();

create function public.reserve_capacity_for_order(p_vehicle_id uuid,p_vehicle_updated_at timestamptz,p_order_id uuid,p_order_updated_at timestamptz,p_comment text default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare vehicle public.capacity_vehicles%rowtype; cargo public.orders%rowtype;
begin
 if auth.uid() is null or coalesce(private.capacity_current_role(),'') not in ('admin','dispatcher')
   or coalesce(public.current_user_role(),'') not in ('admin','dispatcher') then
   raise exception 'Du trenger tilgang til både GNS Cargo og Capacity for å koble ordre.' using errcode='42501';
 end if;
 select * into vehicle from public.capacity_vehicles where id=p_vehicle_id for update;
 if not found or vehicle.status<>'Ledig' or vehicle.deleted_at is not null or vehicle.updated_at is distinct from p_vehicle_updated_at then
   raise exception 'Bilen er endret. Oppdater oversikten og prøv igjen.' using errcode='40001';
 end if;
 select * into cargo from public.orders where id=p_order_id for update;
 if not found or cargo.updated_at is distinct from p_order_updated_at then
   raise exception 'Ordren er endret. Hent lassene på nytt og velg ordren igjen.' using errcode='40001';
 end if;
 if exists(select 1 from public.capacity_vehicles where reserved_order_id=p_order_id and status='Reservert' and deleted_at is null) then
   raise exception 'Lasset er allerede knyttet til en reservert bil.' using errcode='23514';
 end if;
 if char_length(coalesce(p_comment,''))>1800 then raise exception 'Kommentaren kan ha maks 1800 tegn.' using errcode='23514'; end if;
 update public.capacity_vehicles set status='Reservert',reserved_order_id=p_order_id,reservation_comment=nullif(btrim(p_comment),'') where id=p_vehicle_id;
 return p_vehicle_id;
end;
$$;
revoke all on function public.reserve_capacity_for_order(uuid,timestamptz,uuid,timestamptz,text) from public,anon;
grant execute on function public.reserve_capacity_for_order(uuid,timestamptz,uuid,timestamptz,text) to authenticated;

-- Append the link while preserving the existing column order and history rules.
create or replace view public.capacity_vehicle_overview with(security_invoker=true) as
 select id,owner_user_id,carrier,contact,phone,registration,location,available_at,vehicle_type,direction,comment,
 status,reserved_by,reserved_at,created_at,updated_at,door_type,reservation_comment,reserved_by_name,reserved_by_email,
 deleted_at,deleted_by,
 deleted_at is not null or (available_at at time zone 'Europe/Oslo')::date <
 ((statement_timestamp() at time zone 'Europe/Oslo')::date-case when status='Reservert' and
 ((select private.capacity_current_role()))='carrier' then 3 else 0 end) as is_history,
 loading_region,trailer_number,reserved_order_id from public.capacity_vehicles;
