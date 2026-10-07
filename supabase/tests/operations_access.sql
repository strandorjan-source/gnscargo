-- This test covers database/Storage RLS, not an actual network file transfer.
begin;
do $$
#variable_conflict use_variable
declare staff uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); oid uuid:=gen_random_uuid(); other_order uuid:=gen_random_uuid(); grant_id uuid; doc uuid:=gen_random_uuid(); path text; r jsonb; seen int;
begin
 insert into auth.users(id,email,raw_user_meta_data) select x,x::text||'@cargo-roles-test.invalid','{}'::jsonb from unnest(array[staff,a,b]) x;
 update public.profiles set role='dispatcher' where id=staff;
 insert into public.capacity_profiles(user_id,email,full_name,company,role,approved) values(a,a::text||'@cargo-roles-test.invalid','Carrier A','A','carrier',true),(b,b::text||'@cargo-roles-test.invalid','Carrier B','B','carrier',true) on conflict(user_id) do update set approved=true,role='carrier';
 insert into public.orders(id,order_number,customer) values(oid,-1791397201,'TEST A'),(other_order,-1791397202,'TEST B');
 perform set_config('request.jwt.claim.sub',staff::text,true);perform set_config('request.jwt.claims',json_build_object('sub',staff,'role','authenticated')::text,true);execute 'set local role authenticated';
 insert into public.order_upload_grants(order_id,grantee_id) values(oid,a) returning id into grant_id;
 insert into public.order_notes(order_id,body) values(oid,'INTERNAL NEVER EXPOSE');
 insert into public.order_incidents(order_id,category,description,happened_at,notified_at,assigned_to) values(oid,'delay','Internal incident',now(),now(),staff);
 execute 'reset role';
 perform set_config('request.jwt.claim.sub',a::text,true);perform set_config('request.jwt.claims',json_build_object('sub',a,'role','authenticated')::text,true);execute 'set local role authenticated';
 r:=public.cargo_upload_context(grant_id);if r->>'order_id'<>oid::text or r ? 'customer' then raise exception 'Invalid upload context';end if;
 select count(*) into seen from public.orders where id=oid;if seen<>0 then raise exception 'Carrier sees customer order';end if;
 select count(*) into seen from public.order_notes where order_id=oid;if seen<>0 then raise exception 'Carrier sees notes';end if;
 select count(*) into seen from public.order_incidents where order_id=oid;if seen<>0 then raise exception 'Carrier sees incidents';end if;
 select count(*) into seen from public.order_activity where order_id=oid;if seen<>0 then raise exception 'Carrier sees audit';end if;
 path:=oid::text||'/'||doc::text;
 insert into public.order_documents(id,order_id,category,filename,storage_path,mime_type,byte_size,sha256) values(doc,oid,'pod','test.pdf',path,'application/pdf',10,repeat('a',64));
 begin update public.order_documents set status='ready' where id=doc;raise exception 'Missing file accepted';exception when check_violation then null;end;
 begin insert into public.order_documents(order_id,category,filename,storage_path,mime_type,byte_size,sha256) values(other_order,'pod','wrong.pdf','not-valid','application/pdf',10,repeat('a',64));raise exception 'Wrong order accepted';exception when insufficient_privilege then null;end;
 -- Synthetic Storage metadata only; no actual file is uploaded.
 insert into storage.objects(bucket_id,name,metadata) values('cargo-order-documents',path,'{"size":10,"mimetype":"application/pdf"}');
 update public.order_documents set status='ready' where id=doc;
 if not private.cargo_storage_allowed(path,false) then raise exception 'Own document inaccessible';end if;
 begin update public.order_documents set filename='changed.pdf' where id=doc;raise exception 'Evidence overwritten';exception when check_violation then null;end;
 execute 'reset role';
 perform set_config('request.jwt.claim.sub',b::text,true);perform set_config('request.jwt.claims',json_build_object('sub',b,'role','authenticated')::text,true);execute 'set local role authenticated';
 if public.cargo_upload_context(grant_id) is not null then raise exception 'B can use A invitation';end if;
 select count(*) into seen from public.order_documents where id=doc;if seen<>0 then raise exception 'B sees A metadata';end if;
 select count(*) into seen from storage.objects where name=path and bucket_id='cargo-order-documents';if seen<>0 then raise exception 'B sees A file';end if;
 begin perform public.save_cargo_order(oid,1,null,'{"goods":"Unauthorized"}',null);raise exception 'Carrier updates order';exception when insufficient_privilege then null;end;
 execute 'reset role';
 perform set_config('request.jwt.claim.sub',staff::text,true);perform set_config('request.jwt.claims',json_build_object('sub',staff,'role','authenticated')::text,true);execute 'set local role authenticated';
 if not private.cargo_storage_allowed(path,false) then raise exception 'Dispatcher cannot read document';end if;
 update public.order_upload_grants set revoked_at=now() where id=grant_id;
 execute 'reset role';
 perform set_config('request.jwt.claim.sub',a::text,true);perform set_config('request.jwt.claims',json_build_object('sub',a,'role','authenticated')::text,true);execute 'set local role authenticated';
 if public.cargo_upload_context(grant_id) is not null or coalesce(private.cargo_storage_allowed(path,false),false) then raise exception 'Revoked carrier retains access';end if;
 execute 'reset role';
end $$;
rollback;
select 'PASS: carrier A/B isolation, scoped invitation/revocation, private notes/incidents/history, immutable file metadata and finalization; synthetic metadata only' as result;
