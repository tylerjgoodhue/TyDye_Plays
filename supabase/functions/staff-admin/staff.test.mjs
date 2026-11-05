import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {stripTypeScriptTypes} from 'node:module';
const owner='00000000-0000-4000-8000-000000007001',editor='00000000-0000-4000-8000-000000007002';let handler,inserted,updated,deleted,failMember=false,failAuth=false;
const env={SUPABASE_URL:'https://project.example',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'service',STAFF_ADMIN_ALLOWED_USER_IDS:owner,ALLOWED_APP_ORIGINS:'https://creator.example'};
globalThis.Deno={env:{get:key=>env[key]},serve:fn=>handler=fn};
const member={user_id:editor,owner_id:owner,role:'editor',permissions:['dashboard','content','assets'],active:true};
const admin={auth:{admin:{
 listUsers:async()=>({data:{users:[{id:editor,email:'editor@example.invalid',user_metadata:{role:'owner',permissions:['settings']}}]},error:null}),
 createUser:async()=>({data:{user:{id:editor}},error:null}),deleteUser:async id=>{deleted=id;return {error:null};},
 getUserById:async()=>({data:{user:{id:editor,user_metadata:{}}},error:null}),
 updateUserById:async()=>failAuth?{error:new Error('Auth update failed')}:{data:{user:{id:editor}},error:null}
}},from:()=>({select(){return this;},eq(){return this;},then(resolve,reject){return Promise.resolve({data:[member],error:null}).then(resolve,reject);},maybeSingle:async()=>({data:member,error:null}),insert:async row=>{inserted=row;return {error:failMember?new Error('Membership write failed'):null};},upsert:async row=>{updated=row;return {error:null};}})};
globalThis.__staffClient=(url,key)=>key==='service'?admin:{auth:{getUser:async()=>({data:{user:{id:owner}},error:null})}};
let source=await readFile(new URL('./index.ts',import.meta.url),'utf8');source=source.replace('import { createClient } from "npm:@supabase/supabase-js@2";','const createClient=globalThis.__staffClient;').replace('"../_shared/mfa.mjs"',JSON.stringify(new URL('../_shared/mfa.mjs',import.meta.url).href));await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const request=body=>new Request('https://project.example/functions/v1/staff-admin',{method:'POST',headers:{Origin:'https://creator.example',Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify(body)});
test('creating an editor explicitly joins the same owner workplace',async()=>{
 inserted=null;const result=await handler(request({action:'create',email:'editor@example.invalid',password:'test-password',role:'editor',permissions:['dashboard','content','assets']}));assert.equal(result.status,200);assert.equal(inserted.owner_id,owner);assert.equal(inserted.user_id,editor);assert.equal(inserted.role,'editor');
});
test('failed membership creation rolls back the newly created orphan account',async()=>{
 failMember=true;deleted=null;try{assert.equal((await handler(request({action:'create',email:'editor@example.invalid',password:'test-password',role:'editor'}))).status,400);assert.equal(deleted,editor);}finally{failMember=false;}
});
test('staff list uses trusted workplace roles instead of user-editable metadata',async()=>{
 const response=await handler(request({action:'list'}));const body=await response.json();assert.equal(body.users[0].role,'editor');assert.deepEqual(body.users[0].permissions,['dashboard','content','assets']);
});
test('updating suspension and permissions updates shared membership safely',async()=>{
 updated=null;const response=await handler(request({action:'update',id:editor,role:'editor',permissions:['content'],banned:true}));assert.equal(response.status,200);assert.equal(updated.active,false);assert.equal(updated.owner_id,owner);assert.deepEqual(updated.permissions,['content']);
});
test('an auth update failure does not partially grant new workplace permissions',async()=>{
 updated=null;failAuth=true;try{assert.equal((await handler(request({action:'update',id:editor,role:'admin',permissions:['settings']}))).status,400);assert.equal(updated,null);}finally{failAuth=false;}
});
test('additional staff accounts cannot receive the real workplace Owner role',async()=>{
 assert.equal((await handler(request({action:'create',email:'editor@example.invalid',password:'test-password',role:'owner'}))).status,400);
 assert.equal((await handler(request({action:'update',id:editor,role:'owner',permissions:['settings']}))).status,400);
});
test('default editor and viewer permissions do not grant unrelated management access',async()=>{
 await handler(request({action:'create',email:'editor@example.invalid',password:'test-password',role:'editor'}));assert.deepEqual(inserted.permissions,['dashboard','tasks','schedule','content','assets']);
 await handler(request({action:'create',email:'viewer@example.invalid',password:'test-password',role:'viewer'}));assert.deepEqual(inserted.permissions,['dashboard','analytics']);
});
