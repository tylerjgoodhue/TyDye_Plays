-- Account preferences and recovery live in Supabase, never browser persistence.
create table if not exists public.creator_user_preferences(user_id uuid primary key references auth.users(id) on delete cascade,preferences jsonb not null default '{}' check(jsonb_typeof(preferences)='object'),updated_at timestamptz not null default now());
alter table public.creator_user_preferences enable row level security;
drop policy if exists "Account preferences" on public.creator_user_preferences;
create policy "Account preferences" on public.creator_user_preferences for all to authenticated using(user_id=(select auth.uid()) and (select public.creator_mfa_access())) with check(user_id=(select auth.uid()) and (select public.creator_mfa_access()));
grant select,insert,update on public.creator_user_preferences to authenticated;
create table if not exists public.creator_workspace_checkpoints(id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,actor_id uuid not null references auth.users(id) on delete cascade,reason text not null,workspace_data jsonb not null,created_at timestamptz not null default now());
alter table public.creator_workspace_checkpoints enable row level security;
drop policy if exists "Own cloud checkpoints" on public.creator_workspace_checkpoints;
create policy "Own cloud checkpoints" on public.creator_workspace_checkpoints for select to authenticated using(actor_id=(select auth.uid()) and (select public.creator_mfa_access()));
grant select on public.creator_workspace_checkpoints to authenticated;
create or replace function public.capture_workplace_checkpoint(snapshot jsonb,label text) returns uuid language plpgsql security definer set search_path='' as $$
declare context jsonb;result uuid;begin
 context=public.creator_workspace_context();
 if snapshot is null or jsonb_typeof(snapshot)!='object' or octet_length(snapshot::text)>1500000 then raise exception 'Invalid recovery snapshot';end if;
 insert into public.creator_workspace_checkpoints(owner_id,actor_id,reason,workspace_data) values((context->>'owner_id')::uuid,auth.uid(),left(label,120),snapshot) returning id into result;
 delete from public.creator_workspace_checkpoints where actor_id=auth.uid() and id not in(select id from public.creator_workspace_checkpoints where actor_id=auth.uid() order by created_at desc,id desc limit 20);
 return result;
