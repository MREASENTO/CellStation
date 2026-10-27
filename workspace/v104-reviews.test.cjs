'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const {ManagerStore}=require('./manager-store.cjs'),{Reviews,reviewPlan,INTERVAL}=require('./reviews.cjs'),{createManager}=require('./manager-server.cjs');
const base=path.resolve(__dirname,'../work/tests');fs.mkdirSync(base,{recursive:true});
async function fixture() {
 const root=fs.mkdtempSync(path.join(base,'v104-review-')),vault={protect:async s=>'encrypted:'+s,unprotect:async s=>s.slice(10)},store=new ManagerStore(root,vault);
 const a=await store.saveAccount({username:'original',owner:'原账号',password:'test-only',enabled:true}),b=await store.saveAccount({username:'different',owner:'新分配账号',password:'other',enabled:true});
 const job={id:'record',date:'2025-10-28',start:'08:30',end:'09:00',accountId:a.id,accountUsername:'original',accountOwner:'原账号',status:'needs_review',equipment:{equipmentId:51,equipmentName:'原设备'},releaseAt:Date.parse('2025-10-21T09:00:00+08:00'),savingAt:100,message:'原始保存不明确',timeline:[{step:'save_request',at:101,elapsedMs:1}]};store.job(job,job);
 let now=Date.parse('2026-10-23T08:00:00+08:00'),rows=[],failure=false;const launches=[],users=[],browsers=[];
 const page=new EventEmitter();Object.assign(page,{goto:async()=>{},isClosed:()=>false,bringToFront:async()=>{},locator:()=>({getAttribute:async()=>'/cf/main/!people/profile/index.7'})});
 const controller=new Reviews(store,root,{clock:()=>now,launch:async options=>{launches.push(options);const browser=new EventEmitter();Object.assign(browser,{newContext:async()=>({newPage:async()=>page}),close:async()=>{browser.emit('disconnected');}});browsers.push(browser);return browser;},login:async(p,u,pw)=>{users.push([u,pw]);if(failure)throw new Error('network timeout');},open:async(p,e)=>assert.equal(e.equipmentId,51),week:async()=>{},components:async(p,weekStart)=>{assert.equal(weekStart,reviewPlan(job).weekStart);return rows;}});
 return {root,store,job,a,b,controller,users,launches,page,browsers,clock:()=>now,time:t=>now=t,rows:v=>rows=v,failure:v=>failure=v};
}
function component(job,{user=7,start,end,remark='cell',id=88}={}){const p=reviewPlan(job);return{id,dtStart:start??p.start,dtEnd:end??p.end,content:`<a href="/profile/index.${user}">owner</a> ${remark}`};}
test('recheck uses the historical account/equipment even when disabled or reassigned, and confirms past dates without saving',async()=>{
 const f=await fixture();f.store.data.accounts.find(a=>a.id===f.a.id).enabled=false;f.rows([component(f.job)]);
 try{const result=await f.controller.recheck(f.job.id);assert.ok(result.verified);assert.deepEqual(f.users,[['original','test-only']]);assert.equal(f.launches[0].headless,true);const saved=f.store.data.jobs.record;assert.equal(saved.status,'already_exists');assert.equal(saved.reservationId,88);assert.equal(saved.recheckedAt,f.clock());assert.equal(saved.savingAt,100);assert.equal(saved.confirmedAt,undefined);assert.equal(saved.timeline.length,1);assert.equal(f.controller.active,0);assert.equal(JSON.stringify(saved).includes('test-only'),false);}finally{await f.controller.close();}
});
test('unverified account or wrong time cannot confirm a reservation',async()=>{
 for(const change of [()=>({user:70}),f=>({start:reviewPlan(f.job).start+1}),()=>({end:2})]){const f=await fixture();f.rows([component(f.job,change(f))]);try{assert.equal((await f.controller.recheck('record')).verified,false);assert.equal(f.store.data.jobs.record.status,'needs_review');assert.equal(f.store.data.jobs.record.review.state,'waiting');assert.equal(f.store.data.jobs.record.review.stage,'delayed');assert.equal((await f.controller.recheck('record')).verified,false);assert.equal(f.store.data.jobs.record.review.state,'failed');assert.equal(f.store.data.jobs.record.review.manualRequired,true);assert.equal(f.store.data.jobs.record.message,'原始保存不明确');}finally{await f.controller.close();}}
});
test('a verified managed account covering the time is accepted regardless of remark',async()=>{const f=await fixture();f.rows([component(f.job,{remark:'other'})]);try{assert.equal((await f.controller.recheck('record')).verified,true);assert.equal(f.store.data.jobs.record.status,'already_exists');}finally{await f.controller.close();}});
test('automatic review runs immediately, then once after five minutes, and remains stopped through reload',async()=>{
 const f=await fixture();f.store.data.config.enabled=true;await f.controller.tick();const due=f.store.data.jobs.record.review.nextAt;assert.equal(due,f.clock()+INTERVAL);
 f.time(due-1);await f.controller.tick();assert.equal(f.users.length,1);f.time(due);await f.controller.tick();assert.equal(f.users.length,2);assert.equal(f.store.data.jobs.record.review.state,'failed');
 f.time(due+INTERVAL*5);await f.controller.tick();assert.equal(f.users.length,2);const reloaded=new ManagerStore(f.root,f.store.vault);assert.equal(reloaded.data.jobs.record.review.state,'failed');await f.controller.close();
});
test('automatic review respects pause, login failure stops once, and a manual retry can later confirm',async()=>{
 const f=await fixture();f.store.data.config.enabled=true;await f.controller.tick();f.time(f.clock()+INTERVAL);f.store.data.config.enabled=false;await f.controller.tick();assert.equal(f.users.length,1);
 f.store.data.config.enabled=true;f.failure(true);await f.controller.tick();assert.equal(f.users.length,2);assert.equal(f.store.data.jobs.record.review.state,'failed');await f.controller.tick();assert.equal(f.users.length,2);
 f.failure(false);f.rows([component(f.job)]);assert.ok((await f.controller.recheck('record')).verified);await f.controller.close();
});
test('manual web entry is headed, preserves the account, reuses its window, and survives login failure for handoff',async()=>{
 const f=await fixture();const first=await f.controller.openWebsite('record');assert.ok(first.ready);assert.equal(f.launches[0].headless,false);await f.controller.openWebsite('record');assert.equal(f.users.length,1);await f.controller.close();
 const g=await fixture();g.failure(true);const result=await g.controller.openWebsite('record');assert.ok(result.opened);assert.equal(result.ready,false);assert.equal(g.controller.sessions.size,1);await g.controller.close();
});
test('deleted original account or live scheduler guard never falls back to a different login',async()=>{
 const f=await fixture();f.store.data.accounts=f.store.data.accounts.filter(a=>a.id!==f.a.id);await assert.rejects(f.controller.recheck('record'),/原账号已移除/);assert.equal(f.launches.length,0);await f.controller.close();
 const g=await fixture();g.controller.canRun=()=>false;await assert.rejects(g.controller.openWebsite('record'),/正在准备/);assert.equal(g.users.length,0);await g.controller.close();
});
test('review API requires CSRF and accepts a job id rather than client credentials or navigation targets',async()=>{
 const root=fs.mkdtempSync(path.join(base,'v104-api-'));const seen=[];
 const app=await createManager({directory:root,operationsRoot:root,port:0,runScheduler:false,workerFactory:()=>({close:async()=>{}}),reviewFactory:()=>({recheck:async id=>{seen.push(id);return{verified:false};},openWebsite:async id=>{seen.push(id);return{opened:true};},close:async()=>{}})});
 try{const state=await fetch(app.url+'/api/state').then(r=>r.json());const send=(route,token)=>fetch(app.url+'/api/reviews/'+route,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-CSRF-Token':token}:{})},body:JSON.stringify({jobId:'original-record'})});assert.equal((await send('open')).status,403);assert.equal((await send('recheck',state.csrfToken)).status,200);assert.equal((await send('open',state.csrfToken)).status,200);assert.deepEqual(seen,['original-record','original-record']);}finally{await app.close();}
});
test('interrupted or missing-account automatic reviews stop visibly and do not loop',async()=>{
 const f=await fixture();f.store.job(f.job,{review:{state:'checking',attempts:1}});await f.controller.close();const other=new Reviews(f.store,f.root);assert.equal(f.store.data.jobs.record.review.state,'waiting');assert.equal(f.store.data.jobs.record.review.stage,'immediate');await other.close();
 const g=await fixture();g.store.data.config.enabled=true;await g.controller.tick();g.time(g.clock()+INTERVAL);g.store.data.accounts=g.store.data.accounts.filter(a=>a.id!==g.a.id);await g.controller.tick();assert.equal(g.store.data.jobs.record.review.state,'failed');await g.controller.tick();assert.equal(g.users.length,1);await g.controller.close();
});
test('rechecking an older day refreshes its existing daily export and records a separate review timestamp',async()=>{
 const {Operations}=require('./operations.cjs'),f=await fixture();const releaseDay=f.job.releaseAt;
 const operations=new Operations({root:f.root,store:f.store,worker:{},clock:f.clock});f.time(releaseDay+14*3600000);operations.monitorTick();const date='2025-10-21';assert.ok(operations.state.autoReports[date]);
 f.time(Date.parse('2026-10-23T08:00:00+08:00'));f.rows([component(f.job)]);await f.controller.recheck(f.job.id);operations.monitorTick();
 const file=operations.state.autoReports[date].files.find(n=>n.endsWith('.json'));const exported=JSON.parse(fs.readFileSync(file));const row=exported.rows.find(r=>r.id===f.job.id);assert.equal(row.status,'already_exists');assert.equal(row.recheckedAt,f.clock());assert.equal(row.confirmedAt,undefined);await f.controller.close();
});
test('personal calendar selection never changes the original account used by an individual record',async()=>{const f=await fixture();f.store.setEquipments([{equipmentId:51,equipmentName:'原设备'}]);f.store.setPersonalAccount(f.b.id);try{assert.equal((await f.controller.openPersonal(f.b.id,51)).ready,true);assert.equal((await f.controller.openWebsite('record')).ready,true);assert.deepEqual(f.users.map(x=>x[0]),['different','original']);assert.equal(f.launches.every(x=>x.headless===false),true);}finally{await f.controller.close();}});
