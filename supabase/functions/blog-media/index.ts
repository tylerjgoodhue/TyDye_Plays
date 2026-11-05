import {createClient} from 'npm:@supabase/supabase-js@2';
const headers={'Access-Control-Allow-Origin':'*','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
Deno.serve(async request=>{
 if(request.method==='OPTIONS')return new Response(null,{headers:{...headers,'Access-Control-Allow-Methods':'GET,HEAD,OPTIONS'}});
 if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers});
 const url=new URL(request.url),id=url.searchParams.get('post')||'',asset=url.searchParams.get('asset')||'cover';
 if(!/^[0-9a-f-]{36}$/i.test(id)||!(asset==='cover'||/^[0-9a-f-]{36}\.(png|jpg|jpeg|webp|gif)$/i.test(asset)))return new Response('Not found',{status:404,headers});
 try{
 const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:post,error}=await client.from('creator_blog_posts').select('id,owner_id,status,publish_at,cover_path,body,deleted_at').eq('id',id).maybeSingle();
 if(error||!post||post.deleted_at||!['published','scheduled'].includes(post.status)||!post.publish_at||new Date(post.publish_at)>new Date())return new Response('Not found',{status:404,headers});
 const prefix=`${post.owner_id}/${post.id}/`;
 const path=asset==='cover'?post.cover_path:post.body.includes(`](media:${asset})`)?prefix+asset:'';
 if(!path||!path.startsWith(prefix))return new Response('Not found',{status:404,headers});
 const {data:file,error:downloadError}=await client.storage.from('creatorhq-blog-media').download(path);
 if(downloadError||!file||!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))return new Response('Not found',{status:404,headers});
 return new Response(request.method==='HEAD'?null:file,{headers:{...headers,'Content-Type':file.type,'Content-Length':String(file.size)}});
 }catch{return new Response('Media is temporarily unavailable',{status:503,headers});}
});