end $$;
revoke all on function public.capture_workplace_checkpoint(jsonb,text) from public,anon;grant execute on function public.capture_workplace_checkpoint(jsonb,text) to authenticated;
create table if not exists public.creator_device_imports(id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,uploaded_by uuid not null references auth.users(id) on delete cascade,payload jsonb not null,created_at timestamptz not null default now());
alter table public.creator_device_imports enable row level security;
drop policy if exists "Owner reads migration archives" on public.creator_device_imports;
create policy "Owner reads migration archives" on public.creator_device_imports for select to authenticated using(owner_id=(select auth.uid()) and (select public.creator_mfa_access()));
grant select on public.creator_device_imports to authenticated;
create or replace function public.archive_creator_device(payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$ declare context jsonb;result uuid;begin
 context=public.creator_workspace_context();if payload is null or jsonb_typeof(payload)!='object' or octet_length(payload::text)>20000000 then raise exception 'Migration archive is too large';end if;
 insert into public.creator_device_imports(owner_id,uploaded_by,payload) values((context->>'owner_id')::uuid,auth.uid(),payload) returning id into result;return result;end $$;
revoke all on function public.archive_creator_device(jsonb) from public,anon;grant execute on function public.archive_creator_device(jsonb) to authenticated;

-- Private files. Public blog media is served only when its post is visible.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
('creatorhq-assets','creatorhq-assets',false,52428800,null),
('creatorhq-blog-media','creatorhq-blog-media',false,10485760,array['image/jpeg','image/png','image/webp','image/gif']) on conflict(id) do nothing;
create or replace function public.creator_media_access(object_name text,kind text) returns boolean language plpgsql stable security definer set search_path='' as $$
declare context jsonb;begin
 context=public.creator_workspace_context();
 return split_part(object_name,'/',1)=context->>'owner_id' and (context->>'role'='owner' or context->'permissions' ? 'settings' or (kind='assets' and context->'permissions' ?| array['assets','content']) or (kind='blog' and context->'permissions' ?| array['content','website']));
end $$;
revoke all on function public.creator_media_access(text,text) from public,anon;grant execute on function public.creator_media_access(text,text) to authenticated;
drop policy if exists "Workplace asset files" on storage.objects;
create policy "Workplace asset files" on storage.objects for all to authenticated using(bucket_id='creatorhq-assets' and public.creator_media_access(name,'assets')) with check(bucket_id='creatorhq-assets' and public.creator_media_access(name,'assets'));
drop policy if exists "Private blog media" on storage.objects;
create policy "Private blog media" on storage.objects for all to authenticated using(bucket_id='creatorhq-blog-media' and public.creator_media_access(name,'blog')) with check(bucket_id='creatorhq-blog-media' and public.creator_media_access(name,'blog'));

create table if not exists public.creator_blog_posts(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,
 title text not null default '' check(length(title)<=180),slug text not null check(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug)<=150),
 excerpt text not null default '' check(length(excerpt)<=600),body text not null default '' check(length(body)<=120000),
 status text not null default 'draft' check(status in('draft','review','scheduled','published','archived')),
 publish_at timestamptz,author_name text not null default '' check(length(author_name)<=100),category text not null default '' check(length(category)<=80),tags text[] not null default '{}' check(cardinality(tags)<=12),
 cover_path text not null default '',cover_alt text not null default '' check(length(cover_alt)<=250),cover_credit text not null default '' check(length(cover_credit)<=200),
 seo_title text not null default '' check(length(seo_title)<=180),seo_description text not null default '' check(length(seo_description)<=320),canonical_url text not null default '' check(canonical_url='' or canonical_url ~ '^https://'),
 featured boolean not null default false,noindex boolean not null default false,
 revision bigint not null default 0,created_by uuid references auth.users(id) on delete set null,updated_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),deleted_at timestamptz,
 unique(owner_id,slug),check(status not in('scheduled','published') or publish_at is not null),check(cover_path='' or cover_path like owner_id::text||'/'||id::text||'/%')
);
create index if not exists creator_blog_public on public.creator_blog_posts(owner_id,publish_at desc) where deleted_at is null and status in('scheduled','published');
alter table public.creator_blog_posts enable row level security;
drop policy if exists "Workplace blog readers" on public.creator_blog_posts;
create policy "Workplace blog readers" on public.creator_blog_posts for select to authenticated using(owner_id=((select public.creator_workspace_context())->>'owner_id')::uuid and ((select public.creator_workspace_context())->>'role'='owner' or (select public.creator_workspace_context())->'permissions' ?| array['content','website','settings']));
grant select on public.creator_blog_posts to authenticated;
create table if not exists public.creator_blog_revisions(id uuid primary key default gen_random_uuid(),post_id uuid not null references public.creator_blog_posts(id) on delete cascade,owner_id uuid not null references auth.users(id) on delete cascade,snapshot jsonb not null,saved_by uuid references auth.users(id) on delete set null,saved_at timestamptz not null default now());
alter table public.creator_blog_revisions enable row level security;
drop policy if exists "Workplace blog history" on public.creator_blog_revisions;
create policy "Workplace blog history" on public.creator_blog_revisions for select to authenticated using(owner_id=((select public.creator_workspace_context())->>'owner_id')::uuid and ((select public.creator_workspace_context())->>'role'='owner' or (select public.creator_workspace_context())->'permissions' ?| array['content','website','settings']));
grant select on public.creator_blog_revisions to authenticated;

