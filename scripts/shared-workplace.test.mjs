import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {resolveWorkplace,requireWorkplacePermission} from '../supabase/functions/_shared/workspace.mjs';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');const cloud=await readFile(new URL('../cloud-sync.js',import.meta.url),'utf8');
test('workspace permissions come from membership, not editable account metadata',()=>{
 assert.throws(()=>requireWorkplacePermission({role:'staff',permissions:['content']},['social']),/does not allow/);
 assert.doesNotThrow(()=>requireWorkplacePermission({role:'staff',permissions:['social']},['social']));
 assert.doesNotThrow(()=>requireWorkplacePermission({role:'owner',permissions:[]},['settings']));
});
test('private integrations resolve the shared owner using the signed-in editor token',async()=>{
 const original=globalThis.fetch;let seen;
 globalThis.fetch=async(url,options)=>{seen={url,options};return new Response(JSON.stringify({owner_id:'creator',role:'staff',permissions:['assets']}));};
 try{const result=await resolveWorkplace({id:'editor'},'editor-token','https://project.example','public-key',['assets']);assert.equal(result.owner_id,'creator');assert.equal(seen.options.headers.Authorization,'Bearer editor-token');assert.ok(seen.url.endsWith('/rpc/creator_workspace_context'));}finally{globalThis.fetch=original;}
});
test('non-members cannot replace server membership with self-assigned roles',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({message:'No membership'}),{status:403});
 try{await assert.rejects(resolveWorkplace({id:'stranger',user_metadata:{assignedRole:'owner'}},'token','https://project.example','key',['social']),error=>error.status===403);}finally{globalThis.fetch=original;}
});
function dashboard(publish){
 const refresh={};const host={innerHTML:'',querySelector:()=>refresh};let refreshed=0;
 const state={content:[{id:'ready',title:'Ready edit',status:'Ready to Post'},{id:'due',title:'Today post',status:'Scheduled',publishDate:'2026-11-05'},{id:'failed',title:'Retry me',status:'Scheduled',failed:true}],tasks:[{status:'To Do',dueDate:'2026-11-04'}],integrationIssues:[]};
 const context=vm.createContext({state,document:{getElementById:id=>id==='view-dashboard'?{}:host},localDateKey:()=> '2026-11-05',contentPublishingStatus:item=>item.failed?'Needs attention':item.status,escapeHtml:String,userHasAccess:view=>!view.startsWith('buffer-')||publish,window:{CreatorHQCloud:{refreshLinkedContentPosts:async()=>refreshed++}},toast(){},Date});
 const a=html.indexOf('      function renderActionDashboard()'),b=html.indexOf('      function loadState()',a);vm.runInContext(html.slice(a,b)+'\nrenderActionDashboard()',context);
 return {host,refresh,refreshed:()=>refreshed};
}
test('Today’s next steps still shows shared counts and editor-safe content links',()=>{
 const {host,refresh}=dashboard(false);assert.match(host.innerHTML,/Today’s next steps/);assert.match(host.innerHTML,/<strong>1<\/strong><span>Content due to publish today/);assert.match(host.innerHTML,/data-edit-content="ready"/);assert.doesNotMatch(host.innerHTML,/data-content-send=/);assert.equal(refresh.hidden,true);
});
test('homepage publishing actions and refresh still work for publishing accounts',async()=>{
 const d=dashboard(true);assert.match(d.host.innerHTML,/data-view="buffer-scheduled"/);assert.match(d.host.innerHTML,/data-content-send="ready"/);await d.refresh.onclick({currentTarget:d.refresh});assert.equal(d.refreshed(),1);assert.equal(d.refresh.disabled,false);
});
test('content pipeline has one stable destination inside the Buffer navigation group',()=>{
 const sidebar=html.slice(html.indexOf('aria-label="Buffer and content"'),html.indexOf('>In the studio<'));
 assert.match(sidebar,/data-view="content"/);assert.equal((html.match(/id="nav-content-count"/g)||[]).length,1);assert.match(html,/id="view-content"/);
});
test('a shared save uses its loaded revision and retains local edits on conflict',async()=>{
 let sent;const context=vm.createContext({session:{user:{id:'editor'}},preparedForUser:'editor',workspaceRevision:7,workspaceChangeCount:2,workspaceDirty:true,pendingWorkspaceSave:Promise.resolve(),syncTimer:null,clearTimeout(){},cloudPersistence:{persistAssets:async value=>value},currentUser:async()=>({id:'creator',actorId:'editor'}),withoutLocalImageBytes:value=>value,storage:()=>({getWorkspace:()=>({content:[{id:'edit'}]})}),client:{rpc:async(name,args)=>{sent={name,args};return {error:{code:'40001',message:'Newer team changes'}};}},ui:()=>({}),readConfig:()=>({}),writeConfig(){},MAX_SNAPSHOT_BYTES:1500000,TextEncoder,Date});
 const a=cloud.indexOf('async function uploadWorkspace('),b=cloud.indexOf('async function listWorkspaceHistory',a);vm.runInContext(cloud.slice(a,b),context);
 await assert.rejects(vm.runInContext('uploadWorkspace()',context),error=>error.code==='40001');assert.equal(sent.name,'save_creator_workspace');assert.equal(sent.args.expected_revision,7);assert.equal(vm.runInContext('workspaceDirty',context),true);assert.equal(vm.runInContext('workspaceRevision',context),7);
});
test('team polling never replaces unsaved local edits',async()=>{
 let loaded=0;const context=vm.createContext({session:{user:{id:'editor'}},mfaReady:true,preparedForUser:'editor',workspaceDirty:true,syncing:false,workspaceChangeCount:1,workspaceRevision:1,document:{hidden:false},client:{rpc:async()=>{loaded++;}},ui:()=>({}),storage:()=>({replaceWorkspace(){throw new Error('Must not replace edits');}})});
 const a=cloud.indexOf('async function refreshSharedWorkplace()'),b=cloud.indexOf('let authRevision',a);vm.runInContext(cloud.slice(a,b),context);await vm.runInContext('refreshSharedWorkplace()',context);assert.equal(loaded,0);
});
test('an editor loads the shared content before the workspace is unlocked',async()=>{
 const order=[];const state={profile:{name:'Shared creator'},settings:{name:'Shared creator'},content:[]};
 const gate={user:async()=>({id:'editor-account',email:'editor@example.invalid',role:'editor',permissions:['dashboard','content']}),prepareWorkplace:async()=>{order.push('load');state.content=[{id:'owner-content'}];}};
 const context=vm.createContext({state,window:{CreatorHQCloud:{authGate:gate}},applyPermissions(){},unlockWorkspace(){order.push('unlock');assert.equal(state.content[0].id,'owner-content');},location:{hash:''},toast(){},signedInEmail:'',signedInUserId:''});
 const a=html.indexOf('      async function enterWorkspace()'),b=html.indexOf('      async function secureGate()',a);await vm.runInContext(html.slice(a,b)+'\nenterWorkspace()',context);
 assert.deepEqual(order,['load','unlock']);assert.equal(context.signedInUserId,'editor-account');assert.equal(state.settings.name,'Shared creator');
});
test('shared content platform text cannot inject markup into another member’s pipeline',()=>{
 const board={innerHTML:''};const context=vm.createContext({state:{content:[{id:'content',title:'Shared edit',status:'Ready to Post',platform:'<img src=x onerror=alert(1)>',priority:'Medium'}]},CONTENT_STAGES:['Ready to Post'],document:{getElementById:id=>id==='content-board'?board:{value:id==='content-platform-filter'?'all':''}},escapeHtml:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]),userHasAccess:()=>false,contentPublishingStatus:()=>''});
 const a=html.indexOf('      function renderContentBoard()'),b=html.indexOf('      function renderIdeas()',a);vm.runInContext(html.slice(a,b)+'\nrenderContentBoard()',context);assert.doesNotMatch(board.innerHTML,/<img src=x/);assert.match(board.innerHTML,/&lt;img src=x/);
});
test('team polling preserves open content-editor forms before they reach local state',async()=>{
 let loaded=0;const context=vm.createContext({session:{user:{id:'editor'}},mfaReady:true,preparedForUser:'editor',workspaceDirty:false,syncing:false,workspaceChangeCount:1,workspaceRevision:1,document:{hidden:false,querySelector:selector=>selector==='.modal-backdrop'?{}:null},client:{rpc:async()=>{loaded++;}},ui:()=>({}),storage:()=>({replaceWorkspace(){throw new Error('Must not replace an open editor');}})});
 const a=cloud.indexOf('async function refreshSharedWorkplace()'),b=cloud.indexOf('let authRevision',a);vm.runInContext(cloud.slice(a,b),context);await vm.runInContext('refreshSharedWorkplace()',context);assert.equal(loaded,0);
});
test('an editor opened while a team update is loading is not overwritten by that response',async()=>{
 let modal=false,replaced=false;const context=vm.createContext({session:{user:{id:'editor'}},mfaReady:true,preparedForUser:'editor',workspaceDirty:false,syncing:false,workspaceChangeCount:1,workspaceRevision:1,document:{hidden:false,querySelector:selector=>selector==='.modal-backdrop'&&modal?{}:null},client:{rpc:async()=>{modal=true;return {data:{revision:2,workspace_data:{content:[]}}};}},ui:()=>({}),storage:()=>({replaceWorkspace(){replaced=true;}})});
 const a=cloud.indexOf('async function refreshSharedWorkplace()'),b=cloud.indexOf('let authRevision',a);vm.runInContext(cloud.slice(a,b),context);await vm.runInContext('refreshSharedWorkplace()',context);assert.equal(replaced,false);
});
