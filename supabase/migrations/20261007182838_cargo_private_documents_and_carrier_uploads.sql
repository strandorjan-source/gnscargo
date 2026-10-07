create table public.order_upload_grants(
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete restrict,
 grantee_id uuid not null references auth.users(id),expires_at timestamptz not null default (now()+interval '30 days'),
 revoked_at timestamptz,created_by uuid not null default auth.uid(),created_at timestamptz not null default clock_timestamp()
);
alter table public.order_upload_grants enable row level security;
revoke all on public.order_upload_grants from anon,authenticated;
grant select,insert,update on public.order_upload_grants to authenticated;
create policy grants_staff_read on public.order_upload_grants for select to authenticated using(public.current_user_role() in ('admin','dispatcher'));
create policy grants_staff_insert on public.order_upload_grants for insert to authenticated with check(public.current_user_role() in ('admin','dispatcher') and created_by=auth.uid());
create policy grants_staff_update on public.order_upload_grants for update to authenticated using(public.current_user_role() in ('admin','dispatcher')) with check(public.current_user_role() in ('admin','dispatcher'));
create index upload_grantee_order on public.order_upload_grants(grantee_id,order_id);

create function private.cargo_carrier_directory() returns table(id uuid,name text)
language sql stable security definer set search_path='' as $$
 select p.user_id,concat_ws(' · ',p.company,coalesce(nullif(p.full_name,''),p.email)) from public.capacity_profiles p
 where auth.uid() is not null and public.current_user_role() in ('admin','dispatcher') and p.approved and p.deleted_at is null and p.role='carrier'
$$;
revoke all on function private.cargo_carrier_directory() from public,anon;
grant execute on function private.cargo_carrier_directory() to authenticated;
create function public.cargo_carrier_directory() returns table(id uuid,name text)
language sql stable security invoker set search_path='' as $$ select * from private.cargo_carrier_directory() $$;
revoke all on function public.cargo_carrier_directory() from public,anon;
grant execute on function public.cargo_carrier_directory() to authenticated;
create function private.cargo_grant_guard() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if TG_OP='UPDATE' and (NEW.order_id<>OLD.order_id or NEW.grantee_id<>OLD.grantee_id or NEW.created_by<>OLD.created_by or NEW.created_at<>OLD.created_at) then raise exception 'Opprett en ny invitasjon i stedet for å endre mottaker.' using errcode='23514'; end if;
 if NEW.revoked_at is null and not exists(select 1 from public.cargo_carrier_directory() d where d.id=NEW.grantee_id) then raise exception 'Transportørbrukeren må være aktiv og godkjent.' using errcode='23514'; end if;
 if NEW.expires_at>now()+interval '90 days' then raise exception 'Invitasjoner kan vare høyst 90 dager.' using errcode='23514'; end if;
 return NEW;
end $$;
revoke all on function private.cargo_grant_guard() from public,anon,authenticated;
create trigger grant_guard before insert or update on public.order_upload_grants for each row execute function private.cargo_grant_guard();
create trigger grants_audit after insert or update on public.order_upload_grants for each row execute function private.cargo_audit();

