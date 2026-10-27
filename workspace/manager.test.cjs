'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WINDOWS, defaults, generateJobs, validateWindows, addDays } = require('./schedule-logic.cjs');
const { ManagerStore } = require('./manager-store.cjs');
const { Scheduler } = require('./scheduler.cjs');
const { createManager } = require('./manager-server.cjs');
const tempRoot = path.join(__dirname, '..', 'work', 'tests');
fs.mkdirSync(tempRoot, { recursive: true });
const directory = () => fs.mkdtempSync(path.join(tempRoot, 'manager-'));
const fakeVault = { protect: async text => Buffer.from(text).toString('base64'), unprotect: async text => Buffer.from(text, 'base64').toString() };
function configuredStore() {
  const store = new ManagerStore(directory(), fakeVault);
  store.data.config.catchUpEnabled = false;
  store.data.accounts = WINDOWS.map((w, i) => ({ id: `a${i}`, label: `账号${i + 1}`, username: `user${i + 1}`, enabled: true, passwordCipher: 'test' }));
  store.setWindows(WINDOWS.map(w => ({id: w.id, enabled: true})));
  store.persist();
  return store;
}
test('twenty jobs use five accounts, four half-hour slots per window', () => {
  const store = configuredStore();
  const jobs = generateJobs(store.data.config, store.accounts(), '2026-10-22');
  assert.equal(jobs.length, 20);
  for (let i = 0; i < 5; i++) {
    const group = jobs.filter(j => j.windowId === `w${i + 1}`);
    assert.equal(group.length, 4);
    assert.ok(group.every(j => j.accountId === `a${i}`));
    assert.equal(group[0].start, WINDOWS[i].start);
    assert.equal(group[3].end, WINDOWS[i].end);
  }
  assert.equal(jobs[0].date, '2026-10-29');
  assert.equal(jobs[0].releaseAt, Date.parse('2026-10-22T09:00:00+08:00'));
  assert.equal(jobs.at(-1).releaseAt, Date.parse('2026-10-22T20:30:00+08:00'));
  assert.equal(addDays('2026-12-29', 7), '2027-01-05');
});
test('disabled or missing accounts do not execute; more than five enabled accounts are rejected', () => {
  const config = defaults();
  assert.equal(generateJobs(config, [], '2026-10-22').length, 0);
  assert.equal(generateJobs(config, [], '2026-10-22', 1, true).length, 20);
  const accounts = [{ id: 'same', enabled: true }];
  config.windows[0] = { id: 'w1', enabled: true, accountId: 'same' };
  config.windows[1] = { id: 'w2', enabled: true, accountId: 'same' };
  assert.equal(generateJobs(config, accounts, '2026-10-22').length, 4);
  assert.throws(() => validateWindows(config.windows, Array.from({length:6},(_,i)=>({id:String(i),enabled:true}))), /最多启用5/);
});
test('scheduler prepares ahead, submits each job once at release and preserves account isolation', async () => {
  const store = configuredStore();
  const jobs = generateJobs(store.data.config, store.accounts(), '2026-10-22');
  let now = Date.parse('2026-10-22T08:00:00+08:00');
  store.setEnabled(true, now);
  const preparations = [], saves = [];
  const worker = { prepare: async job => { preparations.push(job); return {}; }, commit: async (job, beforeSave) => { beforeSave(); saves.push({ ...job, actual: now }); return { status: 'created', reservationId: `fake-${job.id}` }; }, close: async () => {} };
  const scheduler = new Scheduler(store, worker, () => now);
  for (const job of jobs) {
    now = job.releaseAt - 90000; await scheduler.tick(); await scheduler.idle();
    assert.equal(saves.filter(s => s.id === job.id).length, 0);
    now = job.releaseAt - 1; await scheduler.tick(); await scheduler.idle();
    assert.equal(saves.filter(s => s.id === job.id).length, 0);
    now = job.releaseAt; await scheduler.tick(); await scheduler.idle();
    await scheduler.tick(); await scheduler.idle();
  }
  assert.equal(preparations.length, 20); assert.equal(saves.length, 20);
  assert.ok(saves.every(j => j.actual === j.releaseAt));
  assert.equal(new Set(saves.map(j => j.id)).size, 20);
  for (let i = 0; i < 5; i++) assert.equal(saves.filter(j => j.accountId === `a${i}`).length, 4);
});
test('disabled catch-up never backfills earlier releases and restart protects uncertain saves', async () => {
  const store = configuredStore(); let now = Date.parse('2026-10-22T10:00:01+08:00'); store.setEnabled(true, now);
  let prepares = 0;
  const scheduler = new Scheduler(store, { prepare: async () => { prepares++; return {}; }, close: async () => {} }, () => now);
  await scheduler.tick(); await scheduler.idle(); assert.equal(prepares, 0);
  const job = generateJobs(store.data.config, store.accounts(), '2026-10-22')[3];
  store.job(job, { status: 'saving' });
  const reloaded = new ManagerStore(path.dirname(store.file), fakeVault);
  assert.equal(reloaded.data.jobs[job.id].status, 'needs_review');
});
test('pause before save blocks submission; a save-time failure becomes needs_review', async () => {
  const store = configuredStore(); const job = generateJobs(store.data.config, store.accounts(), '2026-10-22')[0];
  let now = job.releaseAt - 90000; store.setEnabled(true, now);
  const worker = { prepare: async () => ({}), commit: async (j, beforeSave) => { beforeSave(); throw new Error('network lost'); }, close: async () => {} };
  const scheduler = new Scheduler(store, worker, () => now);
  await scheduler.tick(); await scheduler.idle(); store.setEnabled(false, now); now = job.releaseAt;
  await scheduler.tick(); await scheduler.idle(); assert.equal(store.data.jobs[job.id].status, 'ready');
  store.setEnabled(true, now); await scheduler.tick(); await scheduler.idle();
  assert.equal(store.data.jobs[job.id].status, 'needs_review');
  await scheduler.tick(); await scheduler.idle(); assert.equal(store.data.jobs[job.id].status, 'needs_review');
});
test('account password is not returned and window identity stays locked across reassignment', async () => {
  const store = new ManagerStore(directory(), fakeVault);
  const account = await store.saveAccount({ label: '测试', username: 'test-user', password: 'dummy-secret' });
  assert.equal(account.hasPassword, true); assert.equal(account.passwordCipher, undefined);
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes('dummy-secret'));
  assert.equal((await store.credentials(account.id)).password, 'dummy-secret');
  await assert.rejects(store.saveAccount({ ...account, username: 'other-user' }), /不能直接改名/);
  const configured = configuredStore();
  configured.data.bindings['2026-10-29|w1'] = 'a0';
  configured.data.config.windows[0].accountId = 'a4';
  const scheduler = new Scheduler(configured, {}, () => Date.parse('2026-10-22T08:00:00+08:00'));
  const jobs = scheduler.plan(1).filter(j => j.windowId === 'w1');
  assert.ok(jobs.every(j => j.accountId === 'a0'));
});
test('HTTP API rejects cross-origin writes, hides credentials and preview never calls browser', async () => {
  let browserCalls = 0;
  const app = await createManager({ directory: directory(), port: 0, runScheduler: false, vault: fakeVault, workerFactory: () => ({ close: async () => {}, testLogin: async () => { browserCalls++; return {}; } }) });
  try {
    const initial = await fetch(app.url + '/api/state').then(r => r.json());
    const bad = await fetch(app.url + '/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' }); assert.equal(bad.status, 403);
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': initial.csrfToken };
    const cross = await fetch(app.url + '/api/control', { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{"enabled":true}' }); assert.equal(cross.status, 403);
    const added = await fetch(app.url + '/api/accounts', { method: 'POST', headers, body: JSON.stringify({ label: '测试', username: 'local-test', password: 'not-a-real-password' }) }).then(r => r.json()); assert.equal(added.account.passwordCipher, undefined);
    const visible = await fetch(app.url + '/api/state').then(r => r.text()); assert.ok(!visible.includes('not-a-real-password')); assert.ok(!visible.includes('passwordCipher'));
    const simulation = await fetch(app.url + '/api/simulate', { method: 'POST', headers, body: '{"date":"2026-10-29"}' }).then(r => r.json());
    assert.equal(simulation.total, 20); assert.equal(simulation.simulation, true); assert.equal(browserCalls, 0);
    const html = await fetch(app.url).then(r => r.text()); assert.ok(html.includes('预约控制台'));
  } finally { await app.close(); }
});
test('daily shuffled mapping persists across restarts and all four slots keep their account', () => {
  const store = configuredStore();
  const mapping = store.assignment('2026-10-29', () => 0);
  assert.equal(Object.keys(mapping).length, 5);
  assert.equal(new Set(Object.values(mapping)).size, 5);
  assert.notDeepEqual(Object.values(mapping), ['a0', 'a1', 'a2', 'a3', 'a4']);
  const restored = new ManagerStore(path.dirname(store.file), fakeVault);
  assert.deepEqual(restored.assignment('2026-10-29', () => { throw new Error('Must not reshuffle'); }), mapping);
  const scheduler = new Scheduler(restored, {}, () => Date.parse('2026-10-22T07:00:00+08:00'));
  const plan = scheduler.plan(1);
  for (const window of WINDOWS) assert.ok(plan.filter(j => j.windowId === window.id).every(j => j.accountId === mapping[window.id]));
});
test('background browser context and process close when an account task finishes', async () => {
  const { BrowserWorker } = require('./browser-worker.cjs');
  const worker = new BrowserWorker({}, path.resolve(__dirname, '..'));
  let contextClosed = 0, browserClosed = 0;
  const context = { close: async () => { contextClosed++; } };
  worker.sessions.set('test', { context }); worker.contexts.add(context);
  worker.browser = { close: async () => { browserClosed++; } };
  await worker.releaseSession('test');
  assert.equal(contextClosed, 1); assert.equal(browserClosed, 1);
  assert.equal(worker.sessions.size, 0); assert.equal(worker.contexts.size, 0); assert.equal(worker.browser, null);
});
test('equipment navigation failure also closes the background task browser', async () => {
  const { BrowserWorker } = require('./browser-worker.cjs');
  const worker = new BrowserWorker({}, path.resolve(__dirname, '..'));
  let contextClosed = 0, browserClosed = 0;
  const context = { close: async () => { contextClosed++; } };
  const session = { context, page: { url: () => { throw new Error('navigation failed'); } } };
  worker.sessions.set('test', session); worker.contexts.add(context);
  worker.browser = { close: async () => { browserClosed++; } };
  worker.session = async () => session;
  await assert.rejects(worker.prepare({ accountId: 'test' }), /navigation failed/);
  assert.equal(contextClosed, 1); assert.equal(browserClosed, 1);
});
