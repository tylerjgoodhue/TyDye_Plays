create table if not exists public.creator_workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  schema_version integer not null default 1 check (schema_version > 0),
  workspace_data jsonb not null default '{}'::jsonb check (jsonb_typeof(workspace_data) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.creator_workspaces enable row level security;
alter table public.creator_workspaces force row level security;

drop policy if exists "Users can read their own workspace" on public.creator_workspaces;
create policy "Users can read their own workspace"
  on public.creator_workspaces for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own workspace" on public.creator_workspaces;
create policy "Users can create their own workspace"
  on public.creator_workspaces for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own workspace" on public.creator_workspaces;
create policy "Users can update their own workspace"
  on public.creator_workspaces for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own workspace" on public.creator_workspaces;
create policy "Users can delete their own workspace"
  on public.creator_workspaces for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.creator_workspaces from anon;
grant select, insert, update, delete on table public.creator_workspaces to authenticated;

create or replace function public.set_creator_workspace_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_creator_workspace_updated_at on public.creator_workspaces;
create trigger set_creator_workspace_updated_at
  before update on public.creator_workspaces
  for each row execute function public.set_creator_workspace_updated_at();