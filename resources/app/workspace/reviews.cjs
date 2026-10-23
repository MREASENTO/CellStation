'use strict';
const fs = require('node:fs'), path = require('node:path');
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
    this.sessions = new Map(); this.pending = new Map(); this.closed = false;
    for(const job of Object.values(store.data.jobs))if(job.review?.state==='checking')store.job(job,{review:{...job.review,state:'failed',checkedAt:clock(),message:'核对失败：上次核对被程序退出中断，已停止自动核对；可手动重试。'}});
  }
  get active() { return this.sessions.size + this.pending.size; }
  isAccountBusy(accountId) { return [...this.pending.keys()].some(id=>this.store.data.jobs[id]?.accountId===accountId)||[...this.sessions.values()].some(e=>!e.visible&&e.accountId===accountId); }
  target(id) {
    const job = this.store.data.jobs[id];
    if (!job || !['needs_review','failed','missed','already_exists','success'].includes(job.status)) throw new Error('该记录当前不需要核对');
    const account = this.store.data.accounts.find(a => a.id === job.accountId || (job.accountUsername && a.username === job.accountUsername));
    if (!account) throw new Error('原账号已移除，请从设置打开预约网站手动登录原账号核对；不会切换到其他账号');
    if (job.accountUsername && job.accountUsername !== account.username) throw new Error('当前账号与原预约账号不一致');
    reviewPlan(job);
    return { job: structuredClone(job), account: structuredClone(account), rules: rulesFor(job.equipment) };
  }
  start() { this.timer = setInterval(() => this.tick().catch(() => {}),1000); this.timer.unref?.(); }
  async tick() {
    if (this.closed || !this.store.data.config.enabled) return;
    for (const job of Object.values(this.store.data.jobs)) {
      if (job.status !== 'needs_review') continue;
      if (!job.review) {
        this.store.job(job,{ review: { state:'waiting', nextAt:this.clock()+INTERVAL, automatic:true, attempts:0 } });
        continue;
      }
      if (job.review.state === 'waiting' && job.review.nextAt <= this.clock() && !this.pending.size && ![...this.sessions.values()].some(e=>e.accountId===job.accountId) && this.canRun(job)) {
        try{await this.recheck(job.id,true);}catch(error){this.store.job(job,{review:{...job.review,state:'failed',checkedAt:this.clock(),message:'核对失败：'+safeError(error)+'；已停止自动核对。'}});}
      }
    }
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
      const target = this.target(id), { job } = target;
      if (['success','already_exists'].includes(job.status)) return {verified:true,message:'该预约已经确认，无需再次核对'};
      if (!this.canRun(job)) throw new Error('该账号正在准备或执行预约，请稍后核对');
      if (this.sessions.has(id)) throw new Error('该记录的核对网页已打开，请关闭后再由程序核对');
      const startedAt = this.clock();
      this.store.job(job,{review:{state:'checking',startedAt,automatic,attempts:(job.review?.attempts||0)+1}});
      try {
        const entry = await this.session(target,false), page=entry.page, plan=reviewPlan(job);
        const href=await page.locator('a.user').getAttribute('href');
        const userId=href?.match(/index[.](\d+)/)?.[1];if(!userId)throw new Error('无法确认登录身份，未更新预约结果');
        const rows=await this.components(page,plan.weekStart);
        const remark=job.remark||target.rules.remark;
        const match=rows.find(row=>String(row.content||'').includes(remark)&&assessComponents([row],plan,userId).duplicate);
        const checkedAt=this.clock(),review={state:match?'verified':'failed',automatic,attempts:(job.review?.attempts||0)+1,startedAt,checkedAt,durationMs:checkedAt-startedAt};
        const message=match?'复核已查到原账号、原设备、同时段及备注匹配的预约，未再次提交。':'核对失败：未查到匹配预约，已停止自动核对；可打开网页继续确认。未重复提交。';
        review.message=message;
        this.store.job(job,match?{status:'already_exists',reservationId:match.id,review,recheckedAt:checkedAt,message}:{review});
        return {verified:Boolean(match),message};
      } catch(error) {
        const message='核对失败：'+safeError(error)+'；已停止自动核对，可手动重试或打开网页。';
        const diagnosticId=await captureFailure(this.root,job,'recheck',error,this.sessions.get(id)?.page).catch(()=>undefined);
        this.store.job(job,{...(diagnosticId?{diagnosticId}:{}),review:{state:'failed',automatic,attempts:(job.review?.attempts||0)+1,startedAt,checkedAt:this.clock(),message}});
        return {verified:false,message};
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
  async close() {
    this.closed=true;clearInterval(this.timer);
    await Promise.allSettled([...this.sessions.values()].map(entry=>entry.browser.close()));
    await Promise.allSettled([...this.pending.values()]);this.sessions.clear();
  }
}
module.exports={Reviews,reviewPlan,INTERVAL};
