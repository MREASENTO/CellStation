'use strict';
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { automaticLogin } = require('./auto-login.cjs');
const { openEquipment, ensureWeek, calendarComponents } = require('./reservation.cjs');
const { rulesFor } = require('./equipment.cjs');
const { validDate } = require('./schedule-logic.cjs');
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
  constructor(store, root, { clock = Date.now, canRun = () => true, launch, login = automaticLogin, open = openEquipment, week = ensureWeek, components = calendarComponents } = {}) {
    Object.assign(this, { store, root, clock, canRun, login, open, week, components });
    this.launch = launch || (options => require('playwright').chromium.launch(options));
    this.sessions = new Map(); this.pending = new Map(); this.pendingPersonal = new Map(); this.closed = false;
    for(const job of Object.values(store.data.jobs)) {
      if(job.status!=='needs_review')continue;
      if(job.review?.protocol===2&&job.review.state==='checking')store.job(job,{review:{...job.review,state:'waiting',nextAt:clock(),message:'上次复核中断，恢复未完成的查询轮次；不会重复提交预约。'}});
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
  intervalMs() { return (this.store.data.config.reviewPolicy?.retryIntervalMinutes||5)*60000; }
  observe(job) {
    job=this.store.data.jobs[job.id]||job;
    if(job.status!=='needs_review'||job.review?.protocol===2)return job;
    const history=job.review?.checkedAt?[{stage:'legacy',checkedAt:job.review.checkedAt,message:job.review.message||'旧版复核记录'}]:[];
    const record=this.store.job(job,{review:{protocol:2,cycleId:randomUUID(),state:'waiting',stage:'immediate',nextAt:this.clock(),automatic:true,autoAttempts:0,attempts:job.review?.attempts||0,history,message:'等待立即复核；查询原账号、原设备和原时段，不会再次提交预约。'}});
    this.nudge();return record;
  }
  nudge() { if(this.started&&!this.nudgePending){this.nudgePending=true;queueMicrotask(()=>{this.nudgePending=false;this.tick().catch(()=>{});});} }
  reschedule() {
    for(const job of Object.values(this.store.data.jobs))if(job.status==='needs_review'&&job.review?.protocol===2&&job.review.state==='waiting'&&job.review.stage==='delayed') {
      const nextAt=job.review.scheduledFrom+this.intervalMs();
      if(nextAt!==job.review.nextAt)this.store.job(job,{review:{...job.review,nextAt,intervalMinutes:this.intervalMs()/60000,message:`首次复核未确认；已按当前设置安排再次复核，间隔${this.intervalMs()/60000}分钟。`}});
    }
    this.nudge();
  }
  start() { this.started=true;this.timer = setInterval(() => this.tick().catch(() => {}),1000); this.timer.unref?.();this.nudge(); }
  async tick() {
    if (this.ticking || this.closed || !this.store.data.config.enabled) return;
    this.ticking=true;
    try { for (const item of Object.values(this.store.data.jobs)) {
      if (item.status !== 'needs_review') continue;
      const job=this.observe(item);
      if (job.review.state === 'waiting' && job.review.nextAt <= this.clock() && !this.pending.size && ![...this.sessions.values()].some(e=>e.accountId===job.accountId) && this.canRun(job)) {
        try{await this.recheck(job.id,true);}catch(error){const stage=job.review.autoAttempts?'delayed':'immediate';this.finish(job,null,safeError(error),true,stage,this.clock(),'error');}
      }
    }} finally { this.ticking=false; }
  }
  finish(job,match,detail,automatic,stage,startedAt,outcome='not_found') {
    const base=job.review||{},inFlow=job.status==='needs_review'&&base.protocol===2,checkedAt=this.clock();
    const autoAttempts=inFlow?Math.max(base.autoAttempts||0,stage==='immediate'?1:stage==='delayed'?2:0):0;
    const waiting=inFlow&&!match&&autoAttempts<2,manualRequired=inFlow&&!match&&!waiting;
    const message=match?'复核确认该设备时段已有本团队账号的预约。':waiting?`首次复核未确认：${detail}；将在${this.intervalMs()/60000}分钟后再次复核。` :manualRequired?`再次复核失败：${detail}。已停止自动复核，请你自主复核。`:`本次复核未确认：${detail}；可手动再查或打开网页。`;
    const history=[...(base.history||[]),{stage,automatic,startedAt,checkedAt,durationMs:checkedAt-startedAt,outcome:match?'verified':outcome,message}].slice(-30);
    const review={...base,state:match?'verified':waiting?'waiting':'failed',stage:waiting?'delayed':'finished',automatic,attempts:(base.attempts||0)+1,autoAttempts,manualRequired,notice:waiting?'retry_scheduled':manualRequired?'manual_required':undefined,startedAt,checkedAt,durationMs:checkedAt-startedAt,history,message,nextAt:waiting?checkedAt+this.intervalMs():null};
    if(stage==='immediate')review.firstCheckedAt=checkedAt;
    if(stage==='delayed')review.delayedCheckedAt=checkedAt;
    if(waiting)Object.assign(review,{scheduledFrom:checkedAt,intervalMinutes:this.intervalMs()/60000});
    this.store.job(job,match?{status:'already_exists',reservationId:match.id,review,recheckedAt:checkedAt,message}:{review});
    return {verified:Boolean(match),manualRequired,message};
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
  async recheck(id, automatic = false) {
    return this.run(id,async()=>{
      const current=this.store.data.jobs[id];if(current)this.observe(current);
      const target = this.target(id), { job } = target;
      if (['success','already_exists'].includes(job.status)) return {verified:true,message:'该预约已经确认，无需再次核对'};
      if(automatic&&(job.review?.autoAttempts||0)>=2)return {verified:false,manualRequired:true,message:'两轮自动复核已结束，请自主复核。'};
      if (!this.canRun(job)) throw new Error('该账号正在准备或执行预约，请稍后核对');
      if (this.sessions.has(id)) throw new Error('该记录的核对网页已打开，请关闭后再由程序核对');
      const startedAt = this.clock();
      const stage=job.review?.protocol===2&&job.status==='needs_review'?job.review.autoAttempts===0?'immediate':job.review.autoAttempts===1?'delayed':'manual':'manual';
      this.store.job(job,{review:{...job.review,state:'checking',startedAt,automatic,inFlightStage:stage}});
      try {
        const entry = await this.session(target,false), page=entry.page, plan=reviewPlan(job);
        const href=await page.locator('a.user').getAttribute('href');
        const userId=href?.match(/index[.](\d+)/)?.[1];if(!userId)throw new Error('无法确认登录身份，未更新预约结果');
        const identity=require('./site-identity.cjs');identity.recordIdentity(this.store,target.account.id,userId,target.account);
        const rows=await this.components(page,plan.weekStart);
        const match=identity.coveringOurs(rows,plan,[userId,...identity.knownIdentities(this.store).map(a=>a.profileId)],this.store.data.config.teamMembers||[]);
        return this.finish(job,match,'未查到匹配预约',automatic,stage,startedAt);
      } catch(error) {
        const diagnosticId=await captureFailure(this.root,job,'recheck',error,this.sessions.get(id)?.page).catch(()=>undefined);
        if(diagnosticId)this.store.job(job,{diagnosticId});
        return this.finish(job,null,safeError(error),automatic,stage,startedAt,'error');
      } finally {
        const entry=this.sessions.get(id);this.sessions.delete(id);await entry?.browser.close().catch(()=>{});
      }
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
