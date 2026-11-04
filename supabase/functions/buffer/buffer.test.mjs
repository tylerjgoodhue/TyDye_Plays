import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
let handler, lastQuery='', signedIn=true, userId='owner', uploaded=false, missingBucket=false, createdBucket=false;
const origin='https://creator.example';
const channels=[{id:'fb',service:'facebook'},{id:'ig',service:'instagram'},{id:'yt',service:'youtube'},{id:'locked',service:'twitter',isLocked:true}];
const env={BUFFER_MEDIA_UPLOADS_ENABLED:'true',SUPABASE_URL:'https://project.example',SUPABASE_ANON_KEY:'public-test',SUPABASE_SERVICE_ROLE_KEY:'service-test',BUFFER_API_KEY:'buffer-test',BUFFER_ALLOWED_USER_ID:'owner',ALLOWED_APP_ORIGINS:origin};
globalThis.Deno={env:{get:key=>env[key]},serve:fn=>handler=fn};
globalThis.__bufferClient=()=>({auth:{getUser:async()=>({data:{user:signedIn?{id:userId}:null},error:null})},storage:{getBucket:async()=>missingBucket ? {data:null,error:{statusCode:'404'}} : ({data:{public:true},error:null}),createBucket:async(name,options)=>{assert.equal(options.public,true);createdBucket=true;missingBucket=false;return {error:null};},from:()=>({upload:async(path,bytes,options)=>{assert.ok(path.startsWith('owner/'));assert.equal(bytes.byteLength,4);assert.equal(options.contentType,'image/png');uploaded=true;return {error:null};},getPublicUrl:path=>({data:{publicUrl:`https://project.example/storage/v1/object/public/creatorhq-buffer-media/${path}`}})})}});
globalThis.fetch=async(url,options)=>{
 const {query}=JSON.parse(options.body);lastQuery=query;
 const data=query.includes('account { organizations')?{account:{organizations:[{id:'org'}]}}:query.includes('createPost(')?{createPost:{post:{id:'new-post',status:'draft'}}}:query.includes('editPost(')?{editPost:{post:{id:'edited'}}}:query.includes('posts(')?{posts:{edges:[],pageInfo:{hasNextPage:false}}}: {channels};
 return new Response(JSON.stringify({data}),{status:200});
};
let source=await readFile(new URL('./index.ts',import.meta.url),'utf8');
source=source.replace('import { createClient } from "npm:@supabase/supabase-js@2";','const createClient=globalThis.__bufferClient;');
await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const request=payload=>new Request('https://project.example/functions/v1/buffer',{method:'POST',headers:{Origin:origin,Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify(payload)});
test('filters the planner to each supported state and ignores injected status',async()=>{
 for(const status of ['scheduled','draft','error','sent','needs_approval']){assert.equal((await handler(request({action:'posts',organizationId:'org',status}))).status,200);assert.ok(lastQuery.includes(`status: [${status}]`));}
 await handler(request({action:'posts',organizationId:'org',status:'draft] injection'}));assert.ok(lastQuery.includes('status: [scheduled]'));
});
test('copy-only edit preserves scheduling and media by omission',async()=>{
 assert.equal((await handler(request({action:'editPost',id:'post',text:'Updated copy'}))).status,200);
 assert.ok(!lastQuery.includes('dueAt:'));assert.ok(!lastQuery.includes('mode:'));assert.ok(!lastQuery.includes('assets:'));
});
test('explicitly moves posts to draft, queue or a future custom time',async()=>{
 for(const mode of ['draft','addToQueue','customScheduled']){
 const response=await handler(request({action:'editPost',id:'post',text:'Updated',mode,dueAt:new Date(Date.now()+3600000).toISOString()}));assert.equal(response.status,200);
 assert.ok(lastQuery.includes(mode==='draft'?'saveToDraft: true':`mode: ${mode}`));
 }
 assert.equal((await handler(request({action:'editPost',id:'post',text:'Text',mode:'customScheduled',dueAt:'2000-01-01'}))).status,400);
});
test('creates Facebook Buffer drafts with platform metadata without publishing',async()=>{
 const response=await handler(request({action:'schedule',organizationId:'org',mode:'draft',targets:[{channelId:'fb',text:'Draft copy'}]}));
 assert.equal(response.status,200);assert.ok((await response.json()).results[0].post);assert.ok(lastQuery.includes('saveToDraft: true'));assert.ok(lastQuery.includes('facebook: { type: post }'));
});
test('validates Instagram media, YouTube titles, and locked channels per target',async()=>{
 const response=await handler(request({action:'schedule',organizationId:'org',targets:[{channelId:'ig',text:'No media'},{channelId:'yt',text:'No video'},{channelId:'locked',text:'Locked'}]}));
 const data=await response.json();assert.equal(data.results.length,3);assert.ok(data.results.every(item=>item.error));
});
test('creates Instagram reels with media and required feed setting',async()=>{
 await handler(request({action:'schedule',organizationId:'org',targets:[{channelId:'ig',text:'Clip',assetType:'video',assetUrl:'https://media.example/clip.mp4',postType:'reel'}]}));
 assert.ok(lastQuery.includes('type: reel, shouldShareToFeed: true'));assert.ok(lastQuery.includes('video: { url:'));
});
test('creates YouTube posts with a title, category and audience selection',async()=>{
 await handler(request({action:'schedule',organizationId:'org',targets:[{channelId:'yt',text:'Description',assetType:'video',assetUrl:'https://media.example/video.mp4',videoTitle:'My stream',categoryId:'20',madeForKids:false}]}));
 assert.ok(lastQuery.includes('title: "My stream"'));assert.ok(lastQuery.includes('categoryId: "20"'));assert.ok(lastQuery.includes('madeForKids: false'));
});
test('requires the configured owner before uploading media or changing posts',async()=>{
 signedIn=false;assert.equal((await handler(request({action:'posts'}))).status,401);signedIn=true;
 userId='other';assert.equal((await handler(request({action:'posts'}))).status,403);userId='owner';
});
test('uploads publishing media to a unique path and returns a stable public URL',async()=>{
 const response=await handler(new Request('https://project.example/functions/v1/buffer?action=uploadMedia',{method:'POST',headers:{Origin:origin,Authorization:'Bearer test','Content-Type':'image/png'},body:new Uint8Array([1,2,3,4])}));
 assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const data=await response.json();assert.equal(data.type,'image');assert.ok(data.url.includes('/object/public/'));assert.ok(uploaded);
});
test('rejects unsupported and oversized publishing files before storing',async()=>{
 for(const [type,length] of [['text/html','4'],['image/png',String(51*1024*1024)]]){
 const response=await handler(new Request('https://project.example/functions/v1/buffer?action=uploadMedia',{method:'POST',headers:{Origin:origin,Authorization:'Bearer test','Content-Type':type,'Content-Length':length},body:'test'}));assert.ok([400,413].includes(response.status));
 }
});

test('keeps existing deployed clients working before the frontend is pushed',async()=>{
 const response=await handler(request({action:'schedule',targets:[{channelId:'fb',text:'Legacy client post'}]}));assert.equal(response.status,200);assert.ok((await response.json()).results[0].post);
 await handler(request({action:'editPost',id:'post',text:'Legacy timing',dueAt:new Date(Date.now()+3600000).toISOString()}));assert.ok(lastQuery.includes('mode: customScheduled'));
});
test('creates the public publishing bucket on first intentional media upload',async()=>{
 missingBucket=true;
 const response=await handler(new Request('https://project.example/functions/v1/buffer?action=uploadMedia',{method:'POST',headers:{Origin:origin,Authorization:'Bearer test','Content-Type':'image/png'},body:new Uint8Array([1,2,3,4])}));assert.equal(response.status,200);assert.ok(createdBucket);
});

test('does not store or publish files until the owner explicitly enables media uploads',async()=>{
 env.BUFFER_MEDIA_UPLOADS_ENABLED='false';uploaded=false;createdBucket=false;
 const response=await handler(new Request('https://project.example/functions/v1/buffer?action=uploadMedia',{method:'POST',headers:{Origin:origin,Authorization:'Bearer test','Content-Type':'image/png'},body:new Uint8Array([1,2,3,4])}));
 assert.equal(response.status,503);assert.equal(uploaded,false);assert.equal(createdBucket,false);env.BUFFER_MEDIA_UPLOADS_ENABLED='true';
});
