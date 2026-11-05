export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export const slugify=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,150).replace(/-$/,'');
export const plainText=value=>String(value||'').replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[#*`>_~]/g,'').replace(/\s+/g,' ').trim();
export const readingMinutes=value=>Math.max(1,Math.ceil(plainText(value).split(/\s+/).filter(Boolean).length/200));
export function safeUrl(value){try{const url=new URL(String(value));return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
export function effectiveStatus(post,now=new Date()){if(post.deleted_at)return 'trash';if(['scheduled','published'].includes(post.status)&&new Date(post.publish_at)<=now)return 'published';return post.status;}
export function inline(source,resolveMedia=()=>'',depth=0){
 source=String(source||'');
 if(depth>4)return escapeHtml(source);
 const pattern=/`([^`]+)`|!\[([^\]]*)\]\(([^\s)]+)\)|\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;let out='',last=0;
 for(const match of String(source).matchAll(pattern)){
  out+=escapeHtml(source.slice(last,match.index));last=match.index+match[0].length;
  if(match[1])out+=`<code>${escapeHtml(match[1])}</code>`;
  else if(match[2]!==undefined){const raw=match[3];const url=raw.startsWith('media:')?safeUrl(resolveMedia(raw.slice(6))):safeUrl(raw);out+=url?`<img src="${escapeHtml(url)}" alt="${escapeHtml(match[2])}" loading="lazy" decoding="async">`:escapeHtml(match[2]);}
  else if(match[4]){const url=safeUrl(match[5]);out+=url?`<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(match[4])}</a>`:escapeHtml(match[4]);}
  else if(match[6]||match[7])out+=`<strong>${inline(match[6]||match[7],resolveMedia,depth+1)}</strong>`;
  else out+=`<em>${inline(match[8]||match[9],resolveMedia,depth+1)}</em>`;
 }
 return out+escapeHtml(source.slice(last));
}
export function renderMarkdown(value,resolveMedia=()=> ''){
 const lines=String(value||'').replace(/\r/g,'').split('\n');let html='',paragraph=[],list='',toc=[],i=0;
 const flush=()=>{if(paragraph.length){html+=`<p>${inline(paragraph.join(' '),resolveMedia)}</p>`;paragraph=[];}if(list){html+=`</${list}>`;list='';}};
 while(i<lines.length){const line=lines[i++];
  if(line.startsWith('```')){flush();const language=line.slice(3).trim().replace(/[^a-z0-9+-]/gi,'');const code=[];while(i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i++]);i++;html+=`<pre><code${language?` class="language-${language}"`:''}>${escapeHtml(code.join('\n'))}</code></pre>`;continue;}
  const heading=line.match(/^(#{1,4})\s+(.+)$/);if(heading){flush();const level=Math.max(2,heading[1].length),id=`section-${slugify(plainText(heading[2]))||'heading'}-${toc.length}`;toc.push({id,text:plainText(heading[2]),level});html+=`<h${level} id="${id}">${inline(heading[2],resolveMedia)}</h${level}>`;continue;}
  if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){flush();html+='<hr>';continue;}
  if(line.startsWith('> ')){flush();html+=`<blockquote><p>${inline(line.slice(2),resolveMedia)}</p></blockquote>`;continue;}
  const item=line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);if(item){if(paragraph.length){html+=`<p>${inline(paragraph.join(' '),resolveMedia)}</p>`;paragraph=[];}const type=item[1]?'ul':'ol';if(list!==type){if(list)html+=`</${list}>`;html+=`<${type}>`;list=type;}html+=`<li>${inline(item[2],resolveMedia)}</li>`;continue;}
  if(!line.trim()){flush();continue;}
  if(list){html+=`</${list}>`;list='';}paragraph.push(line);
 }flush();return {html,toc};
}
export function mediaNames(body){return [...new Set([...String(body||'').matchAll(/\]\(media:([a-zA-Z0-9._-]+)\)/g)].map(match=>match[1]))].slice(0,30);}
export function validatePost(post,now=new Date()){
 const errors=[];if(!post.title?.trim())errors.push('Add a title.');if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(post.slug||''))errors.push('Use a URL slug with letters, numbers, and hyphens.');
 if(['published','scheduled'].includes(post.status)){if(!post.body?.trim())errors.push('Write the article before publishing.');if(!post.author_name?.trim())errors.push('Add the public author name.');if(!post.publish_at||!Number.isFinite(new Date(post.publish_at).getTime()))errors.push('Choose a publication date.');if(post.cover_path&&!post.cover_alt?.trim())errors.push('Describe the cover image with alt text.');}
 if(post.status==='scheduled'&&new Date(post.publish_at)<=now&&!post._alreadyLive)errors.push('Choose a future publication time.');return errors;
}
