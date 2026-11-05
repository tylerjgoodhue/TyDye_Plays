import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMfa } from '../auth-mfa.mjs';
import { requireMfa } from '../supabase/functions/_shared/mfa.mjs';
const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const factor = {id:'app',factor_type:'totp',status:'verified'};
function fixture(initial=[],level='aal1') {
 let factors=structuredClone(initial),currentLevel=level,failCode=false;
 const calls=[];
 const api={
  listFactors:async()=>({data:{all:structuredClone(factors),totp:factors.filter(f=>f.factor_type==='totp'&&f.status==='verified')},error:null}),
  getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel,nextLevel:factors.some(f=>f.status==='verified')?'aal2':'aal1'},error:null}),
  enroll:async options=>{calls.push(['enroll',options]);factors.push({id:'pending',status:'unverified',factor_type:'totp'});return {data:{id:'pending',totp:{qr_code:'<svg/>',secret:'synthetic-test-secret'}},error:null};},
  challengeAndVerify:async options=>{calls.push(['verify',options]);if(failCode)return {error:new Error('Invalid code')};currentLevel='aal2';factors=factors.map(f=>f.id===options.factorId?{...f,status:'verified'}:f);return {data:{},error:null};},
  unenroll:async({factorId})=>{calls.push(['remove',factorId]);factors=factors.filter(f=>f.id!==factorId);return {data:{},error:null};}
 };
 return {mfa:createMfa(()=>({auth:{mfa:api}})),api,calls,fail:()=>failCode=true};
}
test('an enrolled AAL1 login requires the second factor; AAL2 does not',async()=>{
 assert.equal((await fixture([factor]).mfa.status()).required,true);
 assert.equal((await fixture([factor],'aal2').mfa.status()).required,false);
 assert.equal((await fixture().mfa.status()).required,false);
});
test('failed assurance checks do not allow access',async()=>{
 const f=fixture([factor]);f.api.getAuthenticatorAssuranceLevel=async()=>({error:new Error('Unavailable')});
 await assert.rejects(f.mfa.status(),/Unavailable/);
});
test('verification requires six digits before contacting auth',async()=>{
 const f=fixture([factor]);for(const code of ['123','12345a','1234567',''])await assert.rejects(f.mfa.verify('app',code),/six-digit/);
 assert.equal(f.calls.length,0);
});
test('enrollment remains inactive until a valid first code',async()=>{
 const f=fixture();await f.mfa.enroll();assert.equal((await f.mfa.status()).factors.length,0);
 f.fail();await assert.rejects(f.mfa.confirm('123456'),/Invalid code/);assert.equal((await f.mfa.status()).factors.length,0);
});
test('a verified setup becomes AAL2 and cancellation cannot remove it',async()=>{
 const f=fixture();await f.mfa.enroll();await f.mfa.confirm('123456');await f.mfa.cancel();
 assert.equal((await f.mfa.status()).currentLevel,'aal2');assert.equal((await f.mfa.status()).factors.length,1);
 assert.equal(f.calls.filter(c=>c[0]==='remove').length,0);
});
test('cancelled setup removes only its unverified pending factor',async()=>{
 const f=fixture([factor]);await f.mfa.enroll();await f.mfa.cancel();
 assert.deepEqual(f.calls.filter(c=>c[0]==='remove'),[['remove','pending']]);assert.equal((await f.mfa.status()).factors[0].id,'app');
});
test('retrying setup clears abandoned CreatorHQ setups but preserves other factors',async()=>{
 const f=fixture([factor,{id:'abandoned',factor_type:'totp',status:'unverified',friendly_name:'CreatorHQ setup 123'},{id:'other',factor_type:'totp',status:'unverified',friendly_name:'Another app'}]);
 await f.mfa.enroll();assert.deepEqual(f.calls.filter(c=>c[0]==='remove'),[['remove','abandoned']]);
});
test('removing an authenticator always requires a fresh successful code',async()=>{
 const f=fixture([factor],'aal2');f.fail();await assert.rejects(f.mfa.remove('app','123456'),/Invalid code/);
 assert.equal(f.calls.filter(c=>c[0]==='remove').length,0);
 const g=fixture([factor],'aal2');await g.mfa.remove('app','123456');assert.deepEqual(g.calls.map(c=>c[0]),['verify','remove']);
});
test('backend rejects AAL1, missing AAL, malformed tokens, and mismatched subjects when enrolled',()=>{
 const user={id:'owner',factors:[factor]};
 for(const token of [jwt({sub:'owner',aal:'aal1'}),jwt({sub:'owner'}),'invalid',jwt({sub:'other',aal:'aal2'})])assert.throws(()=>requireMfa(user,token),error=>error.status===403);
 assert.doesNotThrow(()=>requireMfa(user,jwt({sub:'owner',aal:'aal2'})));
});
test('backend does not lock out unenrolled users or treat an unverified setup as enabled',()=>{
 assert.doesNotThrow(()=>requireMfa({id:'owner',factors:[]},'test'));
 assert.doesNotThrow(()=>requireMfa({id:'owner',factors:[{...factor,status:'unverified'}]},'test'));
});

test('workspace gate never unlocks a password-only login when MFA is required', async () => {
 const { readFile } = await import('node:fs/promises');
 const vm = await import('node:vm');
 const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
 const source = html.slice(html.indexOf('      async function enterWorkspace() {'), html.indexOf('      async function secureGate() {'));
 let challenged=false,unlocked=false;
 const context = vm.createContext({window:{CreatorHQCloud:{authGate:{user:async()=>({id:'owner',email:'test@example.invalid',mfaRequired:true,mfaFactors:[{id:'app'}]})}}},showMfa:()=>challenged=true,unlockWorkspace:()=>unlocked=true,showAuth:()=>{},state:{},toast:()=>{}});
 await vm.runInContext(source+'\nenterWorkspace()',context);
 assert.equal(challenged,true);assert.equal(unlocked,false);
});
