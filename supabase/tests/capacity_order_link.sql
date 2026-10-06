begin;
do $$
#variable_conflict use_variable
declare actor uuid:=gen_random_uuid(); carrier_user uuid:=gen_random_uuid();
 first_vehicle uuid:=gen_random_uuid(); second_vehicle uuid:=gen_random_uuid(); test_order uuid:=gen_random_uuid();
 vehicle_time timestamptz; order_time timestamptz; carrier_id bigint;
begin
 insert into auth.users(id,email,raw_user_meta_data) select id,id::text||'@gns-link-test.invalid','{}'::jsonb from unnest(array[actor,carrier_user]) id;
 update public.profiles set role='superuser' where id=actor;
 insert into public.capacity_profiles(user_id,email,full_name,company,role,approved)
 values(actor,actor||'@gns-link-test.invalid','Test staff','Test GNS','admin',true),
 (carrier_user,carrier_user||'@gns-link-test.invalid','Test carrier','Link test carrier','carrier',true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 insert into public.carriers(name,email,phone) values('Link test '||test_order,'booking@example.invalid','12345678') returning id into carrier_id;
 begin
  insert into public.carriers(name) values('  link test '||test_order||'  '); raise exception 'Duplicate carrier permitted';
 exception when unique_violation then null; end;
 insert into public.orders(id,order_number,customer,pickup_name,pickup_phone,pickup_date,vehicle_registration,carrier_name,carrier_email,customer_price,carrier_price)
 values(test_order,-202610067,'PRIVATE CUSTOMER','Pickup','99887766',current_date+1,'OLD123','Old carrier','old@example.invalid',60000,40000) returning updated_at into order_time;
 -- Insert as each vehicle owner, respecting real RLS.
 perform set_config('request.jwt.claim.sub',carrier_user::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',carrier_user,'role','authenticated')::text,true);
 insert into public.capacity_vehicles(id,owner_user_id,carrier,contact,registration,location,loading_region,available_at,vehicle_type,door_type)
 select id,carrier_user,'Link test '||test_order,'Contact','Q'||upper(substr(replace(id::text,'-',''),1,10)),'Oslo','Sør-Norge',now()+interval '1 day','Termo','Bakdører' from unnest(array[first_vehicle,second_vehicle]) id;
 select updated_at into vehicle_time from public.capacity_vehicles where id=first_vehicle;
 if exists(select 1 from public.orders where id=test_order) or exists(select 1 from public.carriers where id=carrier_id) then raise exception 'Carrier can read internal data'; end if;
 begin
  perform public.reserve_capacity_for_order(first_vehicle,vehicle_time,test_order,order_time,null); raise exception 'Carrier could reserve';
 exception when insufficient_privilege then null; end;
 begin
  update public.capacity_vehicles set reserved_order_id=test_order where id=first_vehicle;
  -- A free vehicle must never retain a caller-supplied link.
  if exists(select 1 from public.capacity_vehicles where id=first_vehicle and reserved_order_id is not null) then raise exception 'Carrier forged order link'; end if;
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 select updated_at into vehicle_time from public.capacity_vehicles where id=first_vehicle;
 begin
  perform public.reserve_capacity_for_order(first_vehicle,vehicle_time,test_order,order_time-interval '1 second',null); raise exception 'Stale order accepted';
 exception when serialization_failure then null; end;
 if exists(select 1 from public.capacity_vehicles where id=first_vehicle and status<>'Ledig') then raise exception 'Failed booking was partly saved'; end if;
 perform public.reserve_capacity_for_order(first_vehicle,vehicle_time,test_order,order_time,'Test comment');
 if not exists(select 1 from public.orders where id=test_order and carrier_name='Link test '||test_order and carrier_email='booking@example.invalid' and vehicle_registration=(select registration from public.capacity_vehicles where id=first_vehicle) and customer_price=60000 and carrier_price=40000 and pickup_phone='99887766') then raise exception 'Order assignment incorrect'; end if;
 if not exists(select 1 from public.capacity_vehicle_overview where id=first_vehicle and reserved_order_id=test_order and reservation_comment=E'GNS--202610067\nTest comment') then raise exception 'Link or reference missing'; end if;
 select updated_at into order_time from public.orders where id=test_order;
 select updated_at into vehicle_time from public.capacity_vehicles where id=second_vehicle;
 begin
  perform public.reserve_capacity_for_order(second_vehicle,vehicle_time,test_order,order_time,null); raise exception 'Double booking allowed';
 exception when check_violation then null; end;
 update public.capacity_vehicles set status='Ledig' where id=first_vehicle;
 if exists(select 1 from public.capacity_vehicles where id=first_vehicle and reserved_order_id is not null) then raise exception 'Release did not unlink'; end if;
 if not exists(select 1 from public.capacity_vehicle_events where vehicle_id=first_vehicle and action='released' and before_data->>'reserved_order_id'=test_order::text) then raise exception 'Release lost history'; end if;
 perform public.reserve_capacity_for_order(second_vehicle,vehicle_time,test_order,order_time,null);
 perform set_config('request.jwt.claim.sub',carrier_user::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',carrier_user,'role','authenticated')::text,true);
 if exists(select 1 from public.capacity_vehicle_events where vehicle_id in (first_vehicle,second_vehicle) and (after_data::text like '%99887766%' or after_data::text like '%PRIVATE CUSTOMER%')) then raise exception 'Private order information leaked'; end if;
 begin
  update public.capacity_vehicles set reserved_order_id=null where id=second_vehicle; raise exception 'Carrier changed link';
 exception when insufficient_privilege then null; end;
 execute 'reset role';
end;
$$;
rollback;
select 'PASS: carrier register uniqueness, real role checks, atomic order assignment, stale-write rollback, duplicate booking prevention, release/rebook, audit history and no private data in carrier events' as result;
