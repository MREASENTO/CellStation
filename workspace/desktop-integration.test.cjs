'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DesktopIntegration } = require('./desktop-integration.cjs');
const { ManagerStore } = require('./manager-store.cjs');
const { createManager } = require('./manager-server.cjs');
const base = path.join(__dirname, '..', 'work', 'tests'); fs.mkdirSync(base, { recursive: true });
function fixture() {
  let registered = false, approved = true;
  const native = {
    getLoginItemSettings: () => ({ openAtLogin: registered, executableWillLaunchAtLogin: registered && approved, launchItems: registered ? [{ name: 'CellStation', enabled: approved }] : [] }),
    setLoginItemSettings: input => { assert.equal(input.name, 'CellStation'); assert.equal(input.path, process.execPath); assert.deepEqual(input.args, ['--autostart']); registered = input.openAtLogin; approved = input.enabled; },
  };
  const directory = fs.mkdtempSync(path.join(base, 'desktop-'));
  const messages = [], views = []; let exits = 0;
  const options = { app: native, dataRoot: directory, sendNotification: message => messages.push(message), show: view => views.push(view), quit: () => { exits++; }, batchMs: 5000 };
  const controller = new DesktopIntegration(options);
  return { directory, controller, options, native, messages, views, exits: () => exits, block: () => { approved = false; } };
}
test('startup switch registers hidden launch and can be disabled; Windows blocks are visible', () => {
  const f = fixture();
  assert.equal(f.controller.status().autoStart, false);
  assert.equal(f.controller.update({ autoStart: true }).autoStart, true);
  f.block(); assert.equal(f.controller.status().startupBlocked, true);
  assert.equal(f.controller.update({ autoStart: false }).autoStart, false);
  assert.throws(() => f.controller.update({ path: 'other.exe' }), /设置无效/);
  f.controller.dispose();
});
test('startup resumes only the saved running intent; a user pause survives restart', () => {
  const f = fixture();
  assert.equal(f.controller.shouldResume(true), false);
  f.controller.schedulerIntent(true);
  const restored = new DesktopIntegration(f.options);
  assert.equal(restored.shouldResume(true), true); assert.equal(restored.shouldResume(false), false);
  restored.schedulerIntent(false);
  assert.equal(new DesktopIntegration(f.options).shouldResume(true), false);
  restored.update({ resumeSchedule: false }); restored.schedulerIntent(true);
  assert.equal(restored.shouldResume(true), false);
});
test('failure, missed and uncertain jobs notify once across restarts, batch and open history on click', () => {
  const f = fixture();
  const job = { id: 'one', date: '2026-10-29', start: '08:30', end: '09:00', accountLabel: '账号1', status: 'failed', message: 'network timeout with private-token' };
  f.controller.notify(job); f.controller.notify(job); f.controller.flush();
  assert.equal(f.messages.length, 1); assert.ok(f.messages[0].content.includes('2026-10-29')); assert.ok(!f.messages[0].content.includes('private-token'));
  f.messages[0].click(); assert.deepEqual(f.views, ['history']);
  const restored = new DesktopIntegration(f.options); restored.notify(job); restored.flush(); assert.equal(f.messages.length, 1);
  restored.notify({ ...job, id: 'two', status: 'needs_review' }); restored.notify({ ...job, id: 'three', status: 'missed' }); restored.flush();
  assert.match(f.messages[1].title, /2项/); assert.ok(f.messages[1].content.includes('不会重复提交'));
  restored.notify({ ...job, id: 'success', status: 'success' }); restored.flush(); assert.equal(f.messages.length, 2);
  f.controller.dispose(); restored.dispose();
});
test('turning notifications off cancels pending alerts and manual exit remains available', () => {
  const f = fixture();
  f.controller.notify({ id: 'pending', status: 'failed' });
  f.controller.update({ failureNotifications: false }); f.controller.flush(); assert.equal(f.messages.length, 0);
  f.controller.testNotification(); assert.equal(f.messages.length, 1);
  f.controller.requestExit(); assert.equal(f.exits(), 1);
  f.controller.dispose();
});
test('notification errors never change a persisted booking result', () => {
  const f = fixture(); const store = new ManagerStore(f.directory);
  store.onJob = () => { throw new Error('native error'); };
  const saved = store.job({ id: 'one' }, { status: 'needs_review' });
  assert.equal(saved.status, 'needs_review'); assert.equal(store.data.jobs.one.status, 'needs_review');
});
test('desktop settings and notification APIs require CSRF and forward scheduler intent', async () => {
  const f = fixture(); let intent;
  const manager = await createManager({ directory: f.directory, port: 0, runScheduler: false, desktop: true, desktopIntegration: f.controller, onControl: value => { intent = value; }, workerFactory: () => ({ close: async () => {} }) });
  try {
    const state = await fetch(manager.url + '/api/state').then(r => r.json()); assert.equal(state.desktopSettings.failureNotifications, true);
    const bad = await fetch(manager.url + '/api/desktop/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"autoStart":true}' }); assert.equal(bad.status, 403);
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken };
    const saved = await fetch(manager.url + '/api/desktop/settings', { method: 'PUT', headers, body: '{"autoStart":true}' }).then(r => r.json()); assert.equal(saved.settings.autoStart, true);
    await fetch(manager.url + '/api/desktop/test-notification', { method: 'POST', headers, body: '{}' }); assert.equal(f.messages.length, 1);
    await fetch(manager.url + '/api/control', { method: 'POST', headers, body: '{"enabled":false}' }); assert.equal(intent, false);
    await fetch(manager.url + '/api/desktop/quit', { method: 'POST', headers, body: '{}' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.exits(), 1);
  } finally { await manager.close(); f.controller.dispose(); }
});
