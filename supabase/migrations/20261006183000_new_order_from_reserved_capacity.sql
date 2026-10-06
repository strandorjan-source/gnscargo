-- Keep a partially filled form in the browser; create the complete order and link it atomically.
alter table public.orders add column carrier_contact text, add column carrier_phone text, add column trailer_number text;

create or replace function private.link_capacity_order() returns trigger
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
 if (OLD.status<>'Ledig' and not (OLD.status='Reservert' and OLD.reserved_order_id is null)) or NEW.status<>'Reservert' or NEW.deleted_at is not null or NEW.reserved_order_id is null then
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
   vehicle_registration=NEW.registration, trailer_number=NEW.trailer_number, carrier_contact=NEW.contact, carrier_phone=NEW.phone, updated_at=clock_timestamp()
 where id=cargo.id;
 if not found then raise exception 'Ordren kunne ikke oppdateres.' using errcode='42501'; end if;
 -- Only the GNS reference is copied to the carrier-visible reservation.
 NEW.reservation_comment:=concat('GNS-',cargo.order_number,case when nullif(btrim(NEW.reservation_comment),'') is not null then E'\n'||btrim(NEW.reservation_comment) end);
 return NEW;
end;
$$;

create function public.create_cargo_order_from_capacity(p_vehicle_id uuid,p_reserved_at timestamptz,p_vehicle_updated_at timestamptz,p_order jsonb,p_stops jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare vehicle public.capacity_vehicles%rowtype; draft public.orders%rowtype; created public.orders%rowtype;
begin
 if auth.uid() is null or coalesce(private.capacity_current_role(),'') not in ('admin','dispatcher')
   or coalesce(public.current_user_role(),'') not in ('admin','dispatcher') then
   raise exception 'Du trenger tilgang til både Cargo og Capacity for å opprette denne ordren.' using errcode='42501';
 end if;
 select * into vehicle from public.capacity_vehicles where id=p_vehicle_id for update;
 if not found or vehicle.status<>'Reservert' or vehicle.deleted_at is not null or vehicle.reserved_at is distinct from p_reserved_at then
   raise exception 'Reservasjonen er frigitt, slettet eller endret. Reserver bilen på nytt i Capacity.' using errcode='40001';
 end if;
 -- A retry after a lost response must never create a second order.
 if vehicle.reserved_order_id is not null then
   select * into created from public.orders where id=vehicle.reserved_order_id;
   if not found then raise exception 'Ordren kan ikke leses med din tilgang.' using errcode='42501'; end if;
   return jsonb_build_object('id',created.id,'order_number',created.order_number,'reused',true);
 end if;
 if vehicle.updated_at is distinct from p_vehicle_updated_at then
   raise exception 'Bilopplysningene er endret. Hent bilen på nytt før du lagrer.' using errcode='40001';
 end if;
 if jsonb_typeof(p_order) is distinct from 'object' or jsonb_typeof(p_stops) is distinct from 'array' then
   raise exception 'Ugyldige ordreopplysninger.' using errcode='23514';
 end if;
 draft:=jsonb_populate_record(null::public.orders,p_order);
 if nullif(btrim(draft.customer),'') is null or nullif(btrim(draft.pickup_name),'') is null or draft.pickup_date is null then
   raise exception 'Kunde, hentested og hentedato må fylles ut.' using errcode='23514';
 end if;
 if exists(select 1 from jsonb_populate_recordset(null::public.order_stops,p_stops) x
   where x.stop_type is null or x.stop_type not in ('pickup','delivery') or x.stop_sequence is null or x.stop_sequence<1 or nullif(btrim(x.name),'') is null
    or (x.stop_type='pickup' and x.planned_date is null)) then
   raise exception 'Kontroller steder og datoer på ekstra stopp.' using errcode='23514';
 end if;
 insert into public.orders(customer,customer_reference,goods,pallets,weight_kg,temperature,
  pickup_name,pickup_address,pickup_contact,pickup_phone,pickup_date,pickup_at,
  delivery_name,delivery_address,delivery_contact,delivery_phone,delivery_at,
  carrier_name,carrier_email,carrier_contact,carrier_phone,vehicle_registration,trailer_number,
  driver_name,driver_phone,carrier_price,customer_price,instructions,created_by)
 values(btrim(draft.customer),draft.customer_reference,draft.goods,draft.pallets,draft.weight_kg,draft.temperature,
  btrim(draft.pickup_name),draft.pickup_address,draft.pickup_contact,draft.pickup_phone,draft.pickup_date,draft.pickup_at,
  draft.delivery_name,draft.delivery_address,draft.delivery_contact,draft.delivery_phone,draft.delivery_at,
  vehicle.carrier,draft.carrier_email,vehicle.contact,vehicle.phone,vehicle.registration,vehicle.trailer_number,
  draft.driver_name,draft.driver_phone,draft.carrier_price,draft.customer_price,draft.instructions,auth.uid()) returning * into created;
 insert into public.order_stops(order_id,stop_type,stop_sequence,name,address,contact_name,phone,planned_at,planned_date,goods,pallets,weight_kg,temperature,instructions)
 values(created.id,'pickup',1,created.pickup_name,created.pickup_address,created.pickup_contact,created.pickup_phone,created.pickup_at,created.pickup_date,created.goods,created.pallets,created.weight_kg,created.temperature,created.instructions);
 if nullif(btrim(created.delivery_name),'') is not null then
  insert into public.order_stops(order_id,stop_type,stop_sequence,name,address,contact_name,phone,planned_at,goods,pallets,weight_kg,instructions)
  values(created.id,'delivery',1,created.delivery_name,created.delivery_address,created.delivery_contact,created.delivery_phone,created.delivery_at,created.goods,created.pallets,created.weight_kg,created.instructions);
 end if;
 insert into public.order_stops(order_id,stop_type,stop_sequence,name,address,contact_name,phone,planned_at,planned_date,goods,pallets,weight_kg,temperature,instructions)
 select created.id,x.stop_type,x.stop_sequence,x.name,x.address,x.contact_name,x.phone,x.planned_at,x.planned_date,x.goods,x.pallets,x.weight_kg,
  case when x.stop_type='pickup' then x.temperature end,x.instructions
 from jsonb_populate_recordset(null::public.order_stops,p_stops) x where x.stop_sequence>1;
 update public.capacity_vehicles set reserved_order_id=created.id where id=vehicle.id;
 return jsonb_build_object('id',created.id,'order_number',created.order_number,'reused',false);
end;
$$;
revoke all on function public.create_cargo_order_from_capacity(uuid,timestamptz,timestamptz,jsonb,jsonb) from public,anon;
grant execute on function public.create_cargo_order_from_capacity(uuid,timestamptz,timestamptz,jsonb,jsonb) to authenticated;
