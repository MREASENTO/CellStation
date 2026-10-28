'use strict';
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { automaticLogin } = require('./auto-login.cjs');
const { openEquipment, ensureWeek, calendarComponents } = require('./reservation.cjs');
const { rulesFor } = require('./equipment.cjs');
const { validDate,windowsFor } = require('./schedule-logic.cjs');
const { recorder }=require('./timeline.cjs');
const { minutes, assessComponents } = require('./booking-logic.cjs');
const { safeError, captureFailure } = require('./support-files.cjs');
const INTERVAL = 5 * 60000;
function reviewPlan(job) {
  if (!validDate(job.date) || minutes(job.end) <= minutes(job.start)) throw new Error('原预约日期或时段无效');
  const start = Date.parse(`${job.date}T${job.start}:00+08:00`) / 1000;
  const end = Date.parse(`${job.date}T${job.end}:00+08:00`) / 1000;
  const dayStart = Date.parse(job.date+'T00:00:00+08:00') / 1000;
  const weekday = new Date(dayStart * 1000 + 8 * 3600000).getUTCDay();
  return { start, end, dayStart, weekStart: dayStart - weekday * 86400 };
}
class Reviews {
  constructor(store, root, { clock = Date.now, canRun = () => true, launch, login = automaticLogin, open = openEquipment, week = ensureWeek, components = calendarComponents, bookingApi = require('./reservation.cjs'), pause = ms=>new Promise(resolve=>setTimeout(resolve,ms)) } = {}) {
    Object.assign(this, { store, root, clock, canRun, login, open, week, components, bookingApi, pause });
    this.launch = launch || (options => require('playwright').chromium.launch(options));
    this.sessions = new Map(); this.pending = new Map(); this.pendingPersonal = new Map(); this.closed = false;
    for(const job of Object.values(store.data.jobs)) {
      if(job.status!=='needs_review')continue;
      if(job.review?.protocol>=2&&['checking','rebooking'].includes(job.review.state)){const rebooking=job.review.rebooking;if(rebooking&&['checking','saving'].includes(rebooking.state))rebooking.state='interrupted';store.job(job,{review:{...job.review,...(rebooking?{rebooking}:{}),state:'waiting',nextAt:clock(),message:'上次复核中断，继续未完成的查询；已消耗的补约机会不会重置。'}});}
      this.observe(this.store.data.jobs[job.id]);
    }
    this.reschedule();
  }
  get active() { return this.sessions.size + this.pending.size; }
  isAccountBusy(accountId) { return [...this.pendingPersonal.values()].includes(accountId)||[...this.pending.keys()].some(id=>this.store.data.jobs[id]?.accountId===accountId)||[...this.sessions.values()].some(e=>!e.visible&&e.accountId===accountId); }
  target(id) {
    const job = this.store.data.jobs[id];
    if (!job || !['needs_review','failed','missed','already_exists','success'].includes(job.status)) throw new Error('该记录当前不需要核对');
    const account = this.store.data.accounts.find(a => a.id === job.accountId || (job.accountUsername && a.username === job.accountUsername));
    if (!account) throw new Error('原账号已移除，请先在账号管理中重新添加原账号，再从首页打开网站核对');
    if (job.accountUsername && job.accountUsername !== account.username) throw new Error('当前账号与原预约账号不一致');
    reviewPlan(job);
    return { job: structuredClone(job), account: structuredClone(account), rules: rulesFor(job.equipment) };
  }
  intervalMs() {const p=this.store.data.config.reviewPolicy||{};return (p.retryIntervalSeconds??(p.retryIntervalMinutes||5)*60)*1000;}
  intervalText(){return this.intervalMs()/1000+'秒';}
  observe(job) {
    job=this.store.data.jobs[job.id]||job;if(job.status!=='needs_review')return job;
    if(job.review?.protocol>=2){
      if(job.review.protocol===2&&this.store.data.config.reviewRebookEnabled!==false&&!job.review.manualRequired&&(job.review.autoAttempts||0)<=1){const done=job.review.autoAttempts||0;return this.store.job(job,{review:{...job.review,protocol:3,state:'waiting',stage:done?'rebook':'immediate',nextAt:this.clock(),notice:undefined,message:done?'首次复核未确认，准备尝试一次补约':'等待首次复核'}});}
      return job;
    }
    const protocol=this.store.data.config.reviewRebookEnabled===false?2:3,history=job.review?.checkedAt?[{stage:'legacy',checkedAt:job.review.checkedAt,message:job.review.message||'旧版复核记录'}]:[];
    const record=this.store.job(job,{review:{protocol,cycleId:randomUUID(),state:'waiting',stage:'immediate',nextAt:this.clock(),automatic:true,autoAttempts:0,attempts:job.review?.attempts||0,history,message:protocol===3?'等待立即复核；未确认时核对空闲后补约一次，再即时复核并按设置等待最终复核。':'等待立即复核；查询原账号、原设备和原时段。'}});
    this.nudge();return record;
  }
  nudge() { if(this.started&&!this.nudgePending){this.nudgePending=true;queueMicrotask(()=>{this.nudgePending=false;this.tick().catch(()=>{});});} }
  reschedule() {
    for(const job of Object.values(this.store.data.jobs))if(job.status==='needs_review'&&job.review?.protocol>=2&&job.review.state==='waiting'&&job.review.stage==='delayed') {
      const nextAt=job.review.scheduledFrom+this.intervalMs();
      if(nextAt!==job.review.nextAt)this.store.job(job,{review:{...job.review,nextAt,intervalSeconds:this.intervalMs()/1000,intervalMinutes:this.intervalMs()/60000,message:`已按当前设置安排${job.review.protocol===3?'最终':'再次'}复核，等待${this.intervalText()}。`}});
    }
    this.nudge();
  }
  start() { this.started=true;this.timer = setInterval(() => this.tick().catch(() => {}),1000); this.timer.unref?.();this.nudge(); }
  async tick() {
    if(this.ticking||this.closed||!this.store.data.config.enabled)return;this.ticking=true;
    try{for(const item of Object.values(this.store.data.jobs)){
      if(item.status!=='needs_review')continue;const job=this.observe(item);
      if(job.review.state==='waiting'&&job.review.nextAt<=this.clock()&&!this.pending.size&&![...this.sessions.values()].some(e=>e.accountId===job.accountId)&&this.canRun(job)){
        try{await this.recheck(job.id,true);}catch(error){this.finish(job,null,safeError(error),true,job.review.stage==='rebook'?'post_rebook':job.review.stage||'immediate',this.clock(),'error');}
      }
    }}finally{this.ticking=false;}
  }
  finish(job,match,detail,automatic,stage,startedAt,outcome='not_found') {
    job=this.store.data.jobs[job.id]||job;
    const base=job.review||{},inFlow=job.status==='needs_review'&&base.protocol>=2,newFlow=base.protocol===3,checkedAt=this.clock();
    const count=newFlow?({immediate:1,post_rebook:2,delayed:3}[stage]||0):({immediate:1,delayed:2}[stage]||0),autoAttempts=inFlow?Math.max(base.autoAttempts||0,count):0;
    const rebookNext=inFlow&&newFlow&&!match&&stage==='immediate',waiting=inFlow&&!match&&(rebookNext||autoAttempts<(newFlow?3:2)),manualRequired=inFlow&&!match&&!waiting;
    const nextStage=rebookNext?'rebook':waiting?'delayed':'finished';
    const message=match?'复核确认该设备时段已有本团队的预约。':rebookNext?'首次复核未确认，正在核对空闲并尝试一次补约。':waiting?`${newFlow?'补约后即时复核':'首次复核'}未确认：${detail}；将在${this.intervalText()}后${newFlow?'最终':'再次'}复核。`:manualRequired?`${newFlow?'最终':'再次'}复核失败：${detail}。已停止自动复核，请你自主复核。`:`本次复核未确认：${detail}；可手动再查或打开网页。`;
    const history=[...(base.history||[]),{stage,automatic,startedAt,checkedAt,durationMs:checkedAt-startedAt,outcome:match?'verified':outcome,message}].slice(-30);
    const review={...base,state:match?'verified':waiting?'waiting':'failed',stage:nextStage,automatic,attempts:(base.attempts||0)+1,autoAttempts,manualRequired,notice:waiting&&!rebookNext?'retry_scheduled':manualRequired?'manual_required':undefined,startedAt,checkedAt,durationMs:checkedAt-startedAt,history,message,nextAt:waiting?(rebookNext?checkedAt:checkedAt+this.intervalMs()):null};
    if(stage==='immediate')review.firstCheckedAt=checkedAt;if(stage==='post_rebook')review.postRebookCheckedAt=checkedAt;if(stage==='delayed')review.delayedCheckedAt=checkedAt;
    if(waiting&&!rebookNext)Object.assign(review,{scheduledFrom:checkedAt,intervalSeconds:this.intervalMs()/1000,intervalMinutes:this.intervalMs()/60000});
    let patch={review};if(match){patch={...patch,status:base.rebooking?.outcome==='created'?'success':'already_exists',reservationId:match.id,recheckedAt:checkedAt,message};if(base.rebooking?.outcome==='created')Object.assign(patch,{confirmedAt:checkedAt,verifiedAt:new Date(checkedAt).toISOString(),confirmationDelayMs:checkedAt-job.releaseAt,submissionToConfirmationMs:checkedAt-base.rebooking.submittedAt});}
    this.store.job(job,patch);return {verified:Boolean(match),manualRequired,message};
  }
  run(id, action) {
    if (this.closed) return Promise.reject(new Error('程序正在退出'));
    if (this.pending.has(id)) return this.pending.get(id);
    const promise = Promise.resolve().then(action).finally(() => this.pending.delete(id));
    this.pending.set(id,promise); return promise;
  }
  async session(target, visible) {
    const browser = await this.launch({ channel:'chrome', headless:!visible, args:['--no-first-run','--no-default-browser-check','--disable-save-password-bubble'] });
    const entry = { browser, page:null, visible, accountId:target.account.id };
    this.sessions.set(target.job.id,entry);
    browser.once?.('disconnected',()=>{if(this.sessions.get(target.job.id)===entry)this.sessions.delete(target.job.id);});
    if (this.closed) { await browser.close(); throw new Error('程序正在退出'); }
    const context = await browser.newContext({ viewport:{width:1440,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai',acceptDownloads:false });
    const page = entry.page = await context.newPage();
    if (visible) page.once('close',()=>browser.close().catch(()=>{}));
    await page.goto('https://healthlab.zs-hospital.sh.cn/cf/main/login',{waitUntil:'domcontentloaded',timeout:45000});
    const work = path.join(this.root,'work','review');fs.mkdirSync(work,{recursive:true});
    let credentials = await this.store.credentials(target.account.id,target.account);
    try { await this.login(page,credentials.username,credentials.password,work,{captchaRetries:this.store.data.config.retryPolicy?.captchaRetries??2,deadline:this.clock()+90000,now:this.clock}); }
    finally { credentials.password=undefined;credentials=undefined; }
    await this.open(page,target.rules);
    return entry;
  }
  async query(target,entry) {
    if(this.closed)throw new Error('程序正在退出');entry ||= await this.session(target,false);
    const page=entry.page,href=await page.locator('a.user').getAttribute('href'),userId=href?.match(/index[.](\d+)/)?.[1];if(!userId)throw new Error('无法确认登录身份，未更新预约结果');
    const identity=require('./site-identity.cjs');identity.recordIdentity(this.store,target.account.id,userId,target.account);entry.userId=userId;
    const plan=reviewPlan(target.job),rows=await this.components(page,plan.weekStart),match=identity.coveringOurs(rows,plan,[userId,...identity.knownIdentities(this.store).map(a=>a.profileId)],this.store.data.config.teamMembers||[]);
    return{entry,match};
  }
  rebookGate(target) {
    const {job,account}=target,config=this.store.data.config,now=this.clock(),plan=reviewPlan(job);
    if(this.closed||!config.enabled)throw new Error('调度已暂停，未执行补约');if(config.reviewRebookEnabled===false)throw new Error('首次复核后补约已关闭');
    if(now>=plan.start*1000)throw new Error('原使用时段已开始，未执行补约');if(now<(plan.end-target.rules.release.advanceDays*86400)*1000)throw new Error('原时段尚未开放，未执行补约');
    const current=this.store.data.accounts.find(a=>a.id===account.id);if(!current?.enabled||current.username!==account.username||current.revision!==account.revision)throw new Error('原账号配置已变化，未执行补约');
    if(!(config.equipments||[config.equipment]).some(e=>e.enabled!==false&&e.equipmentId===target.rules.equipmentId&&e.equipmentName===target.rules.equipmentName))throw new Error('原设备配置已变化，未执行补约');
    if(job.windowId){if(!windowsFor(config,job.date).some(w=>w.id===job.windowId&&w.enabled)||this.store.assignment(job.date)[job.windowId]!==account.id||(config.exclusions||[]).some(e=>e.date===job.date&&e.windowIds.includes(job.windowId)))throw new Error('原计划已修改或跳过，未执行补约');}
    if(!this.canRun(job))throw new Error('其他预约即将执行，未执行本次补约');
    if(this.store.data.jobs[job.id]?.status!=='needs_review')throw new Error('原预约状态已变化，未执行补约');
  }
  setRebooking(job,patch){const current=this.store.data.jobs[job.id];this.store.job(job,{review:{...current.review,rebooking:{...current.review.rebooking,...patch}}});}
  async attemptRebooking(target,entry) {
    const {job}=target,current=this.store.data.jobs[job.id];if(current.review.rebooking)return entry;
    const attemptId=randomUUID(),onStep=recorder(this.store,job,this.clock);this.setRebooking(job,{attemptId,attemptCount:1,state:'checking',startedAt:this.clock()});
    this.store.job(job,{review:{...this.store.data.jobs[job.id].review,state:'rebooking',stage:'rebook',nextAt:this.clock(),notice:undefined,message:'首次复核未确认，正在核对并尝试一次补约。'}});onStep('review_rebook_start','首次复核后补约机会已记录，本轮最多额外保存一次');
    try {
      this.rebookGate(target);
      if(!entry){const old=this.sessions.get(job.id);this.sessions.delete(job.id);await old?.browser.close().catch(()=>{});entry=await this.session(target,false);}
      const identity=require('./site-identity.cjs'),options={rules:target.rules,onStep,onIdentity:userId=>identity.recordIdentity(this.store,target.account.id,userId,target.account),profileIds:()=>identity.knownIdentities(this.store).map(a=>a.profileId),teamMembers:()=>this.store.data.config.teamMembers||[],identitiesComplete:()=>identity.knownIdentities(this.store).length===this.store.data.accounts.length},request={date:job.date,start:job.start,end:job.end};
      const first=await this.bookingApi.preflightBooking(entry.page,request,options);
      if(first.alreadyExists){this.setRebooking(job,{state:'already_exists',outcome:'already_exists',finishedAt:this.clock(),reservationId:first.reservationId,message:'网站已有团队预约，未重复提交'});return entry;}
      await this.pause(250);this.rebookGate(target);
      const fresh=await this.bookingApi.preflightBooking(entry.page,request,options);
      if(fresh.alreadyExists){this.setRebooking(job,{state:'already_exists',outcome:'already_exists',finishedAt:this.clock(),reservationId:fresh.reservationId,message:'核对期间已有团队预约，未重复提交'});return entry;}
      onStep('review_rebook_empty','两次实时查询确认目标时段空闲');
      const prepared=await this.bookingApi.prepareBooking(entry.page,request,{...options,preflight:fresh});
      const result=prepared.alreadyExists?{status:'already_exists',reservationId:prepared.reservationId}:await this.bookingApi.commitBooking(entry.page,request,{...options,expectedUserId:fresh.userId,beforeSave:()=>{
        this.rebookGate(target);const retry=this.store.data.jobs[job.id].review.rebooking;
        if(retry.attemptId!==attemptId||retry.submittedAt!==undefined)throw new Error('本轮补约已经提交，禁止再次保存');
        this.setRebooking(job,{state:'saving',submittedAt:this.clock()});onStep('review_rebook_submit','补约保存权限已消耗；原始保存时间保留');
      }});
      this.setRebooking(job,{state:result.status==='created'?'confirmed':'already_exists',outcome:result.status,finishedAt:this.clock(),confirmedAt:result.confirmedAt,reservationId:result.reservationId,message:result.status==='created'?'补约保存后已读回记录，立即再次复核':'网站已有预约，立即再次复核'});onStep('review_rebook_finished','补约处理结束，开始即时复核');
    }catch(error){const retry=this.store.data.jobs[job.id].review.rebooking,diagnosticId=await captureFailure(this.root,job,'review-rebook',error,entry?.page||this.sessions.get(job.id)?.page).catch(()=>undefined);if(diagnosticId)this.store.job(job,{diagnosticId});this.setRebooking(job,{state:retry.submittedAt!==undefined?'uncertain':'not_submitted',finishedAt:this.clock(),message:safeError(error)});onStep('review_rebook_finished','补约未确认：'+safeError(error));}
    return entry;
  }
  async afterFirst(target,entry,automatic) {
    entry=await this.attemptRebooking(target,entry);const job=this.store.data.jobs[target.job.id],startedAt=this.clock();
    this.store.job(job,{review:{...job.review,state:'checking',stage:'post_rebook',inFlightStage:'post_rebook',startedAt,nextAt:startedAt,notice:undefined,message:'补约处理后立即复核原设备和原时段'}});
    try{const result=await this.query(target,entry);return this.finish(job,result.match,'未查到匹配预约',automatic,'post_rebook',startedAt);}
    catch(error){return this.finish(job,null,safeError(error),automatic,'post_rebook',startedAt,'error');}
  }
  async recheck(id, automatic = false) {
    return this.run(id,async()=>{
      const current=this.store.data.jobs[id];if(current)this.observe(current);const target=this.target(id),job=target.job;
      if(['success','already_exists'].includes(job.status))return{verified:true,message:'该预约已经确认，无需再次核对'};
      const limit=job.review?.protocol===3?3:2;if(automatic&&(job.review?.autoAttempts||0)>=limit)return{verified:false,manualRequired:true,message:'自动复核已结束，请自主复核。'};
      if(!this.canRun(job))throw new Error('该账号正在准备或执行预约，请稍后核对');if(this.sessions.has(id))throw new Error('该记录的核对网页已打开，请关闭后再由程序核对');
      const stage=job.status==='needs_review'&&job.review?.protocol>=2&&job.review.stage!=='finished'?job.review.stage:'manual',startedAt=this.clock();let entry;
      try{
        if(stage==='rebook')return await this.afterFirst(target,entry,automatic);
        this.store.job(job,{review:{...job.review,state:'checking',startedAt,automatic,inFlightStage:stage}});
        let match=null,detail='未查到匹配预约',outcome='not_found';
        try{const result=await this.query(target);entry=result.entry;match=result.match;}
        catch(error){detail=safeError(error);outcome='error';const diagnosticId=await captureFailure(this.root,job,'recheck',error,this.sessions.get(id)?.page).catch(()=>undefined);if(diagnosticId)this.store.job(job,{diagnosticId});}
        const result=this.finish(job,match,detail,automatic,stage,startedAt,outcome);
        if(!match&&stage==='immediate'&&job.review?.protocol===3)return await this.afterFirst(target,entry,automatic);
        return result;
      }finally{const active=this.sessions.get(id);this.sessions.delete(id);await active?.browser.close().catch(()=>{});}
    });
  }
  async openWebsite(id) {
    return this.run(id,async()=>{
      const existing=this.sessions.get(id);
      if(existing?.visible&&!existing.page?.isClosed()){await existing.page.bringToFront();return {opened:true,message:'已切换到原账号核对网页'};}
      const target=this.target(id);if(!this.canRun(target.job))throw new Error('该账号正在准备或执行预约，请稍后打开');
      try {
        const entry=await this.session(target,true);
        await this.week(entry.page,reviewPlan(target.job).start);
        await entry.page.bringToFront();
        return {opened:true,ready:true,message:`已用原账号登录并打开 ${target.job.date} 的设备日历；请手动核对。`};
      } catch(error) {
        const entry=this.sessions.get(id);
        if(entry?.page&&!entry.page.isClosed()){await entry.page.bringToFront().catch(()=>{});return {opened:true,ready:false,message:'网页已打开，自动登录或定位未完成：'+safeError(error)+'；可在窗口中手动继续。'};}
        this.sessions.delete(id);await entry?.browser.close().catch(()=>{});throw error;
      }
    });
  }
  async openPersonal(accountId,equipmentId) {
    const account=this.store.data.accounts.find(a=>a.id===accountId);
    const equipment=(this.store.data.config.equipments||[]).find(e=>e.equipmentId===equipmentId);
    if(!account)throw new Error('请先选择本人账号');if(!equipment)throw new Error('请选择预约设备');
    const id=`personal:${account.id}:${equipment.equipmentId}`;
    const action=this.run(id,async()=>{
      const existing=this.sessions.get(id);if(existing?.visible&&!existing.page?.isClosed()){await existing.page.bringToFront();return {opened:true,ready:true,message:'已打开预约日历'};}
      const date=require('./schedule-logic.cjs').shanghaiDate(this.clock()),job={id,accountId:account.id,date},target={job,account:structuredClone(account),rules:rulesFor(equipment)};
      if(!this.canRun(job))throw new Error('该账号正在执行预约，请稍后打开');
      try{const entry=await this.session(target,true);await this.week(entry.page,Date.parse(date+'T00:00:00+08:00')/1000);await entry.page.bringToFront();return {opened:true,ready:true,message:'已登录并打开预约日历'};}
      catch(error){const entry=this.sessions.get(id);if(entry?.page&&!entry.page.isClosed()){await entry.page.bringToFront().catch(()=>{});return {opened:true,ready:false,message:'预约网站已打开，请完成登录或选择设备：'+safeError(error)};}this.sessions.delete(id);await entry?.browser.close().catch(()=>{});throw error;}
    });
    this.pendingPersonal.set(id,account.id);try{return await action;}finally{this.pendingPersonal.delete(id);}
  }
  async close() {
    this.closed=true;clearInterval(this.timer);
    await Promise.allSettled([...this.sessions.values()].map(entry=>entry.browser.close()));
    await Promise.allSettled([...this.pending.values()]);this.sessions.clear();
  }
}
module.exports={Reviews,reviewPlan,INTERVAL};
