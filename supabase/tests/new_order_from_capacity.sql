begin;
do $$
#variable_conflict use_variable
declare actor uuid:=gen_random_uuid(); carrier_user uuid:=gen_random_uuid(); vehicle_id uuid:=gen_random_uuid();
 vehicle_time timestamptz; reservation_time timestamptz; result jsonb; retried jsonb; total_before bigint; draft jsonb;
begin
 insert into auth.users(id,email,raw_user_meta_data) select id,id::text||'@gns-new-order-test.invalid','{}'::jsonb from unnest(array[actor,carrier_user]) id;
 update public.profiles set role='superuser' where id=actor;
 insert into public.capacity_profiles(user_id,email,full_name,company,role,approved)
 values(actor,actor||'@gns-new-order-test.invalid','Test staff','GNS','admin',true),
 (carrier_user,carrier_user||'@gns-new-order-test.invalid','Carrier','Test carrier','carrier',true);
 perform set_config('request.jwt.claim.sub',carrier_user::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',carrier_user,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 insert into public.capacity_vehicles(id,owner_user_id,carrier,contact,phone,registration,trailer_number,location,loading_region,available_at,vehicle_type,door_type)
 values(vehicle_id,carrier_user,'New order carrier','Office contact','11223344','Q'||upper(substr(replace(vehicle_id::text,'-',''),1,10)),'TRAILER-QA','Oslo','Sør-Norge',now()+interval '1 day','Termo','Bakdører');
 begin
  perform public.create_cargo_order_from_capacity(vehicle_id,now(),now(),'{}'); raise exception 'Carrier could create linked order';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 update public.capacity_vehicles set status='Reservert',reservation_comment='Test load' where id=vehicle_id returning updated_at,reserved_at into vehicle_time,reservation_time;
 select count(*) into total_before from public.orders;
 begin
  perform public.create_cargo_order_from_capacity(vehicle_id,reservation_time,vehicle_time,'{}'); raise exception 'Incomplete order saved';
 exception when check_violation then null; end;
 if (select count(*) from public.orders)<>total_before then raise exception 'Incomplete order left a row'; end if;
 draft:=jsonb_build_object('customer','Private test customer','pickup_name','Test pickup','pickup_phone','99887766','pickup_date',(current_date+1)::text,'delivery_name','Delivery','goods','Fish','pallets',33,'carrier_price',40000,'customer_price',50000,'driver_name','Actual driver','carrier_name','Forged carrier','vehicle_registration','FORGED','created_by',carrier_user);
 begin
  perform public.create_cargo_order_from_capacity(vehicle_id,reservation_time,vehicle_time-interval '1 second',draft); raise exception 'Stale vehicle accepted';
 exception when serialization_failure then null; end;
 begin
  perform public.create_cargo_order_from_capacity(vehicle_id,reservation_time,vehicle_time,draft,'[{"stop_type":"pickup","stop_sequence":2,"name":"Extra without date"}]'); raise exception 'Invalid extra pickup saved';
 exception when check_violation then null; end;
 result:=public.create_cargo_order_from_capacity(vehicle_id,reservation_time,vehicle_time,draft,
 jsonb_build_array(jsonb_build_object('stop_type','pickup','stop_sequence',2,'name','Extra','planned_date',(current_date+1)::text,'phone','88776655')));
 if result->>'reused'<>'false' then raise exception 'New order marked reused'; end if;
 if not exists(select 1 from public.orders where id=(result->>'id')::uuid and carrier_name='New order carrier' and carrier_contact='Office contact' and carrier_phone='11223344' and trailer_number='TRAILER-QA' and driver_name='Actual driver' and created_by=actor and carrier_price=40000 and customer_price=50000 and pickup_phone='99887766') then raise exception 'Incomplete or spoofed order'; end if;
 if (select count(*) from public.order_stops where order_id=(result->>'id')::uuid)<>3 then raise exception 'Stops missing'; end if;
 if not exists(select 1 from public.capacity_vehicles where id=vehicle_id and reserved_order_id=(result->>'id')::uuid and reserved_at=reservation_time and reserved_by=actor and reservation_comment like 'GNS-%') then raise exception 'Reservation link or attribution changed'; end if;
 retried:=public.create_cargo_order_from_capacity(vehicle_id,reservation_time,vehicle_time,draft);
 if retried->>'id'<>result->>'id' or retried->>'reused'<>'true' or (select count(*) from public.orders)<>total_before+1 then raise exception 'Duplicate order on retry'; end if;
 update public.capacity_vehicles set status='Ledig' where id=vehicle_id;
 begin
  perform public.create_cargo_order_from_capacity(vehicle_id,reservation_time,vehicle_time,draft); raise exception 'Released reservation accepted';
 exception when serialization_failure then null; end;
 update public.capacity_vehicles set status='Reservert' where id=vehicle_id;
 begin
  perform public.create_cargo_order_from_capacity(vehicle_id,reservation_time,vehicle_time,draft); raise exception 'Old reservation token accepted after rebook';
 exception when serialization_failure then null; end;
 perform set_config('request.jwt.claim.sub',carrier_user::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',carrier_user,'role','authenticated')::text,true);
 if exists(select 1 from public.orders where id=(result->>'id')::uuid) then raise exception 'Carrier can read internal order'; end if;
 if exists(select 1 from public.capacity_vehicle_events e where e.vehicle_id=vehicle_id and (after_data::text like '%99887766%' or after_data::text like '%Private test customer%')) then raise exception 'Private data leaked to events'; end if;
 execute 'reset role';
end;
$$;
rollback;
select 'PASS: new order plus stops and reservation link, incomplete/stale/released reservation rejection, contact/trailer transfer, server identity, idempotent retry and carrier privacy' as result;
