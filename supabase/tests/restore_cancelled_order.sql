-- All users and orders below are synthetic and rolled back.
begin;
do $test$
declare
  staff uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  target uuid := gen_random_uuid();
  legacy uuid;
  rev bigint;
  already_billed boolean;
  status_after text;
begin
  insert into auth.users(id,email,raw_user_meta_data)
    values (staff,staff::text||'@cargo-test.invalid','{}'), (outsider,outsider::text||'@cargo-test.invalid','{}');
  update public.profiles set role='dispatcher' where id=staff;
  perform set_config('request.jwt.claim.sub',staff::text,true);
  perform set_config('request.jwt.claims',json_build_object('sub',staff,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  insert into public.orders(id,order_number,customer,status,customer_price,customer_base_price,carrier_price,
    carrier_invoice_received,customer_invoice_sent,pickup_name,pickup_date,vehicle_registration)
    values(target,-91001,'TEST','delivered',109,109,100,false,false,'Test',current_date,'TEST') returning revision into rev;

  perform public.save_cargo_order(target,rev,null,'{"customer_invoice_sent":true}',null);
  select revision into strict rev from public.orders where id=target and customer_invoice_sent and not carrier_invoice_received;
  perform public.save_cargo_order(target,rev,null,'{"status":"cancelled","cancellation_reason":"Test cancellation"}',null);
  select revision into strict rev from public.orders where id=target and status='cancelled' and cancelled_by=staff;

  begin
    perform public.restore_cargo_order(target,rev-1);
    raise exception 'Stale restore accepted';
  exception when serialization_failure then null; end;
  begin
    perform public.save_cargo_order(target,rev,null,'{"status":"created"}',null);
    raise exception 'Ordinary edit reopened a cancelled order';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claim.sub',outsider::text,true);
  perform set_config('request.jwt.claims',json_build_object('sub',outsider,'role','authenticated')::text,true);
  begin
    perform public.restore_cargo_order(target,rev);
    raise exception 'Non-staff restore accepted';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',staff::text,true);
  perform set_config('request.jwt.claims',json_build_object('sub',staff,'role','authenticated')::text,true);
  status_after := public.restore_cargo_order(target,rev);
  if status_after is distinct from 'delivered' or not exists(
    select from public.orders where id=target and order_number=-91001 and revision=rev+1 and status='delivered'
      and cancelled_at is null and cancelled_by is null and cancellation_reason is null
      and customer_invoice_sent and not carrier_invoice_received and carrier_invoice_received_at is null
      and customer_price=109 and carrier_price=100
  ) then raise exception 'Restore changed original details'; end if;
  if not exists(select from public.order_activity where order_id=target and actor_id=staff
    and changes #>> '{status,before}'='cancelled' and changes #>> '{status,after}'='delivered'
    and changes #>> '{cancellation_reason,before}'='Test cancellation') then raise exception 'Missing restoration history'; end if;
  begin
    perform public.restore_cargo_order(target,rev+1);
    raise exception 'Second restore accepted';
  exception when check_violation then null; end;

  foreach already_billed in array array[false,true] loop
    insert into public.orders(order_number,customer,status,cancellation_reason,customer_invoice_sent,pickup_name,pickup_date,vehicle_registration)
      values(case when already_billed then -91002 else -91003 end,'TEST','cancelled','Legacy',already_billed,'Test',current_date,'TEST')
      returning id,revision into legacy,rev;
    status_after := public.restore_cargo_order(legacy,rev);
    if status_after is distinct from (case when already_billed then 'invoiced' else 'created' end) then
      raise exception 'Incorrect legacy status';
    end if;
  end loop;
  execute 'reset role';
end $test$;
rollback;
select 'PASS: billing without carrier receipt, protected restoration, prior status, history and legacy orders' as result;
