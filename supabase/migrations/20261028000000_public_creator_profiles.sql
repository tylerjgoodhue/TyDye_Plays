create table if not exists public.creator_public_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  profile jsonb not null check (jsonb_typeof(profile) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.creator_public_profiles enable row level security;
alter table public.creator_public_profiles force row level security;

revoke all on public.creator_public_profiles from anon;
revoke all on public.creator_public_profiles from authenticated;
grant select, insert, update on public.creator_public_profiles to authenticated;

drop policy if exists "Owners manage their public creator profile" on public.creator_public_profiles;
create policy "Owners manage their public creator profile"
  on public.creator_public_profiles for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.get_creator_public_profile(profile_owner uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select profile
  from public.creator_public_profiles
  where user_id = profile_owner;
$$;

revoke all on function public.get_creator_public_profile(uuid) from public;
grant execute on function public.get_creator_public_profile(uuid) to anon, authenticated;

create or replace function public.set_creator_public_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_creator_public_profile_updated_at on public.creator_public_profiles;
create trigger set_creator_public_profile_updated_at
  before update on public.creator_public_profiles
  for each row execute function public.set_creator_public_profile_updated_at();
