(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CreatorPublicSite=api;})(typeof window!=='undefined'?window:globalThis,function(){
  const days=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  function validZone(zone){try{if(!zone||zone==='local')return false;new Intl.DateTimeFormat('en',{timeZone:zone}).format();return true;}catch{return false;}}
  function parts(date,zone){return Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));}
  function zonedTime(dateKey,time,zone){
    if(!validZone(zone)||!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)||!/^\d{1,2}:\d{2}$/.test(time))return null;
    const [year,month,day]=dateKey.split('-').map(Number),[hour,minute]=time.split(':').map(Number);
    if(hour>23||minute>59)return null;
    const target=Date.UTC(year,month-1,day,hour,minute);let guess=target;
    for(let attempt=0;attempt<4;attempt++){const p=parts(new Date(guess),zone);const rendered=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);const difference=target-rendered;if(!difference)break;guess+=difference;}
    const p=parts(new Date(guess),zone);return p.year===year&&p.month===month&&p.day===day&&p.hour===hour&&p.minute===minute?new Date(guess):null;
  }
  function nextStream(schedule,now=new Date()){
    if(!schedule||typeof schedule!=='object'||!validZone(schedule.timezone))return null;
    const zone=schedule.timezone,today=parts(now,zone),slots=[];
    const add=(dateKey,item,source)=>{const start=zonedTime(dateKey,String(item.time||''),zone);if(start&&start>now)slots.push({start:start.toISOString(),title:String(item.title||'Community stream'),duration:Math.min(24,Math.max(.25,Number(item.duration)||3)),timezone:zone,source});};
    for(const item of (Array.isArray(schedule.sessions)?schedule.sessions:[]).filter(item=>item&&typeof item==='object'))if(/^\d{4}-\d{2}-\d{2}$/.test(item.isoDate||''))add(item.isoDate,item,'session');
    for(let offset=0;offset<14;offset++){
      const date=new Date(Date.UTC(today.year,today.month-1,today.day+offset));const key=date.toISOString().slice(0,10);
      for(const item of (Array.isArray(schedule.weekly)?schedule.weekly:[]).filter(item=>item&&typeof item==='object'))if(days.indexOf(String(item.day||'').toLowerCase())===date.getUTCDay())add(key,item,'weekly');
    }
    return slots.sort((a,b)=>new Date(a.start)-new Date(b.start)||(a.source==='session'?-1:1))[0]||null;
  }
  function clock(time){const match=/^(\d{1,2}):(\d{2})$/.exec(String(time||''));if(!match||+match[1]>23||+match[2]>59)return String(time||'');const h=+match[1];return `${h%12||12}:${match[2]} ${h<12?'AM':'PM'}`;}
  function calendar(slot,name,url){
    const start=new Date(slot?.start);if(!Number.isFinite(start.getTime()))throw new Error('A valid stream time is required.');
    const clean=value=>String(value||'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
    const stamp=date=>date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    const end=new Date(start.getTime()+Math.min(24,Math.max(.25,Number(slot.duration)||3))*3600000);
    const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//CreatorHQ//Public Stream Schedule//EN','BEGIN:VEVENT',`UID:${start.getTime()}-${[...String(name)].reduce((hash,char)=>Math.imul(hash^char.codePointAt(0),16777619)>>>0,2166136261).toString(36)}@creatorhq-stream`,`DTSTAMP:${stamp(new Date())}`,`DTSTART:${stamp(start)}`,`DTEND:${stamp(end)}`,`SUMMARY:${clean(`${name} — ${slot.title}`)}`,`DESCRIPTION:${clean('Saved from the published schedule. Times may change; check the channel for updates.')}`];
    if(/^https?:\/\//i.test(url||''))lines.push(`URL:${clean(url)}`);lines.push('END:VEVENT','END:VCALENDAR');return lines.map(line=>{let result='',part='',bytes=0;for(const char of line){const size=new TextEncoder().encode(char).length;if(bytes+size>75){result+=part+'\r\n ';part='';bytes=1;}part+=char;bytes+=size;}return result+part;}).join('\r\n')+'\r\n';
  }
  return {validZone,zonedTime,nextStream,clock,calendar};
});
