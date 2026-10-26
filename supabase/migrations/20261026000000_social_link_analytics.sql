create table if not exists public.creator_social_links (
  link_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  platform text not null check (char_length(platform) between 1 and 40),
  destination_url text not null check (char_length(destination_url) <= 500),
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists creator_social_links_user_id_idx on public.creator_social_links (user_id);

create table if not exists public.creator_social_clicks (
  id bigint generated always as identity primary key,
  link_id uuid not null references public.creator_social_links (link_id) on delete cascade,
  source text not null default 'linktree' check (source = 'linktree'),
  clicked_at timestamptz not null default now()
);

create index if not exists creator_social_clicks_link_clicked_idx on public.creator_social_clicks (link_id, clicked_at desc);

alter table public.creator_social_links enable row level security;
alter table public.creator_social_links force row level security;
alter table public.creator_social_clicks enable row level security;
alter table public.creator_social_clicks force row level security;

drop policy if exists "Users can read their social links" on public.creator_social_links;
create policy "Users can read their social links"
  on public.creator_social_links for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read clicks on their social links" on public.creator_social_clicks;
create policy "Users can read clicks on their social links"
  on public.creator_social_clicks for select
  to authenticated
  using (exists (
    select 1 from public.creator_social_links
    where creator_social_links.link_id = creator_social_clicks.link_id
      and creator_social_links.user_id = (select auth.uid())
  ));

revoke all on table public.creator_social_links from anon;
revoke all on table public.creator_social_clicks from anon;
revoke insert, update, delete on table public.creator_social_links from authenticated;
revoke insert, update, delete on table public.creator_social_clicks from authenticated;
grant select on table public.creator_social_links to authenticated;
grant select on table public.creator_social_clicks to authenticated;
grant all on table public.creator_social_links to service_role;
grant all on table public.creator_social_clicks to service_role;
grant usage, select on sequence public.creator_social_clicks_id_seq to service_role;