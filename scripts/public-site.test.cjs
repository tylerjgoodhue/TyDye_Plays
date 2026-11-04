const {test}=require('node:test');const assert=require('node:assert/strict');const tools=require('../public-site-utils.js');
test('weekly schedule finds the next real stream in the creator timezone',()=>{
 const next=tools.nextStream({timezone:'America/Chicago',weekly:[{day:'Thursday',time:'20:00',duration:3}]},new Date('2026-11-04T12:00:00Z'));
 assert.equal(next.start,'2026-11-06T02:00:00.000Z');assert.equal(next.duration,3);
});
test('does not invent dates for a legacy schedule without a timezone',()=>{
 assert.equal(tools.nextStream({weekly:[{day:'Thursday',time:'20:00'}]}),null);assert.equal(tools.nextStream('Thursday | 8 PM'),null);assert.equal(tools.nextStream({timezone:'not-a-zone',weekly:[]}),null);
});
test('honors daylight saving offsets and rejects nonexistent local times',()=>{
 assert.equal(tools.zonedTime('2026-07-02','20:00','America/Chicago').toISOString(),'2026-07-03T01:00:00.000Z');
 assert.equal(tools.zonedTime('2026-12-03','20:00','America/Chicago').toISOString(),'2026-12-04T02:00:00.000Z');
 assert.equal(tools.zonedTime('2026-03-08','02:30','America/Chicago'),null);
});
test('expired streams are skipped and explicit session titles take precedence',()=>{
 const schedule={timezone:'UTC',weekly:[{day:'Thursday',time:'20:00'}],sessions:[{isoDate:'2026-11-05',time:'20:00',title:'Game night'},{isoDate:'2026-11-03',time:'20:00',title:'Past'}]};
 assert.equal(tools.nextStream(schedule,new Date('2026-11-04T12:00:00Z')).title,'Game night');
 assert.equal(tools.nextStream(schedule,new Date('2026-11-05T20:01:00Z')).start,'2026-11-12T20:00:00.000Z');
});
test('invalid dates and times are not presented as appointments',()=>{
 assert.equal(tools.zonedTime('2026-02-31','20:00','UTC'),null);assert.equal(tools.zonedTime('2026-11-05','25:10','UTC'),null);assert.equal(tools.zonedTime('2026-11-05','20:75','UTC'),null);
});
test('calendar exports use UTC times, escape content and fold long UTF-8 lines',()=>{
 const slot={start:'2026-11-06T02:00:00Z',duration:3,title:'Game night, with chat;\nBEGIN:VEVENT '+ '🎮'.repeat(50)};
 const ics=tools.calendar(slot,'TyDye Plays','https://twitch.tv/tydye_plays');assert.ok(ics.includes('DTSTART:20261106T020000Z'));assert.ok(ics.includes('DTEND:20261106T050000Z'));assert.equal(ics.split('\r\n').filter(line=>line==='BEGIN:VEVENT').length,1);
 for(const line of ics.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);
 const other=tools.calendar(slot,'Another creator','https://example.com');assert.notEqual(ics.match(/UID:.+/)[0],other.match(/UID:.+/)[0]);
});
test('public clock labels stay readable and preserve unfamiliar legacy strings',()=>{
 assert.equal(tools.clock('20:00'),'8:00 PM');assert.equal(tools.clock('00:15'),'12:15 AM');assert.equal(tools.clock('Noon'),'Noon');
});
