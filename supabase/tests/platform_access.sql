-- Uses synthetic identities only; every change is rolled back.
begin;
do $$
#variable_conflict use_variable
declare
 actor uuid := gen_random_uuid(); second_user uuid := gen_random_uuid(); carrier_user uuid := gen_random_uuid();
 vehicle uuid := gen_random_uuid(); order_id uuid := gen_random_uuid(); affected integer;
begin
 insert into auth.users(id,email,raw_user_meta_data)
 select id,id::text||'@gns-platform-test.invalid','{}'::jsonb from unnest(array[actor,second_user,carrier_user]) id;
 update public.profiles set role='admin' where id=actor;
 update public.profiles set role='dispatcher' where id=carrier_user;
 insert into public.capacity_profiles(user_id,email,full_name,role,approved)
 values(carrier_user,carrier_user::text||'@gns-platform-test.invalid','Test carrier','carrier',true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 -- The only administrator can bootstrap their own platform role.
 perform public.manage_platform_user(actor,'set_role','superuser');
 if public.current_user_role()<>'admin' or private.capacity_current_role()<>'admin' then raise exception 'Superuser does not have both roles'; end if;
 if public.platform_current_access()->>'role'<>'superuser' then raise exception 'Wrong own profile'; end if;
 begin
   perform public.manage_platform_user(actor,'remove'); raise exception 'Self deletion allowed';
 exception when insufficient_privilege then null; end;
 begin
   perform public.manage_platform_user(actor,'set_role','dispatcher'); raise exception 'Last superuser demotion allowed';
 exception when check_violation then null; end;
 begin
   update public.profiles set role='superuser' where id=second_user; raise exception 'Direct role change allowed';
 exception when insufficient_privilege then null; end;
 -- Full access uses real RLS policies, including order creation and Capacity booking.
 insert into public.orders(id,order_number,customer,pickup_name,pickup_date,vehicle_registration)
 values(order_id,-202610063,'Test platform','Test pickup','2026-10-08','QA123');
 insert into public.capacity_vehicles(id,owner_user_id,carrier,contact,registration,location,loading_region,available_at,vehicle_type,door_type)
 values(vehicle,actor,'Test GNS','Test','Q'||upper(substr(replace(vehicle::text,'-',''),1,10)),'Oslo','Sør-Norge',now()+interval '1 day','Termo','Bakdører');
 update public.capacity_vehicles set status='Reservert',reservation_comment='QA' where id=vehicle;
 if not exists(select 1 from public.capacity_vehicles where id=vehicle and reserved_by=actor and reserved_by_email is not null) then raise exception 'Superuser reservation identity missing'; end if;
 -- Multiple superusers, removal and immediate revocation with the same JWT.
 perform public.manage_platform_user(second_user,'set_role','superuser');
 perform set_config('request.jwt.claim.sub',second_user::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',second_user,'role','authenticated')::text,true);
 begin
   update public.capacity_profiles set approved=true where user_id=actor; raise exception 'Capacity can change platform override';
 exception when insufficient_privilege then null; end;
 perform public.manage_platform_user(actor,'remove');
 if not exists(select 1 from public.profiles where id=actor and deleted_at is not null and deleted_by=second_user) then raise exception 'Removal audit missing'; end if;
 if not exists(select 1 from public.orders where id=order_id) or not exists(select 1 from public.capacity_vehicles where id=vehicle and status='Reservert') then raise exception 'Historical data lost'; end if;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 if public.current_user_role() is not null or private.capacity_current_role() is not null then raise exception 'Removed user retains access'; end if;
 if exists(select 1 from public.orders where id=order_id) or exists(select 1 from public.capacity_vehicles where id=vehicle) then raise exception 'Removed user can read business data'; end if;
 begin
   perform public.manage_platform_user(actor,'set_role','superuser'); raise exception 'Removed user can reactivate';
 exception when insufficient_privilege then null; end;
 -- Normal dispatcher/carrier cannot elevate or remove other users.
 perform set_config('request.jwt.claim.sub',carrier_user::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',carrier_user,'role','authenticated')::text,true);
 if private.capacity_current_role()<>'carrier' then raise exception 'Normal Capacity approval changed'; end if;
 begin
   perform public.manage_platform_user(carrier_user,'set_role','superuser'); raise exception 'Self elevation allowed';
 exception when insufficient_privilege then null; end;
 begin
   perform public.manage_platform_user(second_user,'remove'); raise exception 'Non-admin removal allowed';
 exception when insufficient_privilege then null; end;
 if public.capacity_platform_users()<>'[]'::jsonb then raise exception 'Non-admin can list platform roles'; end if;
 execute 'reset role';
 raise notice 'PASS: platform admin access, last-superuser and self guards, direct-write denial, real order/Capacity RLS, reservation attribution, deletion, preserved history and immediate token revocation.';
end;
$$;
rollback;
