-- Synthetic users and orders only; the complete transaction is rolled back.
begin;
do $$
declare actor uuid:=gen_random_uuid(); request uuid:=gen_random_uuid(); saved jsonb; again jsonb; oid uuid; rev bigint; payload jsonb; stops jsonb;
begin
 insert into auth.users(id,email,raw_user_meta_data) values(actor,actor::text||'@cargo-operations-test.invalid','{}');
 update public.profiles set role='dispatcher' where id=actor;
 perform set_config('request.jwt.claim.sub',actor::text,true); perform set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true); execute 'set local role authenticated';
 payload:=jsonb_build_object('customer','TEST ONLY','pickup_name','Test pickup','pickup_date','2026-10-07','vehicle_registration','TESTONLY','customer_base_price',40000,'customer_diesel_percent',9,'customer_price',43600);
 stops:='[{"stop_type":"pickup","stop_sequence":1,"name":"Test pickup","planned_date":"2026-10-07"}]';
 saved:=public.save_cargo_order(null,null,request,payload,stops); oid:=(saved->>'id')::uuid; rev:=(saved->>'revision')::bigint;
 if saved->>'assigned_to'<>actor::text then raise exception 'Assignment missing'; end if;
 again:=public.save_cargo_order(null,null,request,payload,stops); if again->>'id'<>saved->>'id' or not(again->>'reused')::boolean then raise exception 'Retry duplicated order'; end if;
 saved:=public.save_cargo_order(oid,rev,null,'{"goods":"Updated"}',null);
 begin perform public.save_cargo_order(oid,rev,null,'{"goods":"Stale edit"}',null); raise exception 'Stale edit accepted'; exception when serialization_failure then null; end;
 rev:=(saved->>'revision')::bigint;
 begin perform public.save_cargo_order(oid,rev,null,payload||'{"goods":"Should roll back"}',stops||'[{"stop_type":"pickup","stop_sequence":2,"name":"Missing date"}]'); raise exception 'Invalid stop accepted'; exception when check_violation then null; end;
 if (select goods from public.orders where id=oid)<>'Updated' then raise exception 'Order partially saved'; end if;
 if (select count(*) from public.order_stops where order_id=oid)<>1 then raise exception 'Stops partially saved'; end if;
 if not exists(select 1 from public.order_activity where order_id=oid and actor_id=actor) then raise exception 'Missing audit'; end if;
 begin delete from public.order_activity where order_id=oid; raise exception 'History deletable'; exception when insufficient_privilege then null; end;
 begin perform public.save_cargo_order(oid,rev,null,'{"status":"cancelled"}',null); raise exception 'Reasonless cancellation'; exception when check_violation then null; end;
 saved:=public.save_cargo_order(oid,rev,null,'{"status":"cancelled","cancellation_reason":"Test cancellation"}',null);
 if saved->>'cancelled_by'<>actor::text then raise exception 'Cancellation actor missing'; end if;
 begin delete from public.orders where id=oid; raise exception 'Order permanently deletable'; exception when insufficient_privilege then null; end;
 execute 'reset role';
end $$;
rollback;
select 'PASS: atomic save/rollback, retry, optimistic concurrency, assignment, protected audit and cancellation' as result;
