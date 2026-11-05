-- One creator workplace, individual accounts, owner-managed membership.
create table if not exists public.creator_workspace_members (
 user_id uuid primary key references auth.users(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 role text not null check(role in ('owner','admin','editor','staff','viewer')),
 check(role!='owner' or user_id=owner_id),
 permissions text[] not null default '{}',
 active boolean not null default true,
 created_at timestamptz not null default now()
);
alter table public.creator_workspace_members enable row level security;
revoke all on public.creator_workspace_members from anon, authenticated;
grant select on public.creator_workspace_members to authenticated;
drop policy if exists "Read own workplace membership" on public.creator_workspace_members;
create policy "Read own workplace membership" on public.creator_workspace_members for select to authenticated using(user_id=(select auth.uid()) and (select public.creator_mfa_access()));
-- Existing public-site owners retain their current data and connection IDs.
insert into public.creator_workspace_members(user_id,owner_id,role,permissions)
select user_id,user_id,'owner',array['dashboard','tasks','schedule','content','assets','analytics','community','shop','website','linktree','social','settings'] from public.creator_public_profiles
on conflict(user_id) do nothing;
alter table public.creator_workspaces add column if not exists revision bigint not null default 0;
create or replace function public.bump_creator_workspace_revision() returns trigger language plpgsql set search_path='' as $$ begin new.revision=old.revision+1;return new;end $$;
drop trigger if exists bump_creator_workspace_revision on public.creator_workspaces;
create trigger bump_creator_workspace_revision before update on public.creator_workspaces for each row execute function public.bump_creator_workspace_revision();

create or replace function public.creator_workspace_context() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare member public.creator_workspace_members;
begin
 if not public.creator_mfa_access() then raise exception 'Verify your authenticator code first' using errcode='42501';end if;
 select * into member from public.creator_workspace_members where user_id=(select auth.uid()) and active;
 if not found then raise exception 'Ask the owner to add your account to this workplace in Staff' using errcode='42501';end if;
 return jsonb_build_object('owner_id',member.owner_id,'role',member.role,'permissions',member.permissions);
end $$;

create or replace function public.creator_workspace_keys(context jsonb) returns text[] language plpgsql immutable set search_path='' as $$
declare keys text[]='{}';perm text;
begin
 if context->>'role'='owner' then return null;end if;
 for perm in select jsonb_array_elements_text(context->'permissions') loop
  keys=keys || case perm
   when 'settings' then array['settings','profile','integrationIssues','activityLog']
   when 'tasks' then array['tasks']
   when 'schedule' then array['streams']
   when 'content' then array['content','ideas','goals','routineChecks','reflections']
   when 'assets' then array['assets']
   when 'analytics' then array['metrics','analyticsRevenue']
   when 'community' then array['communityLinks','communityEvents','communityFeedback','crm','notificationDismissed','notificationPreferences','announcementDrafts']
   when 'social' then array['bufferDraftLibrary']
   when 'website' then array['creatorProfile']
   when 'linktree' then array['creatorProfile']
   else array[]::text[] end;
 end loop;
 return keys;
end $$;

create or replace function public.load_creator_workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare context jsonb;row public.creator_workspaces;keys text[];snapshot jsonb;
begin
 context=public.creator_workspace_context();keys=public.creator_workspace_keys(context);
 select * into row from public.creator_workspaces where user_id=(context->>'owner_id')::uuid;
 if not found then return jsonb_build_object('workspace_data',null,'revision',null);end if;
 snapshot=row.workspace_data;
 if keys is not null then
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into snapshot from jsonb_each(snapshot) where key=any(keys || array['settings','creatorProfile']);
  snapshot=snapshot || jsonb_build_object('recoveryTrash',coalesce((select jsonb_agg(item) from jsonb_array_elements(coalesce(row.workspace_data->'recoveryTrash','[]')) item where item->>'collection'=any(keys)),'[]'::jsonb));
 end if;
 return jsonb_build_object('workspace_data',snapshot,'revision',row.revision,'updated_at',row.updated_at);
end $$;

create or replace function public.save_creator_workspace(snapshot jsonb, expected_revision bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare context jsonb;row public.creator_workspaces;keys text[];patch jsonb;next_revision bigint;
begin
 context=public.creator_workspace_context();keys=public.creator_workspace_keys(context);
 if snapshot is null or jsonb_typeof(snapshot)!='object' or octet_length(snapshot::text)>1500000 then raise exception 'Invalid workspace snapshot';end if;
 if keys is not null and cardinality(keys)=0 then raise exception 'This account has read-only workplace access' using errcode='42501';end if;
 select * into row from public.creator_workspaces where user_id=(context->>'owner_id')::uuid for update;
 if not found then
  if context->>'role'!='owner' then raise exception 'The owner must create the workplace first' using errcode='42501';end if;
  if expected_revision is not null then raise exception 'The workplace changed. Reload it before saving' using errcode='40001';end if;
  insert into public.creator_workspaces(user_id,workspace_data) values((context->>'owner_id')::uuid,snapshot) returning revision into next_revision;
 else
  if expected_revision is null or row.revision!=expected_revision then raise exception 'Someone else updated the workplace. Your changes are still on this device. Reload the shared version before trying again' using errcode='40001';end if;
  patch=snapshot;
  if keys is not null then
   select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into patch from jsonb_each(snapshot) where key=any(keys);
   -- Editors only replace recoverable records from collections they may edit.
   patch=patch || jsonb_build_object('recoveryTrash',
    coalesce((select jsonb_agg(item) from jsonb_array_elements(coalesce(row.workspace_data->'recoveryTrash','[]')) item where not(item->>'collection'=any(keys))),'[]'::jsonb)
    || coalesce((select jsonb_agg(item) from jsonb_array_elements(coalesce(snapshot->'recoveryTrash','[]')) item where item->>'collection'=any(keys)),'[]'::jsonb));
  end if;
  update public.creator_workspaces set workspace_data=row.workspace_data || patch where user_id=row.user_id returning revision into next_revision;
 end if;
 return jsonb_build_object('revision',next_revision);
end $$;
revoke all on function public.creator_workspace_context(),public.creator_workspace_keys(jsonb),public.load_creator_workspace(),public.save_creator_workspace(jsonb,bigint) from public,anon;
grant execute on function public.creator_workspace_context(),public.load_creator_workspace(),public.save_creator_workspace(jsonb,bigint) to authenticated;

-- Delegated website managers edit the same published profile, never their own copy.
drop policy if exists "Workplace website managers" on public.creator_public_profiles;
create policy "Workplace website managers" on public.creator_public_profiles for all to authenticated
using(user_id=((select public.creator_workspace_context())->>'owner_id')::uuid and ((select public.creator_workspace_context())->'permissions' ?| array['website','linktree','settings']))
with check(user_id=((select public.creator_workspace_context())->>'owner_id')::uuid and ((select public.creator_workspace_context())->'permissions' ?| array['website','linktree','settings']));
