'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {ManagerStore}=require('./manager-store.cjs'),{Scheduler,RECOVERY_INTERVAL}=require('./scheduler.cjs');
const base=path.resolve(__dirname,'../work/tests');fs.mkdirSync(base,{recursive:true});
async function fixture() {
 const directory=fs.mkdtempSync(path.join(base,'v104-recovery-')),store=new ManagerStore(directory,{protect:async s=>'cipher:'+s,unprotect:async s=>s.slice(7)});
 await store.saveAccount({username:'original',password:'dummy',enabled:true});store.setRetryPolicy({taskRetries:0,captchaRetries:0});
 let now=Date.parse('2026-10-23T07:00:00+08:00'),offline=true,prepareCount=0,commitCount=0;const targets=[];
 const worker={prepare:async job=>{prepareCount++;targets.push({id:job.id,accountId:job.accountId,date:job.date,start:job.start,end:job.end,equipment:job.equipment});if(offline)throw new Error('network timeout');return{};},commit:async(job,before)=>{commitCount++;await before();return{status:'created',reservationId:88,confirmedAt:now};},releaseSession:async()=>{},close:async()=>{}};
 const scheduler=new Scheduler(store,worker,()=>now),job=scheduler.plan(1)[0];now=job.releaseAt-90000;store.setEnabled(true,now);
 return{store,scheduler,worker,job,targets,clock:()=>now,time:t=>now=t,offline:value=>offline=value,counts:()=>({prepareCount,commitCount})};
}
async function tick(f){await f.scheduler.tick();await f.scheduler.idle();}
test('server recovery waits five minutes then reserves the original slot after the ordinary grace window',async()=>{
 const f=await fixture();await tick(f);const old=f.store.data.jobs[f.job.id];assert.equal(old.status,'failed');assert.equal(old.recovery.nextAt,f.clock()+RECOVERY_INTERVAL);assert.equal(f.counts().commitCount,0);
 f.time(old.recovery.nextAt-1);await tick(f);assert.equal(f.counts().prepareCount,1);f.time(old.recovery.nextAt);f.offline(false);await tick(f);assert.equal(f.store.data.jobs[f.job.id].status,'ready');await tick(f);assert.equal(f.store.data.jobs[f.job.id].status,'success');assert.equal(f.store.data.jobs[f.job.id].recovery.state,'completed');assert.equal(f.counts().commitCount,1);assert.deepEqual(f.targets[0],f.targets[1]);await tick(f);assert.equal(f.counts().commitCount,1);
});
test('an unavailable server keeps five-minute intervals, pauses cleanly, and recovery survives restart',async()=>{
 const f=await fixture();await tick(f);let due=f.store.data.jobs[f.job.id].recovery.nextAt;f.time(due);await tick(f);assert.equal(f.counts().prepareCount,2);assert.equal(f.store.data.jobs[f.job.id].recovery.nextAt,due+RECOVERY_INTERVAL);
 f.store.data.config.enabled=false;f.time(due+RECOVERY_INTERVAL);await tick(f);assert.equal(f.counts().prepareCount,2);f.store.data.config.enabled=true;
 const scheduler=new Scheduler(f.store,f.worker,f.clock);await scheduler.tick();await scheduler.idle();assert.equal(f.counts().prepareCount,3);assert.equal(f.store.data.jobs[f.job.id].recovery.nextAt,f.clock()+RECOVERY_INTERVAL);assert.equal(f.counts().commitCount,0);
});
test('recovery cannot submit once the original use time begins, or when account/assignment/device is changed',async()=>{
 for(const change of ['time','account','assignment','device']){const f=await fixture();await tick(f);f.time(f.store.data.jobs[f.job.id].recovery.nextAt);
  if(change==='time')f.time(Date.parse(`${f.job.date}T${f.job.start}:00+08:00`));if(change==='account')f.store.data.accounts[0].enabled=false;if(change==='assignment')f.store.data.config.windows[0].enabled=false;if(change==='device')f.store.data.config.equipments.forEach(e=>e.enabled=false);
  await tick(f);assert.equal(f.store.data.jobs[f.job.id].recovery.state,'stopped',change);assert.equal(f.counts().commitCount,0);assert.equal(f.counts().prepareCount,1);
 }
});
test('uncertain saves are never eligible for server recovery or another save',async()=>{
 const f=await fixture();f.offline(false);await tick(f);f.time(f.job.releaseAt);f.worker.commit=async(job,before)=>{await before();job.onStep('save_request','simulated request');throw new Error('network timeout after save');};await tick(f);assert.equal(f.store.data.jobs[f.job.id].status,'needs_review');assert.notEqual(f.store.data.jobs[f.job.id].recovery?.state,'waiting');f.time(f.clock()+RECOVERY_INTERVAL);await tick(f);assert.equal(f.counts().prepareCount,1);
});
test('permanent account errors and occupied slots do not enter network recovery',async()=>{
 for(const message of ['账号密码错误或账号不可用','目标时段已被占用','验证码/OCR未通过，已用完配置的0次刷新重试']){const f=await fixture();f.worker.prepare=async()=>{throw new Error(message);};await tick(f);assert.equal(f.store.data.jobs[f.job.id].status,'failed');assert.equal(f.store.data.jobs[f.job.id].recovery,undefined);}
});
test('restored interrupted recovery with save evidence becomes review-only, while a pre-save interruption waits five minutes',async()=>{
 for(const saving of [false,true]){const f=await fixture();f.store.job(f.job,{...f.job,status:saving?'saving':'preparing',recovery:{state:'running',attempts:1},...(saving?{savingAt:f.clock()}:{} )});new Scheduler(f.store,f.worker,f.clock);const record=f.store.data.jobs[f.job.id];assert.equal(record.status,saving?'needs_review':'failed');assert.equal(record.recovery.state,saving?'stopped':'waiting');}
});
test('several overdue slots of an unavailable account share the five-minute login backoff',async()=>{
 const f=await fixture();await tick(f);const due=f.store.data.jobs[f.job.id].recovery.nextAt;
 const second=f.scheduler.plan(1)[1];f.store.job(second,{...second,status:'failed',recovery:{state:'waiting',nextAt:due,attempts:0}});
 f.time(due);await tick(f);assert.equal(f.counts().prepareCount,2);assert.equal(f.store.data.jobs[second.id].recovery.nextAt,due+RECOVERY_INTERVAL);await tick(f);assert.equal(f.counts().prepareCount,2);assert.equal(f.counts().commitCount,0);
});
test('a non-network recovery failure becomes terminal rather than looping every scheduler tick',async()=>{
 const f=await fixture();await tick(f);f.time(f.store.data.jobs[f.job.id].recovery.nextAt);let attempts=0;f.worker.prepare=async()=>{attempts++;throw new Error('目标时段已被占用');};await tick(f);assert.equal(f.store.data.jobs[f.job.id].recovery.state,'stopped');await tick(f);assert.equal(attempts,1);
});
test('a slow site becoming ready after normal grace can still execute the original future slot',async()=>{
 const f=await fixture();f.worker.prepare=async()=>{f.time(f.job.releaseAt+120000);return{};};await tick(f);assert.equal(f.store.data.jobs[f.job.id].recovery.state,'running');await tick(f);assert.equal(f.store.data.jobs[f.job.id].status,'success');assert.equal(f.counts().commitCount,1);
});
test('pausing a prepared recovery closes it and persists a waiting task for safe resumption',async()=>{
 const f=await fixture();await tick(f);f.time(f.store.data.jobs[f.job.id].recovery.nextAt);f.offline(false);await tick(f);assert.equal(f.store.data.jobs[f.job.id].status,'ready');f.store.data.config.enabled=false;await f.scheduler.pausePrepared();assert.equal(f.store.data.jobs[f.job.id].recovery.state,'waiting');f.store.data.accounts[0].enabled=false;f.store.data.config.enabled=true;await tick(f);assert.equal(f.store.data.jobs[f.job.id].recovery.state,'stopped');assert.equal(f.counts().commitCount,0);
});
test('any persisted save evidence in a recovery queue forces review instead of another booking attempt',async()=>{
 const f=await fixture();await tick(f);f.store.job(f.job,{savingAt:f.clock()});f.time(f.store.data.jobs[f.job.id].recovery.nextAt);await tick(f);assert.equal(f.store.data.jobs[f.job.id].status,'needs_review');assert.equal(f.store.data.jobs[f.job.id].recovery.state,'stopped');assert.equal(f.counts().prepareCount,1);assert.equal(f.counts().commitCount,0);
});
