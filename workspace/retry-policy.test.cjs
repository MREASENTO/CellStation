'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { ManagerStore } = require('./manager-store.cjs'); const { Scheduler } = require('./scheduler.cjs');
const { generateJobs, validateRetryPolicy } = require('./schedule-logic.cjs');
const { automaticLogin } = require('./auto-login.cjs'); const { Operations } = require('./operations.cjs');
const { createManager } = require('./manager-server.cjs');
const base = path.join(__dirname, '..', 'work', 'tests'); fs.mkdirSync(base, { recursive: true });
const vault = { protect: async s => Buffer.from(s).toString('base64'), unprotect: async s => Buffer.from(s, 'base64').toString() };
function fixture() {
  const root = fs.mkdtempSync(path.join(base, 'retry-')); const store = new ManagerStore(root, vault);
  store.data.accounts = [{ id: 'account', username: 'dummy', label: '模拟账号', enabled: true, revision: 1, passwordCipher: Buffer.from('local-test').toString('base64') }];
  store.data.config.windows[0] = { id: 'w1', enabled: true, accountId: 'account' }; store.persist();
  let now = Date.parse('2026-10-22T07:00:00+08:00');
  return { root, store, clock: () => now, time: value => { now = value; } };
}
function pageFixture({ failures = Infinity, feedback = '验证码不正确' } = {}) {
  let submits = 0, refreshes = 0, logged = false;
  return { page: { url: () => logged ? 'https://healthlab.zs-hospital.sh.cn/cf/main/!people/profile/index.1' : 'https://healthlab.zs-hospital.sh.cn/cf/main/login', waitForNavigation: async () => {}, waitForResponse: async () => ({ finished: async () => {} }), waitForTimeout: async () => {}, locator: selector => ({ screenshot: async () => {}, fill: async () => {}, count: async () => logged ? 0 : 1, innerText: async () => feedback, click: async () => { if (selector.startsWith('img')) refreshes++; else { submits++; logged = submits > failures; } } }) }, counts: () => ({ submits, refreshes }) };
}
test('retry settings migrate, persist and reject invalid values without changing saved state', () => {
  const f = fixture(); assert.deepEqual(f.store.data.config.retryPolicy, { taskRetries: 2, captchaRetries: 2 });
  f.store.setRetryPolicy({ taskRetries: 0, captchaRetries: 7 });
  assert.deepEqual(new ManagerStore(f.root, vault).data.config.retryPolicy, { taskRetries: 0, captchaRetries: 7 });
  for (const invalid of [-1, 21, 1.5, '2', null, true]) assert.throws(() => validateRetryPolicy({ taskRetries: invalid, captchaRetries: 2 }), /0至20/);
  assert.throws(() => f.store.setRetryPolicy({ taskRetries: 2, captchaRetries: 2, other: 1 }), /0至20/);
  f.store.setEnabled(true, f.clock()); f.store.setRetryPolicy({ taskRetries: 1, captchaRetries: 1 });
  assert.deepEqual(f.store.data.config.retryPolicy, { taskRetries: 1, captchaRetries: 1 });
});
test('scheduler enforces configured additional retries: zero, one and four', async () => {
  for (const limit of [0, 1, 4]) {
    const f = fixture(); f.store.setRetryPolicy({ taskRetries: limit, captchaRetries: 2 });
    const job = generateJobs(f.store.data.config, f.store.accounts(), '2026-10-22')[0]; f.time(job.releaseAt - 90000); f.store.setEnabled(true, f.clock()); let attempts = 0;
    const scheduler = new Scheduler(f.store, { prepare: async () => { attempts++; throw new Error('network timeout'); } }, f.clock);
    for (let i = 0; i <= limit; i++) { await scheduler.tick(); await scheduler.idle(); const record = f.store.data.jobs[job.id]; if (record.status === 'retrying') f.time(record.retryAt); }
    assert.equal(attempts, limit + 1); assert.equal(f.store.data.jobs[job.id].status, 'failed'); assert.equal(f.store.data.jobs[job.id].retryCount || 0, limit);
    if (limit) assert.equal(f.store.data.jobs[job.id].retryLimit, limit);
  }
});
test('captcha rejection enforces independent configured refresh counts including zero', async () => {
  for (const limit of [0, 1, 4]) {
    const f = pageFixture();
    await assert.rejects(automaticLogin(f.page, 'dummy', 'not-logged', base, { captchaRetries: limit, recognize: async () => 'abcd' }), error => error.code === 'CAPTCHA_RETRIES_EXHAUSTED' && error.retryable === false);
    assert.deepEqual(f.counts(), { submits: limit + 1, refreshes: limit });
  }
});
test('unreadable OCR observes refresh limit and can succeed within a larger configured budget', async () => {
  const f = pageFixture(); let reads = 0;
  await assert.rejects(automaticLogin(f.page, 'dummy', 'not-logged', base, { captchaRetries: 4, recognize: async () => { reads++; throw new Error('OCR 未返回有效的四位验证码'); } }), /4次/);
  assert.equal(reads, 5); assert.deepEqual(f.counts(), { submits: 0, refreshes: 4 });
  const g = pageFixture({ failures: 3 }); await automaticLogin(g.page, 'dummy', 'not-logged', base, { captchaRetries: 4, recognize: async () => 'abcd' });
  assert.deepEqual(g.counts(), { submits: 4, refreshes: 3 });
});
test('captcha exhaustion cannot be multiplied by outer task retries', async () => {
  const f = fixture(); f.store.setRetryPolicy({ taskRetries: 20, captchaRetries: 0 }); const page = pageFixture(); let failure;
  try { await automaticLogin(page.page, 'dummy', 'not-logged', base, { captchaRetries: 0, recognize: async () => 'abcd' }); } catch (error) { failure = error; }
  const job = generateJobs(f.store.data.config, f.store.accounts(), '2026-10-22')[0]; f.time(job.releaseAt - 90000); f.store.setEnabled(true, f.clock()); let attempts = 0;
  const scheduler = new Scheduler(f.store, { prepare: async () => { attempts++; throw failure; } }, f.clock);
  await scheduler.tick(); await scheduler.idle(); await scheduler.tick(); await scheduler.idle();
  assert.equal(attempts, 1); assert.equal(f.store.data.jobs[job.id].status, 'failed'); assert.equal(f.store.data.jobs[job.id].retryCount, undefined);
});
test('captcha retries stop at job deadline before another refresh or credential submission', async () => {
  for (const unreadable of [true, false]) {
    const f = pageFixture(); let now = 0;
    await assert.rejects(automaticLogin(f.page, 'dummy', 'not-logged', base, { captchaRetries: 20, deadline: 1, now: () => now, recognize: async () => { now = 2; if (unreadable) throw new Error('OCR 未返回有效'); return 'abcd'; } }), /超过执行时间/);
    assert.deepEqual(f.counts(), { submits: 0, refreshes: 0 });
  }
});
test('retry settings are included in backup restore; older backups retain current policy', async () => {
  const f = fixture(); f.store.setRetryPolicy({ taskRetries: 4, captchaRetries: 6 });
  const operations = new Operations({ root: f.root, store: f.store, worker: {}, clock: f.clock });
  const backup = JSON.parse(fs.readFileSync(operations.backup().file, 'utf8')); assert.deepEqual(backup.retryPolicy, { taskRetries: 4, captchaRetries: 6 });
  f.store.setRetryPolicy({ taskRetries: 1, captchaRetries: 0 }); let preview = await operations.previewRestore(backup); operations.restore(preview.token); assert.deepEqual(f.store.data.config.retryPolicy, { taskRetries: 4, captchaRetries: 6 });
  delete backup.retryPolicy; f.store.setRetryPolicy({ taskRetries: 7, captchaRetries: 1 }); preview = await operations.previewRestore(backup); operations.restore(preview.token); assert.deepEqual(f.store.data.config.retryPolicy, { taskRetries: 7, captchaRetries: 1 });
});
test('retry API validates CSRF and values and supports edits while running', async () => {
  const f = fixture(); const manager = await createManager({ directory: path.join(f.root, 'http'), port: 0, runScheduler: false, workerFactory: () => ({ close: async () => {} }) });
  try {
    const initial = await fetch(manager.url + '/api/state').then(r => r.json()); const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': initial.csrfToken };
    const post = (body, custom = headers) => fetch(manager.url + '/api/retry-policy', { method: 'PUT', headers: custom, body: JSON.stringify(body) });
    assert.equal((await post({ taskRetries: 3, captchaRetries: 5 }, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post({ taskRetries: 21, captchaRetries: 1 })).status, 400);
    assert.equal((await post({ taskRetries: 0, captchaRetries: 5 })).status, 200);
    assert.deepEqual(manager.store.data.config.retryPolicy, { taskRetries: 0, captchaRetries: 5 });
    manager.store.data.config.enabled = true; assert.equal((await post({ taskRetries: 2, captchaRetries: 2 })).status, 200); manager.store.data.config.enabled = false;
  } finally { await manager.close(); }
});
