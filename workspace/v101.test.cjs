'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createManager } = require('./manager-server.cjs');
const { ManagerStore } = require('./manager-store.cjs');
const { Operations } = require('./operations.cjs');
const { Scheduler } = require('./scheduler.cjs');
const { WechatNotifications } = require('./wechat-notifications.cjs');
const base = path.resolve(__dirname, '../work/tests'); fs.mkdirSync(base, { recursive: true });
const vault = { protect: async s => 'encrypted:' + s, unprotect: async s => s.slice(10) };
async function fixture() {
  const root = fs.mkdtempSync(path.join(base, 'v101-')), store = new ManagerStore(path.join(root, 'work/manager'), vault); store.data.config.catchUpEnabled = false;
  await store.saveAccount({ username: 'mock-account', owner: '模拟人', password: 'not-real' });
  return { root, store };
}
test('manual control starts offline without any remote probe or login and still accepts pause', async () => {
  const { root, store } = await fixture(); let remoteCalls = 0;
  const remote = async () => { remoteCalls++; throw new Error('network offline'); };
  const manager = await createManager({ directory: path.join(root, 'http'), operationsRoot: root, port: 0, runScheduler: false,
    vault, clock: () => Date.parse('2026-10-22T07:00:00+08:00'), localCheck: async () => ({}),
    workerFactory: () => ({ probeEnvironment: remote, testLogin: remote, prepare: remote, close: async () => {} }) });
  manager.store.data.accounts = store.data.accounts; manager.store.data.config = store.data.config;
  try {
    const state = await fetch(manager.url + '/api/state').then(r => r.json());
    const control = enabled => fetch(manager.url + '/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken }, body: JSON.stringify({ enabled }) });
    assert.equal((await control(true)).status, 200); assert.equal(manager.store.data.config.enabled, true); assert.equal(remoteCalls, 0);
    assert.equal((await control(false)).status, 200); assert.equal(manager.store.data.config.enabled, false);
  } finally { await manager.close(); }
});
test('optional website, login or instrument failures remain advisory; resume readiness never retries remote checks', async () => {
  for (const failure of ['website', 'login', 'equipment']) {
    const { root, store } = await fixture(); let remoteCalls = 0;
    const call = name => { remoteCalls++; if (name === failure) throw new Error('network timeout ' + name); };
    const op = new Operations({ root, store, localCheck: async () => ({}), worker: {
      probeEnvironment: async () => { call('website'); return { chrome: true, website: true }; },
      testLogin: async () => { call('login'); return { success: true }; },
      validateEquipment: async e => { call('equipment'); return { ...e, calendarId: 1 }; }
    } });
    await op.checkLocal(); op.startCheck(); const result = await op.checkPromise;
    assert.equal(result.canStart, true, failure); assert.equal(result.status, 'warning');
    const calls = remoteCalls; await op.ensureCheck(); assert.equal(remoteCalls, calls);
    assert.equal(Object.keys(store.data.jobs).length, 0);
    store.data.config.theme = 'dark'; await op.ensureCheck(); assert.equal(remoteCalls, calls);
  }
});
test('local runtime and invalid account/window configuration still block scheduling', async () => {
  const { root, store } = await fixture();
  const op = new Operations({ root, store, worker: {}, localCheck: async id => { if (id === 'ocr') throw new Error('model missing'); return {}; } });
  await assert.rejects(op.ensureCheck(), /本地必要自检未通过/);
  op.localCheck = async () => ({}); await op.checkLocal();
  store.data.accounts[0].passwordCipher = null; await assert.rejects(op.ensureCheck(), /密码/);
  store.data.accounts[0].enabled = false; await assert.rejects(op.ensureCheck(), /账号|窗口/);
});
test('actual login failure notifies only after configured retries; later slots recover without restarting scheduling', async () => {
  const { root, store } = await fixture(); const messages = [];
  const wechat = new WechatNotifications(path.join(root, 'wechat'), vault, async (_url, options) => { messages.push(new URLSearchParams(options.body).get('desp')); return new Response('{"code":0}'); });
  await wechat.update({ key: 'SCT_fake-key-for-local-tests', enabled: true, failure: true, success: false });
  store.onJob = job => wechat.enqueue(job);
  let now = Date.parse('2026-10-22T07:00:00+08:00'), attempts = 0, fail = true;
  const worker = { prepare: async () => { attempts++; if (fail) throw new Error('network timeout during login'); return {}; }, commit: async (_j, save) => { save(); return { status: 'created' }; }, releaseSession: async () => {} };
  const op = new Operations({ root, store, worker, clock: () => now, localCheck: async () => ({}) });
  await op.ensureCheck(); store.setEnabled(true, now); const sc = new Scheduler(store, worker, () => now), jobs = sc.plan(1);
  await sc.tick(); await sc.idle(); await wechat.idle(); assert.equal(attempts, 0); assert.equal(messages.length, 0);
  now = jobs[0].releaseAt - store.data.config.prewarmSeconds * 1000;
  for (let i = 0; i <= store.data.config.retryPolicy.taskRetries; i++) {
    await sc.tick(); await sc.idle(); await wechat.idle();
    const record = store.data.jobs[jobs[0].id];
    if (record.status === 'retrying') { assert.equal(messages.length, 0); now = record.retryAt; }
  }
  assert.equal(attempts, 1 + store.data.config.retryPolicy.taskRetries); assert.equal(messages.length, 1);
  assert.match(messages[0], /模拟人/); assert.match(messages[0], /08:30–09:00/); assert.match(messages[0], /login/);
  assert.equal(store.data.config.enabled, true); await sc.tick(); await sc.idle(); await wechat.idle(); assert.equal(messages.length, 1);
  fail = false; now = jobs[1].releaseAt - store.data.config.prewarmSeconds * 1000; await sc.tick(); await sc.idle();
  now = jobs[1].releaseAt; await sc.tick(); await sc.idle();
  assert.equal(store.data.jobs[jobs[1].id].status, 'success'); assert.equal(messages.length, 1);
  wechat.enqueue(store.data.jobs[jobs[0].id]); await wechat.idle(); assert.equal(messages.length, 1);
});
