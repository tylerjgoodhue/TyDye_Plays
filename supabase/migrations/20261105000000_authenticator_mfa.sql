-- Existing accounts can enroll without a lockout. Once ANY factor is verified,
-- authenticated access requires an AAL2 token. Never trust editable user metadata.
create or replace function public.creator_mfa_access()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    coalesce((select auth.jwt()->>'aal') = 'aal2', false)
    or not exists (
      select 1 from auth.mfa_factors
      where user_id = (select auth.uid()) and status = 'verified'
    )
  );
$$;
revoke all on function public.creator_mfa_access() from public, anon;
grant execute on function public.creator_mfa_access() to authenticated;

-- Restrictive policies combine with ownership policies rather than replacing them.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'creator_workspaces', 'creator_workspace_history', 'creator_public_profiles',
    'creator_social_links', 'creator_social_clicks', 'creator_platform_accounts',
    'creator_platform_metrics', 'dropbox_connections'
  ] loop
    if pg_catalog.to_regclass('public.' || table_name) is not null then
      execute format('drop policy if exists "Verified authenticator required" on public.%I', table_name);
      execute format('create policy "Verified authenticator required" on public.%I as restrictive for all to authenticated using ((select public.creator_mfa_access())) with check ((select public.creator_mfa_access()))', table_name);
    end if;
  end loop;
end;
$$;
