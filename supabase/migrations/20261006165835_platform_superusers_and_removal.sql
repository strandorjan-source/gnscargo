alter table public.profiles
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users(id) on delete set null;
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending', 'admin', 'dispatcher', 'viewer', 'disabled', 'superuser'));
alter table public.profiles alter column role set default 'pending';
alter table public.profiles add constraint profiles_removed_access_check
  check (deleted_at is null or role = 'disabled');

-- Existing Cargo policies already recognize admin. Map the new platform role
-- here, while retaining the real role on the profile and in platform_current_access.
create or replace function public.current_user_role()
returns text language sql stable security definer set search_path = ''
as $$
  select case when p.role = 'superuser' then 'admin' else p.role end
  from public.profiles p where p.id = (select auth.uid()) and p.deleted_at is null
$$;
revoke all on function public.current_user_role() from public, anon;
grant execute on function public.current_user_role() to authenticated;

-- All Capacity policies already use this function. Removed/disabled platform
-- users lose access immediately, including when they still hold a valid JWT.
create or replace function private.capacity_current_role()
returns text language sql stable security definer set search_path = ''
as $$
  select case
    when exists(select 1 from public.profiles p where p.id = (select auth.uid())
      and (p.deleted_at is not null or p.role = 'disabled')) then null
    when exists(select 1 from public.profiles p where p.id = (select auth.uid())
      and p.role = 'superuser' and p.deleted_at is null) then 'admin'
    else (select cp.role from public.capacity_profiles cp
      where cp.user_id = (select auth.uid()) and cp.approved and cp.deleted_at is null limit 1)
  end
$$;
revoke all on function private.capacity_current_role() from public, anon;
grant execute on function private.capacity_current_role() to authenticated;

create or replace function public.platform_current_access()
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object('id', p.id, 'role', p.role, 'full_name', p.full_name,
    'email', p.email, 'deleted_at', p.deleted_at,
    'blocked', p.deleted_at is not null or p.role = 'disabled')
  from public.profiles p where p.id = (select auth.uid())
$$;
revoke all on function public.platform_current_access() from public, anon;
grant execute on function public.platform_current_access() to authenticated;

-- Only the checked, serialized management operation may change Cargo access.
-- Browser clients cannot bypass the last-admin or removed-user guards.
revoke update, delete on public.profiles from authenticated, anon;

create or replace function private.manage_platform_user(target_user uuid, action text, next_role text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role text;
  target public.profiles%rowtype;
  remaining_role text;
begin
  if actor is null then raise exception 'Innlogging kreves.' using errcode = '42501'; end if;
  -- Serialize privilege changes so two administrators cannot remove one another
  -- or concurrently demote the last superusers.
  perform pg_advisory_xact_lock(hashtextextended('gns-platform-user-management', 0));
  select p.role into actor_role from public.profiles p
    where p.id = actor and p.deleted_at is null;
  if actor_role is null or actor_role not in ('admin', 'superuser') then
    raise exception 'Kun administrator eller superbruker kan endre brukertilgang.' using errcode = '42501';
  end if;
  if action not in ('set_role', 'remove') or action is null then
    raise exception 'Ugyldig handling.' using errcode = '22023';
  end if;
  select * into target from public.profiles p where p.id = target_user for update;
  if not found then raise exception 'Brukeren finnes ikke.' using errcode = 'P0002'; end if;
  if target.deleted_at is not null then raise exception 'Brukeren er allerede slettet.' using errcode = '22023'; end if;
  if action = 'remove' and actor = target_user then
    raise exception 'Du kan ikke slette din egen bruker.' using errcode = '42501';
  end if;
  if action = 'set_role' and (next_role is null or next_role not in ('pending', 'admin', 'dispatcher', 'viewer', 'disabled', 'superuser')) then
    raise exception 'Ugyldig rolle.' using errcode = '22023';
  end if;
  remaining_role := case when action = 'remove' then 'disabled' else next_role end;
  if target.role = 'superuser' and remaining_role <> 'superuser' and not exists (
    select 1 from public.profiles p where p.id <> target_user and p.role = 'superuser' and p.deleted_at is null
  ) then raise exception 'Den siste superbrukeren kan ikke fjernes eller miste tilgangen.' using errcode = '23514'; end if;
  if target.role in ('admin', 'superuser') and remaining_role not in ('admin', 'superuser') and not exists (
    select 1 from public.profiles p where p.id <> target_user and p.role in ('admin', 'superuser') and p.deleted_at is null
  ) then raise exception 'Den siste administratoren kan ikke fjernes eller miste tilgangen.' using errcode = '23514'; end if;
  if remaining_role = 'superuser' then
    -- Keep a real Capacity identity for reservation names and the event log,
    -- without overwriting any previously approved Capacity role.
    insert into public.capacity_profiles(user_id, email, full_name, company, role, approved)
    select u.id, u.email, coalesce(target.full_name, u.email), 'GNS Cargo AS', 'carrier', false
    from auth.users u where u.id = target_user
    on conflict (user_id) do nothing;
  end if;
  update public.profiles set role = remaining_role,
    approved_at = case when remaining_role in ('admin', 'dispatcher', 'superuser') then now() else null end,
    updated_at = now(), deleted_at = case when action = 'remove' then now() else null end,
    deleted_by = case when action = 'remove' then actor else null end
    where id = target_user returning * into target;
  return to_jsonb(target);
end;
$$;
revoke all on function private.manage_platform_user(uuid, text, text) from public, anon;
grant execute on function private.manage_platform_user(uuid, text, text) to authenticated;

create or replace function public.manage_platform_user(target_user uuid, action text, next_role text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.manage_platform_user(target_user, action, next_role) $$;
revoke all on function public.manage_platform_user(uuid, text, text) from public, anon;
grant execute on function public.manage_platform_user(uuid, text, text) to authenticated;

-- The Capacity user screen labels platform overrides and cannot accidentally
-- claim that a superuser has been disabled by changing only a local approval.
create or replace function private.capacity_platform_users()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', p.id,
    'platform_superuser', p.role = 'superuser' and p.deleted_at is null,
    'platform_blocked', p.role = 'disabled' or p.deleted_at is not null,
    'platform_deleted', p.deleted_at is not null)), '[]'::jsonb)
  from public.profiles p join public.capacity_profiles cp on cp.user_id = p.id
  where (select private.capacity_current_role()) = 'admin'
$$;
revoke all on function private.capacity_platform_users() from public, anon;
grant execute on function private.capacity_platform_users() to authenticated;
create or replace function public.capacity_platform_users()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.capacity_platform_users() $$;
revoke all on function public.capacity_platform_users() from public, anon;
grant execute on function public.capacity_platform_users() to authenticated;

create or replace function private.guard_capacity_platform_access()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.role, new.approved, new.deleted_at, new.deleted_by) is distinct from
     (old.role, old.approved, old.deleted_at, old.deleted_by) and exists (
       select 1 from public.profiles p where p.id = old.user_id
       and (p.role in ('superuser','disabled') or p.deleted_at is not null)
     ) then
    raise exception 'Denne brukerens plattformtilgang styres i GNS Cargo.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_capacity_platform_access() from public, anon, authenticated;
create trigger capacity_platform_access_guard before update on public.capacity_profiles
  for each row execute function private.guard_capacity_platform_access();
