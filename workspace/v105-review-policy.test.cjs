'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {ManagerStore}=require('./manager-store.cjs'),{Reviews}=require('./reviews.cjs'),{WechatNotifications}=require('./wechat-notifications.cjs'),{Operations}=require('./operations.cjs'),{createManager}=require('./manager-server.cjs');
const base=path.resolve(__dirname,'../work/tests');fs.mkdirSync(base,{recursive:true});
const vault={protect:async s=>'encrypted:'+s,unprotect:async s=>s.slice(10)};
async function fixture({matchAt=Infinity,error=false}={}) {
 const root=fs.mkdtempSync(path.join(base,'v105-review-')),store=new ManagerStore(root,vault);await store.saveAccount({username:'mock-original',password:'test-only'});
 let now=Date.parse('2026-10-24T08:00:00+08:00'),queries=0,available=true;const sent=[];
 const notifications=new WechatNotifications(root,vault,async(url,options)=>{const p=new URLSearchParams(options.body);sent.push({title:p.get('title'),content:p.get('desp')});return new Response('{"code":0}');});await notifications.update({key:'SCT_mock-key-for-tests',enabled:true});
 const reviews=new Reviews(store,root,{clock:()=>now,canRun:()=>available,components:async()=>queries>=matchAt?[{id:77,dtStart:Date.parse('2026-10-31T08:30:00+08:00')/1000,dtEnd:Date.parse('2026-10-31T09:00:00+08:00')/1000,content:'<a href="/profile/index.1">own</a> cell'}]:[]});
 reviews.session=async()=>{queries++;if(error)throw new Error('network timeout (mock)');return{page:{locator:()=>({getAttribute:async()=>'/profile/index.1'})}};};
 store.onJob=job=>notifications.enqueue(reviews.observe(job));
 const job={id:'mock-record',date:'2026-10-31',start:'08:30',end:'09:00',accountId:store.accounts()[0].id,accountUsername:'mock-original',equipment:{equipmentId:51,equipmentName:'模拟设备'},status:'needs_review',releaseAt:now,savingAt:now-1000,message:'保存结果不明确',timeline:[{step:'save_request',at:now-1000,elapsedMs:1}]};store.job(job,job);store.data.config.enabled=true;
 return{root,store,reviews,notifications,sent,job,clock:()=>now,time:value=>now=value,queries:()=>queries,available:value=>available=value,close:async()=>{await reviews.close();await notifications.idle();}};
}
test('review interval defaults to five minutes, migrates, persists and rejects invalid values',()=>{
 const root=fs.mkdtempSync(path.join(base,'v105-policy-')),store=new ManagerStore(root,vault);assert.deepEqual(store.data.config.reviewPolicy,{retryIntervalMinutes:5});store.setReviewPolicy({retryIntervalMinutes:13});assert.equal(new ManagerStore(root,vault).data.config.reviewPolicy.retryIntervalMinutes,13);
 for(const value of [0,-1,1.5,NaN,Infinity,'3',true,null,Number.MAX_SAFE_INTEGER])assert.throws(()=>store.setReviewPolicy({retryIntervalMinutes:value}),/正整数/);assert.equal(store.data.config.reviewPolicy.retryIntervalMinutes,13);
 delete store.data.config.reviewPolicy;store.persist();assert.equal(new ManagerStore(root,vault).data.config.reviewPolicy.retryIntervalMinutes,5);
});
test('immediate successful review updates the result without waiting, preserving original timing and sending no failure alert',async()=>{
 const f=await fixture({matchAt:1});try{assert.equal(f.queries(),0);await f.reviews.tick();await f.notifications.idle();const row=f.store.data.jobs[f.job.id];assert.equal(f.queries(),1);assert.equal(row.status,'already_exists');assert.equal(row.review.autoAttempts,1);assert.equal(row.recheckedAt,f.clock());assert.equal(row.confirmedAt,undefined);assert.equal(row.savingAt,f.job.savingAt);assert.equal(row.timeline.length,1);assert.equal(f.sent.length,1);assert.match(f.sent[0].title,/预约成功/);f.time(f.clock()+86400000);await f.reviews.tick();assert.equal(f.queries(),1);}finally{await f.close();}
});
test('first failure updates waiting status; delayed success ends the flow without an autonomous-review demand',async()=>{
 const f=await fixture({matchAt:2});try{f.store.setReviewPolicy({retryIntervalMinutes:7});await f.reviews.tick();await f.notifications.idle();const first=f.store.data.jobs[f.job.id].review;assert.equal(first.stage,'delayed');assert.equal(first.state,'waiting');assert.equal(first.nextAt,f.clock()+7*60000);assert.equal(first.autoAttempts,1);assert.equal(f.sent.length,1);assert.match(f.sent[0].title,/首次复核未确认/);assert.doesNotMatch(f.sent[0].title,/请自主复核/);
 f.time(first.nextAt-1);await f.reviews.tick();assert.equal(f.queries(),1);f.time(first.nextAt);await f.reviews.tick();await f.notifications.idle();assert.equal(f.store.data.jobs[f.job.id].status,'already_exists');assert.equal(f.sent.length,2);assert.equal(f.sent.some(n=>n.title.startsWith('【请自主复核】')),false);}finally{await f.close();}
});
test('delayed failure sends a distinctly titled manual demand despite an older generic failure dedupe key',async()=>{
 const f=await fixture();try{f.notifications.data.sent.push(f.job.id+'|needs_review');await f.reviews.tick();f.time(f.store.data.jobs[f.job.id].review.nextAt);await f.reviews.tick();await f.notifications.idle();const final=f.store.data.jobs[f.job.id];assert.equal(final.review.state,'failed');assert.equal(final.review.autoAttempts,2);assert.equal(final.review.manualRequired,true);assert.equal(final.review.history.length,2);assert.equal(f.sent.length,2);assert.match(f.sent[1].title,/^【请自主复核】/);assert.match(f.sent[1].content,/需要你亲自处理/);assert.match(f.sent[1].content,/已停止自动复核/);assert.match(f.sent[1].content,/打开网页核对/);assert.match(f.sent[1].content,/首次复核时间/);assert.match(f.sent[1].content,/再次复核时间/);
 f.time(f.clock()+86400000);await f.reviews.tick();f.notifications.enqueue(final);await f.notifications.idle();assert.equal(f.queries(),2);assert.equal(f.sent.length,2);
 const reloaded=new WechatNotifications(f.root,vault,async()=>{throw new Error('must not resend');});reloaded.enqueue(final);await reloaded.idle();assert.equal(reloaded.error,'');}finally{await f.close();}
});
test('query errors also consume exactly two rounds and produce the final demand',async()=>{
 const f=await fixture({error:true});try{await f.reviews.tick();assert.equal(f.store.data.jobs[f.job.id].review.state,'waiting');f.time(f.store.data.jobs[f.job.id].review.nextAt);await f.reviews.tick();await f.notifications.idle();assert.equal(f.queries(),2);assert.equal(f.store.data.jobs[f.job.id].review.manualRequired,true);assert.match(f.sent.at(-1).title,/请自主复核/);}finally{await f.close();}
});
test('interval edits reschedule a waiting second round relative to the first check; shortening can make it due immediately',async()=>{
 const f=await fixture();try{await f.reviews.tick();const start=f.clock();f.time(start+2*60000);f.store.setReviewPolicy({retryIntervalMinutes:10});f.reviews.reschedule();assert.equal(f.store.data.jobs[f.job.id].review.nextAt,start+10*60000);await f.reviews.tick();assert.equal(f.queries(),1);f.store.setReviewPolicy({retryIntervalMinutes:1});f.reviews.reschedule();assert.equal(f.store.data.jobs[f.job.id].review.nextAt,start+60000);await f.reviews.tick();assert.equal(f.queries(),2);}finally{await f.close();}
});
test('pause and account preparation defer queries without spending a review round',async()=>{
 const f=await fixture();try{f.store.data.config.enabled=false;await f.reviews.tick();assert.equal(f.queries(),0);f.store.data.config.enabled=true;f.available(false);await f.reviews.tick();assert.equal(f.queries(),0);f.available(true);await f.reviews.tick();f.time(f.store.data.jobs[f.job.id].review.nextAt);f.store.data.config.enabled=false;await f.reviews.tick();assert.equal(f.queries(),1);f.store.data.config.enabled=true;await f.reviews.tick();assert.equal(f.queries(),2);}finally{await f.close();}
});
test('restart preserves the delayed deadline, completed budget, and final stop',async()=>{
 const f=await fixture();try{await f.reviews.tick();const due=f.store.data.jobs[f.job.id].review.nextAt;await f.reviews.close();const store=new ManagerStore(f.root,vault),reviews=new Reviews(store,f.root,{clock:f.clock});assert.equal(store.data.jobs[f.job.id].review.nextAt,due);assert.equal(store.data.jobs[f.job.id].review.autoAttempts,1);await reviews.close();}finally{await f.close();}
});
test('interrupted query resumes its unfinished round after restart without resetting the completed budget',async()=>{
 const f=await fixture();try{await f.reviews.tick();f.store.job(f.job,{review:{...f.store.data.jobs[f.job.id].review,state:'checking',inFlightStage:'delayed'}});await f.reviews.close();const store=new ManagerStore(f.root,vault),reviews=new Reviews(store,f.root,{clock:f.clock});assert.equal(store.data.jobs[f.job.id].review.state,'waiting');assert.equal(store.data.jobs[f.job.id].review.stage,'delayed');assert.equal(store.data.jobs[f.job.id].review.autoAttempts,1);await reviews.close();}finally{await f.close();}
});
test('review interval is included in backup preview/restore and older backups retain the local setting',async()=>{
 const f=await fixture();try{f.store.data.config.enabled=false;const op=new Operations({root:f.root,store:f.store,worker:{}});f.store.setReviewPolicy({retryIntervalMinutes:8});const backup=JSON.parse(fs.readFileSync(op.backup().file));assert.equal(backup.reviewPolicy.retryIntervalMinutes,8);f.store.setReviewPolicy({retryIntervalMinutes:3});let preview=await op.previewRestore(backup);assert.equal(preview.reviewPolicy.retryIntervalMinutes,8);op.restore(preview.token);assert.equal(f.store.data.config.reviewPolicy.retryIntervalMinutes,8);delete backup.reviewPolicy;f.store.setReviewPolicy({retryIntervalMinutes:9});preview=await op.previewRestore(backup);op.restore(preview.token);assert.equal(f.store.data.config.reviewPolicy.retryIntervalMinutes,9);}finally{await f.close();}
});
test('review policy API validates CSRF and supports automatic save while scheduling is enabled',async()=>{
 const root=fs.mkdtempSync(path.join(base,'v105-api-')),app=await createManager({directory:root,operationsRoot:root,port:0,runScheduler:false,workerFactory:()=>({close:async()=>{}})});
 try{const state=await fetch(app.url+'/api/state').then(r=>r.json());const put=(value,token)=>fetch(app.url+'/api/review-policy',{method:'PUT',headers:{'Content-Type':'application/json',...(token?{'X-CSRF-Token':token}:{})},body:JSON.stringify({retryIntervalMinutes:value})});assert.equal((await put(3)).status,403);assert.equal((await put(0,state.csrfToken)).status,400);app.store.data.config.enabled=true;assert.equal((await put(3,state.csrfToken)).status,200);assert.equal(app.store.data.config.reviewPolicy.retryIntervalMinutes,3);app.store.data.config.enabled=false;}finally{await app.close();}
});
test('turning off failure notifications suppresses both review notices without altering review state',async()=>{
 const f=await fixture();try{await f.notifications.update({failure:false});await f.reviews.tick();f.time(f.store.data.jobs[f.job.id].review.nextAt);await f.reviews.tick();await f.notifications.idle();assert.equal(f.sent.length,0);assert.equal(f.store.data.jobs[f.job.id].review.manualRequired,true);}finally{await f.close();}
});
test('PushPlus receives a clearly distinct final manual-review title and instructions',async()=>{
 const f=await fixture();try{const calls=[];await f.notifications.update({provider:'pushplus',key:'mock-pushplus-key',enabled:true});f.notifications.request=async(url,options)=>{calls.push(JSON.parse(options.body));return new Response('{"code":200}');};await f.reviews.tick();f.time(f.store.data.jobs[f.job.id].review.nextAt);await f.reviews.tick();await f.notifications.idle();assert.equal(calls.length,2);assert.doesNotMatch(calls[0].title,/^【请自主复核】/);assert.match(calls[1].title,/^【请自主复核】/);assert.match(calls[1].content,/需要你亲自处理/);}finally{await f.close();}
});
test('Windows reminders also distinguish the final stage and prioritize it in a mixed batch',async()=>{
 const {DesktopIntegration}=require('./desktop-integration.cjs'),f=await fixture();const shown=[];const desktop=new DesktopIntegration({app:{getLoginItemSettings:()=>({openAtLogin:false})},dataRoot:f.root,sendNotification:message=>shown.push(message),show:()=>{},quit:()=>{},batchMs:10000});
 try{desktop.notify(f.store.data.jobs[f.job.id]);desktop.flush();assert.equal(shown.length,0);await f.reviews.tick();desktop.notify(f.store.data.jobs[f.job.id]);desktop.flush();assert.equal(shown.length,1);f.time(f.store.data.jobs[f.job.id].review.nextAt);await f.reviews.tick();desktop.notify({id:'other',status:'failed',date:'2026-10-31',start:'09:00',end:'09:30'});desktop.notify(f.store.data.jobs[f.job.id]);desktop.flush();assert.match(shown[1].title,/^【请自主复核】/);assert.match(shown[1].content,/自主复核/);desktop.notify(f.store.data.jobs[f.job.id]);desktop.flush();assert.equal(shown.length,2);}finally{desktop.dispose();await f.close();}
});
test('new uncertain records nudge a started review service immediately and overlapping ticks do not duplicate queries',async()=>{
 const f=await fixture();try{f.reviews.start();await new Promise(resolve=>setTimeout(resolve,30));await f.reviews.tick();assert.equal(f.queries(),1);assert.equal(f.store.data.jobs[f.job.id].review.stage,'delayed');assert.equal(f.store.data.jobs[f.job.id].review.autoAttempts,1);}finally{await f.close();}
});
