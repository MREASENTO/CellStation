'use strict';
const DAY = 86400;
const minutes = text => {
  if (!/^\d{2}:\d{2}$/.test(text)) throw new Error('时间格式应为 HH:MM');
  const [h, m] = text.split(':').map(Number);
  if (h > 23 || m > 59) throw new Error('时间超出范围');
  return h * 60 + m;
};
function planSlot(rules, request, now = Date.now() / 1000, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date)) throw new Error('日期格式应为 YYYY-MM-DD');
  const startMinute = minutes(request.start);
  const endMinute = minutes(request.end);
  if (startMinute % 30 || endMinute - startMinute !== rules.slotMinutes) throw new Error('本版本每次只预约一个对齐整点或半点的30分钟时段');
  const start = Date.parse(`${request.date}T${request.start}:00+08:00`) / 1000;
  const end = Date.parse(`${request.date}T${request.end}:00+08:00`) / 1000;
  if (!Number.isFinite(start) || new Date((start + 8 * 3600) * 1000).toISOString().slice(0, 10) !== request.date) throw new Error('日期不存在');
  const inside = rules.dailyWindows.some(([a, b]) => startMinute >= minutes(a) && endMinute <= minutes(b));
  const test = rules.currentRequest;
  const exception = test.outsideDailyWindowsAuthorized && ['date', 'start', 'end'].every(k => request[k] === test[k]);
  if (!inside && !exception) throw new Error('此时段不在日常预约窗口内');
  const release = end - rules.release.advanceDays * DAY;
  if (now < release && !options.allowBeforeRelease) throw new Error(`尚未开放预约；按规则开放时间为 ${new Date(release * 1000).toISOString()}`);
  if (start <= now) throw new Error('不能预约已开始或过去的时段');
  return { date: request.date, startText: request.start, endText: request.end, start, end, release, dayStart: start - startMinute * 60, remark: rules.remark, equipmentId: rules.equipmentId };
}
function normalizedEnd(component) {
  const end = Number(component.dtEnd);
  // Legacy records end at xx:xx:59; newer records use an exclusive boundary.
  return end % 60 === 59 ? end + 1 : end;
}
function assessComponents(components, plan, userId) {
  const owner = new RegExp(`profile/index[.]${userId}(?![0-9])`);
  const unique = [...new Map(components.map(c => [String(c.id), c])).values()];
  const own = unique.filter(c => owner.test(c.content || ''));
  const duplicate = own.find(c => Number(c.dtStart) === plan.start && normalizedEnd(c) === plan.end);
  const conflicts = unique.filter(c => Number(c.dtStart) < plan.end && normalizedEnd(c) > plan.start);
  const usedSeconds = own.reduce((sum, c) => sum + Math.max(0, Math.min(normalizedEnd(c), plan.dayStart + DAY) - Math.max(Number(c.dtStart), plan.dayStart)), 0);
  return { duplicate, conflicts, usedMinutes: usedSeconds / 60 };
}
module.exports = { planSlot, assessComponents, normalizedEnd, minutes };
