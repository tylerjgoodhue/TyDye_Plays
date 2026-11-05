-- Homepage recency must not be affected by the journal's featured-first ordering.
create or replace function public.get_latest_public_blog_post(profile_owner uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'slug',p.slug,'title',p.title,'excerpt',p.excerpt,
   'publish_at',p.publish_at,'cover_path',p.cover_path,'cover_alt',p.cover_alt)
 from public.creator_blog_posts p
 where p.owner_id=profile_owner and p.deleted_at is null
   and p.status in ('published','scheduled') and p.publish_at<=now()
 order by p.publish_at desc,p.id desc limit 1;
$$;
revoke all on function public.get_latest_public_blog_post(uuid) from public;
grant execute on function public.get_latest_public_blog_post(uuid) to anon,authenticated;
