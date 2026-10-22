'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { ManagerStore } = require('./manager-store.cjs'), { Scheduler } = require('./scheduler.cjs'), { Operations } = require('./operations.cjs'), { createManager } = require('./manager-server.cjs');
const { WINDOWS, generateJobs, windowsFor } = require('./schedule-logic.cjs');
const base = path.resolve(__dirname, '../work/tests'); fs.mkdirSync(base, { recursive: true });
const now = Date.parse('2026-10-22T07:00:00+08:00'), date = '2026-10-29';
const vault = { protect: async s => 'dummy:' + s, unprotect: async s => { if (!s.startsWith('dummy:')) throw new Error('foreign'); return s.slice(6); } };
async function fixture(n = 3) {
  const root = fs.mkdtempSync(path.join(base, 'v081-')), store = new ManagerStore(path.join(root, 'work/manager'), vault);
  for (let i = 0; i < n; i++) await store.saveAccount({ username: 'dummy-user' + i, owner: '模拟使用人' + i, password: 'not-real' });
  const op = new Operations({ root, store, worker: {}, clock: () => now }); return { root, store, op };
}
test('rerandomization changes available combinations, retains selected windows and other dates, and survives restart', async () => {
  const f = await fixture(); const first = f.store.assignmentView(date), other = structuredClone(f.store.assignment('2026-10-30'));
  const result = f.store.rerandomize(date, first.revision, now, () => 0);
  assert.equal(result.changed, true); assert.notDeepEqual(result.mapping, first.mapping); assert.deepEqual(result.windows, first.windows);
  assert.deepEqual(f.store.assignment('2026-10-30'), other); assert.equal(new Set(Object.values(result.mapping)).size, 3);
  const reloaded = new ManagerStore(path.dirname(f.store.file), vault); assert.deepEqual(reloaded.assignment(date), result.mapping);
  const plan = new Scheduler(reloaded, {}, () => now).plan(1); assert.equal(plan.length, 12);
  for (const w of first.windows.filter(w => w.enabled)) assert.ok(plan.filter(j => j.windowId === w.id).every(j => j.accountId === result.mapping[w.id]));
});
test('single window can rerandomize across spare accounts; single combination is explicitly reported', async () => {
  const f = await fixture(2); f.store.setWindows(WINDOWS.map(w => ({ id: w.id, enabled: w.id === 'w5' })));
  const first = f.store.assignmentView(date), result = f.store.rerandomize(date, first.revision, now);
  assert.equal(result.changed, true); assert.notEqual(result.mapping.w5, first.mapping.w5);
  const one = await fixture(1), only = one.store.assignmentView(date), unchanged = one.store.rerandomize(date, only.revision, now);
  assert.equal(unchanged.changed, false); assert.match(unchanged.message, /只有一种/); assert.deepEqual(unchanged.mapping, only.mapping);
});
test('manual account selection swaps assignments without duplication and supports an unused enabled account', async () => {
  const f = await fixture(3), first = f.store.assignmentView(date), a = first.mapping.w1, b = first.mapping.w2;
  let changed = f.store.setAssignment(date, 'w1', b, first.revision, now); assert.equal(changed.mapping.w1, b); assert.equal(changed.mapping.w2, a);
  f.store.setWindows(WINDOWS.map(w => ({ id: w.id, enabled: w.id === 'w1' })));
  changed = f.store.assignmentView(date); const spare = f.store.accounts().find(x => x.id !== changed.mapping.w1);
  const selected = f.store.setAssignment(date, 'w1', spare.id, changed.revision, now); assert.equal(selected.mapping.w1, spare.id); assert.equal(Object.keys(selected.mapping).length, 1);
});
test('moving to an unused time changes only that target date and actual plan; moving onto an occupied window swaps accounts', async () => {
  const f = await fixture(2), first = f.store.assignmentView(date), a = first.mapping.w1, b = first.mapping.w2, otherDate = structuredClone(f.store.assignment('2026-10-30'));
  const moved = f.store.moveAssignment(date, 'w1', 'w5', first.revision, now);
  assert.equal(moved.customWindows, true); assert.deepEqual(moved.windows.filter(w => w.enabled).map(w => w.id), ['w2', 'w5']);
  assert.equal(moved.mapping.w5, a); assert.equal(moved.mapping.w2, b); assert.equal(moved.mapping.w1, undefined);
  assert.deepEqual(f.store.data.config.windows.filter(w => w.enabled).map(w => w.id), ['w1', 'w2']);
  assert.deepEqual(windowsFor(f.store.data.config, '2026-10-30'), f.store.data.config.windows);
  const sc = new Scheduler(f.store, {}, () => now); const plan = sc.plan(1); assert.equal(plan.length, 8); assert.ok(!plan.some(j => j.windowId === 'w1'));
  assert.ok(plan.filter(j => j.windowId === 'w5').every(j => j.accountId === a)); assert.equal(f.op.summary(date).pending, 8);
  const swapped = f.store.moveAssignment(date, 'w2', 'w5', moved.revision, now); assert.equal(swapped.mapping.w2, a); assert.equal(swapped.mapping.w5, b);
  assert.deepEqual(swapped.windows, moved.windows); assert.deepEqual(f.store.assignment('2026-10-30'), otherDate);
});
test('prepared windows remain manually editable; actual concurrent edits still reject stale views', async () => {
  const f = await fixture(3), first = f.store.assignmentView(date);
  f.store.data.bindings[date + '|w1'] = first.mapping.w1;
  let changed = f.store.setAssignment(date, 'w1', first.mapping.w2, first.revision, now);
  assert.equal(changed.mapping.w1, first.mapping.w2); assert.equal(changed.mapping.w2, first.mapping.w1);
  assert.equal(Object.keys(f.store.lockedAssignments(date)).length, 0);
  assert.throws(() => f.store.moveAssignment(date, 'w1', 'w5', first.revision, now), /分配已变化/);
  for (const w of ['w1', 'w2', 'w3']) f.store.data.bindings[date + '|' + w] = changed.mapping[w];
  changed = f.store.rerandomize(date, changed.revision, now);
  assert.equal(changed.changed, true); assert.equal(new Set(Object.values(changed.mapping)).size, 3);
  const moved = f.store.moveAssignment(date, 'w1', 'w5', changed.revision, now);
  assert.equal(moved.mapping.w5, changed.mapping.w1); assert.deepEqual(moved.locked, {});
});
test('unrelated window/account edits retain valid manual results; restoring daily windows removes only the selected date override', async () => {
  const f = await fixture(3); let current = f.store.assignmentView(date);
  current = f.store.moveAssignment(date, 'w1', 'w5', current.revision, now); const saved = structuredClone(current.mapping);
  await f.store.saveAccount({ id: f.store.accounts()[0].id, owner: '新备注' }); assert.deepEqual(f.store.assignment(date), saved);
  f.store.setWindows(WINDOWS.map(w => ({ id: w.id, enabled: ['w1', 'w4'].includes(w.id) })));
  assert.deepEqual(f.store.assignment(date), saved); assert.deepEqual(windowsFor(f.store.data.config, date).filter(w => w.enabled).map(w => w.id), ['w2', 'w3', 'w5']);
  current = f.store.assignmentView(date); const reset = f.store.resetDateWindows(date, current.revision, now);
  assert.equal(reset.customWindows, false); assert.deepEqual(reset.windows.filter(w => w.enabled).map(w => w.id), ['w1', 'w4']);
});
test('scheduler executes the moved evening slot exactly once and every later half hour keeps the same account', async () => {
  const f = await fixture(1), initial = f.store.assignmentView(date); f.store.moveAssignment(date, 'w1', 'w5', initial.revision, now);
  let clock = Date.parse('2026-10-22T18:58:30+08:00'); const prepared = [], committed = [];
  const sc = new Scheduler(f.store, { prepare: async j => { prepared.push(j); return {}; }, commit: async (j, before) => { before(); committed.push(j); return { status: 'created', reservationId: 'mock' }; }, releaseSession: async () => {} }, () => clock);
  f.store.setEnabled(true, clock); await sc.tick(); await sc.idle(); assert.equal(prepared.length, 1); assert.equal(prepared[0].start, '18:30');
  assert.equal(f.store.assignmentView(date).customWindows,true);
  clock = Date.parse('2026-10-22T19:00:00+08:00'); await sc.tick(); await sc.idle(); await sc.tick(); await sc.idle(); assert.equal(committed.length, 1);
  assert.ok(sc.plan(1).every(j => j.accountId === prepared[0].accountId && j.windowId === 'w5'));
});
test('backup v3 restores date-specific windows and manual mappings by username with newly allocated local ids; v2 remains readable', async () => {
  const source = await fixture(2); let first = source.store.assignmentView(date); source.store.moveAssignment(date, 'w1', 'w5', first.revision, now);
  first = source.store.assignmentView(date); source.store.setAssignment(date, 'w5', first.mapping.w2, first.revision, now);
  const backup = JSON.parse(fs.readFileSync(source.op.backup().file)); assert.equal(backup.version, 3); assert.ok(backup.dateWindows[date]); assert.ok(backup.assignmentPlans[date]);
  const target = await fixture(0), preview = await target.op.previewRestore(backup); assert.equal(preview.customDates, 1); assert.equal(preview.assignmentDays, 1); assert.equal(preview.dateDetails[0].accounts.length, 2);
  target.op.restore(preview.token); const restored = target.store.assignmentView(date);
  assert.deepEqual(restored.windows, source.store.assignmentView(date).windows);
  for (const [id, username] of Object.entries(backup.assignmentPlans[date].mapping)) assert.equal(target.store.accounts().find(a => a.id === restored.mapping[id]).username, username);
  const reloaded = new ManagerStore(path.dirname(target.store.file), vault); assert.deepEqual(reloaded.assignmentView(date).mapping, restored.mapping);
  const old = structuredClone(backup); old.version = 2; delete old.assignmentPlans; delete old.dateWindows; const fresh = await fixture(0);
  const compatible = await fresh.op.previewRestore(old); assert.equal(compatible.assignmentDays, 0); assert.equal(compatible.customDates, 0);
});
test('invalid dates, disabled accounts, duplicate backup mappings and stale backup previews cannot mutate an assignment', async () => {
  const f = await fixture(2), first = f.store.assignmentView(date);
  assert.doesNotThrow(() => f.store.rerandomize('2026-10-28', undefined, now));
  assert.throws(() => f.store.rerandomize('2026-02-30', undefined, now), /日期无效/);
  assert.throws(() => f.store.moveAssignment(date, 'w1', 'w9', first.revision, now), /有效/);
  const backup = JSON.parse(fs.readFileSync(f.op.backup().file)), preview = await f.op.previewRestore(backup);
  f.store.rerandomize(date, first.revision, now); assert.throws(() => f.op.restore(preview.token), /配置变化/);
  backup.assignmentPlans = { [date]: { mode: 'manual', mapping: { w1: backup.accounts[0].username, w2: backup.accounts[0].username } } };
  await assert.rejects(f.op.previewRestore(backup), /重复账号/);
  backup.assignmentPlans = {}; backup.dateWindows = { '2026-02-30': WINDOWS.map(w => ({ id: w.id, enabled: false })) };
  await assert.rejects(f.op.previewRestore(backup), /无效日期/);
});
test('date-specific windows with too few accounts block startup even when daily defaults are valid', async () => {
  const f = await fixture(2); let current = f.store.assignmentView(date); f.store.moveAssignment(date, 'w1', 'w5', current.revision, now);
  f.store.setWindows(WINDOWS.map(w => ({ id: w.id, enabled: w.id === 'w1' })));
  await f.store.saveAccount({ id: f.store.accounts()[1].id, enabled: false });
  assert.throws(() => f.store.setEnabled(true, now), /2026-10-29 单日配置/);
});
test('assignment APIs enforce CSRF and revisions while allowing changes during other active work; simulation reflects moved slots', async () => {
  const f = await fixture(2), app = await createManager({ directory: path.dirname(f.store.file), operationsRoot: f.root, port: 0, runScheduler: false, vault, clock: () => now, workerFactory: () => ({ close: async () => {} }) });
  try {
    const state = await fetch(app.url + '/api/state').then(r => r.json()), headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken };
    const call = async (route, data) => { const r = await fetch(app.url + '/api/' + route, { method: 'POST', headers, body: JSON.stringify(data) }); return { status: r.status, body: await r.json() }; };
    const denied = await fetch(app.url + '/api/assignments/randomize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(denied.status, 403);
    const first = (await call('assignments/view', { date })).body; app.scheduler.busy.set('mock', Promise.resolve());
    const moved = await call('assignments/move', { date, fromId: 'w1', toId: 'w5', revision: first.revision }); assert.equal(moved.status, 200);
    const stale = await call('assignments/randomize', { date, revision: first.revision }); assert.equal(stale.status, 400);
    const simulation = await call('simulate', { date }); assert.equal(simulation.body.assigned, 8); assert.ok(simulation.body.jobs.filter(j => j.available).every(j => ['w2', 'w5'].includes(j.windowId)));
    assert.equal((await call('assignments/randomize', { date })).status, 400);
  } finally { app.scheduler.busy.clear(); await app.close(); }
});

test('changes while asynchronous password preview runs invalidate the preview before a restore token is issued', async () => {
  const f = await fixture(2), backup = JSON.parse(fs.readFileSync(f.op.backup().file));
  let release; const gate = new Promise(resolve => { release = resolve; }); const original = f.store.vault;
  f.store.vault = { ...original, unprotect: async s => { await gate; return original.unprotect(s); } };
  const preview = f.op.previewRestore(backup); const current = f.store.assignmentView(date); f.store.rerandomize(date,current.revision,now); release();
  await assert.rejects(preview,/预览生成期间变化/);assert.equal(f.op.restorePlan,null);
});
