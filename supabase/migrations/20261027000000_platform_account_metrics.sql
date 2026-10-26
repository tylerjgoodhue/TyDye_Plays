create table if not exists public.creator_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('twitch', 'youtube', 'instagram', 'tiktok')),
  return_url text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists creator_oauth_states_expiry_idx on public.creator_oauth_states (expires_at);

create table if not exists public.creator_platform_accounts (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('twitch', 'youtube', 'instagram', 'tiktok')),
  external_account_id text not null,
  display_name text not null,
  username text not null default '',
  scopes text[] not null default '{}',
  token_ciphertext text not null,
  token_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error text,
  primary key (user_id, provider)
);

create table if not exists public.creator_platform_metrics (
  user_id uuid not null,
  provider text not null,
  metric_date date not null,
  metrics jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  primary key (user_id, provider, metric_date),
  foreign key (user_id, provider)
    references public.creator_platform_accounts (user_id, provider) on delete cascade
);

create index if not exists creator_platform_metrics_user_date_idx
  on public.creator_platform_metrics (user_id, metric_date desc);

alter table public.creator_oauth_states enable row level security;
alter table public.creator_oauth_states force row level security;
alter table public.creator_platform_accounts enable row level security;
alter table public.creator_platform_accounts force row level security;
alter table public.creator_platform_metrics enable row level security;
alter table public.creator_platform_metrics force row level security;

revoke all on public.creator_oauth_states from anon, authenticated;
revoke all on public.creator_platform_accounts from anon, authenticated;
revoke all on public.creator_platform_metrics from anon, authenticated;
grant all on public.creator_oauth_states to service_role;
grant all on public.creator_platform_accounts to service_role;
grant all on public.creator_platform_metrics to service_role;