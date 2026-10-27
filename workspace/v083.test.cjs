'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { ManagerStore } = require('./manager-store.cjs'), { Scheduler } = require('./scheduler.cjs');
const { WINDOWS } = require('./schedule-logic.cjs');
const date = '2026-10-29', release = Date.parse('2026-10-22T09:00:00+08:00');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(hooks = {}) {
  const directory = fs.mkdtempSync(path.resolve(__dirname, '../work/tests/v083-'));
  const store = new ManagerStore(directory, { protect: async s => 'mock:' + s, unprotect: async s => s.slice(5) }); store.data.config.catchUpEnabled = false;
  for (let i = 0; i < 2; i++) await store.saveAccount({ username: 'mock-user-' + i, password: 'not-real', owner: '测试' + i });
  let clock = release - 90000;
  const prepared = [], saves = [], closed = [];
  const worker = {
    prepare: async j => { prepared.push(j); await hooks.prepare?.(j); return {}; },
    commit: async (j, before) => { await hooks.before?.(j); before(); saves.push(j); await hooks.saved?.(j); return { status: 'created', reservationId: 'mock' }; },
    releaseSession: async id => { closed.push(id); }, close: async () => {},
  };
  const scheduler = new Scheduler(store, worker, () => clock);
  store.setEnabled(true, clock);
  const tick = async () => { await scheduler.tick(); await scheduler.idle(); };
  return { store, scheduler, prepared, saves, closed, tick, setClock: t => { clock = t; } };
}
test('ready task can change account; old session is discarded and only replacement account saves once', async () => {
  const f = await fixture(); await f.tick(); const old = f.prepared[0], view = f.store.assignmentView(date);
  const updated = f.store.setAssignment(date, 'w1', view.mapping.w2, view.revision, release - 60000);
  await f.tick(); assert.equal(f.closed.includes(old.accountId), true); assert.equal(f.scheduler.prepared.size, 0);
  await f.tick(); assert.equal(f.prepared.length, 2); assert.equal(f.prepared[1].accountId, updated.mapping.w1);
  f.setClock(release); await f.tick(); await f.tick(); assert.equal(f.saves.length, 1); assert.equal(f.saves[0].accountId, updated.mapping.w1);
  assert.equal(f.store.data.jobs[old.id].status, 'success');
});
test('moving a ready slot withdraws old preparation and changes all remaining slots without saving the old time', async () => {
  const f = await fixture(); await f.tick(); const view = f.store.assignmentView(date);
  f.store.moveAssignment(date, 'w1', 'w5', view.revision, release - 60000);
  await f.tick(); f.setClock(release); await f.tick(); assert.equal(f.saves.length, 0);
  assert.ok(f.scheduler.plan(1).every(j => j.windowId !== 'w1'));
  f.setClock(Date.parse('2026-10-22T18:58:30+08:00')); await f.tick();
  f.setClock(Date.parse('2026-10-22T19:00:00+08:00')); await f.tick(); await f.tick();
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].windowId, 'w5');
});
test('edit during asynchronous login cannot resurrect an obsolete ready task', async () => {
  const wait = gate(), entered = gate(); let first = true;
  const f = await fixture({ prepare: async () => { if (first) { first = false; entered.resolve(); await wait.promise; } } });
  await f.scheduler.tick(); await entered.promise;
  const view = f.store.assignmentView(date); f.store.setAssignment(date, 'w1', view.mapping.w2, view.revision, release - 60000);
  wait.resolve(); await f.scheduler.idle(); assert.equal(f.scheduler.prepared.size, 0); assert.equal(f.scheduler.snapshots.size, 0);
  await f.tick(); f.setClock(release); await f.tick(); assert.equal(f.saves.length, 1); assert.notEqual(f.saves[0].accountId, view.mapping.w1);
});
test('edit while opening form is rechecked immediately before save; obsolete request is never submitted', async () => {
  const wait = gate(), entered = gate(); let first = true;
  const f = await fixture({ before: async () => { if (first) { first = false; entered.resolve(); await wait.promise; } } });
  await f.tick(); f.setClock(release); await f.scheduler.tick(); await entered.promise;
  const view = f.store.assignmentView(date); f.store.setAssignment(date, 'w1', view.mapping.w2, view.revision, release);
  wait.resolve(); await f.scheduler.idle(); assert.equal(f.saves.length, 0);
  await f.tick(); await f.tick(); await f.tick(); assert.equal(f.saves.length, 1); assert.equal(f.saves[0].accountId, view.mapping.w2);
});
test('edit after save is accepted while result is reconciled; the same slot is never resubmitted', async () => {
  const wait = gate(), entered = gate(); const f = await fixture({ saved: async () => { entered.resolve(); await wait.promise; } });
  await f.tick(); f.setClock(release); await f.scheduler.tick(); await entered.promise;
  const view = f.store.assignmentView(date), updated = f.store.setAssignment(date, 'w1', view.mapping.w2, view.revision, release);
  assert.equal(updated.mapping.w1, view.mapping.w2); assert.equal(f.saves.length, 1);
  wait.resolve(); await f.scheduler.idle(); await f.tick(); await f.tick(); assert.equal(f.saves.length, 1);
  const original = f.saves[0]; assert.equal(f.store.data.jobs[original.id].accountId, original.accountId); assert.equal(f.store.data.jobs[original.id].status, 'success');
  f.setClock(release + 30 * 60000 - 90000); await f.tick(); assert.equal(f.prepared.at(-1).accountId, updated.mapping.w1);
});
test('restore generic windows remains editable after preparation and withdrawal follows the new date plan', async () => {
  const f = await fixture(); let view = f.store.assignmentView(date);
  f.store.moveAssignment(date, 'w1', 'w5', view.revision, release - 90000);
  f.setClock(Date.parse('2026-10-22T18:58:30+08:00')); await f.tick();
  view = f.store.assignmentView(date); const reset = f.store.resetDateWindows(date, view.revision);
  assert.equal(reset.customWindows, false); assert.equal(Object.values(reset.mapping).filter(Boolean).length, 2);
  await f.tick(); f.setClock(Date.parse('2026-10-22T19:00:00+08:00')); await f.tick(); assert.equal(f.saves.length, 0);
});
test('date edits have no arbitrary range limits and automatic pool changes retain manual revision', async () => {
  const f = await fixture();
  for (const d of ['2026-10-22', '2026-10-28', '2028-12-31']) {
    const view = f.store.assignmentView(d); const changed = f.store.setAssignment(d, 'w1', view.mapping.w2, view.revision);
    assert.equal(changed.mapping.w1, view.mapping.w2);
  }
  const v = f.store.data.dailyAssignments[date]?.manualRevision || 0;
  f.store.setWindows(WINDOWS.map(w => ({ id: w.id, enabled: w.id === 'w1' }))); f.store.assignment(date);
  assert.equal(f.store.data.dailyAssignments[date].manualRevision, v);
});
test('manual changes remove bindings retained from deselected historical windows', async () => {
  const f = await fixture(); let view = f.store.assignmentView(date);
  f.store.data.bindings[date+'|w1'] = view.mapping.w1;
  f.store.setWindows(WINDOWS.map(w=>({id:w.id,enabled:w.id==='w5'})));
  view = f.store.assignmentView(date);
  const updated = f.store.setAssignment(date,'w5',view.mapping.w1,view.revision);
  assert.deepEqual(Object.keys(updated.mapping),['w5']);
  assert.equal(Object.keys(f.store.lockedAssignments(date)).length,0);
});
test('manual edit during a lost save response preserves needs_review and never repeats the submitted slot', async () => {
  const wait=gate(), entered=gate();
  const f=await fixture({saved:async()=>{entered.resolve();await wait.promise;throw new Error('network timeout');}});
  await f.tick();f.setClock(release);await f.scheduler.tick();await entered.promise;
  const view=f.store.assignmentView(date);f.store.setAssignment(date,'w1',view.mapping.w2,view.revision);
  wait.resolve();await f.scheduler.idle();await f.tick();await f.tick();
  assert.equal(f.saves.length,1);assert.equal(f.store.data.jobs[f.saves[0].id].status,'needs_review');
});