-- Grant UUID is not a bearer credential. A logged-in, active, approved recipient is required.
create function private.cargo_can_upload(p_order uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (
  public.current_user_role() in ('admin','dispatcher') or exists(
   select 1 from public.order_upload_grants g join public.capacity_profiles c on c.user_id=g.grantee_id
   where g.order_id=p_order and g.grantee_id=auth.uid() and g.revoked_at is null and g.expires_at>now()
    and c.approved and c.deleted_at is null and c.role='carrier')
 )
$$;
revoke all on function private.cargo_can_upload(uuid) from public,anon;
grant execute on function private.cargo_can_upload(uuid) to authenticated;
create function private.cargo_upload_context(p_grant uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('order_id',g.order_id,'reference',o.reference,'expires_at',g.expires_at)
 from public.order_upload_grants g join public.orders o on o.id=g.order_id
 where auth.uid() is not null and g.id=p_grant and g.grantee_id=auth.uid() and g.revoked_at is null and g.expires_at>now() and private.cargo_can_upload(g.order_id)
$$;
revoke all on function private.cargo_upload_context(uuid) from public,anon;
grant execute on function private.cargo_upload_context(uuid) to authenticated;
create function public.cargo_upload_context(p_grant uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.cargo_upload_context(p_grant) $$;
revoke all on function public.cargo_upload_context(uuid) from public,anon;
grant execute on function public.cargo_upload_context(uuid) to authenticated;

create table public.order_documents(
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete restrict,
 category text not null check(category in ('cmr','pod','photo','temperature','other')),
 filename text not null check(char_length(filename) between 1 and 240),
 storage_path text not null unique,mime_type text not null check(mime_type in ('application/pdf','image/jpeg','image/png','image/webp')),
 byte_size bigint not null check(byte_size between 1 and 20971520),sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 status text not null default 'pending' check(status in ('pending','ready','withdrawn')),
 uploaded_by uuid not null default auth.uid(),created_at timestamptz not null default clock_timestamp(),
 check(storage_path=order_id::text||'/'||id::text)
);
alter table public.order_documents enable row level security;
revoke all on public.order_documents from anon,authenticated;
grant select,insert,update on public.order_documents to authenticated;
create policy documents_read on public.order_documents for select to authenticated using(public.current_user_role() in ('admin','dispatcher') or (uploaded_by=auth.uid() and private.cargo_can_upload(order_id)));
create policy documents_insert on public.order_documents for insert to authenticated with check(uploaded_by=auth.uid() and status='pending' and private.cargo_can_upload(order_id));
create policy documents_update on public.order_documents for update to authenticated using(public.current_user_role() in ('admin','dispatcher') or(uploaded_by=auth.uid() and private.cargo_can_upload(order_id))) with check(public.current_user_role() in ('admin','dispatcher') or(uploaded_by=auth.uid() and private.cargo_can_upload(order_id)));
create index documents_order_time on public.order_documents(order_id,created_at desc);

-- Private bucket: file reads/writes are constrained by the metadata and invitation.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('cargo-order-documents','cargo-order-documents',false,20971520,array['application/pdf','image/jpeg','image/png','image/webp']);
create function private.cargo_storage_allowed(p_path text,p_write boolean) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.order_documents d where d.storage_path=p_path
  and case when p_write then d.status='pending' and d.uploaded_by=auth.uid() and private.cargo_can_upload(d.order_id)
    else d.status='ready' and (public.current_user_role() in ('admin','dispatcher') or(d.uploaded_by=auth.uid() and private.cargo_can_upload(d.order_id))) end)
$$;
revoke all on function private.cargo_storage_allowed(text,boolean) from public,anon;
grant execute on function private.cargo_storage_allowed(text,boolean) to authenticated;
create policy cargo_documents_upload on storage.objects for insert to authenticated with check(bucket_id='cargo-order-documents' and private.cargo_storage_allowed(name,true));
create policy cargo_documents_read on storage.objects for select to authenticated using(bucket_id='cargo-order-documents' and private.cargo_storage_allowed(name,false));
-- No UPDATE or DELETE policy: an uploaded evidence file is never silently replaced.
create function private.cargo_document_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare meta jsonb;
begin
 if auth.uid() is null or not coalesce(private.cargo_can_upload(NEW.order_id),false) then raise exception 'Ingen opplastingstilgang.' using errcode='42501'; end if;
 if TG_OP='INSERT' then NEW.uploaded_by:=auth.uid(); NEW.created_at:=clock_timestamp(); NEW.status:='pending'; return NEW; end if;
 if (to_jsonb(NEW)-'status') is distinct from (to_jsonb(OLD)-'status') then raise exception 'Dokumentopplysninger er låst. Last opp en ny fil.' using errcode='23514'; end if;
 if NEW.status=OLD.status then return NEW; end if;
 if NEW.status='ready' and OLD.status='pending' and OLD.uploaded_by=auth.uid() then
  select metadata into meta from storage.objects where bucket_id='cargo-order-documents' and name=NEW.storage_path;
  if meta is null or (meta->>'size')::bigint is distinct from NEW.byte_size or meta->>'mimetype' is distinct from NEW.mime_type then raise exception 'Filen er ikke ferdig lastet opp eller filinformasjonen stemmer ikke.' using errcode='23514'; end if;
 elsif NEW.status='withdrawn' and (public.current_user_role() in ('admin','dispatcher') or(OLD.status='pending' and OLD.uploaded_by=auth.uid())) then null;
 else raise exception 'Ugyldig dokumentstatus.' using errcode='23514'; end if;
 return NEW;
end $$;
revoke all on function private.cargo_document_guard() from public,anon,authenticated;
create trigger document_guard before insert or update on public.order_documents for each row execute function private.cargo_document_guard();
create trigger documents_audit after insert or update on public.order_documents for each row execute function private.cargo_audit();

