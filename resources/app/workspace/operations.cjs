'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WINDOWS, generateJobs, addDays, shanghaiDate, validDate, windowsFor, validateSchedules, validateDateWindows, validateWindows, validateExclusions, validateRetryPolicy, validateReviewPolicy } = require('./schedule-logic.cjs');
const { recognizeCaptcha } = require('./ocr.cjs');
const { archiveDiagnostics, safeError } = require('./support-files.cjs');
const { Retention, validateRetention } = require('./retention.cjs');
const FINAL = new Set(['success', 'already_exists', 'failed', 'needs_review', 'missed']);
function csvCell(value) { let text = String(value ?? ''); if (/^\s*[=+\-@]|^[\t\r]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; }
class Operations {
  constructor({ root, store, worker, clock = Date.now, desktop, localCheck, onProgress = () => {}, canMaintain = () => true }) {
    this.root = root; this.store = store; this.worker = worker; this.clock = clock; this.desktop = desktop;
    this.canMaintain = canMaintain; this.retention = new Retention(root, clock); this.retentionPromise = null;
    this.localCheck = localCheck; this.checkPromise = null; this.cancelled = false; this.restorePlan = null;
    this.onProgress = onProgress;
    this.directory = path.join(root, 'work', 'manager'); this.exports = path.join(root, 'exports');
    fs.mkdirSync(this.directory, { recursive: true }); fs.mkdirSync(this.exports, { recursive: true });
    this.file = path.join(this.directory, 'operations-state.json');
    this.state = { health: null, network: 'unknown', suspendedAt: null, autoReports: {}, ...(fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}) };
    if (this.state.health?.running) { this.state.health.running = false; this.state.health.status = 'interrupted'; this.state.health.canStart = false; }
    if (!store.data.diagnosticHistoryIndexed) {
      const diagnostics = path.join(root, 'outputs', 'diagnostics');
      if (fs.existsSync(diagnostics)) for (const entry of fs.readdirSync(diagnostics).sort()) {
        if (!/^failure-\d+-[a-f0-9]{8}$/.test(entry)) continue;
        try {
          const report = JSON.parse(fs.readFileSync(path.join(diagnostics, entry, 'report.json'), 'utf8'));
          const job = store.data.jobs[report.jobId];
          if (job) job.diagnosticIds = [...new Set([...(job.diagnosticIds || []), entry])].sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]) || a.localeCompare(b));
        } catch {}
      }
      store.data.diagnosticHistoryIndexed = true; store.persist();
    }
    this.lastTick = clock(); this.persist();
  }
  persist() { const temp = this.file + `.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(this.state, null, 2)); fs.renameSync(temp, this.file); }
  publicState() { return { startup: this.state.startup, health: this.state.health, network: this.state.network, suspendedAt: this.state.suspendedAt, lastResume: this.state.lastResume, exportsDirectory: this.exports, autoReports: this.state.autoReports, retention: this.state.retention }; }
  signature() { return crypto.createHash('sha256').update(JSON.stringify({ accounts: this.store.accounts(), windows: this.store.data.config.windows, teamMembers:this.store.data.config.teamMembers, exclusions: this.store.data.config.exclusions, personalAccountUsername:this.store.data.accounts.find(a=>a.id===this.store.data.config.personalAccountId)?.username||null, catchUpEnabled:this.store.data.config.catchUpEnabled, reviewRebookEnabled:this.store.data.config.reviewRebookEnabled, reviewPolicy:this.store.data.config.reviewPolicy, retryPolicy: this.store.data.config.retryPolicy, equipment: this.store.data.config.equipment, equipments: this.store.data.config.equipments, theme: this.store.data.config.theme, dateWindows: this.store.data.config.dateWindows, assignmentRevision: this.store.data.assignmentRevision, retentionPolicy: this.store.data.config.retentionPolicy })).digest('hex'); }
  recentCheck() { const check = this.state.health; return Boolean(check?.canStart && check.signature === this.signature() && this.clock() - check.completedAt < 600000); }
  startCheck(options = {}) {
    if (this.checkPromise) throw new Error('自检正在进行，请稍候');
    this.state.health = { running: true, status: 'running', canStart: false, startedAt: this.clock(), items: [] }; this.persist();
    this.checkPromise = this.runCheck(options).finally(() => { this.checkPromise = null; });
    return this.state.health;
  }
  async item(id, title, action, blocking = true) {
    if (this.cancelled) throw new Error('自检已取消');
    const item = { id, title, status: 'running', detail: '检查中' }; this.state.health.items.push(item); this.persist();
    this.onProgress(this.state.health);
    try { const result = await action(); Object.assign(item, { status: 'pass', ...result }); }
    catch (error) { Object.assign(item, { status: blocking ? 'fail' : 'warn', detail: safeError(error), diagnosticId: error.diagnosticId }); }
    this.persist(); this.onProgress(this.state.health); return item;
  }
  async checkLocal() {
    if (this.checkPromise) await this.checkPromise;
    this.startCheck({ phase: 'local', accounts: false });
    const result = await this.checkPromise;
    this.state.startup = structuredClone(result); this.persist();
    if (result.status !== 'pass') throw new Error('本地必要自检未通过：' + result.items.filter(i => i.status === 'fail').map(i => i.title + '：' + i.detail).join('；'));
    return result;
  }
  async runCheck({ accounts = true, phase = 'runtime' } = {}) {
    const check = this.state.health;
    const initialSignature = this.signature();
    try {
      if (phase === 'local' || this.state.startup?.status !== 'pass') {
      await this.item('runtime', '本地运行环境与数据写入', async () => {
        if (this.localCheck) return this.localCheck('runtime');
        const probe = path.join(this.directory, `write-check-${crypto.randomBytes(4).toString('hex')}.tmp`);
        fs.writeFileSync(probe, 'ok', { flag: 'wx' }); fs.unlinkSync(probe);
        return { detail: `Node ${process.versions.node}；本地数据目录可写；按北京时间调度` };
      });
      await this.item('ocr', '本地OCR模型与固定样例识别', async () => {
        if (this.localCheck) return this.localCheck('ocr');
        const started = this.clock(); const text = await recognizeCaptcha(path.join(__dirname, 'fixtures', 'ocr-selftest.png'));
        if (text.toLowerCase() !== 'jzgp') throw new Error('OCR模型已运行，但固定样例识别不一致，请检查运行环境');
        return { detail: `Python、ONNX模型加载及样例识别通过，耗时${this.clock() - started}ms；全程本地运行` };
      });
      await this.item('browser-local', '本地Chrome启动能力', async () => {
        if (this.localCheck) return this.localCheck('browser-local');
        await this.worker.getBrowser(); await this.worker.closeIdle(); return { detail: '后台Chrome启动和关闭通过；未连接网站' };
      });
      }
      if (phase === 'local') { check.status = check.items.every(i => i.status === 'pass') ? 'pass' : 'fail'; return check; }
      const browser = await this.item('chrome', 'Chrome与预约网站连接', async () => {
        const probe = await this.worker.probeEnvironment();
        if (!probe.chrome || !probe.website) throw new Error(probe.detail || 'Chrome或预约网站不可用');
        return { detail: probe.detail };
      }, false);
      const ids = this.store.accounts().filter(a => a.enabled).map(a => a.id);
      if (!ids.length) await this.item('accounts', '启用窗口与账号', async () => ({ status: 'warn', detail: '尚未启用账号；请先启用至少一个账号' }));
      for (const id of ids) {
        const account = this.store.accounts().find(a => a.id === id);
        await this.item(`account-${id}`, `账号登录 · ${account?.owner || account?.username || '未配置'}`, async () => {
          if (!account?.enabled || !account.hasPassword) throw new Error('账号未启用或需要补录密码');
          if (!accounts) return { status: 'warn', detail: '本次未检查登录；实际预约任务准备时登录' };
          if (browser.status !== 'pass') return { status: 'warn', detail: '网站不可访问，未发送登录请求；不影响启动等待，实际任务会重新登录' };
          const result = await this.worker.testLogin(id); if (!result.success) throw new Error(result.message || '登录检查未通过');
          return { detail: result.message || '验证码自动识别和登录通过；未操作预约' };
        }, false);
      }
      if (ids.length && browser.status === 'pass' && accounts && this.worker.validateEquipment) for (const equipment of require('./equipment.cjs').equipmentList(this.store.data.config)) await this.item('equipment-'+equipment.equipmentId, '目标设备 · '+equipment.equipmentName, async () => { const target = await this.worker.validateEquipment(equipment); return { detail: `${target.equipmentName} · 编号${target.equipmentId} · 日历${target.calendarId}` }; }, false);
      await this.item('window-selection', '预约窗口与账号数量', async () => { this.validateReadiness(); return { detail: `已选${this.store.data.config.windows.filter(w => w.enabled).length}个窗口，启用${ids.length}个账号；每天随机分配` }; });
      check.canStart = ids.length > 0 && check.items.every(item => item.status !== 'fail');
      check.status = check.items.some(item => item.status === 'fail') ? 'fail' : check.items.some(item => item.status === 'warn') ? 'warning' : 'pass';
      check.signature = initialSignature;
      if (initialSignature !== this.signature()) { check.canStart = false; check.status = 'warning'; check.message = '自检期间配置变化，请重新检查'; }
      this.store.event('selfcheck', check.canStart ? '调度配置可用；网站与登录检测仅供参考，实际任务准备时重新检查' : '自检结束；请修复本地环境或预约配置后启动');
    } catch (error) { check.canStart = false; check.status = 'interrupted'; check.message = safeError(error); }
    finally { check.running = false; check.completedAt = this.clock(); this.persist(); }
    return check;
  }
  validateReadiness() {
    validateSchedules(this.store.data.config, this.store.data.accounts, this.clock());
    if (this.store.accounts().some(a => a.enabled && !a.hasPassword)) throw new Error('启用账号需要补录密码');
  }
  async ensureCheck() {
    // Only local prerequisites and configuration gate scheduling. Remote checks are
    // optional diagnostics; the actual task owns login, retries and notifications.
    this.validateReadiness();
    if (this.recentCheck()) return;
    if (this.state.startup?.status !== 'pass') await this.checkLocal();
    this.validateReadiness();
  }
  summary(date) {
    if (!validDate(date)) throw new Error('目标日期无效');
    const mapping = this.store.assignment(date);
    const accounts = this.store.accounts();
    const rows = generateJobs(this.store.data.config, accounts, addDays(date, -7), 1, true).map(job => {
      const id = this.store.data.bindings[`${date}|${job.windowId}`] || mapping[job.windowId] || null;
      const account = accounts.find(a => a.id === id);
      const record = this.store.data.jobs[job.id] || Object.values(this.store.data.jobs).find(r => require('./equipment.cjs').slotKey(r) === require('./equipment.cjs').slotKey(job));
      const historical = record && FINAL.has(record.status);
      return { ...job, accountId: id, accountLabel: account?.owner || account?.username || job.accountLabel, accountOwner: record ? record.accountOwner || '' : account?.owner || '', ...record, status: historical ? record.status : job.skipped ? 'skipped' : record?.status || (job.equipmentEnabled && job.selected && account?.enabled && !job.skipped ? 'planned' : 'disabled'), message: historical ? record.message || '' : job.skipped ? job.skipReason : record?.message || '' };
    });
    const count = status => rows.filter(row => row.status === status).length;
    for (const record of Object.values(this.store.data.jobs)) if (record.date === date && FINAL.has(record.status) && !rows.some(row => row.id === record.id)) rows.push({ ...record, historicalOnly: true });
    const byAccount = [...new Set(rows.map(row => row.accountId).filter(Boolean))].map(id => {
      const list = rows.filter(row => row.accountId === id); const confirmed = list.filter(row => ['success', 'already_exists'].includes(row.status)).length;
      return { accountId: id, accountLabel: list[0].accountLabel, accountOwner: list[0].accountOwner || '', plannedMinutes: list.filter(row => !['skipped', 'disabled'].includes(row.status)).length * 30, confirmedMinutes: confirmed * 30, confirmedHours: confirmed / 2 };
    });
    return { date, releaseDate: addDays(date, -7), generatedAt: new Date(this.clock()).toISOString(), planBasis: '计划按当前配置显示；历史结果保留实际执行记录', total: rows.length, success: count('success'), alreadyExists: count('already_exists'), failed: rows.filter(r=>r.status==='failed'&&!['waiting','running'].includes(r.recovery?.state)).length, recovering: rows.filter(r=>['waiting','running'].includes(r.recovery?.state)).length, uncertain: count('needs_review'), missed: count('missed'), skipped: count('skipped'), disabled: count('disabled'), pending: rows.filter(row => !FINAL.has(row.status) && !['skipped', 'disabled'].includes(row.status)).length, rows, byAccount };
  }
  exportSummary(date, automatic = false) {
    const report = this.summary(date);
    const suffix = automatic ? '' : `-${this.clock()}-${crypto.randomBytes(2).toString('hex')}`;
    const base = path.join(this.exports, `daily-${date}${suffix}`);
    fs.writeFileSync(base + '.json', JSON.stringify(report, null, 2));
    const columns = ['设备名称', '目标日期', '开始', '结束', '账号', '使用人', '状态', '说明', '预约编号', '提交延迟ms', '保存调用时间', '网站读回确认时间', '开放到确认ms', '提交到确认ms', '步骤时间线JSON','复核确认时间','复核结果','补约开始时间','补约提交时间','补约状态','补约后即时复核时间'];
    const rows = report.rows.map(row => [row.equipment?.equipmentName, row.date, row.start, row.end, row.accountLabel, row.accountOwner || '', row.status, row.message, row.reservationId, row.delayMs, row.savingAt ? new Date(row.savingAt).toISOString() : '', row.verifiedAt || '', row.confirmationDelayMs, row.submissionToConfirmationMs, JSON.stringify(row.timeline || []), row.recheckedAt ? new Date(row.recheckedAt).toISOString() : '', row.review?.message || '',row.review?.rebooking?.startedAt?new Date(row.review.rebooking.startedAt).toISOString():'',row.review?.rebooking?.submittedAt?new Date(row.review.rebooking.submittedAt).toISOString():'',row.review?.rebooking?.state||'',row.review?.postRebookCheckedAt?new Date(row.review.postRebookCheckedAt).toISOString():'']);
    fs.writeFileSync(base + '.csv', '\ufeff' + [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n'), 'utf8');
    return { files: [base + '.json', base + '.csv'], summary: report };
  }
  backup(label = 'manual', destination) {
    const file = destination || path.join(this.exports, `backup-${label}-${this.clock()}-${crypto.randomBytes(3).toString('hex')}.json`);
    const backup = { schema: 'cellstation-backup', version: 3, createdAt: new Date(this.clock()).toISOString(), encryptedFor: 'Windows CurrentUser DPAPI', accounts: this.store.data.accounts, teamMembers:this.store.data.config.teamMembers, windows: this.store.data.config.windows, exclusions: this.store.data.config.exclusions || [], personalAccountUsername:this.store.data.accounts.find(a=>a.id===this.store.data.config.personalAccountId)?.username||null, catchUpEnabled:this.store.data.config.catchUpEnabled, reviewRebookEnabled:this.store.data.config.reviewRebookEnabled, reviewPolicy:this.store.data.config.reviewPolicy, retryPolicy: this.store.data.config.retryPolicy, equipment: this.store.data.config.equipment, equipments: this.store.data.config.equipments, theme: this.store.data.config.theme, poolMigration: 1, windowSelectionMigration: 1, retentionPolicy: this.store.data.config.retentionPolicy, dateWindows: this.store.data.config.dateWindows || {}, assignmentPlans: Object.fromEntries(Object.entries(this.store.data.dailyAssignments).filter(([, plan]) => ['manual', 'random'].includes(plan.mode)).map(([date, plan]) => [date, { mode: plan.mode, mapping: Object.fromEntries(Object.entries(plan.mapping).filter(([id, accountId]) => require('./schedule-logic.cjs').assignmentWindows(this.store.data.config, date).some(w => w.id === id && w.enabled) && this.store.data.accounts.some(a => a.id === accountId)).map(([id, accountId]) => [id, this.store.data.accounts.find(a => a.id === accountId).username])) }])) };
    const temporary = destination ? `${file}.${crypto.randomBytes(5).toString('hex')}.tmp` : file;
    try { fs.writeFileSync(temporary, JSON.stringify(backup, null, 2), { flag: 'wx', mode: 0o600 }); if (destination) fs.renameSync(temporary, file); }
    catch (error) { if (destination && fs.existsSync(temporary)) fs.unlinkSync(temporary); throw error; }
    return { file, filename: path.basename(file), createdAt: backup.createdAt, accounts: backup.accounts.length, enabledAccounts: backup.accounts.filter(a => a.enabled).length, selectedWindows: WINDOWS.filter(w => backup.windows.find(b => b.id === w.id)?.enabled).map(w => `${w.start}–${w.end}`), customDates: Object.keys(backup.dateWindows).length, assignmentDays: Object.keys(backup.assignmentPlans).length, message: '已导出账号、加密密码、所选窗口、单日时间段与分配结果、跳过日期、重试次数、复核等待时间、仪器和主题；不含执行记录、失败截图、Cookie及开机自启动等桌面设置。换电脑或Windows用户时，密码可能需要重新录入。' };
  }
  async previewRestore(input) {
    if (this.store.data.config.enabled || this.checkPromise) throw new Error('请暂停调度，并等待自检结束后导入');
    const initialSignature = this.signature();
    if (!input || input.schema !== 'cellstation-backup' || ![1, 2, 3].includes(input.version) || !Array.isArray(input.accounts) || input.accounts.length > 50) throw new Error('备份格式无效');
    const seen = new Set(); const ids = new Set(); const accounts = []; const accountChanges = [];
    for (const source of input.accounts) {
      if (typeof source.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(source.id) || ids.has(source.id) || typeof source.username !== 'string' || !source.username.trim() || source.username.length > 120 || seen.has(source.username) || source.passwordCipher && (typeof source.passwordCipher !== 'string' || source.passwordCipher.length > 16000)) throw new Error('备份账号字段无效或重复');
      ids.add(source.id); seen.add(source.username);
      if (source.owner !== undefined && (typeof source.owner !== 'string' || source.owner.length > 60)) throw new Error('备份中的使用人字段无效');
      let usable = false;
      if (source.passwordCipher) { try { const clear = await this.store.vault.unprotect(source.passwordCipher); usable = typeof clear === 'string' && clear.length > 0 && clear.length <= 500; } catch {} }
      const existing = this.store.data.accounts.find(a => a.username === source.username);
      let existingUsable = false;
      if (!usable && existing?.passwordCipher) { try { const clear = await this.store.vault.unprotect(existing.passwordCipher); existingUsable = typeof clear === 'string' && clear.length > 0 && clear.length <= 500; } catch {} }
      accountChanges.push({ username: source.username, owner: source.owner === undefined ? existing?.owner || source.label || '' : source.owner.trim(), action: existing ? '更新已有账号' : '新增账号', password: usable ? '使用备份中的加密密码' : existingUsable ? '保留本机可用密码' : '需重新输入密码，将停用', enabled: Boolean(source.enabled !== false && (usable || existingUsable)) });
      accounts.push({ oldId: source.id, id: existing?.id || crypto.randomUUID(), username: source.username, owner: source.owner === undefined ? existing?.owner || source.label || '' : source.owner.trim(), enabled: source.enabled !== false, passwordCipher: usable ? source.passwordCipher : existingUsable ? existing.passwordCipher : null, revision: (existing?.revision || 0) + 1 });
    }
    if (!Array.isArray(input.windows) || input.windows.length !== 5) throw new Error('备份窗口不完整');
    validateWindows(input.windows, []);
    const windows = WINDOWS.map((fixed, i) => ({ id: fixed.id, enabled: input.version === 1 && input.poolMigration ? i < accounts.filter(a => a.enabled && a.passwordCipher).length : input.windows.find(w => w.id === fixed.id).enabled }));
    const sanitized = accounts.map(({ oldId, ...account }) => ({ ...account, enabled: Boolean(account.enabled && account.passwordCipher) }));
    const merged = this.store.data.accounts.filter(a => !sanitized.some(b => a.id === b.id)).concat(sanitized);
    if (merged.filter(a => a.enabled).length > 5) throw new Error('合并后启用账号超过5个。请先在账号管理停用不需要的本机账号，再重新预览；不会删除本机账号。');
    validateWindows(windows, merged); const exclusions = validateExclusions(input.exclusions || []);
    const teamMembers=require('./site-identity.cjs').validateTeam(input.teamMembers===undefined?this.store.data.config.teamMembers:input.teamMembers);
    const personalAccountId=input.personalAccountUsername===undefined?(merged.find(a=>a.id===this.store.data.config.personalAccountId)?.id||null):input.personalAccountUsername===null?null:merged.find(a=>a.username===input.personalAccountUsername)?.id;if(personalAccountId===undefined)throw new Error('备份中的本人账号不存在');
    const catchUpEnabled=input.catchUpEnabled===undefined?this.store.data.config.catchUpEnabled:input.catchUpEnabled;if(typeof catchUpEnabled!=='boolean')throw new Error('备份中的自动补尝试设置无效');
    const reviewRebookEnabled=input.reviewRebookEnabled===undefined?this.store.data.config.reviewRebookEnabled:input.reviewRebookEnabled;if(typeof reviewRebookEnabled!=='boolean')throw new Error('备份中的首次复核后补约设置无效');
    const reviewPolicy=validateReviewPolicy(input.reviewPolicy||this.store.data.config.reviewPolicy);
    const retryPolicy = validateRetryPolicy(input.retryPolicy || this.store.data.config.retryPolicy || { taskRetries: 2, captchaRetries: 2 });
    const equipment = require('./equipment.cjs').validateEquipment(input.equipment || this.store.data.config.equipment);
    const equipments = require('./equipment.cjs').validateEquipmentList(input.equipments || [equipment]);
    const theme = ['light', 'dark', 'system'].includes(input.theme) ? input.theme : this.store.data.config.theme;
    const retentionPolicy = validateRetention(input.retentionPolicy || this.store.data.config.retentionPolicy);
    const dateWindows = validateDateWindows(input.dateWindows);
    const assignmentPlans = {}, rawPlans = input.assignmentPlans || {};
    if (!rawPlans || typeof rawPlans !== 'object' || Array.isArray(rawPlans) || Object.keys(rawPlans).length > 366) throw new Error('备份中的单日分配配置无效');
    for (const [date, source] of Object.entries(rawPlans)) {
      if (!validDate(date) || !source || !['manual', 'random'].includes(source.mode) || !source.mapping || typeof source.mapping !== 'object' || Array.isArray(source.mapping) || Object.keys(source.mapping).length > 5) throw new Error('备份中的单日分配日期或字段无效');
      const mapping = {}, used = new Set(), selected = require('./schedule-logic.cjs').assignmentWindows({windows,dateWindows,equipments},date);
      for (const [windowId, username] of Object.entries(source.mapping)) {
        const account = merged.find(a => a.username === username);
        if (!selected.some(w => w.id === windowId && w.enabled) || !account || used.has(account.id)) throw new Error('备份中的单日分配有重复账号或无效窗口');
        used.add(account.id); if (account.enabled && account.passwordCipher) mapping[windowId] = account.id;
      }
      assignmentPlans[date] = { mode: source.mode, mapping };
    }
    if (initialSignature !== this.signature()) throw new Error('配置在预览生成期间变化，请重新选择文件预览');
    const token = crypto.randomBytes(16).toString('hex');
    this.restorePlan = { token, expires: this.clock() + 600000, signature: this.signature(), accounts: merged, windows, exclusions, teamMembers, retryPolicy, reviewPolicy, reviewRebookEnabled, catchUpEnabled, personalAccountId, equipment, equipments, theme, retentionPolicy, dateWindows, assignmentPlans, importedAccounts: sanitized.length, needsPassword: sanitized.filter(a => !a.passwordCipher).length };
    const selectedWindows = WINDOWS.filter(w => windows.find(b => b.id === w.id).enabled).map(w => `${w.start}–${w.end}`);
    return { equipmentSchedules:equipments.map(e=>({equipmentName:e.equipmentName,bookingSchedule:e.bookingSchedule||null})),token, sourceCreatedAt: input.createdAt || null, sourceVersion: input.version, importedAccounts: sanitized.length, newAccounts: accountChanges.filter(a => a.action === '新增账号').length, updatedAccounts: accountChanges.filter(a => a.action === '更新已有账号').length, retainedAccounts: merged.length - sanitized.length, needsPassword: sanitized.filter(a => !a.passwordCipher).length, enabledAccounts: merged.filter(a => a.enabled).length, enabledWindows: selectedWindows.length, selectedWindows, customDates: Object.keys(dateWindows).length, assignmentDays: Object.keys(assignmentPlans).length, retentionPolicy, dateDetails: [...new Set([...Object.keys(dateWindows), ...Object.keys(assignmentPlans)])].sort().map(date => ({ date, windows: WINDOWS.filter(w => (dateWindows[date] || windows).some(b => b.id === w.id && b.enabled)).map(w => `${w.start}–${w.end}`), accounts: Object.entries(assignmentPlans[date]?.mapping || {}).map(([id, accountId]) => ({ windowId: id, username: merged.find(a => a.id === accountId).username })) })), accountChanges, teamMembers:teamMembers.length, exclusions: exclusions.length, retryPolicy, reviewPolicy, reviewRebookEnabled, catchUpEnabled, personalAccountId, equipment: equipment.equipmentName, theme, selectionWarning: selectedWindows.length > merged.filter(a => a.enabled).length ? '所选窗口多于可用账号，导入后需补录密码或取消多余窗口才能启动。' : selectedWindows.length ? '' : '未选择预约窗口，导入后请先勾选再启动。', message: '按登录账号合并：同名更新、新账号加入、本机其他账号保留。所选窗口、单日分配、跳过日期、团队人员、本人账号、自动处理已开放计划、重试设置、仪器及主题将替换；执行记录、失败截图和桌面设置保留。导入前自动备份，导入后调度保持暂停。' };
  }
  restore(token) {
    const plan = this.restorePlan;
    if (this.store.data.config.enabled || this.checkPromise || !plan || token !== plan.token || this.clock() > plan.expires || this.signature() !== plan.signature) throw new Error('导入预览已过期或配置变化，请重新预览');
    const previous = this.backup('before-restore');
    this.store.data.windowSelectionMigration = 1; this.store.data.windowSelectionManual = true; this.store.data.dailyAssignments = {};
    this.store.data.accounts = plan.accounts; this.store.data.config.windows = plan.windows; this.store.data.config.exclusions = plan.exclusions;
    this.store.data.config.teamMembers=plan.teamMembers;
    this.store.data.config.personalAccountId=plan.personalAccountId;
    this.store.data.config.catchUpEnabled=plan.catchUpEnabled;
    this.store.data.config.reviewRebookEnabled=plan.reviewRebookEnabled;
    this.store.data.config.reviewPolicy=plan.reviewPolicy;
    this.store.data.config.retryPolicy = plan.retryPolicy; this.store.data.config.equipment = plan.equipment; this.store.data.config.theme = plan.theme;
    this.store.data.config.retentionPolicy = plan.retentionPolicy;
    this.store.data.config.equipments = plan.equipments;
    this.store.data.config.dateWindows = plan.dateWindows;
    for (const [date, assignment] of Object.entries(plan.assignmentPlans)) {
      this.store.data.dailyAssignments[date] = { signature: null, mapping: assignment.mapping, mode: assignment.mode, createdAt: new Date(this.clock()).toISOString() };
      this.store.assignment(date);
    }
    this.store.data.assignmentRevision++;
    this.store.data.config.enabled = false; this.store.data.config.enabledAt = null; this.restorePlan = null;
    this.desktop?.update?.({ theme: plan.theme });
    this.store.event('backup', '已导入配置；预约历史保留，调度仍暂停');
    return { restored: true, previousBackup: previous.file, importedAccounts: plan.importedAccounts, needsPassword: plan.needsPassword, selectedWindows: plan.windows.filter(w => w.enabled).length, customDates: Object.keys(plan.dateWindows).length, assignmentDays: Object.keys(plan.assignmentPlans).length, message: '配置已导入，调度保持暂停；执行记录和失败截图已保留。原配置的恢复备份已生成。' };
  }
  async exportDiagnostic(jobId, diagnosticId) {
    const record = diagnosticId ? { diagnosticId } : this.store.data.jobs[jobId]; if (!record?.diagnosticId) throw new Error('这条记录暂无诊断材料');
    const destination = path.join(this.exports, `diagnostic-${this.clock()}-${crypto.randomBytes(3).toString('hex')}.zip`);
    await archiveDiagnostics(this.root, record.diagnosticId, destination); return { file: destination };
  }
  systemMessage(title, content) { try { this.desktop?.systemMessage(title, content); } catch {} }
  networkStatus(online) {
    const previous = this.state.network; const next = online ? 'online' : 'offline'; if (previous === next) return;
    this.state.network = next; this.state.networkChangedAt = this.clock(); this.persist();
    if (!online || previous === 'offline') {
      this.store.event('network', online ? '网络连接已恢复，计划将按当前设置处理' : '网络连接已断开，可能影响预约');
      this.systemMessage(online ? 'CellStation · 网络已恢复' : 'CellStation · 网络已断开', online ? '网络已恢复，请查看预约状态。' : '本机网络不可用，请检查连接。正在运行的预约可能失败。');
    }
  }
  suspend() { this.state.suspendedAt = this.clock(); this.persist(); this.store.event('power', '电脑即将休眠，休眠期间不能执行预约'); }
  resume(inferred = false) {
    const gap = this.state.suspendedAt ? this.clock() - this.state.suspendedAt : this.clock() - this.lastTick;
    this.state.suspendedAt = null; this.state.lastResume = this.clock(); this.lastTick = this.clock(); this.persist();
    this.store.event('power', `${inferred ? '检测到较长运行间隔，可能为休眠或进程暂停' : '电脑已恢复'}，间隔约${Math.max(0, Math.round(gap / 60000))}分钟；计划将按当前设置处理`);
    this.systemMessage(inferred ? 'CellStation · 运行已恢复' : 'CellStation · 电脑已恢复', '请查看执行记录；待处理计划将按当前设置执行。' + (this.store.data.config.enabled ? '调度继续运行。' : '调度仍保持暂停。'));
  }
  monitorTick() {
    const now = this.clock(); if (now - this.lastTick > 90000 && !this.state.suspendedAt) this.resume(true); this.lastTick = now;
    const date = shanghaiDate(now); const end = Date.parse(date + 'T20:31:00+08:00');
    const dates=new Set(Object.keys(this.state.autoReports));if(now>=end)dates.add(date);
    for(const reportDate of dates){
      const jobs=Object.values(this.store.data.jobs).filter(job=>shanghaiDate(job.releaseAt)===reportDate);
      if(!jobs.length)continue;
      const signature=JSON.stringify(jobs.map(job=>[job.id,job.status,job.updatedAt,job.recheckedAt,job.review?.state,job.recovery?.state,job.recovery?.nextAt]));
      if(this.state.autoReports[reportDate]?.signature===signature)continue;
      const report=this.exportSummary(addDays(reportDate,7),true);this.state.autoReports[reportDate]={at:now,files:report.files,signature};this.persist();
      this.store.event('summary',reportDate+' 对应预约汇总已更新JSON和CSV');
    }
  }
  maintainFiles() {
    const now = this.clock(), policy = this.store.data.config.retentionPolicy;
    if (!policy.enabled || this.retentionPromise || this.checkPromise || !this.canMaintain()) return;
    const last = this.state.retention;
    if (last && last.policy === JSON.stringify(policy) && now - last.at < (last.more ? 30000 : last.error || last.errors?.length ? 3600000 : 86400000)) return;
    this.retentionPromise = this.retention.run(policy).then(result => { this.state.retention = { ...result, at: this.clock(), policy: JSON.stringify(policy) }; this.persist(); }).catch(error => { this.state.retention = { at: this.clock(), policy: JSON.stringify(policy), error: safeError(error) }; this.persist(); }).finally(() => { this.retentionPromise = null; });
    return this.retentionPromise;
  }
  start() { this.timer = setInterval(() => { try { this.monitorTick(); if (this.retentionPromise && !this.canMaintain()) this.retention.stop(); else this.maintainFiles(); } catch {} }, 30000); }
  cancel() { this.cancelled = true; clearInterval(this.timer); this.retention.stop(); }
}
module.exports = { Operations, csvCell };
