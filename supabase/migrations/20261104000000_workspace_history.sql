begin;
create table if not exists public.creator_workspace_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_data jsonb not null,
  workspace_updated_at timestamptz,
  captured_at timestamptz not null default now()
);
create index if not exists creator_workspace_history_owner_time on public.creator_workspace_history(user_id,captured_at desc);
alter table public.creator_workspace_history enable row level security;
alter table public.creator_workspace_history force row level security;
revoke all on public.creator_workspace_history from public, anon, authenticated;
grant select on public.creator_workspace_history to authenticated;
drop policy if exists "Owners read their workspace history" on public.creator_workspace_history;
create policy "Owners read their workspace history" on public.creator_workspace_history for select to authenticated using ((select auth.uid())=user_id);
create or replace function public.capture_creator_workspace_history()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.workspace_data is not distinct from new.workspace_data then return new; end if;
  insert into public.creator_workspace_history(user_id,workspace_data,workspace_updated_at) values(old.user_id,old.workspace_data,old.updated_at);
  delete from public.creator_workspace_history where user_id=old.user_id and id not in (select id from public.creator_workspace_history where user_id=old.user_id order by captured_at desc,id desc limit 20);
  return new;
end;
$$;
revoke all on function public.capture_creator_workspace_history() from public,anon,authenticated;
drop trigger if exists capture_creator_workspace_history on public.creator_workspaces;
create trigger capture_creator_workspace_history before update on public.creator_workspaces for each row execute function public.capture_creator_workspace_history();
commit;
