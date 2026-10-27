'use strict';
const { generateJobs, windowsFor, shanghaiDate, addDays } = require('./schedule-logic.cjs');
const { recorder } = require('./timeline.cjs');
const { slotKey } = require('./equipment.cjs');
const TERMINAL = new Set(['success', 'already_exists', 'failed', 'needs_review', 'missed']);
const retryable = error => /timeout|timed out|network|ERR_CONNECTION|ERR_NETWORK|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ECONNRESET|ETIMEDOUT|验证码|OCR|网络|超时/i.test(String(error?.message || error)) && !/占用|冲突|密码错误|账号.*锁定|无效|不匹配|尚未|暂停|超过|禁止.*重试|schema changed/i.test(String(error?.message || error));
const RECOVERY_INTERVAL = 5 * 60000;
const recoverable = error => /timeout|timed out|network|ERR_|ECONN|ETIMEDOUT|网络|超时|服务器|HTTP 5\d\d|登录未通过|登录准备已超过执行时间/i.test(String(error?.message || error)) && !/占用|冲突|密码错误|账号.*(锁定|禁用|不存在)|验证码\/OCR未通过|OCR 未返回|无效|不匹配|尚未|暂停|禁止.*重试|schema changed/i.test(String(error?.message || error));
const saveAttempted = job => Boolean(job?.savingAt || job?.timeline?.some(e => ['save_click','save_request'].includes(e.step)));
class Scheduler {
  constructor(store, worker, clock = Date.now) {
    this.store = store;
    this.worker = worker;
    this.clock = clock;
    this.busy = new Map();
    this.activeAccounts = new Map();
    this.prepared = new Map();
    this.timer = null;
    this.snapshots = new Map();
    this.releaseTimers = new Map();
    for(const job of Object.values(store.data.jobs))if(job.recovery?.state==='running'&&!['success','already_exists','needs_review'].includes(job.status)){const uncertain=saveAttempted(job);store.job(job,{status:uncertain?'needs_review':'failed',recovery:{...job.recovery,state:uncertain?'stopped':'waiting',nextAt:clock()+RECOVERY_INTERVAL}});}
  }
  plan(days = 7, includeDisabled = false, releaseDate = shanghaiDate(this.clock())) {
    const accounts = this.store.accounts();
    const existing = new Map(Object.values(this.store.data.jobs).map(j => [slotKey(j), j]));
    return generateJobs(this.store.data.config, accounts, releaseDate, days, true).map(job => {
      const record = existing.get(slotKey(job)) || this.store.data.jobs[this.store.data.equipmentReplacements?.[slotKey(job)]];
      if (record && record.id !== job.id) return { ...job, ...record, equipment: record.equipment || require('./equipment.cjs').defaultEquipment() };
      const mapping = this.store.assignment(job.date);
      const lockedId = this.store.data.bindings[`${job.date}|${job.windowId}`] || mapping[job.windowId];
      if (!lockedId) return { ...job, accountId: null, accountOwner: '', accountLabel: '未分配账号', available: false };
      const account = accounts.find(a => a.id === lockedId);
      const window = windowsFor(this.store.data.config, job.date).find(w => w.id === job.windowId);
      return { ...job, accountId: lockedId, accountLabel: account?.owner || account?.username || '账号不可用', accountOwner: account?.owner || '', available: Boolean(job.equipmentEnabled && window.enabled && account?.enabled && !job.skipped), locked: Boolean(this.store.data.bindings[`${job.date}|${job.windowId}`]), shuffled: true };
    }).filter(job => includeDisabled || job.available);
  }
  catchUpPlan(now) {
    const config=this.store.data.config,date=shanghaiDate(now),key=JSON.stringify([date,config.windows,config.dateWindows,config.equipments,config.exclusions,this.store.accounts(),this.store.data.assignmentRevision]);
    if(!this.catchUpCache||this.catchUpCache.key!==key||now-this.catchUpCache.at>=5000||now<this.catchUpCache.at)this.catchUpCache={key,at:now,jobs:this.plan(8,false,addDays(date,-7))};
    return this.catchUpCache.jobs.filter(j=>j.releaseAt<=now&&Date.parse(`${j.date}T${j.start}:00+08:00`)>now);
  }
  start() {
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, 200);
    return this.tick();
  }
  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.releaseTimers.values()) clearTimeout(timer); this.releaseTimers.clear();
    await Promise.allSettled([...this.busy.values()]);
    await this.worker.close();
  }
  async tick() {
    const config = this.store.data.config;
    if (!config.enabled) return;
    const now = this.clock();
    const normal=this.plan(2),late=config.catchUpEnabled===false?[]:this.catchUpPlan(now);
    const pending = new Map([...normal,...late].map(j => [j.id, j]));
    for (const [id, snapshot] of this.snapshots) pending.set(id, snapshot);
    for (const record of Object.values(this.store.data.jobs)) if (record.recovery?.state === 'waiting') pending.set(record.id,{...record});
    this.beforeJobs?.(now,[...pending.values()],this.store.data.jobs);
    const startedSlots = new Map(Object.values(this.store.data.jobs).map(j => [slotKey(j), j.id]));
    for (let job of pending.values()) {
      const slotId = startedSlots.get(slotKey(job));
      const occupied = slotId && slotId !== job.id;
      if (occupied && !this.snapshots.has(job.id)) continue;
      const record = this.store.data.jobs[job.id];
      if(config.catchUpEnabled===false&&record?.recovery?.origin==='catch-up'&&['waiting','running'].includes(record.recovery.state)){
        if(this.busy.has(job.id))continue;
        const wasPrepared=this.prepared.has(job.id);this.prepared.delete(job.id);this.snapshots.delete(job.id);
        this.store.job(job,{status:'skipped',recovery:{...record.recovery,state:'stopped',stopReason:'disabled'},message:'自动补尝试已关闭'});
        if(wasPrepared)this.launch(job,()=>this.worker.releaseSession?.(job.accountId,job.id));
        continue;
      }
      if(config.catchUpEnabled===false&&record?.recovery?.origin==='catch-up'&&record.recovery.stopReason==='disabled')continue;
      const overdue=job.releaseAt<=now&&(job.releaseAt<config.enabledAt||now>job.releaseAt+(job.runtime?.config||config).graceSeconds*1000);
      if(config.catchUpEnabled!==false&&overdue&&Date.parse(`${job.date}T${job.start}:00+08:00`)>now&&!this.busy.has(job.id)&&!record?.recovery?.state?.match(/^(waiting|running)$/)&&(!record||['queued','missed','retrying','ready'].includes(record.status)||(record.status==='skipped'&&record.recovery?.origin==='catch-up'&&record.recovery.stopReason==='disabled'))) {
        if(saveAttempted(record)){this.store.job(job,{status:'needs_review',message:'已有保存记录，正在核对预约结果'});continue;}
        if(record?.status==='retrying'&&now<record.retryAt)continue;
        const higher=normal.some(other=>other.id!==job.id&&other.accountId===job.accountId&&other.releaseAt>=now-60000&&other.releaseAt<=now+config.prewarmSeconds*1000+300000&&!TERMINAL.has(this.store.data.jobs[other.id]?.status)&&(other.releaseAt>job.releaseAt||(other.releaseAt===job.releaseAt&&other.equipmentOrder<job.equipmentOrder)));
        if(higher||[...this.activeAccounts.values()].includes(job.accountId)||this.externalBusy?.(job.accountId))continue;
        if(this.snapshots.has(job.id)&&!this.assignmentMatches(job)){this.launch(job,()=>this.discardPreparation(job));continue;}
        const wasPrepared=this.prepared.has(job.id);this.prepared.delete(job.id);this.snapshots.delete(job.id);
        job={...job,recovery:{state:'running',phase:'catch-up',origin:'catch-up',attempts:1}};
        this.store.job(job,{...job,status:'queued',recovery:job.recovery,retryAt:null,retryCount:0,message:'开放时间已过，正在核对网站并处理原计划'});
        if(wasPrepared){this.launch(job,async()=>{await this.worker.releaseSession?.(job.accountId,job.id);await this.prepare(job);});continue;}
      }
      if (record?.recovery?.state === 'waiting') {
        if (this.busy.has(job.id)) continue;
        const startsAt=Date.parse(`${job.date}T${job.start}:00+08:00`);
        const account=this.store.data.accounts.find(a=>a.id===job.accountId&&a.enabled);
        const equipment=(config.equipments||[config.equipment]).find(e=>e.equipmentId===(job.equipment?.equipmentId||37)&&e.enabled!==false);
        const stillAssigned=windowsFor(config,job.date).some(w=>w.id===job.windowId&&w.enabled)&&this.store.assignment(job.date)[job.windowId]===job.accountId;
        if (now >= startsAt || !account || !equipment || !stillAssigned || saveAttempted(record)) {
          this.store.job(job,{...(saveAttempted(record)?{status:'needs_review'}:{}),recovery:{...record.recovery,state:'stopped'},message:now>=startsAt?'已到原使用时段，停止网站恢复重试':!stillAssigned||!account||!equipment?'原计划配置已修改，停止网站恢复重试':'已进入保存阶段，停止补约并保留核对记录'});
          continue;
        }
        if (record.recovery.nextAt > now || [...this.activeAccounts.values()].includes(job.accountId) || this.externalBusy?.(job.accountId)) continue;
        const otherDue=[...pending.values()].some(other=>other.id!==job.id&&other.accountId===job.accountId&&other.releaseAt<=now+config.prewarmSeconds*1000&&!TERMINAL.has(this.store.data.jobs[other.id]?.status));
        if(otherDue)continue;
        this.snapshots.delete(job.id);
        job={...job,recovery:{...record.recovery,state:'running',attempts:(record.recovery.attempts||0)+1}};
        this.store.job(job,{status:'queued',recovery:job.recovery,retryAt:null,message:'网站恢复重试：重新登录，核对原计划后预约原时段'});
      }
      const recovering=this.store.data.jobs[job.id]?.recovery?.state==='running';
      if (TERMINAL.has(record?.status) && !recovering) { this.snapshots.delete(job.id); continue; }
      if (this.busy.has(job.id)) continue;
      if (this.snapshots.has(job.id) && !this.assignmentMatches(job)) {
        this.launch(job, () => this.discardPreparation(job));
        continue;
      }
      // A replaced task releases its account's browser before another slot uses it.
      if ([...this.activeAccounts].some(([id, accountId]) => id !== job.id && accountId === job.accountId)) continue;
      if (this.externalBusy?.(job.accountId)) continue;
      const taskConfig = job.runtime?.config || config;
      if (!recovering && job.releaseAt < config.enabledAt) {
        if (record) this.store.job(job, { status: 'missed', message: '上次任务已过期，重新启动后不补约' });
        continue;
      }
      if (record?.status === 'retrying' && now < record.retryAt) continue;
      if (now > this.deadline(job)) {
        this.prepared.delete(job.id);
        this.store.job(job, { status: 'missed', recovery:this.finishedRecovery(job,'stopped'), message: '已超过开放后的执行窗口，未补约' });
        this.launch(job, async () => { await this.worker.releaseSession?.(job.accountId, job.id); });
        continue;
      }
      if (record?.status === 'ready' && this.prepared.has(job.id) && now >= job.releaseAt) {
        if ([...pending.values()].some(other => other.id !== job.id && other.accountId === job.accountId && other.releaseAt === job.releaseAt && other.equipmentOrder < job.equipmentOrder && !TERMINAL.has(this.store.data.jobs[other.id]?.status))) continue;
        clearTimeout(this.releaseTimers.get(job.id)); this.releaseTimers.delete(job.id);
        this.launch(job, () => this.commit(job));
      } else if (now >= job.releaseAt - config.prewarmSeconds * 1000 && !this.prepared.has(job.id)) {
        this.launch(job, () => this.prepare(job));
      }
    }
  }
  launch(job, action) {
    this.activeAccounts.set(job.id, job.accountId);
    const promise = Promise.resolve().then(action).finally(() => { this.busy.delete(job.id); this.activeAccounts.delete(job.id); });
    this.busy.set(job.id, promise);
  }
  snapshot(job) {
    if (this.snapshots.has(job.id)) return this.snapshots.get(job.id);
    const task = { ...job };
    task.accountUsername ||= this.store.data.accounts.find(a=>a.id===job.accountId)?.username;
    const account = this.store.data.accounts.find(a => a.id === job.accountId);
    if (!account) throw new Error('账号不存在');
    Object.defineProperty(task, 'runtime', { value: { config: structuredClone(this.store.data.config), account: structuredClone(account), manualRevision: this.store.data.dailyAssignments[job.date]?.manualRevision || 0 } });
    Object.defineProperty(task, 'onStep', { value: recorder(this.store, task, this.clock) });
    this.snapshots.set(task.id, task);
    return task;
  }
  assignmentMatches(job) {
    const plan = this.store.data.dailyAssignments[job.date];
    if (!job.runtime || (plan?.manualRevision || 0) === job.runtime.manualRevision) return true;
    return Boolean(windowsFor(this.store.data.config, job.date).find(w => w.id === job.windowId)?.enabled && this.store.assignment(job.date)[job.windowId] === job.accountId);
  }
  async discardPreparation(job) {
    this.prepared.delete(job.id);
    clearTimeout(this.releaseTimers.get(job.id)); this.releaseTimers.delete(job.id);
    // Keep the snapshot until closing finishes so another slot cannot reuse this session.
    await this.worker.releaseSession?.(job.accountId, job.id);
    this.snapshots.delete(job.id);
    const record = this.store.data.jobs[job.id];
    if (record && !TERMINAL.has(record.status) && record.status !== 'saving') this.store.job(job, { status: 'queued', retryAt: null, message: '手动分配已修改，旧准备任务已撤下；按新分配处理尚未保存的时段' });
  }
  async prepare(job) {
    job = this.snapshot(job);
    const otherWindow = Object.entries(this.store.data.bindings).some(([key, accountId]) => key.startsWith(job.date + '|') && key !== `${job.date}|${job.windowId}` && accountId === job.accountId);
    if (otherWindow) {
      this.store.job(job, { status: 'failed', recovery:this.finishedRecovery(job,'stopped'), message: '该账号当天已锁定另一个两小时窗口，未跨窗口加约' });
      return;
    }
    this.store.data.bindings[`${job.date}|${job.windowId}`] ||= job.accountId;
    const attempts = (this.store.data.jobs[job.id]?.prepareAttempts || 0) + 1;
    this.store.job(job, { ...job, status: 'preparing', prepareAttempts: attempts, message: `正在提前登录并定位预约页面（第${attempts}次准备）` });
    try {
      job.onStep?.('prepare_start', '准备任务：配置与账号已固定');
      const result = await this.worker.prepare(job);
      if (!this.assignmentMatches(job)) { await this.discardPreparation(job); return; }
      if(this.store.data.config.catchUpEnabled===false&&this.store.data.jobs[job.id]?.recovery?.origin==='catch-up'){this.store.job(job,{status:'skipped',recovery:{...this.store.data.jobs[job.id].recovery,state:'stopped',stopReason:'disabled'},message:'自动补尝试已关闭'});await this.worker.releaseSession?.(job.accountId,job.id);return;}
      if (result.alreadyExists) {
        this.store.job(job, { status: 'already_exists', recovery:this.finishedRecovery(job), reservationId: result.reservationId, message: '网站已有相同预约，未重复提交' });
      } else if (!this.store.data.config.enabled) {
        this.store.job(job, { status: 'queued', recovery:this.pausedRecovery(job), message: '调度已暂停，未提交' });
        await this.worker.releaseSession?.(job.accountId, job.id);
      } else {
        // Preparation started inside its normal window, but a slow site may only
        // become ready later. The original slot still has to be in the future.
        if(this.clock()>this.deadline(job)&&!saveAttempted(this.store.data.jobs[job.id])&&this.clock()<Date.parse(`${job.date}T${job.start}:00+08:00`))this.store.job(job,{recovery:{state:'running',attempts:1,phase:'late-preparation'},message:'页面已恢复，核对原计划后预约原时段'});
        this.prepared.set(job.id, true);
        if (this.timer && !this.releaseTimers.has(job.id)) {
          const timer = setTimeout(() => { this.releaseTimers.delete(job.id); this.tick().catch(() => {}); }, Math.max(0, job.releaseAt - this.clock()));
          timer.unref?.(); this.releaseTimers.set(job.id, timer);
        }
        job.onStep?.('ready', '已就绪，等待开放');
        this.store.job(job, { status: 'ready', message: '已登录并预选目标时间，等待开放后打开表单、核对并提交' });
      }
    } catch (error) {
      if (!this.assignmentMatches(job)) { await this.discardPreparation(job); return; }
      if(this.store.data.config.catchUpEnabled===false&&this.store.data.jobs[job.id]?.recovery?.origin==='catch-up'){this.store.job(job,{status:'skipped',recovery:{...this.store.data.jobs[job.id].recovery,state:'stopped',stopReason:'disabled'},message:'自动补尝试已关闭'});await this.worker.releaseSession?.(job.accountId,job.id);return;}
      if (!this.store.data.config.enabled) { this.store.job(job, { status: 'queued', recovery:this.pausedRecovery(job), diagnosticId: error.diagnosticId, message: '调度已暂停，未提交' }); return; }
      if(error.code==='OWNERSHIP_UNCERTAIN'){this.store.job(job,{status:'needs_review',recovery:this.finishedRecovery(job,'stopped'),diagnosticId:error.diagnosticId,message:error.message});return;}
      if (this.retry(job, error, 'prepare')) return;
      if (this.deferRecovery(job,error,'prepare')) return;
      this.store.job(job, { status: 'failed', recovery:this.finishedRecovery(job,'stopped'), diagnosticId: error.diagnosticId, message: String(error.message).slice(0, 800) });
      this.store.event('error', `${job.date} ${job.start} · ${job.accountLabel} · 准备失败，请查看执行记录`);
    }
  }
  async commit(job) {
    try {
      if (!this.store.data.config.enabled) return;
      if (!this.assignmentMatches(job)) { await this.discardPreparation(job); return; }
      if (this.clock() > this.deadline(job)) {
        this.store.job(job, { status: 'missed', recovery:this.finishedRecovery(job,'stopped'), message: '准备耗时过长，未补约' });
        return;
      }
      job.onStep?.('release_reached', '已到开放时间，开始填写与提交');
      const result = await this.worker.commit(job, () => {
        if (!this.store.data.config.enabled) throw new Error('调度已暂停，保存未执行');
        if(this.store.data.config.catchUpEnabled===false&&this.store.data.jobs[job.id]?.recovery?.origin==='catch-up'){const error=new Error('自动补尝试已关闭');error.code='CATCH_UP_DISABLED';throw error;}
        if (!this.assignmentMatches(job)) { const error = new Error('手动分配已修改，旧任务未保存'); error.code = 'ASSIGNMENT_CHANGED'; throw error; }
        const savingAt = this.clock();
        if (savingAt < job.releaseAt) throw new Error('尚未到开放时刻');
        if (savingAt > this.deadline(job)) throw new Error('已超过执行窗口');
        this.store.job(job, { status: 'saving', savingAt, delayMs: savingAt - job.releaseAt, message: '正在提交一次预约' });
      });
      const status = result.status === 'already_exists' ? 'already_exists' : 'success';
      const confirmedAt = result.confirmedAt || (result.verifiedAt ? Date.parse(result.verifiedAt) : this.clock());
      job.onStep?.('result_confirmed', status === 'success' ? '读回网站记录并核实成功' : '网站已有相同预约');
      const savingAt = this.store.data.jobs[job.id]?.savingAt;
      this.store.job(job, { status, recovery:this.finishedRecovery(job), confirmedAt, verifiedAt: new Date(confirmedAt).toISOString(), confirmationDelayMs: confirmedAt - job.releaseAt, submissionToConfirmationMs: savingAt ? confirmedAt - savingAt : null, reservationId: result.reservationId, message: status === 'success' ? '网站已确认预约成功' : '网站已有相同预约，未重复提交' });
      this.store.event('result', `${job.date} ${job.start}–${job.end} · ${job.accountLabel} · ${status === 'success' ? '预约成功' : '已存在'}`);
    } catch (error) {
      const uncertain = this.store.data.jobs[job.id]?.status === 'saving';
      if(!uncertain&&error.code==='CATCH_UP_DISABLED'){this.store.job(job,{status:'skipped',recovery:{...this.store.data.jobs[job.id].recovery,state:'stopped',stopReason:'disabled'},message:'自动补尝试已关闭'});return;}
      if (!uncertain && !this.assignmentMatches(job)) { await this.discardPreparation(job); return; }
      if (!uncertain && !this.store.data.config.enabled) { this.store.job(job, { status: 'queued', recovery:this.pausedRecovery(job), message: '调度已暂停，保存未执行' }); return; }
      if (!uncertain&&error.code==='OWNERSHIP_UNCERTAIN'){this.store.job(job,{status:'needs_review',recovery:this.finishedRecovery(job,'stopped'),diagnosticId:error.diagnosticId,message:error.message});return;}
      if (!uncertain && this.retry(job, error, 'commit')) return;
      if (!uncertain && this.deferRecovery(job,error,'commit')) return;
      this.store.job(job, { status: uncertain ? 'needs_review' : 'failed', recovery:this.finishedRecovery(job,'stopped'), diagnosticId: error.diagnosticId, message: uncertain ? `保存结果需复核，程序将立即查询并按设置间隔再查一次，不重复提交预约。${String(error.message).slice(0, 650)}` : String(error.message).slice(0, 800) });
      this.store.event('error', `${job.date} ${job.start} · ${job.accountLabel} · ${uncertain ? '保存结果需复核，程序将立即查询' : '执行未完成'}`);
    } finally { this.prepared.delete(job.id); await this.worker.releaseSession?.(job.accountId, job.id); }
  }
  retry(job, error, phase) {
    const record = this.store.data.jobs[job.id];
    if (record?.recovery?.state==='running'&&record.recovery.phase!=='catch-up') return false;
    const count = record?.retryCount || 0;
    const maxRetries = (job.runtime?.config || this.store.data.config).retryPolicy?.taskRetries ?? 2;
    const retryAt = this.clock() + (count ? 5000 : 2000);
    if (error.retryable === false || !retryable(error) || count >= maxRetries || !this.store.data.config.enabled || retryAt > this.deadline(job)) return false;
    this.prepared.delete(job.id);
    this.store.job(job, { status: 'retrying', retryAt, retryCount: count + 1, retryLimit: maxRetries, retryPhase: phase, diagnosticId: error.diagnosticId, message: `保存前遇到短暂错误，将有限重试（${count + 1}/${maxRetries}）` });
    this.store.event('retry', `${job.date} ${job.start} · ${job.accountLabel} · 保存前有限重试${count + 1}/${maxRetries}`);
    return true;
  }
  deadline(job) {
    return this.store.data.jobs[job.id]?.recovery?.state==='running' ? Date.parse(`${job.date}T${job.start}:00+08:00`)-1 : job.releaseAt+(job.runtime?.config||this.store.data.config).graceSeconds*1000;
  }
  pausedRecovery(job) { const value=this.store.data.jobs[job.id]?.recovery;return value?{...value,state:'waiting',nextAt:this.clock()+RECOVERY_INTERVAL}:undefined; }
  finishedRecovery(job,state='completed') { const value=this.store.data.jobs[job.id]?.recovery;return value?{...value,state}:undefined; }
  deferRecovery(job,error,phase) {
    const record=this.store.data.jobs[job.id],nextAt=this.clock()+RECOVERY_INTERVAL;
    if(!this.store.data.config.enabled||!recoverable(error)||saveAttempted(record)||nextAt>=Date.parse(`${job.date}T${job.start}:00+08:00`))return false;
    const recovery={...record?.recovery,state:'waiting',nextAt,phase,attempts:record?.recovery?.attempts||0};
    this.store.job(job,{status:'failed',recovery,diagnosticId:error.diagnosticId,message:`网站或登录暂不可用，5分钟后重新登录并按原计划预约原时段。${String(error.message).slice(0,400)}`});
    // An unavailable account is probed once per five minutes, even with several overdue slots.
    for(const other of Object.values(this.store.data.jobs))if(other.id!==job.id&&other.accountId===job.accountId&&other.recovery?.state==='waiting'&&other.recovery.nextAt<nextAt)this.store.job(other,{recovery:{...other.recovery,nextAt}});
    return true;
  }
  async pausePrepared() {
    for (const timer of this.releaseTimers.values()) clearTimeout(timer); this.releaseTimers.clear();
    for (const id of [...this.prepared.keys()]) {
      if (this.busy.has(id)) continue;
      const job = this.store.data.jobs[id];
      this.prepared.delete(id);
      await this.worker.releaseSession?.(job.accountId, job.id);
      this.snapshots.delete(id);
      if (job.status === 'ready') this.store.job(job, { status: 'queued', recovery:this.pausedRecovery(job), message: '调度已暂停，后台页面已关闭' });
    }
  }
  async idle() { await Promise.allSettled([...this.busy.values()]); }
}
module.exports = { Scheduler, TERMINAL, retryable, recoverable, saveAttempted, RECOVERY_INTERVAL };
