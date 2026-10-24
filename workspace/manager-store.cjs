'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WINDOWS, windowsFor, validateDateWindows, validDate, addDays, shanghaiDate, defaults, validateWindows, validateSelection, validateSchedules, shuffleAssignments, validateExclusions, validateRetryPolicy, validateReviewPolicy } = require('./schedule-logic.cjs');
class ManagerStore {
  constructor(directory, vault = require('./vault.cjs')) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'manager-state.json');
    this.vault = vault;
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, accounts: [], config: defaults(), jobs: {}, events: [] };
    if (this.data.version !== 1) throw new Error('管理数据版本不兼容');
    this.data.bindings ||= {};
    this.data.dailyAssignments ||= {};
    this.data.config.shuffleDaily = true;
    this.data.config.equipment ||= require('./equipment.cjs').defaultEquipment();
    this.data.config.equipments = require('./equipment.cjs').validateEquipmentList(this.data.config.equipments || [this.data.config.equipment]);
    this.data.config.theme ||= 'system';
    if (!this.data.poolMigration) {
      // v0.6 backups remain readable; only the redundant display label is retired.
      for (const a of this.data.accounts) { a.owner = a.owner || a.label || ''; delete a.label; }
      this.data.config.windows = defaults().windows;
      this.data.dailyAssignments = {};
      this.data.poolMigration = 1;
    }
    if (!this.data.windowSelectionMigration) {
      const count = this.data.accounts.filter(a => a.enabled).length;
      this.data.config.windows = defaults().windows.map((w, i) => ({ id: w.id, enabled: i < count }));
      this.data.windowSelectionMigration = 1;
      this.data.windowSelectionManual = false;
      this.data.dailyAssignments = {};
    }
    this.data.config.dateWindows = validateDateWindows(this.data.config.dateWindows);
    this.data.assignmentRevision ||= 0;
    this.data.config.retentionPolicy = require('./retention.cjs').validateRetention({ ...require('./retention.cjs').defaults, ...this.data.config.retentionPolicy });
    this.data.config.exclusions ||= [];
    this.data.config.reviewPolicy=validateReviewPolicy({...defaults().reviewPolicy,...this.data.config.reviewPolicy});
    this.data.config.retryPolicy = validateRetryPolicy({ ...defaults().retryPolicy, ...this.data.config.retryPolicy });
    // A crash after entering saving may have created a booking. Never silently resubmit.
    for (const job of Object.values(this.data.jobs)) {
      if (job.status === 'saving') { job.status = 'needs_review'; job.message = '上次在保存期间中断，请在网站核对；不会自动重试'; }
      else if (['preparing', 'ready'].includes(job.status)) { job.status = 'queued'; job.message = '程序重启后重新检查'; }
    }
    this.persist();
  }
  persist() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  accounts() { return this.data.accounts.map(({ passwordCipher, ...account }) => ({ ...account, hasPassword: Boolean(passwordCipher) })); }
  assignmentSignature(date) {
    return JSON.stringify({ windows: windowsFor(this.data.config, date), accounts: this.data.accounts.map(a => [a.id, a.enabled]), shuffle: this.data.config.shuffleDaily });
  }
  lockedAssignments(date) {
    return Object.fromEntries(Object.entries(this.data.bindings).filter(([key]) => key.startsWith(date + '|')).map(([key, id]) => [key.split('|')[1], id]));
  }
  assignment(date, randomInt) {
    const signature = this.assignmentSignature(date), previous = this.data.dailyAssignments[date], locked = this.lockedAssignments(date);
    if (previous?.signature === signature && Object.entries(locked).every(([key, id]) => previous.mapping[key] === id)) return previous.mapping;
    const retained = { ...locked }, reserved = new Set(Object.values(locked));
    // Keep valid, untouched choices when accounts or selected windows change.
    for (const window of windowsFor(this.data.config, date).filter(w => w.enabled && !retained[w.id])) {
      const id = previous?.mapping[window.id];
      if (id && !reserved.has(id) && this.data.accounts.some(a => a.id === id && a.enabled)) { retained[window.id] = id; reserved.add(id); }
    }
    const mapping = shuffleAssignments({ ...this.data.config, windows: windowsFor(this.data.config, date) }, this.accounts(), retained, randomInt);
    this.data.dailyAssignments[date] = { signature, mapping, mode: previous?.mode || 'auto', manualRevision: previous?.manualRevision || 0, createdAt: new Date().toISOString() };
    this.persist(); return mapping;
  }
  assignmentView(date) {
    if (!validDate(date)) throw new Error('目标预约日期无效');
    const mapping = this.assignment(date), windows = windowsFor(this.data.config, date);
    const revision = crypto.createHash('sha256').update(JSON.stringify({ windows, mapping, accounts: this.accounts().map(a => [a.id, a.enabled]) })).digest('hex');
    return { date, mapping, locked: {}, windows, customWindows: Boolean(this.data.config.dateWindows[date]), mode: this.data.dailyAssignments[date].mode || 'auto', revision };
  }
  checkAssignmentEdit(date, revision, now = Date.now()) {
    if (!validDate(date)) throw new Error('目标预约日期无效');
    const view = this.assignmentView(date);
    if (revision !== undefined && revision !== view.revision) throw new Error('此日分配已变化，请刷新后重试');
    return view;
  }
  saveAssignment(date, mapping, mode, message) {
    // Explicit user edits supersede automatic bindings, including prepared windows.
    mapping = Object.fromEntries(Object.entries(mapping).filter(([id]) => windowsFor(this.data.config, date).some(w => w.id === id && w.enabled)));
    const manualRevision = (this.data.dailyAssignments[date]?.manualRevision || 0) + 1;
    for (const key of Object.keys(this.data.bindings)) if (key.startsWith(date + '|')) delete this.data.bindings[key];
    this.data.dailyAssignments[date] = { signature: this.assignmentSignature(date), mapping, mode, manualRevision, createdAt: new Date().toISOString() };
    this.data.assignmentRevision++;
    this.event('assignment', message);
    return this.assignmentView(date);
  }
  rerandomize(date, revision, now, randomInt) {
    const old = this.checkAssignmentEdit(date, revision, now), config = { ...this.data.config, windows: old.windows };
    validateSelection(config, this.data.accounts);
    const mapping = shuffleAssignments(config, this.accounts(), {}, randomInt);
    const editable = old.windows.filter(w => w.enabled);
    const same = () => editable.every(w => (mapping[w.id] || null) === (old.mapping[w.id] || null));
    if (same()) {
      const assigned = editable.filter(w => mapping[w.id]);
      if (assigned.length > 1) { const a = assigned[0].id, b = assigned[1].id; [mapping[a], mapping[b]] = [mapping[b], mapping[a]]; }
      else if (assigned.length === 1) { const w = assigned[0].id; const other = this.accounts().find(a => a.enabled && a.id !== mapping[w]); if (other) mapping[w] = other.id; }
    }
    const changed = !same();
    const message = changed ? `${date} 已重新随机；保存前的任务按新分配准备，其他日期保持原分配` : `${date} 可分配组合只有一种，结果保持不变`;
    return { ...this.saveAssignment(date, mapping, 'random', message), changed, message };
  }
  setAssignment(date, windowId, accountId, revision, now) {
    const view = this.checkAssignmentEdit(date, revision, now);
    if (!view.windows.some(w => w.id === windowId && w.enabled)) throw new Error('该窗口未选择预约');
    if (!this.accounts().some(a => a.id === accountId && a.enabled && a.hasPassword)) throw new Error('请选择启用且已保存密码的账号');
    const mapping = { ...view.mapping }, previousId = mapping[windowId];
    const other = view.windows.find(w => w.enabled && w.id !== windowId && mapping[w.id] === accountId);
    if (other) mapping[other.id] = previousId || null;
    mapping[windowId] = accountId;
    return { ...this.saveAssignment(date, mapping, 'manual', `${date} 账号分配已手动调整${other ? '，两个窗口自动交换' : ''}`), message: other ? '已交换两个窗口的账号，修改已保存' : '账号分配已保存，仅作用于所选目标日期' };
  }
  moveAssignment(date, fromId, toId, revision, now) {
    const view = this.checkAssignmentEdit(date, revision, now);
    if (!WINDOWS.some(w => w.id === toId) || !view.windows.some(w => w.id === fromId && w.enabled) || !view.mapping[fromId]) throw new Error('请选择有效的已分配窗口和目标时间段');
    if (fromId === toId) return { ...view, message: '时间段未变化' };
    const mapping = { ...view.mapping }, occupied = view.windows.find(w => w.id === toId).enabled;
    if (occupied) [mapping[fromId], mapping[toId]] = [mapping[toId] || null, mapping[fromId]];
    else {
      const windows = view.windows.map(w => ({ id: w.id, enabled: w.id === fromId ? false : w.id === toId ? true : w.enabled }));
      if (!this.data.config.dateWindows[date] && Object.keys(this.data.config.dateWindows).length >= 366) throw new Error('最多保存366天的单日时间段调整');
      validateSelection({ ...this.data.config, windows }, this.data.accounts);
      this.data.config.dateWindows[date] = windows; mapping[toId] = mapping[fromId]; delete mapping[fromId];
    }
    return { ...this.saveAssignment(date, mapping, 'manual', `${date} 时间段已${occupied ? '交换' : '调整'}；只作用于此目标日期`), message: occupied ? '两个窗口已交换账号，仅作用于此日' : '时间段已调整并保存，其他日期仍使用每日通用窗口' };
  }
  resetDateWindows(date, revision, now) {
    const view = this.checkAssignmentEdit(date, revision, now);
    delete this.data.config.dateWindows[date];
    const retained = Object.fromEntries(Object.entries(view.mapping).filter(([id]) => this.data.config.windows.some(w => w.id === id && w.enabled)));
    const mapping = shuffleAssignments(this.data.config, this.accounts(), retained);
    return { ...this.saveAssignment(date, mapping, 'manual', `${date} 已恢复每日通用窗口`), message: '已恢复每日通用窗口，保存前的任务按新分配准备' };
  }
  async saveAccount(input) {
    
    
    const username = String(input.username || this.data.accounts.find(a => a.id === input.id)?.username || '').trim();
    if (!username || username.length > 120) throw new Error('请填写有效的登录账号');
    const current = input.id ? this.data.accounts.find(a => a.id === input.id) : null;
    if (input.id && !current) throw new Error('账号不存在');
    if (current && current.username !== username) throw new Error('登录账号不能直接改名，请新增另一个账号');
    const owner = input.owner === undefined ? current?.owner || '' : typeof input.owner === 'string' ? input.owner.trim() : null;
    if (owner === null || owner.length > 60) throw new Error('使用人需填写60字以内的文字');
    if (this.data.accounts.some(a => a.username === username && a.id !== current?.id)) throw new Error('该登录账号已存在');
    let passwordCipher = current?.passwordCipher;
    if (input.password) {
      if (typeof input.password !== 'string' || input.password.length > 500) throw new Error('密码格式无效');
      passwordCipher = await this.vault.protect(input.password);
    }
    if (!passwordCipher) throw new Error('新账号需要密码');
    
    if (this.data.accounts.some(a => a.username === username && a.id !== current?.id)) throw new Error('该登录账号已存在');
    const account = { id: current?.id || crypto.randomUUID(), username, owner: input.owner === undefined ? current?.owner || '' : owner, enabled: input.enabled === undefined ? current?.enabled ?? true : input.enabled === true, passwordCipher, revision: (current?.revision || 0) + 1 };
    validateWindows(this.data.config.windows, this.data.accounts.filter(a => a.id !== account.id).concat(account));
    if (current) Object.assign(current, account); else this.data.accounts.push(account);
    if (!this.data.windowSelectionManual) { const n = this.data.accounts.filter(a => a.enabled).length; if (n > this.data.config.windows.filter(w => w.enabled).length) this.data.config.windows = defaults().windows.map((w, i) => ({ id: w.id, enabled: i < n })); }
    this.event('account', `已保存账号：${owner || username}`);
    return this.accounts().find(a => a.id === account.id);
  }
  async credentials(id, snapshot) {
    const account = snapshot || this.data.accounts.find(a => a.id === id && a.enabled);
    if (!account) throw new Error('指定账号未启用');
    return { username: account.username, password: await this.vault.unprotect(account.passwordCipher) };
  }
  setWindows(windows) {
    validateWindows(windows, this.data.accounts);
    const selected = windows.filter(w => w.enabled).length, count = this.data.accounts.filter(a => a.enabled).length;
    if (selected > count) throw new Error(`只有${count}个启用账号，最多选择${count}个窗口；请先取消一个窗口再选择其他窗口`);
    this.data.config.windows = defaults().windows.map(w => ({ id: w.id, enabled: windows.find(b => b.id === w.id).enabled }));
    this.data.windowSelectionManual = true;
    this.event('config', `预约窗口已保存：${selected}个；每日随机分配，已开始的任务保留原配置`);
  }
  setEquipment(equipment) {
    this.data.equipmentReplacements ||= {};
    for (const job of Object.values(this.data.jobs)) if (['preparing','ready','retrying','saving'].includes(job.status)) this.data.equipmentReplacements[`${equipment.equipmentId}|${job.date}|${job.start}|${job.end}`] = job.id;
    this.data.config.equipment = require('./equipment.cjs').validateEquipment(equipment);
    this.data.config.equipments = require('./equipment.cjs').validateEquipmentList([equipment]);
    this.event('config', `预约仪器已切换：${equipment.equipmentName}；已开始的任务保留原仪器`);
  }
  setEquipments(items) {
    this.data.config.equipments = require('./equipment.cjs').validateEquipmentList(items);
    this.data.config.equipment = require('./equipment.cjs').validateEquipment(this.data.config.equipments.find(e => e.enabled) || this.data.config.equipments[0]);
    this.event('config', `设备列表已保存：${this.data.config.equipments.filter(e => e.enabled).length}个启用；同一时段按列表顺序依次预约全部启用设备`);
  }
  setTheme(theme) {
    if (!['light', 'dark', 'system'].includes(theme)) throw new Error('主题设置无效');
    this.data.config.theme = theme; this.persist();
  }
  setEnabled(enabled, now = Date.now()) {
    if (enabled) {
      validateSchedules(this.data.config, this.data.accounts, now);
    }
    if (this.data.config.enabled === enabled) return;
    this.data.config.enabled = enabled;
    this.data.config.enabledAt = enabled ? now : null;
    this.event('scheduler', enabled ? '调度已启动，只处理启动后开放的时段' : '调度已暂停');
  }
  setExclusions(entries) {
    this.data.config.exclusions = validateExclusions(entries);
    this.event('config', '按目标预约日期的跳过规则已保存');
  }
  setRetentionPolicy(policy) {
    this.data.config.retentionPolicy = require('./retention.cjs').validateRetention(policy);
    this.event('config', `截图与文件日志保留规则已保存：${policy.enabled ? `${policy.compressAfterDays}天压缩、${policy.deleteAfterDays}天清理` : '自动维护已关闭'}`);
  }
  setReviewPolicy(policy) { this.data.config.reviewPolicy=validateReviewPolicy(policy);this.event('config',`再次复核间隔已保存：${policy.retryIntervalMinutes}分钟`); }
  setRetryPolicy(policy) {
    this.data.config.retryPolicy = validateRetryPolicy(policy);
    this.event('config', `重试次数已保存：预约失败${policy.taskRetries}次，验证码刷新${policy.captchaRetries}次（均不含首次）`);
  }
  job(job, patch) {
    const old = this.data.jobs[job.id] || { ...job, status: 'queued' };
    if (patch.diagnosticId) patch = { ...patch, diagnosticIds: [...new Set([...(old.diagnosticIds || []), ...(old.diagnosticId ? [old.diagnosticId] : []), patch.diagnosticId])] };
    this.data.jobs[job.id] = { ...old, ...patch, updatedAt: new Date().toISOString() };
    this.persist();
    const record = this.data.jobs[job.id];
    try { this.onJob?.({ ...record }); } catch { this.event('notification', '系统提醒处理失败，预约结果已保存，请查看执行记录'); }
    return record;
  }
  event(type, message) {
    this.data.events.unshift({ id: crypto.randomUUID(), type, message, at: new Date().toISOString() });
    this.data.events = this.data.events.slice(0, 200);
    this.persist();
  }
}
module.exports = { ManagerStore };
