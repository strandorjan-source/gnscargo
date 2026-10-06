begin;
do $$
declare actor uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); target bigint;
begin
 insert into auth.users(id,email,raw_user_meta_data)
 select id,id::text||'@gns-edi-test.invalid','{}'::jsonb from unnest(array[actor,outsider]) id;
 update public.profiles set role='superuser' where id=actor;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 insert into public.carriers(name,edi_system) values('EDI test '||actor,'opter') returning id into target;
 if not exists(select 1 from public.carriers where id=target and edi_system='opter') then raise exception 'Staff cannot read EDI preference'; end if;
 update public.carriers set edi_system='timpex' where id=target;
 if not found then raise exception 'Staff cannot edit preference'; end if;
 begin
  update public.carriers set edi_system='unrecognized-system' where id=target;
  raise exception 'Unsupported EDI system accepted';
 exception when check_violation then null; end;
 perform set_config('request.jwt.claim.sub',outsider::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',outsider,'role','authenticated')::text,true);
 if exists(select 1 from public.carriers where id=target) then raise exception 'Outsider can read internal carrier register'; end if;
 update public.carriers set edi_system=null where id=target;
 if found then raise exception 'Outsider can change recipient'; end if;
 begin
  insert into public.carriers(name,edi_system) values('Unauthorized '||outsider,'opter');
  raise exception 'Outsider can create recipient';
 exception when insufficient_privilege then null; end;
 execute 'reset role';
 execute 'set local role anon';
 begin
  if exists(select 1 from public.carriers) then raise exception 'Anonymous user can read recipients'; end if;
 exception when insufficient_privilege then null; end;
 execute 'reset role';
end;
$$;
rollback;
select 'PASS: staff can manage EDI preference; unsupported systems and unauthorized reads/writes are rejected' as result;
