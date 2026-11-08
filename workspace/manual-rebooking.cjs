'use strict';
const {randomUUID}=require('node:crypto');
const {reviewPlan}=require('./reviews.cjs');
const {recorder}=require('./timeline.cjs');
const {safeError,captureFailure}=require('./support-files.cjs');
const pendingStates=new Set(['checking','saving']);
function uncertainReview(job,attempt,now){
 return {...job.review,protocol:3,cycleId:randomUUID(),state:'waiting',stage:'post_rebook',nextAt:now,automatic:false,manualRequired:false,notice:undefined,autoAttempts:1,
  rebooking:{attemptId:attempt.requestId,attemptCount:1,state:'uncertain',submittedAt:attempt.submittedAt,message:'手动重新预约保存结果待核对；本次保存机会已使用'},message:'手动重新预约结果待确认，先立即复核，不重复提交'};
}
function recoverManual(reviews){
 for(const job of Object.values(reviews.store.data.jobs)){
  const attempt=job.manualRebooking;if(!attempt||!pendingStates.has(attempt.state))continue;
  const uncertain=attempt.submittedAt!==undefined,now=reviews.clock();
  reviews.store.job(job,{status:uncertain?'needs_review':'failed',manualRebooking:{...attempt,state:uncertain?'uncertain':'interrupted',finishedAt:now,message:uncertain?'上次手动重新预约在保存后中断，待核对结果':'上次手动重新预约已中断，未进入保存'},recovery:job.recovery?{...job.recovery,state:'stopped'}:undefined,...(uncertain?{review:uncertainReview(job,attempt,now)}:{}),message:uncertain?'上次手动保存结果不明确，转入复核；不会自动重新提交':'上次手动重新预约已中断，可再次点击重新预约'});
 }
}
function result(job){return {verified:['success','already_exists'].includes(job.status),status:job.status,message:job.manualRebooking?.message||job.message};}
function rebook(reviews,id,requestId){
 if(typeof id!=='string'||!Object.hasOwn(reviews.store.data.jobs,id)||typeof requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))return Promise.reject(new Error('重新预约请求无效'));
 const current=reviews.store.data.jobs[id];
 if(reviews.pending.has(id))return reviews.manualRequests.get(id)===requestId?reviews.pending.get(id):Promise.reject(new Error('该记录正在处理，请等待当前操作完成'));
 if([current.manualRebooking,...(current.manualRebookingHistory||[])].some(a=>a?.requestId===requestId))return Promise.resolve(result(current));
 reviews.manualRequests.set(id,requestId);
 return reviews.run(id,async()=>{
  const target=reviews.target(id),job=target.job;
  if(!['failed','missed'].includes(job.status))throw new Error('仅失败或已错过的记录可重新预约；结果不明确时请先重新核对');
  if(reviews.sessions.has(id)||[...reviews.sessions.values()].some(e=>e.accountId===target.account.id)||[...reviews.pending.keys()].some(other=>other!==id&&reviews.store.data.jobs[other]?.accountId===target.account.id))throw new Error('原账号有核对任务或网页正在使用，请关闭后重试');
  const version=reviews.controlVersion(),gate=()=>{
   const live=reviews.store.data.jobs[id],account=reviews.store.data.accounts.find(a=>a.id===target.account.id),plan=reviewPlan(job),now=reviews.clock();
   if(reviews.closed||reviews.controlVersion()!==version)throw new Error('手动重新预约已取消，未再次提交');
   if(!account||account.username!==target.account.username||account.revision!==target.account.revision)throw new Error('原账号配置已变化，请重新操作');
   if(now>=plan.start*1000)throw new Error('原使用时段已开始，无法重新预约');
   if(now<(plan.end-target.rules.release.advanceDays*86400)*1000)throw new Error('原时段尚未开放预约');
   if(!reviews.canRun({...job,accountId:target.account.id}))throw new Error('原账号正在执行其他预约，请稍后重试');
   if(!['failed','missed'].includes(live?.status)||live.manualRebooking?.requestId!==requestId)throw new Error('预约状态已变化，请刷新记录');
  };
  if(!reviews.canRun({...job,accountId:target.account.id}))throw new Error('原账号正在执行其他预约，请稍后重试');
  const attempt={requestId,accountId:target.account.id,state:'checking',startedAt:reviews.clock(),previousStatus:job.status,previousMessage:job.message,previousReview:job.review};
  const history=[...(job.manualRebookingHistory||[]),...(job.manualRebooking?[job.manualRebooking]:[])].slice(-30);
  // Stop the old five-minute recovery before reserving the account for this explicit action.
  reviews.store.job(job,{manualRebooking:attempt,manualRebookingHistory:history,recovery:job.recovery?{...job.recovery,state:'stopped'}:undefined});
  const onStep=recorder(reviews.store,job,reviews.clock),patch=changes=>{Object.assign(attempt,changes);reviews.store.job(job,{manualRebooking:{...attempt}});};let entry;
  onStep('manual_rebook_start','手动重新预约：使用原账号、原设备及原时段');
  try{
   gate();entry=await reviews.session(target,false);gate();
   const identity=require('./site-identity.cjs'),request={date:job.date,start:job.start,end:job.end},options={rules:target.rules,onStep,onCalendar:snapshot=>reviews.onCalendar?.(job,snapshot),onIdentity:userId=>identity.recordIdentity(reviews.store,target.account.id,userId,target.account),profileIds:()=>identity.knownIdentities(reviews.store).map(a=>a.profileId),teamMembers:()=>reviews.store.data.config.teamMembers||[],identitiesComplete:()=>identity.knownIdentities(reviews.store).length===reviews.store.data.accounts.length};
   const first=await reviews.bookingApi.preflightBooking(entry.page,request,options);gate();
   const prepared=first.alreadyExists?first:await reviews.bookingApi.prepareBooking(entry.page,request,{...options,preflight:first});gate();
   const booked=prepared.alreadyExists?{status:'already_exists',reservationId:prepared.reservationId}:await reviews.bookingApi.commitBooking(entry.page,request,{...options,expectedUserId:first.userId,beforeSave:()=>{
    gate();if(attempt.submittedAt!==undefined)throw new Error('本次手动请求已提交，请先核对结果');
    patch({state:'saving',submittedAt:reviews.clock()});onStep('manual_rebook_submit','手动重新预约开始保存，本次请求不重复提交');
   }});
   if(!['created','already_exists'].includes(booked?.status))throw new Error('网站未返回可确认的预约结果');
   const confirmedAt=booked.confirmedAt||reviews.clock(),status=booked.status==='created'?'success':'already_exists',message=status==='success'?'手动重新预约成功，已从网站读回确认':'网站已有本团队预约，未重复提交';
   patch({state:status,finishedAt:reviews.clock(),confirmedAt,reservationId:booked.reservationId,message});
   onStep('manual_rebook_confirmed',message);
   reviews.store.job(job,{status,reservationId:booked.reservationId,confirmedAt,verifiedAt:new Date(confirmedAt).toISOString(),confirmationDelayMs:confirmedAt-job.releaseAt,submissionToConfirmationMs:attempt.submittedAt!==undefined?confirmedAt-attempt.submittedAt:undefined,message,review:job.review?{...job.review,state:'verified',stage:'finished',nextAt:null,manualRequired:false,notice:undefined,message}:undefined});
  }catch(error){
   const message=safeError(error),diagnosticId=await captureFailure(reviews.root,job,'manual-rebook',error,entry?.page||reviews.sessions.get(id)?.page).catch(()=>undefined);
   patch({state:attempt.submittedAt!==undefined?'uncertain':'failed',finishedAt:reviews.clock(),message});onStep('manual_rebook_finished',message);
   if(attempt.submittedAt!==undefined){
    reviews.store.job(job,{status:'needs_review',diagnosticId,review:uncertainReview(job,attempt,reviews.clock()),message:'手动保存结果不明确，正在核对预约结果'});
    const startedAt=reviews.clock();let match=null,detail=message;
    try{({match}=await reviews.query(target,entry));}catch(queryError){detail=safeError(queryError);}
    const checked=reviews.finish(reviews.store.data.jobs[id],match,detail,false,'post_rebook',startedAt,match?'verified':'error');
    patch({state:checked.verified?'already_exists':'uncertain',...(checked.verified?{confirmedAt:reviews.clock(),reservationId:match.id}:{}),message:checked.message,finishedAt:reviews.clock()});
   }else reviews.store.job(job,{status:'failed',diagnosticId,message:'手动重新预约未完成：'+message});
  }finally{const active=reviews.sessions.get(id);reviews.sessions.delete(id);await active?.browser.close().catch(()=>{});}
  return result(reviews.store.data.jobs[id]);
 }).finally(()=>reviews.manualRequests.delete(id));
}
module.exports={rebook,recoverManual};
