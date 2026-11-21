create or replace function public.poweroffice_claim_export(p_order_id uuid,p_environment text,p_user_id uuid,p_revision bigint,p_snapshot jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare current_order public.orders; item public.poweroffice_exports; claimed boolean:=false;
  provider_ref text := 'GNS-' || case when p_environment='production' then 'prod' else p_environment end || '-' || p_order_id;
  legacy_ref text := 'GNS-production-' || p_order_id;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles where id=p_user_id and deleted_at is null and role in ('admin','dispatcher','superuser')) then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into current_order from public.orders where id=p_order_id for update;
  if not found or current_order.revision<>p_revision or current_order.status='cancelled' or current_order.customer_invoice_sent then raise exception 'Order changed' using errcode='40001'; end if;
  insert into public.poweroffice_exports(order_id,environment,external_reference,state,payload,source_revision,created_by)
    values(p_order_id,p_environment,provider_ref,'creating',jsonb_set(p_snapshot,'{ExternalImportReference}',to_jsonb(provider_ref)),p_revision,p_user_id)
    on conflict(order_id,environment) do nothing returning * into item;
  if found then claimed:=true;
  else
    select * into item from public.poweroffice_exports where order_id=p_order_id and environment=p_environment for update;
    if p_environment='production' and item.external_reference=legacy_ref then
      -- PowerOffice rejected 51-character references. Repair only after sync
      -- has confirmed that neither an invoice nor a draft exists for this key.
      if item.state <> 'missing' or item.last_synced_at is null
         or item.invoice_id is not null or item.sales_order_id is not null
         or item.payload->>'ExternalImportReference' is distinct from legacy_ref then
        return jsonb_build_object('claimed',false,'row',to_jsonb(item));
      end if;
      update public.poweroffice_exports set external_reference=provider_ref,
        payload=jsonb_set(item.payload,'{ExternalImportReference}',to_jsonb(provider_ref))
        where order_id=p_order_id and environment=p_environment returning * into item;
    end if;
    if item.state in ('uncertain','missing') or (item.state='creating' and item.updated_at<clock_timestamp()-interval '2 minutes') then
      -- Preserve the original snapshot on retries: the provider may have accepted it already.
      update public.poweroffice_exports set state='creating',updated_at=clock_timestamp() where order_id=p_order_id and environment=p_environment returning * into item;
      claimed:=true;
    end if;
  end if;
  return jsonb_build_object('claimed',claimed,'row',to_jsonb(item));
end $$;
