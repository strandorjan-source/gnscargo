-- The fixture is rolled back and never invokes PowerOffice.
begin;
do $test$
declare
  buyer_order uuid := gen_random_uuid();
  staff uuid;
  sent_time timestamptz := '2026-11-21 11:30:00+00';
  first_revision bigint;
  sent_revision bigint;
begin
  select id into strict staff from public.profiles where role in ('admin','dispatcher','superuser') limit 1;
  insert into public.orders(id,order_number,customer,pickup_name,pickup_date,vehicle_registration,status,carrier_invoice_received,customer_invoice_sent)
    values(buyer_order,-92971,'TEST','TEST',current_date,'TEST','delivered',false,false) returning revision into first_revision;
  insert into public.poweroffice_exports(order_id,environment,external_reference,state,payload,source_revision,created_by)
    select buyer_order,env,'test-'||env||buyer_order,'draft','{}',first_revision,staff from (values('demo'),('production')) as envs(env);
  update public.poweroffice_exports set state='invoiced',invoice_number='5543',invoice_id='demo-invoice',provider_sent_at=sent_time where order_id=buyer_order and environment='demo';
  update public.poweroffice_exports set state='invoiced',invoice_number='5543',invoice_id='prod-invoice',provider_sent_at=null where order_id=buyer_order and environment='production';
  if (select customer_invoice_sent from public.orders where id=buyer_order) then raise exception 'Unsent or demo invoice marked as sent'; end if;
  update public.poweroffice_exports set provider_sent_at=sent_time where order_id=buyer_order and environment='production';
  select revision into strict sent_revision from public.orders where id=buyer_order and customer_invoice_sent and customer_invoice_sent_at=sent_time
    and customer_invoice_number='5543' and not carrier_invoice_received and status='delivered';
  if sent_revision<>first_revision+1 or (select source_revision from public.poweroffice_exports where order_id=buyer_order and environment='production')<>sent_revision then raise exception 'Unexpected revision'; end if;
  update public.poweroffice_exports set provider_sent_at=sent_time where order_id=buyer_order and environment='production';
  if (select revision from public.orders where id=buyer_order)<>sent_revision then raise exception 'Duplicate sent edit'; end if;
  update public.orders set customer_invoice_number='999',customer_invoice_sent=false,customer_invoice_sent_at=null where id=buyer_order;
  update public.poweroffice_exports set provider_sent_at=sent_time where order_id=buyer_order and environment='production';
  if (select customer_invoice_sent or customer_invoice_number<>'999' from public.orders where id=buyer_order) then raise exception 'Manual invoice number overwritten'; end if;
  update public.orders set customer_invoice_number=null,status='cancelled',cancellation_reason='TEST' where id=buyer_order;
  update public.poweroffice_exports set provider_sent_at=sent_time where order_id=buyer_order and environment='production';
  if (select customer_invoice_sent from public.orders where id=buyer_order) then raise exception 'Cancelled order marked as sent'; end if;
end $test$;
rollback;
