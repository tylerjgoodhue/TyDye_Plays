import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const cloud=await readFile(new URL('../cloud-sync.js',import.meta.url),'utf8');
const helpers=html.slice(html.indexOf('      let workspaceSaveFailed'),html.indexOf('      function loadState()'));
const saver=html.slice(html.indexOf('      function saveState(options'),html.indexOf('      function normalizeCreatorProfile'));
function fixture(){
 const saved=new Map();let fail=false,queued=0;
 const element={dataset:{},setAttribute(){},append(){},focus(){}};
 const document={getElementById:id=>id==='view-dashboard'?null:element,createElement:()=>({...element,dataset:{}}),querySelector:()=>element};
 const state={tasks:[{id:'task',title:'Keep my task'}],content:[],ideas:[],goals:[],assets:[],streams:[],crm:[],recoveryTrash:[],integrationIssues:[]};
 const context=vm.createContext({state,signedInEmail:'owner@example.com',STORE_KEY:'workspace',document,crypto:webcrypto,structuredClone,console:{error(){},warn(){}},Date,Map,Set,localStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>{if(fail&&key==='workspace')throw new Error('Storage full');saved.set(key,value);}},window:{CreatorHQCloud:{queueSync:()=>queued++}},toast(){},profilePublicData:()=>({}),publicCreatorProfilesData:()=>({}),renderAll(){},renderContentBoard(){},lastPublicProfileSnapshot:null});
 vm.runInContext(helpers+saver+'\nopenRecoveryCenter=()=>{};renderActionDashboard=()=>{};',context);
 return {context,saved,setFail:value=>fail=value,queued:()=>queued,run:code=>vm.runInContext(code,context)};
}
test('workspace deletions are recoverable and restore preserves other records',()=>{
 const f=fixture();f.run("moveToRecovery('tasks','task')");assert.equal(f.context.state.tasks.length,0);assert.equal(f.context.state.recoveryTrash.length,1);
 f.context.state.tasks.push({id:'different',title:'New task'});f.run('restoreRecoveryItem(state.recoveryTrash[0].id)');assert.equal(f.context.state.tasks.length,2);assert.equal(f.context.state.recoveryTrash.length,0);
});
test('a failed local save rolls back a deletion and does not queue cloud sync',()=>{
 const f=fixture();f.setFail(true);f.run("moveToRecovery('tasks','task')");assert.equal(f.context.state.tasks.length,1);assert.equal(f.context.state.recoveryTrash.length,0);assert.equal(f.queued(),0);
});
test('recovery rejects unsupported collection names',()=>{
 const f=fixture();f.context.state.recoveryTrash=[{id:'bad',collection:'__proto__',record:{id:'bad'}}];f.run("restoreRecoveryItem('bad')");assert.equal(f.context.state.recoveryTrash.length,1);
});
test('checkpoints retain five versions and exclude local image bytes',()=>{
 const f=fixture();for(let i=0;i<7;i++)f.run(`captureLocalRecovery({assets:[{id:'image',dataUrl:'private-image'}],recoveryTrash:[{record:{dataUrl:'private-deleted-image'}}]},'Checkpoint ${i}')`);
 const list=f.run('localRecoveryHistory()');assert.equal(list.length,5);assert.equal(list[0].reason,'Checkpoint 6');assert.equal(list[0].workspace.assets[0].dataUrl,'');assert.equal(list[0].workspace.recoveryTrash[0].record.dataUrl,'');
});
test('partial Buffer delivery cannot mark content as fully published',()=>{
 const f=fixture();f.context.state.content=[{id:'content',status:'Scheduled',bufferPostIds:['a','b']}];
 f.run("reconcileContentPosts([{id:'a',status:'sent'}])");assert.equal(f.context.state.content[0].status,'Scheduled');assert.equal(f.run('contentPublishingStatus(state.content[0])'),'Partly published');
 f.run("reconcileContentPosts([{id:'b',status:'sent'}])");assert.equal(f.context.state.content[0].status,'Published');
});
test('failed linked posts are surfaced without dropping other channels',()=>{
 const f=fixture();f.context.state.content=[{id:'content',status:'Scheduled',bufferPostIds:['a','b']}];f.run("reconcileContentPosts([{id:'a',status:'scheduled'},{id:'b',status:'error',error:{message:'Reconnect channel'}}])");assert.equal(f.run('contentPublishingStatus(state.content[0])'),'Needs attention');assert.equal(Object.keys(f.context.state.content[0].bufferPostStates).length,2);
});
test('content editor no longer duplicates the Buffer source control ID',()=>{
 const start=html.indexOf('function contentModal(');const end=html.indexOf('function ideaModal(',start);assert.ok(!html.slice(start,end).includes('id="buffer-content-source"'));
});
test('Dropbox uploads preserve duplicate filenames and safely encode Unicode headers',async()=>{
 let headers={},percent=0;
 class XHR{constructor(){this.upload={};}open(){}setRequestHeader(name,value){headers[name]=value;assert.ok(!/[^\x00-\x7f]/.test(value));}send(){this.upload.onprogress({lengthComputable:true,loaded:5,total:10});this.status=200;this.responseText='{"name":"new.png"}';this.onload();}}
 const section=cloud.slice(cloud.indexOf('  upload: async (path,file,options={})=>{'),cloud.indexOf('\n};',cloud.indexOf('  upload: async (path,file,options={})=>{')));
 const context=vm.createContext({readConfig:()=>({url:'https://project.example',anonKey:'public'}),client:{},session:{access_token:'test'},XMLHttpRequest:XHR,Promise,Error,JSON});
 const api=vm.runInContext('({'+section+'})',context);
 await api.upload('/émoji-🎮.png',new Uint8Array([1]),{onProgress:value=>percent=value});const args=JSON.parse(headers['Dropbox-API-Arg']);assert.equal(args.path,'/émoji-🎮.png');assert.equal(args.mode,'add');assert.equal(args.autorename,true);assert.equal(percent,50);
 await api.upload('/same.png',new Uint8Array([1]),{replace:true});assert.equal(JSON.parse(headers['Dropbox-API-Arg']).mode,'overwrite');
});

test('workspace restore rolls back if the replacement cannot be saved',()=>{
 const f=fixture();f.context.defaults={settings:{days:[1]},assets:[],tasks:[],streams:[],content:[],ideas:[],goals:[],metrics:[],crm:[],notificationPreferences:{},announcementDrafts:{}};f.context.ANNOUNCEMENT_TEMPLATES={};f.context.normalizeCreatorProfile=value=>value||{};
 const start=html.indexOf('        replaceWorkspace: workspace => {');const end=html.indexOf('\n      };\n      window.CreatorHQCloudUI',start);
 const api=f.run('({'+html.slice(start,end)+'})');f.setFail(true);assert.throws(()=>api.replaceWorkspace({settings:{days:[2]},tasks:[],streams:[]}),/current workspace was kept/);assert.equal(f.context.state.tasks[0].title,'Keep my task');
});

test('website previews use the profile page instead of recursively loading CreatorHQ',()=>{
 const start=html.indexOf('      function profilePreviewUrl()');const end=html.indexOf('      function linktreeShareUrl()',start);
 const context=vm.createContext({URL,encodeURIComponent,profilePublicData:()=>({name:'Preview'}),profileShareUrl:()=> 'http://localhost/'});vm.runInContext(html.slice(start,end),context);
 assert.equal(new URL(vm.runInContext('profilePreviewUrl()',context)).pathname,'/profile.html');
});
