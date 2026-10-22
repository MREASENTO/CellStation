'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { ManagerStore } = require('./manager-store.cjs'); const { Scheduler } = require('./scheduler.cjs'); const { Operations } = require('./operations.cjs');
const base = path.join(__dirname, '..', 'work', 'tests'); fs.mkdirSync(base, { recursive: true });
const vault = { protect: async s => Buffer.from(s).toString('base64'), unprotect: async s => Buffer.from(s, 'base64').toString() };
async function fixture() {
  const root = fs.mkdtempSync(path.join(base, 'owner-')); const store = new ManagerStore(root, vault);
  const account = await store.saveAccount({ username: 'dummy-owner-test', label: '账号1', owner: ' 张三 ', password: 'local-only' });
  store.persist();
  const clock = () => Date.parse('2026-10-22T07:00:00+08:00'); const operations = new Operations({ root, store, worker: {}, clock });
  return { root, store, account, clock, operations };
}
test('owner can be added, edited, cleared and persisted while password remains encrypted', async () => {
  const f = await fixture(); assert.equal(f.store.accounts()[0].owner, '张三'); const cipher = f.store.data.accounts[0].passwordCipher;
  await f.store.saveAccount({ ...f.account, owner: '李四' }); assert.equal(f.store.accounts()[0].owner, '李四'); assert.equal(f.store.data.accounts[0].passwordCipher, cipher);
  assert.equal(new ManagerStore(f.root, vault).accounts()[0].owner, '李四');
  await f.store.saveAccount({ ...f.account, owner: '' }); assert.equal(f.store.accounts()[0].owner, '');
  await assert.rejects(f.store.saveAccount({ ...f.account, owner: 'a'.repeat(61) }), /60字/);
  await assert.rejects(f.store.saveAccount({ ...f.account, owner: {} }), /60字/);
});
test('daily shuffled plans expose owner metadata while website remark remains cell', async () => {
  const f = await fixture(); const plan = new Scheduler(f.store, {}, f.clock).plan(1);
  assert.equal(plan.length, 4); assert.ok(plan.every(job => job.accountOwner === '张三' && job.remark === 'cell'));
});
test('historical owner snapshot is preserved when the account annotation changes', async () => {
  const f = await fixture(); const job = new Scheduler(f.store, {}, f.clock).plan(1)[0]; f.store.job(job, { status: 'success' });
  await f.store.saveAccount({ ...f.account, owner: '李四' });
  const summary = f.operations.summary(job.date); assert.equal(summary.rows[0].accountOwner, '张三'); assert.equal(summary.rows[1].accountOwner, '李四');
  const exported = f.operations.exportSummary(job.date); assert.ok(fs.readFileSync(exported.files[1], 'utf8').includes('使用人')); assert.ok(fs.readFileSync(exported.files[1], 'utf8').includes('张三'));
});
test('owner annotations round-trip in backup; legacy backup retains existing annotation', async () => {
  const f = await fixture(); const backup = JSON.parse(fs.readFileSync(f.operations.backup().file, 'utf8')); assert.equal(backup.accounts[0].owner, '张三');
  await f.store.saveAccount({ ...f.account, owner: '李四' }); let preview = await f.operations.previewRestore(backup); f.operations.restore(preview.token); assert.equal(f.store.accounts()[0].owner, '张三');
  delete backup.accounts[0].owner; await f.store.saveAccount({ ...f.account, owner: '王五' }); preview = await f.operations.previewRestore(backup); f.operations.restore(preview.token); assert.equal(f.store.accounts()[0].owner, '王五');
  backup.accounts[0].owner = 123; await assert.rejects(f.operations.previewRestore(backup), /使用人字段无效/);
});
