'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { automaticLogin } = require('./auto-login.cjs');
const { openEquipment, warmSlot, preflightBooking, prepareBooking, commitBooking } = require('./reservation.cjs');
const { rulesFor, catalogue, verifyTarget } = require('./equipment.cjs');
const { captureFailure, safeError } = require('./support-files.cjs');
class BrowserWorker {
  constructor(store, root) {
    this.store = store;
    this.root = root;
    this.work = path.join(root, 'work');
    this.sessions = new Map();
    this.browser = null;
    this.launching = null;
    this.contexts = new Set();
    this.closing = null;
    this.closed = false;
    this.bookingApi = { prepareBooking, preflightBooking, commitBooking };
  }
  async getBrowser() {
    if (this.closed) throw new Error('程序正在退出，未启动浏览器');
    if (this.closing) await this.closing;
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) this.launching = require('playwright').chromium.launch({ channel: 'chrome', headless: true, args: ['--no-first-run', '--no-default-browser-check', '--disable-save-password-bubble'] }).then(browser => { this.browser = browser; return browser; }).finally(() => { this.launching = null; });
    return this.launching;
  }
  async session(accountId, separate = false, fresh = false, job = null) {
    const sessionKey = job?.id || accountId;
    const existing = this.sessions.get(sessionKey);
    const revision = this.store.data.accounts.find(a => a.id === accountId)?.revision || 0;
    if (!fresh && !separate && existing && existing.revision === revision && !existing.page.isClosed() && !await existing.page.locator('input[type="password"]:visible').count()) return existing;
    if (existing && !separate) { await existing.context.close().catch(() => {}); this.contexts.delete(existing.context); this.sessions.delete(sessionKey); }
    const browser = await this.getBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: false });
    this.contexts.add(context);
    let page;
    try {
      job?.onStep?.('browser_open', '无界面浏览器已启动');
      page = await context.newPage();
      await page.goto('https://healthlab.zs-hospital.sh.cn/cf/main/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
      job?.onStep?.('login_page', '登录页面已加载');
      let credentials = await this.store.credentials(accountId, job?.runtime?.account);
      try {
        await automaticLogin(page, credentials.username, credentials.password, this.work, {
          onStep: job?.onStep, captchaRetries: (job?.runtime?.config || this.store.data.config).retryPolicy?.captchaRetries ?? 2,
          deadline: job ? job.releaseAt + (job.runtime?.config || this.store.data.config).graceSeconds * 1000 : Date.now() + 90000,
        });
      }
      finally { credentials.password = undefined; credentials = undefined; }
      const session = { context, page, revision, accountId };
      if (!separate) this.sessions.set(sessionKey, session);
      return session;
    } catch (error) { await this.capture(job, 'login', error, page); await context.close().catch(() => {}); this.contexts.delete(context); await this.closeIdle(); throw error; }
  }
  async prepare(job) {
    // Each half-hour job starts a fresh authenticated context, avoiding unknown
    // website session expiry between jobs while preserving the same account id.
    let page;
    try {
      ({ page } = await this.session(job.accountId, false, true, job));
      if (!new URL(page.url()).pathname.includes(`index.${job.equipment?.equipmentId || 37}.reserv`)) {
        const rules = rulesFor(job.equipment);
        await openEquipment(page, rules);
      }
      job.onStep?.('equipment_open', '目标仪器日历已加载');
      // A prior failed or paused form must not be reused for another slot.
      const cancel = page.locator('.dialog_block:visible input[name="cancel"]');
      if (await cancel.count()) await cancel.click();
      const result = await preflightBooking(page, { date: job.date, start: job.start, end: job.end }, { allowBeforeRelease: true, rules: rulesFor(job.equipment), onStep: job.onStep });
      if (result.alreadyExists) await this.releaseSession(job.accountId, job.id);
      else { const session = (this.sessions.get(job.id) || this.sessions.get(job.accountId)); session.preflight = result; await warmSlot(page, job.date, job.start); job.onStep?.('slot_warmed', '目标时间已提前预选，双击事件已准备；尚未打开表单或保存'); }
      return result;
    } catch (error) { await this.capture(job, 'prepare', error, page); await this.releaseSession(job.accountId, job.id); throw error; }
  }
  async commit(job, beforeSave) {
    const session = (this.sessions.get(job.id) || this.sessions.get(job.accountId));
    if (!session || session.page.isClosed()) throw new Error('账号浏览器会话已关闭，未保存');
    try {
      const request = { date: job.date, start: job.start, end: job.end };
      let prepared;
      for (;;) {
        if (this.store.data.config.enabled === false) throw new Error('调度已暂停，保存未执行');
        try { prepared = await this.bookingApi.prepareBooking(session.page, request, { rules: rulesFor(job.equipment), preflight: session.preflight, onStep: job.onStep }); break; }
        catch (error) {
          if (error.code !== 'WEBSITE_REJECTED') throw error;
          const config = job.runtime?.config || this.store.data.config;
          if (/最早提前|尚未开放|未到.*开放/.test(error.message) && Date.now() >= job.releaseAt) {
            const count = this.store.data.jobs?.[job.id]?.retryCount || 0, limit = config.retryPolicy?.taskRetries ?? 2;
            const delay = Math.min(1000, (count + 1) * 500), deadline = job.releaseAt + config.graceSeconds * 1000;
            if (count >= limit || Date.now() + delay >= deadline) { error.retryable = false; throw error; }
            this.store.job(job, { retryCount: count + 1, retryLimit: limit, message: `等待服务器开放（额外重试${count + 1}/${limit}）；尚未保存` });
            job.onStep?.('server_release_wait', '服务器暂未开放，按配置短暂等待；与任务重试共用次数');
            await session.page.waitForTimeout(delay); continue;
          }
          // Reconcile a booking that appeared while waiting, without another save.
          const assessment = await this.bookingApi.preflightBooking(session.page, request, { rules: rulesFor(job.equipment), onStep: job.onStep });
          if (assessment.alreadyExists) return { status: 'already_exists', reservationId: assessment.reservationId };
          throw error;
        }
      }
      if (prepared.alreadyExists) return { status: 'already_exists', reservationId: prepared.reservationId };
      return await this.bookingApi.commitBooking(session.page, request, { beforeSave, expectedUserId: session.preflight?.userId, rules: rulesFor(job.equipment), onStep: job.onStep });
    } catch (error) { await this.capture(job, 'commit', error, session.page); throw error; }
    finally { await this.releaseSession(job.accountId, job.id); }
  }
  async searchEquipment(name) {
    const account = this.store.accounts().find(a => a.enabled && a.hasPassword);
    if (!account) throw new Error('请先添加并启用一个账号以检索仪器');
    const session = await this.session(account.id, true);
    try { return await catalogue(session.page, name); }
    finally { await session.context.close().catch(() => {}); this.contexts.delete(session.context); await this.closeIdle(); }
  }
  async validateEquipment(equipment) {
    const account = this.store.accounts().find(a => a.enabled && a.hasPassword);
    if (!account) throw new Error('请先启用一个账号');
    const session = await this.session(account.id, true);
    try { return await verifyTarget(session.page, equipment); }
    finally { await session.context.close().catch(() => {}); this.contexts.delete(session.context); await this.closeIdle(); }
  }
  async capture(job, phase, error, page) {
    if (!job || error.diagnosticId) return;
    try { error.diagnosticId = await captureFailure(this.root, job, phase, error, page); } catch {}
  }
  async probeEnvironment() {
    const browser = await this.getBrowser();
    let context;
    try {
      context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' }); this.contexts.add(context);
      const page = await context.newPage();
      try {
        const response = await page.goto('https://healthlab.zs-hospital.sh.cn/cf/main/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const available = Boolean(response?.ok() && await page.locator('input[name="password"]').count());
        return { chrome: true, website: available, detail: available ? '预约系统登录页可以访问；未提交预约' : '登录页结构或响应异常' };
      } catch (error) { return { chrome: true, website: false, detail: safeError(error) }; }
    } finally { if (context) { await context.close().catch(() => {}); this.contexts.delete(context); } await this.closeIdle(); }
  }
  async testLogin(accountId) {
    const account = this.store.accounts().find(a => a.id === accountId);
    const check = { id: `selfcheck|${Date.now()}|${accountId}`, accountId, accountOwner: account?.owner || '', accountLabel: account?.owner || account?.username || '', equipment: this.store.data.config.equipment, releaseAt: Date.now() + 30000 };
    let session;
    try {
      session = await this.session(accountId, true, false, check);
      await openEquipment(session.page, rulesFor(check.equipment));
      return { success: true, message: '本地OCR登录、仪器名称检索与预约日历访问通过；未提交预约' };
    } catch (error) { await this.capture(check, 'selfcheck', error, session?.page); throw error; }
    finally { if (session) { await session.context.close().catch(() => {}); this.contexts.delete(session.context); } await this.closeIdle(); }
  }
  async releaseSession(accountId, jobId) {
    const sessionKey = this.sessions.has(jobId) ? jobId : accountId;
    const session = this.sessions.get(sessionKey);
    this.sessions.delete(sessionKey);
    if (session) { await session.context.close().catch(() => {}); this.contexts.delete(session.context); }
    await this.closeIdle();
  }
  async closeIdle() {
    if (!this.contexts.size && this.browser && !this.closing) {
      const browser = this.browser; this.browser = null;
      this.closing = browser.close().catch(() => {}).finally(() => { this.closing = null; });
      await this.closing;
    }
  }
  async close() {
    this.closed = true;
    await this.launching?.catch(() => {});
    this.sessions.clear();
    this.contexts.clear();
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}
module.exports = { BrowserWorker };
