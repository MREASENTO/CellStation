'use strict';
const { generateJobs, windowsFor, shanghaiDate } = require('./schedule-logic.cjs');
const { recorder } = require('./timeline.cjs');
const { slotKey } = require('./equipment.cjs');
const TERMINAL = new Set(['success', 'already_exists', 'failed', 'needs_review', 'missed']);
const retryable = error => /timeout|timed out|network|ERR_CONNECTION|ERR_NETWORK|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ECONNRESET|ETIMEDOUT|验证码|OCR|网络|超时/i.test(String(error?.message || error)) && !/占用|冲突|密码错误|账号.*锁定|无效|不匹配|尚未|暂停|超过|禁止.*重试|schema changed/i.test(String(error?.message || error));
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
  }
  plan(days = 7, includeDisabled = false) {
    const accounts = this.store.accounts();
    const existing = new Map(Object.values(this.store.data.jobs).map(j => [slotKey(j), j]));
    return generateJobs(this.store.data.config, accounts, shanghaiDate(this.clock()), days, true).map(job => {
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
    const pending = new Map(this.plan(2).map(j => [j.id, j]));
    for (const [id, snapshot] of this.snapshots) pending.set(id, snapshot);
    const startedSlots = new Map(Object.values(this.store.data.jobs).map(j => [slotKey(j), j.id]));
    for (let job of pending.values()) {
      const slotId = startedSlots.get(slotKey(job));
      const occupied = slotId && slotId !== job.id;
      if (occupied && !this.snapshots.has(job.id)) continue;
      const record = this.store.data.jobs[job.id];
      if (TERMINAL.has(record?.status)) { this.snapshots.delete(job.id); continue; }
      if (this.busy.has(job.id)) continue;
      if (this.snapshots.has(job.id) && !this.assignmentMatches(job)) {
        this.launch(job, () => this.discardPreparation(job));
        continue;
      }
      // A replaced task releases its account's browser before another slot uses it.
      if ([...this.activeAccounts].some(([id, accountId]) => id !== job.id && accountId === job.accountId)) continue;
      const taskConfig = job.runtime?.config || config;
      if (job.releaseAt < config.enabledAt) {
        if (record) this.store.job(job, { status: 'missed', message: '上次任务已过期，重新启动后不补约' });
        continue;
      }
      if (record?.status === 'retrying' && now < record.retryAt) continue;
      if (now > job.releaseAt + taskConfig.graceSeconds * 1000) {
        this.prepared.delete(job.id);
        this.store.job(job, { status: 'missed', message: '已超过开放后的执行窗口，未补约' });
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
      this.store.job(job, { status: 'failed', message: '该账号当天已锁定另一个两小时窗口，未跨窗口加约' });
      return;
    }
    this.store.data.bindings[`${job.date}|${job.windowId}`] ||= job.accountId;
    const attempts = (this.store.data.jobs[job.id]?.prepareAttempts || 0) + 1;
    this.store.job(job, { ...job, status: 'preparing', prepareAttempts: attempts, message: `正在提前登录并定位预约页面（第${attempts}次准备）` });
    try {
      job.onStep?.('prepare_start', '准备任务：配置与账号已固定');
      const result = await this.worker.prepare(job);
      if (!this.assignmentMatches(job)) { await this.discardPreparation(job); return; }
      if (result.alreadyExists) {
        this.store.job(job, { status: 'already_exists', reservationId: result.reservationId, message: '网站已有相同预约，未重复提交' });
      } else if (!this.store.data.config.enabled) {
        this.store.job(job, { status: 'queued', message: '调度已暂停，未提交' });
        await this.worker.releaseSession?.(job.accountId, job.id);
      } else {
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
      if (!this.store.data.config.enabled) { this.store.job(job, { status: 'queued', diagnosticId: error.diagnosticId, message: '调度已暂停，未提交' }); return; }
      if (this.retry(job, error, 'prepare')) return;
      this.store.job(job, { status: 'failed', diagnosticId: error.diagnosticId, message: String(error.message).slice(0, 800) });
      this.store.event('error', `${job.date} ${job.start} · ${job.accountLabel} · 准备失败，请查看执行记录`);
    }
  }
  async commit(job) {
    try {
      if (!this.store.data.config.enabled) return;
      if (!this.assignmentMatches(job)) { await this.discardPreparation(job); return; }
      if (this.clock() > job.releaseAt + (job.runtime?.config || this.store.data.config).graceSeconds * 1000) {
        this.store.job(job, { status: 'missed', message: '准备耗时过长，未补约' });
        return;
      }
      job.onStep?.('release_reached', '已到开放时间，开始填写与提交');
      const result = await this.worker.commit(job, () => {
        if (!this.store.data.config.enabled) throw new Error('调度已暂停，保存未执行');
        if (!this.assignmentMatches(job)) { const error = new Error('手动分配已修改，旧任务未保存'); error.code = 'ASSIGNMENT_CHANGED'; throw error; }
        const savingAt = this.clock();
        if (savingAt < job.releaseAt) throw new Error('尚未到开放时刻');
        if (savingAt > job.releaseAt + (job.runtime?.config || this.store.data.config).graceSeconds * 1000) throw new Error('已超过执行窗口');
        this.store.job(job, { status: 'saving', savingAt, delayMs: savingAt - job.releaseAt, message: '正在提交一次预约' });
      });
      const status = result.status === 'already_exists' ? 'already_exists' : 'success';
      const confirmedAt = result.confirmedAt || (result.verifiedAt ? Date.parse(result.verifiedAt) : this.clock());
      job.onStep?.('result_confirmed', status === 'success' ? '读回网站记录并核实成功' : '网站已有相同预约');
      const savingAt = this.store.data.jobs[job.id]?.savingAt;
      this.store.job(job, { status, confirmedAt, verifiedAt: new Date(confirmedAt).toISOString(), confirmationDelayMs: confirmedAt - job.releaseAt, submissionToConfirmationMs: savingAt ? confirmedAt - savingAt : null, reservationId: result.reservationId, message: status === 'success' ? '网站已确认预约成功' : '网站已有相同预约，未重复提交' });
      this.store.event('result', `${job.date} ${job.start}–${job.end} · ${job.accountLabel} · ${status === 'success' ? '预约成功' : '已存在'}`);
    } catch (error) {
      const uncertain = this.store.data.jobs[job.id]?.status === 'saving';
      if (!uncertain && !this.assignmentMatches(job)) { await this.discardPreparation(job); return; }
      if (!uncertain && !this.store.data.config.enabled) { this.store.job(job, { status: 'queued', message: '调度已暂停，保存未执行' }); return; }
      if (!uncertain && this.retry(job, error, 'commit')) return;
      this.store.job(job, { status: uncertain ? 'needs_review' : 'failed', diagnosticId: error.diagnosticId, message: uncertain ? `保存结果需核对，不会自动重试。${String(error.message).slice(0, 650)}` : String(error.message).slice(0, 800) });
      this.store.event('error', `${job.date} ${job.start} · ${job.accountLabel} · ${uncertain ? '保存结果需人工核对' : '执行未完成'}`);
    } finally { this.prepared.delete(job.id); await this.worker.releaseSession?.(job.accountId, job.id); }
  }
  retry(job, error, phase) {
    const record = this.store.data.jobs[job.id];
    const count = record?.retryCount || 0;
    const maxRetries = (job.runtime?.config || this.store.data.config).retryPolicy?.taskRetries ?? 2;
    const retryAt = this.clock() + (count ? 5000 : 2000);
    if (error.retryable === false || !retryable(error) || count >= maxRetries || !this.store.data.config.enabled || retryAt > job.releaseAt + (job.runtime?.config || this.store.data.config).graceSeconds * 1000) return false;
    this.prepared.delete(job.id);
    this.store.job(job, { status: 'retrying', retryAt, retryCount: count + 1, retryLimit: maxRetries, retryPhase: phase, diagnosticId: error.diagnosticId, message: `保存前遇到短暂错误，将有限重试（${count + 1}/${maxRetries}）` });
    this.store.event('retry', `${job.date} ${job.start} · ${job.accountLabel} · 保存前有限重试${count + 1}/${maxRetries}`);
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
      if (job.status === 'ready') this.store.job(job, { status: 'queued', message: '调度已暂停，后台页面已关闭' });
    }
  }
  async idle() { await Promise.allSettled([...this.busy.values()]); }
}
module.exports = { Scheduler, TERMINAL, retryable };
