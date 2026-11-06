import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('      function assetModal('),html.indexOf('      function metricModal('));
async function submit(file,existing=null){
 let handler;const notices=[];const state={assets:existing?[existing]:[]};let saved=0,closed=0;
 const values={title:'Canva template',url:'https://www.canva.com/design/example/view',type:'Link',folder:'Canva Templates',tags:'story',file};
 const context={document:{getElementById:()=>({set innerHTML(v){},addEventListener:(name,fn)=>handler=fn})},FormData:class{get(key){return values[key]}},state,crypto:{randomUUID:()=> 'asset-id'},escapeHtml:v=>v,toast:v=>notices.push(v),saveState:()=>saved++,closeModal:()=>closed++,renderAll(){},FileReader:class{readAsDataURL(){this.result='data:image/png;base64,aGVsbG8=';this.onload()}},existing};
 vm.createContext(context);vm.runInContext(source+';assetModal(existing);',context);await handler({preventDefault(){},currentTarget:{}});return {state,notices,saved,closed};
}
test('Canva links save without a selected file',async()=>{const r=await submit({size:0,type:'application/octet-stream'});assert.equal(r.saved,1);assert.equal(r.closed,1);assert.equal(r.state.assets[0].url,'https://www.canva.com/design/example/view');assert.equal(r.state.assets[0].dataUrl,'');});
test('selected images are read and retained for cloud upload',async()=>{const r=await submit({size:100,type:'image/png',name:'preview.png'});assert.equal(r.saved,1);assert.equal(r.state.assets[0].fileName,'preview.png');assert.match(r.state.assets[0].dataUrl,/^data:image\/png/);});
test('editing a link preserves its existing stored image',async()=>{const a={id:'old',storagePath:'owner/old/preview.png',fileName:'preview.png',mimeType:'image/png'};const r=await submit(null,a);assert.equal(r.saved,1);assert.equal(r.state.assets.length,1);assert.equal(a.storagePath,'owner/old/preview.png');assert.equal(a.fileName,'preview.png');});
test('invalid or oversized images leave the form open and do not save',async()=>{for(const file of [{size:700*1024,type:'image/png'},{size:100,type:'text/html'}]){const r=await submit(file);assert.equal(r.saved,0);assert.equal(r.closed,0);assert.equal(r.notices.length,1);}});
