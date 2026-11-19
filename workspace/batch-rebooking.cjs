'use strict';
const {randomUUID}=require('node:crypto');
const {validDate}=require('./schedule-logic.cjs');
const {safeError}=require('./support-files.cjs');
const activeStates=new Set(['running','cancelling']),eligible=new Set(['failed','needs_review']);
const validRequest=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
class BatchRebooking {
 constructor(reviews){
  this.reviews=reviews;this.store=reviews.store;this.clock=reviews.clock;this.promise=null;
  const old=this.store.data.rebookingBatch;
  if(old&&activeStates.has(old.state)){old.state='interrupted';old.finishedAt=this.clock();old.message='上次批量任务已中断，未处理记录不会自动继续；可重新发起并逐条核对';for(const item of old.items||[])if(['queued','processing'].includes(item.state)){item.state='unprocessed';item.message='批量任务中断，未确认完成';}this.store.persist();}
 }
 get active(){return Boolean(this.promise||activeStates.has(this.store.data.rebookingBatch?.state));}
 counts(){const result={};for(const j of Object.values(this.store.data.jobs))if(eligible.has(j.status))result[j.date]=(result[j.date]||0)+1;return result;}
 publicState(batch=this.store.data.rebookingBatch){
  if(!batch)return null;
  const items=batch.items||[],count=outcome=>items.filter(i=>i.outcome===outcome).length,processed=items.filter(i=>i.state==='done').length;
  return structuredClone({...batch,total:items.length,processed,remaining:items.length-processed,booked:count('booked'),existing:count('exists'),review:count('review'),failed:count('failed'),skipped:count('skipped')});
 }
 start(date,requestId){
  if(!validDate(date)||!validRequest(requestId))throw new Error('批量重新预约请求无效');
  const old=[this.store.data.rebookingBatch,...(this.store.data.rebookingBatchHistory||[])].find(b=>b?.id===requestId);
  if(old){if(old.date!==date)throw new Error('批量请求日期不一致');return this.publicState(old);}
  if(this.reviews.closed)throw new Error('程序正在退出');
  if(this.active)throw new Error('已有批量任务正在处理，请等待完成或停止当前任务');
  if(this.reviews.active)throw new Error('核对或预约网页正在使用，请等待结束或关闭网页后再批量处理');
  const order=j=>j.equipmentOrder??this.store.data.config.equipments.findIndex(e=>e.equipmentId===j.equipment?.equipmentId);
  const jobs=Object.values(this.store.data.jobs).filter(j=>j.date===date&&eligible.has(j.status)).sort((a,b)=>a.start.localeCompare(b.start)||order(a)-order(b)||a.id.localeCompare(b.id));
  if(!jobs.length)throw new Error('所选日期没有预约失败或需核对的记录');
  const batch={id:requestId,date,state:'running',startedAt:this.clock(),message:'正在依次核对并重新预约',items:jobs.map(j=>({jobId:j.id,start:j.start,end:j.end,equipmentName:j.equipment?.equipmentName||'原设备',state:'queued'}))};
  this.store.data.rebookingBatchHistory=[...(this.store.data.rebookingBatchHistory||[]),...(this.store.data.rebookingBatch?[this.store.data.rebookingBatch]:[])].slice(-5);
  this.store.data.rebookingBatch=batch;this.store.persist();const version=this.reviews.controlVersion();
  this.promise=Promise.resolve().then(()=>this.process(batch,version)).catch(error=>{batch.state='interrupted';batch.message='批量处理已中断：'+safeError(error);batch.finishedAt=this.clock();this.store.persist();}).finally(()=>{this.promise=null;});
  return this.publicState(batch);
 }
 async process(batch,version){
  const stopped=()=>this.reviews.closed||batch.state==='cancelling'||this.reviews.controlVersion()!==version;
  const pool=this.sessionPool=new (require('./batch-sessions.cjs').BatchSessions)(this.reviews,metrics=>{batch.sessionStats=metrics;this.store.persist();});
  try{
  for(const item of batch.items){
   if(stopped())break;
   const job=this.store.data.jobs[item.jobId];
   item.startedAt=this.clock();
   if(!job||job.date!==batch.date||!eligible.has(job.status)){
    Object.assign(item,{state:'done',outcome:['success','already_exists'].includes(job?.status)?'exists':'skipped',message:['success','already_exists'].includes(job?.status)?'该记录已经确认，已跳过':'记录已移除或状态变化，已跳过',finishedAt:this.clock()});this.store.persist();continue;
   }
   batch.currentJobId=job.id;item.state='processing';batch.message=`正在核对 ${batch.date} ${item.start}–${item.end} · ${item.equipmentName}`;this.store.persist();
   try{
    const result=await this.reviews.rebook(job.id,randomUUID(),{batchId:batch.id,verifyFirst:true,cancelled:stopped,sessionPool:pool});
    Object.assign(item,{state:'done',outcome:result.status==='success'?'booked':result.status==='already_exists'?'exists':result.status==='needs_review'?'review':'failed',message:result.message});
   }catch(error){Object.assign(item,{state:'done',outcome:'failed',message:safeError(error)});}
   item.finishedAt=this.clock();batch.currentJobId=null;this.store.persist();
  }
  }finally{await pool.close();this.sessionPool=null;}
  batch.state=stopped()?'cancelled':'completed';batch.currentJobId=null;batch.finishedAt=this.clock();
  for(const item of batch.items)if(item.state==='queued'){item.state='unprocessed';item.message='任务已停止，未处理';}
  batch.message=batch.state==='completed'?'批量重新预约已完成':'批量重新预约已停止，未处理记录保持原状态';this.store.persist();
 }
 cancel(id){
  const batch=this.store.data.rebookingBatch;if(id&&batch?.id!==id)throw new Error('批量任务已变化，请刷新后重试');
  if(batch&&this.active){batch.state='cancelling';batch.message='正在停止批量任务；保存结果不明确时仅核对，不重复提交';this.store.persist();const entry=this.reviews.sessions.get(batch.currentJobId);if(this.sessionPool){this.sessionPool.close().catch(()=>{});this.sessionPool.closeEntry(entry).catch(()=>{});}else entry?.browser.close().catch(()=>{});}
  return this.publicState();
 }
}
module.exports={BatchRebooking};
