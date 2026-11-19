'use strict';
const {knownIdentities}=require('./site-identity.cjs');
const {shanghaiDate}=require('./schedule-logic.cjs');
const origin='https://healthlab.zs-hospital.sh.cn';
const expired=(message='登录会话已失效，需重新登录核对')=>Object.assign(new Error(message),{code:'AUTH_EXPIRED'});
const equipmentKey=rules=>JSON.stringify([rules.equipmentId,rules.equipmentName,rules.equipmentModel||'']);
class ScheduledSessions {
 constructor(worker,idleMs=35*60000){this.worker=worker;this.idleMs=idleMs;this.entries=new Map();this.all=new Set();this.pending=new Map();this.closed=false;this.metrics={loginAttempts:0,reused:0,reconnects:0};}
 account(job){const account=job.runtime?.account||this.worker.store.data.accounts.find(a=>a.id===job.accountId);if(!account)throw new Error('账号不存在');return account;}
 key(account){return JSON.stringify([account.id,account.username,account.revision||0]);}
 check(){if(this.closed||this.worker.closed)throw new Error('程序正在退出，未继续预约');if(this.worker.store.data.config.enabled===false)throw new Error('调度已暂停，未继续预约');}
 async inspect(page,account,expected){
  const url=new URL(page.url());if(url.origin!==origin||/\/login\/?$/.test(url.pathname))throw expired();
  const href=await page.locator('a.user').getAttribute('href',{timeout:10000}),userId=href?.match(/index[.](\d+)/)?.[1];if(!userId)throw expired('无法确认登录会话，需重新登录核对');
  const known=knownIdentities(this.worker.store).find(a=>a.accountId===account.id)?.profileId;
  if((expected&&userId!==expected)||(known&&userId!==known))throw Object.assign(new Error('登录身份与任务原账号不一致，未保存'),{code:'LOGIN_IDENTITY_MISMATCH',retryable:false});
  return userId;
 }
 async create(job,account,key,refreshing=false){
  this.metrics.loginAttempts++;if(refreshing)this.metrics.reconnects++;job.onStep?.('scheduled_session_new',refreshing?'重新建立原账号登录，继续实时核对':'建立原账号的独立后台登录，供后续时段复用');let raw;
  try{
   raw=await this.worker.session(account.id,true,true,job);this.check();const userId=await this.inspect(raw.page,account);this.check();
   const lease={key,account:{id:account.id,username:account.username,revision:account.revision||0},context:raw.context,initialPage:raw.page,landingUrl:raw.page.url(),userId,urls:new Map(),refs:new Set(),lastUsed:this.worker.clock(),day:shanghaiDate(this.worker.clock()),invalid:false};
   this.all.add(lease);this.entries.set(key,lease);return lease;
  }catch(error){if(raw)await this.worker.closeContext(raw.context);throw error;}
 }
 async get(job,account,budget){
  const key=this.key(account);let lease=this.entries.get(key);
  if(lease?.invalid||lease&&this.worker.browser&&!this.worker.browser.isConnected()){if(budget.remaining<=0)throw expired();budget.remaining--;budget.refreshing=true;this.invalidate(lease);if(!lease.refs.size)await this.destroy(lease);lease=null;}
  if(lease)return{lease,reused:true};
  if(this.pending.has(key))return{lease:await this.pending.get(key),reused:true};
  const promise=this.create(job,account,key,budget.refreshing).finally(()=>this.pending.delete(key));this.pending.set(key,promise);
  return{lease:await promise,reused:false};
 }
 invalidate(lease){if(!lease)return;lease.invalid=true;if(this.entries.get(lease.key)===lease)this.entries.delete(lease.key);}
 async acquire(job,budget={remaining:1}){
  this.check();await this.prune();const account=this.account(job);
  for(;;){let entry,lease;
   try{
    const selected=await this.get(job,account,budget);lease=selected.lease;const reused=selected.reused;this.check();lease.refs.add(job.id);
    const initial=lease.initialPage;lease.initialPage=null;
    entry={context:lease.context,page:initial||await lease.context.newPage(),revision:account.revision||0,accountId:account.id,userId:lease.userId,poolLease:lease};this.worker.sessions.set(job.id,entry);
    if(!initial){const rules=require('./equipment.cjs').rulesFor(job.equipment),url=lease.urls.get(equipmentKey(rules))||lease.landingUrl;await entry.page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});}
    this.check();await this.inspect(entry.page,account,lease.userId);this.check();
    if(reused){this.metrics.reused++;job.onStep?.('scheduled_session_reused','已复用原账号登录；本任务使用独立页面并实时核对');}return entry;
   }catch(error){
    if(entry)await this.release(job.id,entry,false);else if(lease){lease.refs.delete(job.id);this.invalidate(lease);if(!lease.refs.size)await this.destroy(lease);}
    if(error.code!=='AUTH_EXPIRED'||budget.remaining<=0)throw error;
    budget.remaining--;budget.refreshing=true;job.onStep?.('scheduled_session_refresh','登录已失效，恢复原账号有效登录后从实时核对开始；尚未保存');this.check();
   }
  }
 }
 isExpired(entry){try{return Boolean(entry?.poolLease&&(entry.poolLease.invalid||entry.page.isClosed()||this.worker.browser&&!this.worker.browser.isConnected()||/\/login\/?$/.test(new URL(entry.page.url()).pathname)));}catch{return true;}}
 async validate(job,entry){this.check();const lease=entry.poolLease;if(!lease||this.isExpired(entry))throw expired();await this.inspect(entry.page,this.account(job),lease.userId);}
 async remember(job,entry,rules){await this.validate(job,entry);const url=new URL(entry.page.url());if(!url.pathname.endsWith('/index.'+rules.equipmentId+'.reserv'))throw new Error('当前仪器页面不匹配');entry.poolLease.urls.set(equipmentKey(rules),url.href);}
 async reconnect(job,entry,budget){
  if(budget.remaining<=0)throw expired('重新登录后会话仍不可用，未继续提交');budget.remaining--;budget.refreshing=true;job.onStep?.('scheduled_session_refresh','原会话失效，恢复原账号有效登录并重读日历；未重复保存');
  if(entry)await this.release(job.id,entry,false);this.check();return this.acquire(job,budget);
 }
 async destroy(lease){
  if(lease.closing)return lease.closing;this.invalidate(lease);this.all.delete(lease);
  lease.closing=this.worker.closeContext(lease.context);await lease.closing;
 }
 async release(jobId,entry,healthy=false){
  if(this.worker.sessions.get(jobId)===entry)this.worker.sessions.delete(jobId);const lease=entry.poolLease;if(!lease)return;
  lease.refs.delete(jobId);await entry.page?.close().catch(()=>{});lease.lastUsed=this.worker.clock();
  if(!healthy)this.invalidate(lease);
  if(!lease.refs.size&&(lease.invalid||this.closed||this.worker.closed||this.worker.store.data.config.enabled===false))await this.destroy(lease);
 }
 async prune(force=false){
  const now=this.worker.clock(),date=shanghaiDate(now),accounts=this.worker.store.data?.accounts||[];
  for(const lease of [...this.all])if(!lease.refs.size){const current=accounts.find(a=>a.id===lease.account.id);if(force||lease.invalid||this.worker.store.data?.config?.enabled===false||!current?.enabled||this.key(current)!==lease.key||lease.day!==date||now-lease.lastUsed>=this.idleMs)await this.destroy(lease);}
  const idle=[...this.all].filter(l=>!l.refs.size).sort((a,b)=>a.lastUsed-b.lastUsed);while(idle.length>5)await this.destroy(idle.shift());
 }
 state(){return{...this.metrics,activePages:[...this.all].reduce((n,l)=>n+l.refs.size,0),idleAccounts:[...this.all].filter(l=>!l.refs.size&&!l.invalid).length};}
 async close(){this.closed=true;await Promise.allSettled([...this.pending.values()]);await Promise.all([...this.all].map(l=>this.destroy(l)));this.entries.clear();}
}
module.exports={ScheduledSessions,expired};
