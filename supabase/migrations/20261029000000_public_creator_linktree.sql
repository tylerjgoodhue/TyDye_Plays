create or replace function public.get_creator_public_profile(profile_owner uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(profile -> 'website', profile)
  from public.creator_public_profiles
  where user_id = profile_owner;
$$;

create or replace function public.get_creator_public_linktree(profile_owner uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select profile -> 'linktree'
  from public.creator_public_profiles
  where user_id = profile_owner
    and profile ? 'linktree';
$$;

revoke all on function public.get_creator_public_profile(uuid) from public;
grant execute on function public.get_creator_public_profile(uuid) to anon, authenticated;
revoke all on function public.get_creator_public_linktree(uuid) from public;
grant execute on function public.get_creator_public_linktree(uuid) to anon, authenticated;
