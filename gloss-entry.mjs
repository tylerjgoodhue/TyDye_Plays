import {createGlossStudio} from './gloss-studio.mjs';
const host=document.getElementById('gloss-studio-root');
if(host){window.CreatorHQGloss=createGlossStudio({host,getAssets:()=>window.CreatorHQStorage?.getGlossAssets?.()||[],saveAsset:record=>window.CreatorHQStorage.saveGlossAsset(record),openAssets:()=>window.CreatorHQNavigate?.('assets'),notify:message=>window.CreatorHQCloudUI?.toast?.(message),confirm:(...args)=>window.CreatorHQDialogs.confirm(...args)});if(!document.getElementById('view-gloss').hidden)window.CreatorHQGloss.open();}
