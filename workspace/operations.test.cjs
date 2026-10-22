'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { Operations, csvCell } = require('./operations.cjs');
const { ManagerStore } = require('./manager-store.cjs');
const { Scheduler } = require('./scheduler.cjs');
const { WINDOWS, generateJobs } = require('./schedule-logic.cjs');
const { automaticLogin, captchaRejected } = require('./auto-login.cjs');
const { captureFailure, archiveDiagnostics, diagnosticDirectory } = require('./support-files.cjs');
const { createManager } = require('./manager-server.cjs');
const base = path.join(__dirname, '..', 'work', 'tests'); fs.mkdirSync(base, { recursive: true });
const vault = { protect: async value => Buffer.from(value).toString('base64'), unprotect: async value => Buffer.from(value, 'base64').toString() };
function fixture() {
  const root = fs.mkdtempSync(path.join(base, 'ops-')); const store = new ManagerStore(path.join(root, 'work', 'manager'), vault);
  store.data.accounts = WINDOWS.map((_w, i) => ({ id: `a${i}`, label: `账号${i}`, username: `test${i}`, enabled: true, revision: 1, passwordCipher: Buffer.from('local-dummy').toString('base64') }));
  store.setWindows(WINDOWS.map(w => ({id: w.id, enabled: true})));
  store.persist();
  let now = Date.parse('2026-10-22T07:00:00+08:00'); const calls = []; const messages = [];
  const worker = { probeEnvironment: async () => { calls.push('browser'); return { chrome: true, website: true, detail: 'fake website' }; }, testLogin: async id => { calls.push(id); return { success: true }; }, close: async () => {} };
  const options = { root, store, worker, clock: () => now, desktop: { systemMessage: (...args) => messages.push(args) }, localCheck: async id => { calls.push(id); return { detail: 'fake check' }; } };
  const operations = new Operations(options);
  return { root, store, calls, messages, worker, operations, options, clock: () => now, time: value => { now = value; } };
}
test('full preflight includes OCR execution, every active account, caching and revision invalidation', async () => {
  const f = fixture(); f.operations.startCheck(); const report = await f.operations.checkPromise;
  assert.equal(report.canStart, true); assert.ok(f.calls.includes('ocr')); assert.equal(f.calls.filter(id => /^a\d$/.test(id)).length, 5);
  await f.operations.ensureCheck(); assert.equal(f.calls.filter(id => id === 'ocr').length, 1);
  f.store.data.accounts[0].revision++; assert.equal(f.operations.recentCheck(), false);
  f.operations.localCheck = async id => { if (id === 'ocr') throw new Error('OCR model missing'); return {}; };
  await assert.rejects(f.operations.ensureCheck(), /自检未通过/); assert.equal(f.store.data.config.enabled, false);
});
test('skip rules use target dates, exclude four slots or a full day and retain saved records', () => {
  const f = fixture(); f.store.setExclusions([{ date: '2026-10-29', windowIds: ['w1'], reason: '假期' }]);
  const plan = new Scheduler(f.store, {}, f.clock).plan(1, true);
  assert.equal(plan.filter(j => j.skipped).length, 4); assert.equal(plan.filter(j => j.available).length, 16);
  assert.equal(f.operations.summary('2026-10-29').skipped, 4);
  assert.throws(() => f.store.setExclusions([{ date: '2026-02-30', windowIds: ['w1'] }]), /无效/);
  assert.throws(() => f.store.setExclusions([{ date: '2026-10-29', windowIds: ['w1'] }, { date: '2026-10-29', windowIds: ['w1'] }]), /重复/);
  const saved = plan[0]; f.store.job(saved, { status: 'success' });
  f.store.setExclusions([{ date: '2026-10-29', windowIds: WINDOWS.map(w => w.id) }]);
  assert.equal(new Scheduler(f.store, {}, f.clock).plan(1).length, 0);
  assert.equal(f.operations.summary('2026-10-29').success, 1);
});
test('skipping an already prepared task changes its derived report, and stale retries finalize on restart', async () => {
  const f = fixture(); const job = generateJobs(f.store.data.config, f.store.accounts(), '2026-10-22')[0];
  f.store.job(job, { status: 'queued' }); f.store.setExclusions([{ date: job.date, windowIds: ['w1'] }]);
  assert.equal(f.operations.summary(job.date).rows[0].status, 'skipped');
  f.store.setExclusions([]); f.time(job.releaseAt + 10000); f.store.setEnabled(true, f.clock());
  const scheduler = new Scheduler(f.store, {}, f.clock); await scheduler.tick();
  assert.equal(f.store.data.jobs[job.id].status, 'missed');
});
test('transient preparation retries are bounded and never run before retry time', async () => {
  const f = fixture(); const job = generateJobs(f.store.data.config, f.store.accounts(), '2026-10-22')[0];
  f.time(job.releaseAt - 90000); f.store.setEnabled(true, f.clock()); let calls = 0;
  const scheduler = new Scheduler(f.store, { prepare: async () => { calls++; throw new Error('network timeout'); }, close: async () => {} }, f.clock);
  await scheduler.tick(); await scheduler.idle(); assert.equal(f.store.data.jobs[job.id].status, 'retrying');
  await scheduler.tick(); await scheduler.idle(); assert.equal(calls, 1);
  f.time(f.store.data.jobs[job.id].retryAt); await scheduler.tick(); await scheduler.idle();
  f.time(f.store.data.jobs[job.id].retryAt); await scheduler.tick(); await scheduler.idle();
  assert.equal(calls, 3); assert.equal(f.store.data.jobs[job.id].status, 'failed');
});
test('commit can retry only before saving; uncertain saves never resubmit', async () => {
  for (const enterSaving of [false, true]) {
    const f = fixture(); const job = generateJobs(f.store.data.config, f.store.accounts(), '2026-10-22')[0];
    f.time(job.releaseAt - 90000); f.store.setEnabled(true, f.clock()); let submits = 0;
    const scheduler = new Scheduler(f.store, { prepare: async () => ({}), commit: async (_job, beforeSave) => { submits++; if (enterSaving) beforeSave(); throw new Error('network timeout'); }, close: async () => {} }, f.clock);
    await scheduler.tick(); await scheduler.idle(); f.time(job.releaseAt); await scheduler.tick(); await scheduler.idle();
    assert.equal(f.store.data.jobs[job.id].status, enterSaving ? 'needs_review' : 'retrying');
    if (enterSaving) { f.time(job.releaseAt + 5000); await scheduler.tick(); await scheduler.idle(); assert.equal(submits, 1); }
  }
});
test('summary totals, account hours, CSV escaping and automatic daily report are consistent', () => {
  const f = fixture(); const jobs = generateJobs(f.store.data.config, f.store.accounts(), '2026-10-22');
  for (const job of jobs.slice(0, 4)) f.store.job(job, { status: 'success', accountLabel: '=unsafe' });
  f.store.job(jobs[4], { status: 'needs_review' });
  const result = f.operations.exportSummary('2026-10-29'); assert.equal(result.summary.success, 4); assert.equal(result.summary.uncertain, 1);
  assert.equal(result.summary.byAccount.find(a => a.accountId === 'a0').confirmedHours, 2);
  assert.ok(fs.readFileSync(result.files[1], 'utf8').includes("'=unsafe")); assert.ok(!fs.readFileSync(result.files[1], 'utf8').includes('local-dummy'));
  assert.equal(csvCell('  =SUM(1)'), '"\'  =SUM(1)"');
  f.time(Date.parse('2026-10-22T20:32:00+08:00')); f.operations.monitorTick(); f.operations.monitorTick();
  assert.ok(f.operations.state.autoReports['2026-10-22']); assert.equal(f.store.data.events.filter(e => e.type === 'summary').length, 1);
});
test('backup restore previews merge safely, preserves uncertain jobs and handles foreign DPAPI', async () => {
  const f = fixture(); const exported = f.operations.backup(); const backup = JSON.parse(fs.readFileSync(exported.file));
  assert.ok(!fs.readFileSync(exported.file, 'utf8').includes('local-dummy'));
  const g = fixture(); g.store.data.accounts = []; g.store.data.config.windows.forEach(w => { w.accountId = null; w.enabled = false; });
  g.store.data.jobs.existing = { id: 'existing', status: 'needs_review' }; g.store.persist();
  const preview = await g.operations.previewRestore(backup); assert.equal(preview.needsPassword, 0); assert.equal(g.store.data.accounts.length, 0);
  const restored = g.operations.restore(preview.token); assert.ok(fs.existsSync(restored.previousBackup)); assert.equal(g.store.data.accounts.length, 5); assert.equal(g.store.data.jobs.existing.status, 'needs_review'); assert.equal(g.store.data.config.enabled, false);
  const foreign = fixture(); foreign.store.data.accounts = []; foreign.store.vault = { unprotect: async () => { throw new Error('foreign machine'); } };
  const foreignPreview = await foreign.operations.previewRestore(backup); assert.equal(foreignPreview.needsPassword, 5); assert.equal(foreignPreview.enabledWindows, 5); assert.equal(foreignPreview.enabledAccounts, 0); assert.match(foreignPreview.selectionWarning, /密码|账号/);
  await assert.rejects(g.operations.previewRestore({ ...backup, accounts: [backup.accounts[0], backup.accounts[0]] }), /无效或重复/);
});
test('network changes and resume produce one notice per transition without changing scheduling', () => {
  const f = fixture(); f.operations.networkStatus(true); assert.equal(f.messages.length, 0);
  f.operations.networkStatus(false); f.operations.networkStatus(false); f.operations.networkStatus(true); assert.equal(f.messages.length, 2);
  f.operations.suspend(); f.time(f.clock() + 120000); f.operations.resume(); assert.equal(f.messages.length, 3); assert.equal(f.store.data.config.enabled, false);
});
function fakePage({ rejection = '', successes = [true] } = {}) {
  let logged = false, submits = 0, refreshes = 0;
  const page = { url: () => logged ? 'https://healthlab.zs-hospital.sh.cn/cf/main/!people/profile/index.1' : 'https://healthlab.zs-hospital.sh.cn/cf/main/login', waitForNavigation: async () => {}, waitForResponse: async () => ({ finished: async () => {} }), waitForTimeout: async () => {}, locator: selector => ({ screenshot: async () => {}, fill: async () => {}, count: async () => logged ? 0 : 1, innerText: async () => rejection, click: async () => { if (selector.startsWith('img')) refreshes++; else { logged = successes[submits] ?? false; submits++; } } }) };
  return { page, stats: () => ({ submits, refreshes }) };
}
test('invalid OCR refreshes captcha image before re-reading; website captcha rejection does likewise', async () => {
  const f = fakePage(); let reads = 0;
  await automaticLogin(f.page, 'dummy', 'never-log-me', base, { recognize: async () => { if (++reads === 1) throw new Error('OCR 未返回有效的四位验证码'); return 'abcd'; } });
  assert.deepEqual(f.stats(), { submits: 1, refreshes: 1 });
  const g = fakePage({ rejection: '验证码不正确', successes: [false, true] });
  await automaticLogin(g.page, 'dummy', 'never-log-me', base, { recognize: async () => 'abcd' }); assert.deepEqual(g.stats(), { submits: 2, refreshes: 1 });
  assert.equal(captchaRejected('密码错误'), false);
});
test('password errors stop immediately and repeated invalid OCR stops after two refreshes', async () => {
  const f = fakePage({ rejection: '用户名或密码错误', successes: [false] });
  await assert.rejects(automaticLogin(f.page, 'dummy', 'secret', base, { recognize: async () => 'abcd' }), /账号密码错误/); assert.deepEqual(f.stats(), { submits: 1, refreshes: 0 });
  const g = fakePage(); await assert.rejects(automaticLogin(g.page, 'dummy', 'secret', base, { recognize: async () => { throw new Error('OCR 未返回有效的四位验证码'); } }), /OCR/); assert.deepEqual(g.stats(), { submits: 0, refreshes: 2 });
});
test('failure diagnostics mask inputs, strip query secrets and ZIP excludes credentials', async () => {
  const f = fixture(); let masked;
  const page = { isClosed: () => false, url: () => 'https://healthlab.zs-hospital.sh.cn/cf/main/login?token=secret', locator: value => value, screenshot: async options => { masked = options.mask; fs.writeFileSync(options.path, 'fake-png'); } };
  const id = await captureFailure(f.root, { id: 'job', date: '2026-10-29', start: '08:30', end: '09:00', accountLabel: 'dummy' }, 'login', new Error('network timeout token=secret'), page);
  assert.ok(masked[0].includes('input')); const directory = diagnosticDirectory(f.root, id); const text = fs.readFileSync(path.join(directory, 'report.json'), 'utf8'); assert.ok(!text.includes('secret'));
  const file = path.join(f.root, 'diag.zip'); await archiveDiagnostics(f.root, id, file); assert.ok(fs.statSync(file).size > 0);
  assert.throws(() => diagnosticDirectory(f.root, '../manager'), /无效/);
});
test('manual pause while automatic preflight is pending cancels the subsequent start', async () => {
  const f = fixture(); let release; const gate = new Promise(resolve => { release = resolve; }); let probeStarted = false;
  f.options.localCheck = async id => { if(id === 'runtime') { probeStarted = true; await gate; } return {detail:'mock local check'}; };
  const manager = await createManager({ directory: path.join(f.root, 'http'), operationsRoot: f.root, port: 0, runScheduler: false, clock: f.clock, vault, localCheck: f.options.localCheck, workerFactory: () => f.worker });
  manager.store.data.accounts = f.store.data.accounts; manager.store.data.config = f.store.data.config;
  try {
    const state = await fetch(manager.url + '/api/state').then(r => r.json()); const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken };
    const start = fetch(manager.url + '/api/control', { method: 'POST', headers, body: '{"enabled":true}' });
    for (let i = 0; i < 50 && !probeStarted; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(probeStarted, true);
    await fetch(manager.url + '/api/control', { method: 'POST', headers, body: '{"enabled":false}' }); release();
    const response = await start; assert.equal(response.status, 400); assert.equal(manager.store.data.config.enabled, false);
  } finally { release(); await manager.close(); }
});
