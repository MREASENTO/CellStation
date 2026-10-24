'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { reviewNotice } = require('./wechat-notifications.cjs');
const FAILURE = new Set(['failed', 'needs_review', 'missed']);
function reason(job) {
  if (job.status === 'needs_review') return reviewNotice(job)?.summary||'保存结果不明确，程序将立即复核，并按设置间隔再查一次；不会重复提交。';
  if (job.status === 'missed') return '已超过执行时间，未补约。';
  const message = String(job.message || '');
  if (/验证码|OCR|登录|密码|账号/.test(message)) return '账号登录或验证码检查未通过。';
  if (/占用|冲突/.test(message)) return '目标时段已被占用。';
  if (/timeout|network|网络|超时|ERR_/i.test(message)) return '网络或网站响应异常。';
  return '预约执行未完成，请查看执行记录。';
}
class DesktopIntegration {
  constructor({ app, dataRoot, sendNotification, show, quit, openDirectory, openExternal, chooseBackupPath, revealBackup, startupName = 'CellStation', clock = Date.now, batchMs = 1200 }) {
    this.app = app; this.sendNotification = sendNotification; this.show = show; this.quit = quit;
    this.dataRoot = dataRoot; this.openDirectory = openDirectory;
    this.openExternal = openExternal; this.chooseBackupPath = chooseBackupPath; this.revealBackup = revealBackup;
    this.startupName = startupName; this.clock = clock; this.batchMs = batchMs;
    this.file = path.join(dataRoot, 'desktop-settings.json');
    this.settings = { theme: 'system', failureNotifications: true, resumeSchedule: true, lastSchedulerEnabled: false, notifiedJobs: {}, ...(fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}) };
    this.pending = []; this.timer = null;
    this.persist();
  }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + `.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.settings, null, 2));
    fs.renameSync(temporary, this.file);
  }
  loginOptions() { return { path: process.execPath, args: ['--autostart'] }; }
  status() {
    const login = this.app.getLoginItemSettings(this.loginOptions());
    const item = login.launchItems?.find(item => item.name === this.startupName);
    const registered = Boolean(item) || Boolean(login.openAtLogin);
    const approved = item ? item.enabled : login.executableWillLaunchAtLogin !== false;
    return { theme: this.settings.theme, autoStart: registered && approved, startupRegistered: registered, startupBlocked: registered && !approved, failureNotifications: this.settings.failureNotifications, resumeSchedule: this.settings.resumeSchedule, lastSchedulerEnabled: this.settings.lastSchedulerEnabled };
  }
  update(input) {
    const allowed = new Set(['autoStart', 'failureNotifications', 'resumeSchedule', 'theme']);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key) || (key === 'theme' ? !['light', 'dark', 'system'].includes(input[key]) : typeof input[key] !== 'boolean'))) throw new Error('桌面设置无效');
    if ('autoStart' in input) {
      this.app.setLoginItemSettings({ ...this.loginOptions(), name: this.startupName, openAtLogin: input.autoStart, enabled: input.autoStart });
      const actual = this.status();
      if (input.autoStart && !actual.autoStart) throw new Error('Windows未启用启动项，请检查任务管理器的启动应用');
      if (!input.autoStart && actual.autoStart) throw new Error('Windows启动项未关闭，请检查任务管理器的启动应用');
    }
    for (const key of ['failureNotifications', 'resumeSchedule', 'theme']) if (key in input) this.settings[key] = input[key];
    if (!this.settings.failureNotifications) { clearTimeout(this.timer); this.timer = null; this.pending = []; }
    this.persist();
    const status = this.status();
    this.onSettingsChanged?.(status);
    return status;
  }
  schedulerIntent(enabled) { this.settings.lastSchedulerEnabled = Boolean(enabled); this.persist(); }
  shouldResume(autoStarted) { return Boolean(autoStarted && this.settings.resumeSchedule && this.settings.lastSchedulerEnabled); }
  notify(job) {
    if (!FAILURE.has(job.status)) return;
    const notice=reviewNotice(job);if(!notice)return;
    const key = notice.key;
    if (key in this.settings.notifiedJobs) return;
    this.settings.notifiedJobs[key] = this.clock();
    this.settings.notifiedJobs = Object.fromEntries(Object.entries(this.settings.notifiedJobs).slice(-500));
    this.persist();
    if (!this.settings.failureNotifications) return;
    this.pending.push({ date: job.date, start: job.start, end: job.end, accountLabel: String(job.accountOwner || job.accountLabel || '未备注使用人').slice(0, 70), status: job.status, kind:notice.kind, title:notice.title, reason: reason(job) });
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.batchMs);
  }
  flush() {
    const list = this.pending.splice(0);
    if (!list.length || !this.settings.failureNotifications) return;
    list.sort((a,b)=>Number(b.kind==='manual_required')-Number(a.kind==='manual_required'));
    const first = list[0];
    const title = first.kind==='manual_required'?(list.length>1?`【请自主复核】CellStation · ${list.filter(j=>j.kind==='manual_required').length}项需你亲自确认`:first.title):list.length > 1 ? `CellStation · ${list.length}项预约需处理` : first.title|| (first.status === 'needs_review' ? 'CellStation · 预约结果需核对' : first.status === 'missed' ? 'CellStation · 已错过预约' : 'CellStation · 预约失败');
    const content = list.slice(0, 3).map(job => `${job.date} ${job.start}–${job.end} · ${job.accountLabel}\n${job.reason}`).join('\n') + (list.length > 3 ? `\n另有${list.length - 3}项，请查看执行记录。` : '');
    try { this.sendNotification({ title, content: content.slice(0, 240), click: () => this.show('history') }); }
    catch (error) { console.error('WINDOWS_NOTIFICATION_FAILED', error.message); }
  }
  replayUncertain(jobs) {
    for (const job of jobs) if (job.status === 'needs_review' && this.clock() - Date.parse(job.updatedAt) < 86400000) this.notify(job);
  }
  testNotification() {
    this.sendNotification({ title: 'CellStation · 通知测试', content: '这是一条Windows系统提醒。真实预约失败、错过或结果不明确时，将显示日期、时段和账号。未进行预约。', click: () => this.show('history') });
    return { sent: true, message: '已向Windows发送测试提醒；如果没有显示，请检查系统通知和勿扰模式。' };
  }
  requestExit() { this.quit(); }
  systemMessage(title, content) { if (this.settings.failureNotifications) this.sendNotification({ title, content, click: () => this.show('history') }); }
  async openExports(directory) {
    if (path.resolve(directory) !== path.resolve(this.dataRoot, 'exports') || !this.openDirectory) throw new Error('导出目录不可用');
    const error = await this.openDirectory(directory); if (error) throw new Error('无法打开导出目录');
  }
  async openWebsite() { if (!this.openExternal) throw new Error('桌面浏览器入口不可用'); await this.openExternal('https://healthlab.zs-hospital.sh.cn/cf/main/login'); }
  dispose() { clearTimeout(this.timer); this.timer = null; this.pending = []; }
}
module.exports = { DesktopIntegration, reason };