create or replace function public.save_creator_blog(post jsonb,expected_revision bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare context jsonb;existing public.creator_blog_posts;next public.creator_blog_posts;can_publish boolean;post_id uuid;new_status text;begin
 context=public.creator_workspace_context();can_publish=context->>'role'='owner' or context->'permissions' ?| array['website','settings'];
 if not can_publish and not(context->'permissions' ? 'content') then raise exception 'Your role cannot edit blog posts' using errcode='42501';end if;
 if post is null or jsonb_typeof(post)!='object' or octet_length(post::text)>200000 then raise exception 'The article is too large';end if;
 post_id=coalesce(nullif(post->>'id','')::uuid,gen_random_uuid());new_status=coalesce(post->>'status','draft');
 select * into existing from public.creator_blog_posts where id=post_id for update;
 if found then
  if existing.owner_id!=(context->>'owner_id')::uuid then raise exception 'This post belongs to another workplace' using errcode='42501';end if;
  if expected_revision is null or expected_revision!=existing.revision then raise exception 'A teammate changed this post. Reload it before saving your version' using errcode='40001';end if;
  if not can_publish and (existing.status in('scheduled','published') or new_status in('scheduled','published','archived') or nullif(post->>'deleted_at','') is not null) then raise exception 'A website manager must publish, schedule, or remove live posts' using errcode='42501';end if;
  insert into public.creator_blog_revisions(post_id,owner_id,snapshot,saved_by) values(existing.id,existing.owner_id,to_jsonb(existing),auth.uid());
 else
  if expected_revision is not null then raise exception 'This post no longer exists' using errcode='40001';end if;
  if not can_publish and new_status not in('draft','review') then raise exception 'A website manager must publish or schedule posts' using errcode='42501';end if;
 end if;
 if new_status in('scheduled','published') and (length(trim(coalesce(post->>'title','')))=0 or length(trim(coalesce(post->>'body','')))=0 or length(trim(coalesce(post->>'author_name','')))=0) then raise exception 'Add a title, article, and public author name before publishing';end if;
 if new_status in('scheduled','published') and coalesce(post->>'cover_path','')!='' and length(trim(coalesce(post->>'cover_alt','')))=0 then raise exception 'Add descriptive alt text for the cover image';end if;
 if new_status='scheduled' and (nullif(post->>'publish_at','')::timestamptz is null or (nullif(post->>'publish_at','')::timestamptz<=now() and existing.status is distinct from 'scheduled')) then raise exception 'Choose a future publication time';end if;
 insert into public.creator_blog_posts(id,owner_id,title,slug,excerpt,body,status,publish_at,author_name,category,tags,cover_path,cover_alt,cover_credit,seo_title,seo_description,canonical_url,featured,noindex,revision,created_by,updated_by,deleted_at)
 values(post_id,(context->>'owner_id')::uuid,coalesce(post->>'title',''),post->>'slug',coalesce(post->>'excerpt',''),coalesce(post->>'body',''),new_status,nullif(post->>'publish_at','')::timestamptz,coalesce(post->>'author_name',''),coalesce(post->>'category',''),array(select left(trim(value),60) from jsonb_array_elements_text(coalesce(post->'tags','[]')) value),coalesce(post->>'cover_path',''),coalesce(post->>'cover_alt',''),coalesce(post->>'cover_credit',''),coalesce(post->>'seo_title',''),coalesce(post->>'seo_description',''),coalesce(post->>'canonical_url',''),coalesce((post->>'featured')::boolean,false),coalesce((post->>'noindex')::boolean,false),coalesce(existing.revision+1,0),auth.uid(),auth.uid(),nullif(post->>'deleted_at','')::timestamptz)
 on conflict(id) do update set title=excluded.title,slug=excluded.slug,excerpt=excluded.excerpt,body=excluded.body,status=excluded.status,publish_at=excluded.publish_at,author_name=excluded.author_name,category=excluded.category,tags=excluded.tags,cover_path=excluded.cover_path,cover_alt=excluded.cover_alt,cover_credit=excluded.cover_credit,seo_title=excluded.seo_title,seo_description=excluded.seo_description,canonical_url=excluded.canonical_url,featured=excluded.featured,noindex=excluded.noindex,revision=excluded.revision,updated_by=auth.uid(),updated_at=clock_timestamp(),deleted_at=excluded.deleted_at returning * into next;
 delete from public.creator_blog_revisions rev where rev.post_id=next.id and rev.id not in(select kept.id from public.creator_blog_revisions kept where kept.post_id=next.id order by kept.saved_at desc,kept.id desc limit 20);
 return to_jsonb(next);
end $$;
revoke all on function public.save_creator_blog(jsonb,bigint) from public,anon;grant execute on function public.save_creator_blog(jsonb,bigint) to authenticated;

-- Scheduling is enforced on every public read using database time; no browser tab or cron is needed.
create or replace function public.list_public_blog_posts(profile_owner uuid,search_text text default '',category_filter text default '',tag_filter text default '',page_size integer default 12,page_offset integer default 0) returns jsonb language sql stable security definer set search_path='' as $$
 with visible as(select p.* from public.creator_blog_posts p where p.owner_id=profile_owner and p.deleted_at is null and p.status in('published','scheduled') and p.publish_at<=now()
 and (category_filter='' or p.category=category_filter) and (tag_filter='' or p.tags @> array[tag_filter]) and (search_text='' or to_tsvector('english',p.title||' '||p.excerpt||' '||p.body) @@ websearch_to_tsquery('english',left(search_text,200)))),
 page as(select id,title,slug,excerpt,publish_at,author_name,category,tags,cover_path,cover_alt,cover_credit,featured,seo_title,seo_description,noindex,updated_at,greatest(1,ceil(array_length(regexp_split_to_array(body,'\s+'),1)/200.0)) as reading_minutes from visible order by featured desc,publish_at desc,id limit greatest(1,least(page_size,30)) offset greatest(0,least(page_offset,10000)))
 select jsonb_build_object('posts',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb),'total',(select count(*) from visible),'categories',coalesce((select jsonb_agg(distinct category) from public.creator_blog_posts where owner_id=profile_owner and deleted_at is null and status in('published','scheduled') and publish_at<=now() and category!=''),'[]'::jsonb));
