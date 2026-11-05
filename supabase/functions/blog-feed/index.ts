import {createClient} from 'npm:@supabase/supabase-js@2';
const xml=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
Deno.serve(async request=>{
 const headers={'Content-Type':'application/rss+xml; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff'};
 if(request.method==='OPTIONS')return new Response(null,{headers});if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers});
 const query=new URL(request.url),owner=query.searchParams.get('owner')||'';if(!/^[0-9a-f-]{36}$/i.test(owner))return new Response('Not found',{status:404,headers});
 try{
 const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data,error}=await client.from('creator_blog_posts').select('id,title,slug,excerpt,publish_at,author_name').eq('owner_id',owner).is('deleted_at',null).in('status',['published','scheduled']).lte('publish_at',new Date().toISOString()).order('publish_at',{ascending:false}).limit(100);
 if(error)throw error;
 const site=(Deno.env.get('PUBLIC_SITE_URL')||'https://tydyeplays.com').replace(/\/$/,'');
 return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>TyDye Plays · The journal</title><link>${xml(site+'/blog.html')}</link><description>Stories, updates, and behind the scenes from the studio.</description>${(data||[]).map(post=>`<item><title>${xml(post.title)}</title><link>${xml(site+'/blog-post.html?slug='+encodeURIComponent(post.slug))}</link><guid isPermaLink="false">${xml(post.id)}</guid><description>${xml(post.excerpt)}</description><pubDate>${new Date(post.publish_at).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`,{headers});
 }catch{return new Response('The feed is temporarily unavailable',{status:503,headers});}
});
