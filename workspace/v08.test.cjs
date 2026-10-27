'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { ManagerStore } = require('./manager-store.cjs');
const { Scheduler } = require('./scheduler.cjs');
const { Operations } = require('./operations.cjs');
const { WINDOWS, generateJobs } = require('./schedule-logic.cjs');
const { createManager } = require('./manager-server.cjs');
const base = path.resolve(__dirname, '../work/tests'); fs.mkdirSync(base, { recursive: true });
const vault = { protect: async s => 'test:' + s, unprotect: async s => { if (!s.startsWith('test:')) throw new Error('foreign'); return s.slice(5); } };
const windows = (...ids) => WINDOWS.map(w => ({ id: w.id, enabled: ids.includes(w.id) }));
async function fixture(n = 1) {
  const root = fs.mkdtempSync(path.join(base, 'v08-')), store = new ManagerStore(path.join(root, 'work/manager'), vault); store.data.config.catchUpEnabled = false;
  for (let i = 0; i < n; i++) await store.saveAccount({ username: 'test' + i, owner: '模拟使用人' + i, password: 'dummy' });
  return { root, store, op: new Operations({ root, store, worker: {} }) };
}
test('one account can select the evening window: exactly four jobs, one account and correct end-based release', async () => {
  const f = await fixture(); f.store.setWindows(windows('w5'));
  const raw = generateJobs(f.store.data.config, f.store.accounts(), '2026-10-22');
  assert.equal(raw.length, 4); assert.ok(raw.every(j => j.windowId === 'w5' && j.accountId));
  assert.equal(raw[0].releaseAt, Date.parse('2026-10-22T19:00:00+08:00'));
  const plan = new Scheduler(f.store, {}, () => Date.parse('2026-10-22T07:00:00+08:00')).plan(1);
  assert.equal(plan.length, 4); assert.ok(plan.every(j => j.windowId === 'w5'));
  assert.equal(f.op.summary('2026-10-29').pending, 4);
  assert.equal(f.op.summary('2026-10-29').disabled, 16);
  const reloaded = new ManagerStore(path.dirname(f.store.file), vault);
  assert.deepEqual(reloaded.data.config.windows, windows('w5'));
});
test('three nonconsecutive windows receive different accounts; unused accounts remain eligible when fewer windows selected', async () => {
  const f = await fixture(3); f.store.setWindows(windows('w1', 'w3', 'w5'));
  let mapping = f.store.assignment('2026-10-29', () => 0);
  assert.equal(new Set(Object.values(mapping)).size, 3);
  const plan = new Scheduler(f.store, {}, () => Date.parse('2026-10-22T07:00:00+08:00')).plan(1);
  assert.equal(plan.length, 12); assert.deepEqual([...new Set(plan.map(j => j.windowId))], ['w1', 'w3', 'w5']);
  for (const id of ['w1', 'w3', 'w5']) assert.equal(new Set(plan.filter(j => j.windowId === id).map(j => j.accountId)).size, 1);
  f.store.setWindows(windows('w4')); mapping = f.store.assignment('2026-10-30', () => 0);
  assert.equal(Object.keys(mapping).length, 1); assert.notEqual(mapping.w4, f.store.accounts()[0].id);
});
test('selection cannot exceed enabled accounts; empty selection and later account shortage block start', async () => {
  const f = await fixture(2); assert.throws(() => f.store.setWindows(windows('w1', 'w3', 'w5')), /最多选择2/);
  f.store.setWindows(windows()); assert.throws(() => f.store.setEnabled(true), /至少一个预约窗口/);
  f.store.setWindows(windows('w3', 'w5')); await f.store.saveAccount({ id: f.store.accounts()[1].id, enabled: false });
  assert.deepEqual(f.store.data.config.windows, windows('w3', 'w5')); assert.throws(() => f.store.setEnabled(true), /已选2个窗口/);
});
test('changing selected windows while a job is prepared preserves its snapshot and same-day account lock', async () => {
  const f = await fixture(); let now = Date.parse('2026-10-22T08:58:30+08:00'); const saved = [];
  const sc = new Scheduler(f.store, { prepare: async () => ({}), commit: async (j, before) => { before(); saved.push(j); return { status: 'created', reservationId: 'mock' }; }, releaseSession: async () => {} }, () => now);
  f.store.setEnabled(true, now); await sc.tick(); await sc.idle(); f.store.setWindows(windows('w5'));
  now = Date.parse('2026-10-22T09:00:00+08:00'); await sc.tick(); await sc.idle(); assert.equal(saved.length, 1); assert.equal(saved[0].windowId, 'w1');
  assert.equal(sc.plan(1).length, 0); assert.ok(sc.plan(2).some(j => j.windowId === 'w5' && j.date === '2026-10-30'));
});
test('v0.7 migration preserves former effective first N windows, credentials, records and daily locks', async () => {
  const f = await fixture(2); const raw = structuredClone(f.store.data);
  delete raw.windowSelectionMigration; delete raw.windowSelectionManual; raw.config.windows = windows(...WINDOWS.map(w => w.id));
  raw.jobs.mock = { id: 'mock', status: 'failed' }; raw.bindings['2026-10-29|w2'] = raw.accounts[0].id;
  fs.writeFileSync(f.store.file, JSON.stringify(raw)); const s = new ManagerStore(path.dirname(f.store.file), vault);
  assert.deepEqual(s.data.config.windows, windows('w1', 'w2')); assert.deepEqual(s.data.bindings, raw.bindings);
  assert.deepEqual(s.data.accounts, raw.accounts); assert.equal(s.data.jobs.mock.status, 'failed');
});
test('backup v2 round-trips arbitrary windows, previews merge and password fallback, preserves records and produces recovery backup', async () => {
  const source = await fixture(2); source.store.setWindows(windows('w3', 'w5'));
  const backup = JSON.parse(fs.readFileSync(source.op.backup().file)); assert.equal(backup.version, 3);
  const target = await fixture(); await target.store.saveAccount({ username: 'extra', password: 'dummy', enabled: false });
  target.store.data.jobs.history = { id: 'history', status: 'needs_review' }; target.store.persist();
  backup.accounts[0].passwordCipher = 'foreign-cipher'; backup.accounts[0].owner = '导入使用人';
  const before = fs.readFileSync(target.store.file, 'utf8'), preview = await target.op.previewRestore(backup);
  assert.equal(fs.readFileSync(target.store.file, 'utf8'), before); assert.equal(preview.newAccounts, 1); assert.equal(preview.updatedAccounts, 1); assert.equal(preview.retainedAccounts, 1);
  assert.equal(preview.accountChanges[0].password, '保留本机可用密码'); assert.equal(preview.needsPassword, 0); assert.deepEqual(preview.selectedWindows, ['13:30–15:30', '18:30–20:30']);
  const result = target.op.restore(preview.token); assert.ok(fs.existsSync(result.previousBackup)); assert.equal(result.importedAccounts, 2);
  assert.deepEqual(target.store.data.config.windows, windows('w3', 'w5')); assert.equal(target.store.data.jobs.history.status, 'needs_review'); assert.equal(target.store.data.config.enabled, false);
  const s = new ManagerStore(path.dirname(target.store.file), vault); assert.deepEqual(s.data.config.windows, windows('w3', 'w5')); assert.equal(s.data.accounts.length, 3);
});
test('foreign passwords are disabled with an explicit selection warning; v1 backups retain their former first N meaning', async () => {
  const source = await fixture(2), backup = JSON.parse(fs.readFileSync(source.op.backup().file)), target = await fixture(0);
  target.store.vault = { unprotect: async () => { throw new Error('foreign'); } };
  let preview = await target.op.previewRestore(backup); assert.equal(preview.needsPassword, 2); assert.equal(preview.enabledAccounts, 0); assert.match(preview.selectionWarning, /账号/);
  target.op.restore(preview.token); assert.ok(target.store.accounts().every(a => !a.enabled && !a.hasPassword));
  const local = await fixture(0); backup.version = 1; delete backup.windowSelectionMigration; backup.windows = windows(...WINDOWS.map(w => w.id));
  preview = await local.op.previewRestore(backup); assert.deepEqual(preview.selectedWindows, ['08:30–10:30', '11:00–13:00']);
});
test('backup preview is invalidated by theme changes and fails without overwriting current data', async () => {
  const f = await fixture(); const preview = await f.op.previewRestore(JSON.parse(fs.readFileSync(f.op.backup().file)));
  f.store.setTheme('dark'); assert.throws(() => f.op.restore(preview.token), /配置变化/); assert.equal(f.store.data.config.theme, 'dark');
});
test('HTTP window autosave works during a busy task; native export cancellation creates no file and reveal uses only exported path', async () => {
  const f = await fixture(); let chosen = null, revealed;
  const desktop = { status: () => ({}), chooseBackupPath: async () => chosen, revealBackup: async file => { revealed = file; } };
  const app = await createManager({ directory: path.dirname(f.store.file), operationsRoot: f.root, port: 0, runScheduler: false, vault, desktopIntegration: desktop, workerFactory: () => ({ close: async () => {} }) });
  try {
    const state = await fetch(app.url + '/api/state').then(r => r.json()); const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken };
    const call = async (route, data, method = 'POST') => { const r = await fetch(app.url + '/api/' + route, { method, headers, body: JSON.stringify(data) }); assert.equal(r.status, 200); return r.json(); };
    app.scheduler.busy.set('mock', Promise.resolve()); await call('windows', { windows: windows('w5') }, 'PUT'); assert.deepEqual(app.store.data.config.windows, windows('w5')); app.scheduler.busy.clear();
    const before = fs.readdirSync(app.operations.exports); assert.deepEqual(await call('backup/export', { chooseLocation: true }), { cancelled: true }); assert.deepEqual(fs.readdirSync(app.operations.exports), before);
    chosen = path.join(f.root, 'chosen-backup.json'); const exported = await call('backup/export', { chooseLocation: true, destination: 'C:/ignored.json' });
    assert.equal(exported.file, chosen); assert.ok(fs.existsSync(chosen)); await call('backup/reveal', {}); assert.equal(revealed, chosen);
    assert.deepEqual(JSON.parse(fs.readFileSync(chosen)).windows, windows('w5'));
  } finally { app.scheduler.busy.clear(); await app.close(); }
});
