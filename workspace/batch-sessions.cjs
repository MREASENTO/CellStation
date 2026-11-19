'use strict';
const {knownIdentities}=require('./site-identity.cjs');
const origin='https://healthlab.zs-hospital.sh.cn';
const equipmentKey=rules=>JSON.stringify([rules.equipmentId,rules.equipmentName,rules.equipmentModel||'']);
class BatchSessions {
 constructor(reviews,onMetrics=()=>{}){this.reviews=reviews;this.entries=new Map();this.closing=new WeakMap();this.closed=false;this.metrics={loginAttempts:0,reused:0,reconnects:0};this.onMetrics=onMetrics;}
 emit(){this.onMetrics({...this.metrics});}
 check(target,cancelled){
  if(this.closed||this.reviews.closed||cancelled?.())throw new Error('批量任务已停止，未继续使用登录会话');
  const current=this.reviews.store.data.accounts.find(a=>a.id===target.account.id);
  if(!current||current.username!==target.account.username||current.revision!==target.account.revision)throw new Error('原账号配置已变化，请重新操作');
 }
 usable(entry){return Boolean(entry?.page&&!entry.page.isClosed()&&entry.browser.isConnected());}
 async inspect(target,entry,expectedUserId){
  const url=new URL(entry.page.url());
  if(url.origin!==origin||!url.pathname.endsWith('/index.'+target.rules.equipmentId+'.reserv'))throw new Error('登录会话或设备页面已失效，未继续预约');
  await entry.page.locator('table.calendar_week').waitFor({state:'visible',timeout:10000});
  const href=await entry.page.locator('a.user').getAttribute('href',{timeout:10000}),userId=href?.match(/index[.](\d+)/)?.[1];
  const known=knownIdentities(this.reviews.store).find(a=>a.accountId===target.account.id)?.profileId;
  if(!userId||(expectedUserId&&userId!==expectedUserId)||(known&&userId!==known))throw new Error('登录身份与原账号不一致，未继续预约');
  entry.userId=userId;return url.href;
 }
 async closeEntry(entry){
  if(!entry?.browser)return;
  let promise=this.closing.get(entry.browser);
  if(!promise){promise=Promise.resolve().then(()=>entry.browser.close()).catch(()=>{});this.closing.set(entry.browser,promise);}
  await promise;
 }
 async discard(lease){if(!lease)return;if(this.entries.get(lease.accountId)===lease)this.entries.delete(lease.accountId);await this.closeEntry(lease.entry);}
 async acquire(target,onStep,cancelled){
  this.check(target,cancelled);let lease=this.entries.get(target.account.id);
  if(lease?.inUse)throw new Error('该账号的批量会话正在使用，未并行提交');
  if(lease&&(lease.username!==target.account.username||lease.revision!==target.account.revision)){await this.discard(lease);lease=null;}
  if(lease){
   try{
    if(!this.usable(lease.entry))throw new Error('后台登录会话已关闭');
    this.reviews.sessions.set(target.job.id,lease.entry);
    if(lease.equipment!==equipmentKey(target.rules))await this.reviews.open(lease.entry.page,target.rules);
    else await lease.entry.page.goto(lease.calendarUrl,{waitUntil:'domcontentloaded',timeout:45000});
    this.check(target,cancelled);lease.calendarUrl=await this.inspect(target,lease.entry,lease.userId);this.check(target,cancelled);
    lease.equipment=equipmentKey(target.rules);lease.inUse=true;this.metrics.reused++;this.emit();onStep('batch_session_reused','已复用原账号登录，重新确认身份及设备；本时段仍实时核对');return lease.entry;
   }catch(error){
    this.reviews.sessions.delete(target.job.id);await this.discard(lease);this.check(target,cancelled);
    this.metrics.reconnects++;this.emit();onStep('batch_session_refresh','原会话不可用，重新登录后从本时段核对开始；未提交保存');
   }
  }
  if(this.entries.size>=5){const oldest=[...this.entries.values()].filter(e=>!e.inUse).sort((a,b)=>a.lastUsed-b.lastUsed)[0];if(!oldest)throw new Error('后台会话正在使用，请稍后重试');await this.discard(oldest);}
  this.check(target,cancelled);this.metrics.loginAttempts++;this.emit();let entry;
  try{
   entry=await this.reviews.session(target,false);this.check(target,cancelled);
   const calendarUrl=await this.inspect(target,entry);this.check(target,cancelled);
   this.entries.set(target.account.id,{accountId:target.account.id,username:target.account.username,revision:target.account.revision,equipment:equipmentKey(target.rules),calendarUrl,userId:entry.userId,entry,inUse:true,lastUsed:this.reviews.clock()});
   onStep('batch_session_new','原账号已登录并确认身份，供本批次后续时段复用');return entry;
  }catch(error){const active=entry||this.reviews.sessions.get(target.job.id);this.reviews.sessions.delete(target.job.id);await this.closeEntry(active);throw error;}
 }
 async release(target,entry,healthy){
  const lease=this.entries.get(target.account.id),current=this.reviews.store.data.accounts.find(a=>a.id===target.account.id);
  if(lease?.entry===entry&&healthy&&!this.closed&&this.usable(entry)&&current?.username===lease.username&&current?.revision===lease.revision){lease.inUse=false;lease.lastUsed=this.reviews.clock();return;}
  if(lease?.entry===entry)await this.discard(lease);else await this.closeEntry(entry);
 }
 async close(){if(this.closePromise)return this.closePromise;this.closed=true;const entries=[...this.entries.values()];this.entries.clear();this.closePromise=Promise.all(entries.map(e=>this.closeEntry(e.entry)));await this.closePromise;}
}
module.exports={BatchSessions};