$$;
create or replace function public.get_public_blog_post(profile_owner uuid,post_slug text) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(p)-'owner_id'-'created_by'-'updated_by'-'deleted_at' from public.creator_blog_posts p where owner_id=profile_owner and slug=post_slug and deleted_at is null and status in('published','scheduled') and publish_at<=now();
$$;
revoke all on function public.list_public_blog_posts(uuid,text,text,text,integer,integer),public.get_public_blog_post(uuid,text) from public;
grant execute on function public.list_public_blog_posts(uuid,text,text,text,integer,integer),public.get_public_blog_post(uuid,text) to anon,authenticated;

-- Editors may read workplace draft media, but cannot replace/remove live media.
create or replace function public.creator_blog_media_write(object_name text) returns boolean language plpgsql stable security definer set search_path='' as $$
declare context jsonb;begin
 context=public.creator_workspace_context();
 if not public.creator_media_access(object_name,'blog') then return false;end if;
 if context->>'role'='owner' or context->'permissions' ?| array['website','settings'] then return true;end if;
 return exists(select 1 from public.creator_blog_posts where id::text=split_part(object_name,'/',2) and owner_id=(context->>'owner_id')::uuid and status in('draft','review') and deleted_at is null);
end $$;
revoke all on function public.creator_blog_media_write(text) from public,anon;grant execute on function public.creator_blog_media_write(text) to authenticated;
drop policy if exists "Private blog media" on storage.objects;
drop policy if exists "Read private blog media" on storage.objects;
create policy "Read private blog media" on storage.objects for select to authenticated using(bucket_id='creatorhq-blog-media' and public.creator_media_access(name,'blog'));
drop policy if exists "Upload private blog media" on storage.objects;
create policy "Upload private blog media" on storage.objects for insert to authenticated with check(bucket_id='creatorhq-blog-media' and public.creator_blog_media_write(name));
drop policy if exists "Update private blog media" on storage.objects;
create policy "Update private blog media" on storage.objects for update to authenticated using(bucket_id='creatorhq-blog-media' and public.creator_blog_media_write(name)) with check(bucket_id='creatorhq-blog-media' and public.creator_blog_media_write(name));
drop policy if exists "Remove private blog media" on storage.objects;
create policy "Remove private blog media" on storage.objects for delete to authenticated using(bucket_id='creatorhq-blog-media' and public.creator_blog_media_write(name));

create or replace function public.list_creator_blog_posts(search_text text default '',status_filter text default 'all',page_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare context jsonb;result jsonb;begin
 context=public.creator_workspace_context();
 if context->>'role'!='owner' and not(context->'permissions' ?| array['content','website','settings']) then raise exception 'Your role cannot view blog drafts' using errcode='42501';end if;
 with all_posts as(select p.*,case when deleted_at is not null then 'trash' when status in('published','scheduled') and publish_at<=now() then 'published' else status end as effective_status from public.creator_blog_posts p where owner_id=(context->>'owner_id')::uuid),
 filtered as(select * from all_posts where ((status_filter='all' and deleted_at is null and status!='archived') or (status_filter!='all' and effective_status=status_filter)) and (search_text='' or to_tsvector('english',title||' '||excerpt||' '||body||' '||category) @@ websearch_to_tsquery('english',left(search_text,200)))),
 page as(select id,title,slug,excerpt,publish_at,author_name,category,tags,cover_path,cover_alt,featured,status,deleted_at,updated_at,revision,effective_status,greatest(1,ceil(array_length(regexp_split_to_array(body,'\s+'),1)/200.0)) as reading_minutes from filtered order by updated_at desc,id limit 30 offset greatest(0,least(page_offset,100000)))
 select jsonb_build_object('posts',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb),'total',(select count(*) from filtered),'stats',(select jsonb_build_object('draft',count(*) filter(where effective_status='draft'),'review',count(*) filter(where effective_status='review'),'scheduled',count(*) filter(where effective_status='scheduled'),'published',count(*) filter(where effective_status='published')) from all_posts where deleted_at is null)) into result;
 return result;
end $$;
revoke all on function public.list_creator_blog_posts(text,text,integer) from public,anon;grant execute on function public.list_creator_blog_posts(text,text,integer) to authenticated;
