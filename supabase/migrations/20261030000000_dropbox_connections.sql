-- Stores the Dropbox OAuth refresh token for each Creator HQ owner who connects
-- their account. Row-level security restricts access to the owning user only.
create table if not exists public.dropbox_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  account_name text not null default '',
  account_email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dropbox_connections enable row level security;
alter table public.dropbox_connections force row level security;

revoke all on public.dropbox_connections from anon, authenticated;

drop policy if exists "Owners manage their Dropbox connection" on public.dropbox_connections;
create policy "Owners manage their Dropbox connection"
  on public.dropbox_connections
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.set_dropbox_connection_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_dropbox_connection_updated_at on public.dropbox_connections;
create trigger set_dropbox_connection_updated_at
  before update on public.dropbox_connections
  for each row
  execute function public.set_dropbox_connection_updated_at();
