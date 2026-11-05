const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const {readFileSync}=require('node:fs');
const html=readFileSync(new URL('../index.html',`file://${__filename}`),'utf8');
const start=html.indexOf("      let signedInEmail = '';");
const source=html.slice(start,html.indexOf('      function logActivity(',start));
function fixture(){
 const calls=[];let fail=false;
 const values={'user-display-name':{value:'Ty'},'user-accent':{value:'purple'},'user-settings-status':{textContent:''}};
 const state={settings:{name:'Shared creator',accent:'lime',hiddenWidgets:['goals'],days:[2,4,6]}};
 const context=vm.createContext({state,document:{getElementById:id=>values[id],querySelectorAll:()=>[{dataset:{widgetToggle:'tasks'}}]},window:{CreatorHQCloud:{savePersonalPreferences:async preferences=>{if(fail)throw new Error('Could not save to Supabase');calls.push(preferences);return preferences;}}},applyAccent(){},renderProfile(){},renderDashboard(){},toast(){}});
 vm.runInContext(source,context);
 return {context,calls,state,values,run:code=>vm.runInContext(code,context),fail:()=>fail=true};
}
test('personal preferences save to Supabase without changing shared workspace data',async()=>{
 const f=fixture(),before=JSON.stringify(f.state);await f.run("signedInUserId='alice';saveUserSettings()");assert.equal(JSON.stringify(f.state),before);assert.equal(f.calls[0].displayName,'Ty');assert.match(f.values['user-settings-status'].textContent,/Supabase/);
});
test('account preferences are hydrated from cloud state rather than shared creator settings',()=>{
 const f=fixture();f.run("personalPreferences={displayName:'Alice',accent:'purple',hiddenWidgets:['tasks']}");assert.equal(f.run('readUserSettings().displayName'),'Alice');f.run("personalPreferences={displayName:'Bob',accent:'blue',hiddenWidgets:[]}");assert.equal(f.run('readUserSettings().displayName'),'Bob');assert.equal(f.state.settings.name,'Shared creator');
});
test('the new dashboard defaults show all original widgets in the website theme',()=>{
 const f=fixture();assert.equal(f.run('readUserSettings().accent'),'purple');assert.equal(JSON.stringify(f.run('readUserSettings().hiddenWidgets')),'[]');
});
test('signed-out saves and failed cloud saves never report success',async()=>{
 const f=fixture();await f.run('saveUserSettings()');assert.equal(f.calls.length,0);assert.match(f.values['user-settings-status'].textContent,/Sign in/);f.run("signedInUserId='alice'");f.fail();await f.run('saveUserSettings()');assert.equal(f.calls.length,0);assert.match(f.values['user-settings-status'].textContent,/Could not save/);
});
test('restricted staff can manage their own account without gaining workspace management',()=>{
 const a=html.indexOf('      function userHasAccess(viewName) {'),b=html.indexOf('      function applyPermissions()',a);
 const context=vm.createContext({currentUserAccess:{full:false,role:'viewer',permissions:['dashboard']},VIEW_PERMISSIONS:{settings:'settings',website:'website'}});
 vm.runInContext(html.slice(a,b),context);
 assert.equal(vm.runInContext("userHasAccess('account')",context),true);
 assert.equal(vm.runInContext("userHasAccess('settings')",context),false);
 assert.equal(vm.runInContext("userHasAccess('website')",context),false);
});
test('saving shared settings preserves existing personal appearance and dashboard choices',()=>{
 const a=html.indexOf('      function saveSettings()'),b=html.indexOf('      function downloadBlob(',a);
 const state={settings:{accent:'blue',hiddenWidgets:['goals'],name:'Old name'},profile:{name:'Old name'}};
 const values={'setting-name':'Workspace','setting-handle':'channel','setting-timezone':'UTC','setting-start':'19:00','setting-duration':'2'};
 const context=vm.createContext({state,document:{getElementById:id=>({value:values[id]}),querySelectorAll:()=>[{value:'3'}]},saveState(){},renderAll(){},toast(){}});
 vm.runInContext(html.slice(a,b)+'\nsaveSettings()',context);
 assert.equal(state.settings.name,'Workspace');assert.equal(state.settings.accent,'blue');assert.deepEqual(state.settings.hiddenWidgets,['goals']);
});
