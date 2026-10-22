'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./booking-rules.json');
const { planSlot, assessComponents } = require('./booking-logic.cjs');
const now = Date.parse('2026-10-21T23:00:00+08:00') / 1000;
test('release follows slot end minus seven days', () => {
  const plan = planSlot(rules, { date: '2026-10-28', start: '08:30', end: '09:00' }, now);
  assert.equal(plan.release, Date.parse('2026-10-21T09:00:00+08:00') / 1000);
  assert.throws(() => planSlot(rules, { date: '2026-10-28', start: '08:30', end: '09:00' }, plan.release - 1), /尚未开放/);
  assert.doesNotThrow(() => planSlot(rules, { date: '2026-10-28', start: '08:30', end: '09:00' }, plan.release - 90, { allowBeforeRelease: true }));
});
test('only the exact authorized overnight test bypasses daily windows', () => {
  assert.doesNotThrow(() => planSlot(rules, rules.currentRequest, now));
  assert.throws(() => planSlot(rules, { date: '2026-10-28', start: '02:00', end: '02:30' }, now), /窗口/);
});
test('rejects malformed and misaligned slots and dates', () => {
  assert.throws(() => planSlot(rules, { date: '2026-10-28', start: '08:45', end: '09:15' }, now), /30分钟/);
  assert.throws(() => planSlot(rules, { date: '2026-10-28', start: '08:30', end: '09:30' }, now), /30分钟/);
  assert.throws(() => planSlot(rules, { date: '2026-02-30', start: '08:30', end: '09:00' }, now), /日期不存在/);
  assert.throws(() => planSlot(rules, { date: '2026-10-28', start: '10:30', end: '11:00' }, now), /窗口/);
});
test('normalizes inclusive legacy ends and allows adjacent slots', () => {
  const plan = planSlot(rules, rules.currentRequest, now);
  const owner = '<a href="/cf/main/!people/profile/index.1451">self</a>';
  const previous = { id: '1', dtStart: plan.start - 1800, dtEnd: plan.start - 1, content: owner };
  assert.equal(assessComponents([previous], plan, '1451').conflicts.length, 0);
  const duplicate = { id: '2', dtStart: plan.start, dtEnd: plan.end - 1, content: owner };
  const result = assessComponents([previous, duplicate, duplicate], plan, '1451');
  assert.equal(result.duplicate.id, '2');
  assert.equal(result.usedMinutes, 60);
  assert.equal(result.conflicts.length, 1);
});
test('does not confuse another user id with the current account', () => {
  const plan = planSlot(rules, rules.currentRequest, now);
  const entry = { id: '3', dtStart: plan.start, dtEnd: plan.end, content: '<a href="/cf/main/!people/profile/index.14510">other</a>' };
  const result = assessComponents([entry], plan, '1451');
  assert.equal(result.duplicate, undefined);
  assert.equal(result.usedMinutes, 0);
  assert.equal(result.conflicts.length, 1);
});
