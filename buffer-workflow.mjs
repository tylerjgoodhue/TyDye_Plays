// Buffer owns delivery stages; local stages describe preparation only.
export const stages=['Idea','In production','Ready to Post','CreatorHQ draft','Buffer draft','Needs review','Scheduled','Partly published','Published','Needs attention'];
export function stage(item){
 const ids=[...new Set(item.bufferPostIds||[])],posts=ids.map(id=>item.bufferPostStates?.[id]).filter(Boolean);
 if(posts.some(p=>p.status==='error'))return 'Needs attention';
 if(ids.length&&posts.length===ids.length&&posts.every(p=>p.status==='sent'))return 'Published';
 if(posts.some(p=>p.status==='sent'))return 'Partly published';
 if(posts.some(p=>p.status==='needs_approval'))return 'Needs review';
 if(posts.some(p=>['scheduled','sending'].includes(p.status)))return 'Scheduled';
 if(posts.some(p=>p.status==='draft'))return 'Buffer draft';
 if(ids.length)return 'Needs attention';
 if(item.bufferLibraryDraftId)return 'CreatorHQ draft';
 return ['Idea','Ready to Post'].includes(item.status)?item.status:item.status==='Published'?'Published':item.status==='Scheduled'?'Needs attention':'In production';
}
export function reconcile(content,posts,{now=new Date().toISOString(),organizationId=''}={}){
 const next=structuredClone(content);let changed=false;
 for(const post of posts){if(!post?.id)continue;
  let matches=next.filter(item=>(item.bufferPostIds||[]).includes(post.id));
  if(!matches.length){const item={id:crypto.randomUUID(),title:(post.text||'Buffer post').split('\n')[0].slice(0,120),description:post.text||'',bufferText:post.text||'',bufferTitle:(post.text||'Buffer post').split('\n')[0].slice(0,120),platform:post.channelService||'Buffer',status:'Planning',priority:'Medium',origin:'buffer',bufferOrganizationId:organizationId,bufferPostIds:[post.id],bufferPostStates:{},createdAt:now};next.push(item);matches=[item];changed=true;}
  for(const item of matches){const value={id:post.id,status:post.status,dueAt:post.dueAt||'',channelId:post.channelId||'',error:post.error?.message||'',externalLink:post.externalLink||'',sentAt:post.sentAt||item.bufferPostStates?.[post.id]?.sentAt||''};
   if(JSON.stringify(item.bufferPostStates?.[post.id])===JSON.stringify(value)&&!(item.origin==='buffer'&&post.text!==undefined&&item.bufferText!==post.text))continue;
   item.bufferPostStates={...item.bufferPostStates,[post.id]:value};
   if(item.origin==='buffer'&&post.text!==undefined){const title=(post.text||'Buffer post').split('\n')[0].slice(0,120);if(item.title===item.bufferTitle||!item.bufferTitle)item.title=title;if(item.description===item.bufferText||item.bufferText===undefined)item.description=post.text;item.bufferTitle=title;item.bufferText=post.text;item.platform=post.channelService||item.platform;}
   item.updatedAt=now;changed=true;
  }
 }
 return {content:next,changed};
}
// Move a post's association explicitly. Keep custom production records and their notes.
export function link(content,targetId,post){
 const next=structuredClone(content),target=next.find(item=>item.id===targetId);if(!target)throw new Error('Choose an existing workflow item.');
 for(const item of next){if(item.id===targetId)continue;item.bufferPostIds=(item.bufferPostIds||[]).filter(id=>id!==post.id);if(item.bufferPostStates)delete item.bufferPostStates[post.id];}
 target.bufferPostIds=[...new Set([...(target.bufferPostIds||[]),post.id])];
 return reconcile(next.filter(item=>item.id===targetId||item.origin!=='buffer'||item.bufferPostIds.length||(item.description!==item.bufferText)||(item.title!==item.bufferTitle)||(item.dropboxFiles||[]).length),[post]).content;
}
