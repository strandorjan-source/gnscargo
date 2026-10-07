create table public.order_notes(
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete restrict,
 body text not null check(char_length(btrim(body)) between 1 and 10000),created_by uuid not null default auth.uid(),created_at timestamptz not null default clock_timestamp()
);
alter table public.order_notes enable row level security;
revoke all on public.order_notes from anon,authenticated;
grant select,insert on public.order_notes to authenticated;
revoke update,delete on public.order_notes from authenticated;
create policy notes_read on public.order_notes for select to authenticated using (public.current_user_role() in ('admin','dispatcher'));
create policy notes_create on public.order_notes for insert to authenticated with check (public.current_user_role() in ('admin','dispatcher') and created_by=auth.uid());
create index notes_order_time on public.order_notes(order_id,created_at desc);
create trigger notes_audit after insert on public.order_notes for each row execute function private.cargo_audit();

create table public.order_incidents(
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete restrict,
 category text not null check(category in ('delay','damage','temperature','other')),
 description text not null check(char_length(btrim(description)) between 1 and 10000),
 happened_at timestamptz not null,notified_at timestamptz not null,
 assigned_to uuid references public.profiles(id),status text not null default 'open' check(status in ('open','in_progress','resolved')),
 resolution text,revision bigint not null default 1,created_by uuid not null default auth.uid(),created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 check(status<>'resolved' or nullif(btrim(resolution),'') is not null)
);
alter table public.order_incidents enable row level security;
revoke all on public.order_incidents from anon,authenticated;
grant select,insert,update on public.order_incidents to authenticated;
revoke delete on public.order_incidents from authenticated;
create policy incidents_read on public.order_incidents for select to authenticated using (public.current_user_role() in ('admin','dispatcher'));
create policy incidents_create on public.order_incidents for insert to authenticated with check(public.current_user_role() in ('admin','dispatcher') and created_by=auth.uid());
create policy incidents_edit on public.order_incidents for update to authenticated using(public.current_user_role() in ('admin','dispatcher')) with check(public.current_user_role() in ('admin','dispatcher'));
create index incidents_order_status on public.order_incidents(order_id,status);
create function private.cargo_incident_guard() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if TG_OP='UPDATE' then
  if NEW.order_id<>OLD.order_id or NEW.created_by<>OLD.created_by or NEW.created_at<>OLD.created_at then raise exception 'Avviket kan ikke flyttes eller endre opphav.' using errcode='23514'; end if;
  NEW.revision:=OLD.revision+1; NEW.updated_at:=clock_timestamp();
 else NEW.created_by:=auth.uid(); NEW.created_at:=clock_timestamp(); NEW.updated_at:=NEW.created_at; NEW.revision:=1;
 end if;
 if NEW.assigned_to is not null and not exists(select 1 from public.cargo_staff_directory() d where d.id=NEW.assigned_to) then raise exception 'Velg aktiv ansvarlig for avviket.' using errcode='23514'; end if;
 return NEW;
end $$;
revoke all on function private.cargo_incident_guard() from public,anon,authenticated;
create trigger incident_guard before insert or update on public.order_incidents for each row execute function private.cargo_incident_guard();
create trigger incidents_audit after insert or update on public.order_incidents for each row execute function private.cargo_audit();

