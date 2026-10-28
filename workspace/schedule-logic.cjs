'use strict';
const DAY = 86400000;
const WINDOWS = [
  { id: 'w1', start: '08:30', end: '10:30' },
  { id: 'w2', start: '11:00', end: '13:00' },
  { id: 'w3', start: '13:30', end: '15:30' },
  { id: 'w4', start: '16:00', end: '18:00' },
  { id: 'w5', start: '18:30', end: '20:30' },
];
const shanghaiDate = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const addDays = (date, days) => new Date(Date.parse(date + 'T00:00:00+08:00') + days * DAY + 8 * 3600000).toISOString().slice(0, 10);
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const minuteOf = text => { const [h, m] = text.split(':').map(Number); return h * 60 + m; };
function validateRetryPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['taskRetries', 'captchaRetries'].includes(key)) || !['taskRetries', 'captchaRetries'].every(key => Number.isInteger(policy[key]) && policy[key] >= 0 && policy[key] <= 20)) throw new Error('重试次数需为0至20的整数');
  return { taskRetries: policy.taskRetries, captchaRetries: policy.captchaRetries };
}
function validateReviewPolicy(policy) {
  if(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).some(k=>!['retryIntervalMinutes','retryIntervalSeconds'].includes(k)))throw new Error('复核等待时间需为正整数秒');
  let seconds=policy.retryIntervalSeconds;
  if(seconds===undefined){const minutes=policy.retryIntervalMinutes;if(!Number.isSafeInteger(minutes)||minutes<1)throw new Error('复核等待时间需为正整数秒');seconds=minutes*60;}
  if(!Number.isSafeInteger(seconds)||seconds<1||!Number.isSafeInteger(seconds*1000)||!Number.isFinite(new Date(Date.now()+seconds*1000).getTime())||policy.retryIntervalSeconds!==undefined&&policy.retryIntervalMinutes!==undefined&&(!Number.isFinite(policy.retryIntervalMinutes)||Math.abs(policy.retryIntervalMinutes*60-seconds)>0.000001))throw new Error('复核等待时间需为正整数秒');
  return {retryIntervalMinutes:seconds/60,retryIntervalSeconds:seconds};
}
function validDate(date) { return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T00:00:00+08:00')) && shanghaiDate(Date.parse(date + 'T00:00:00+08:00')) === date; }
function validateExclusions(entries) {
  if (!Array.isArray(entries) || entries.length > 366) throw new Error('最多保存366条日期例外');
  const seen = new Set();
  return entries.map(entry => {
    if (!validDate(entry.date) || !Array.isArray(entry.windowIds) || !entry.windowIds.length || entry.windowIds.some(id => !WINDOWS.some(w => w.id === id))) throw new Error('跳过日期或窗口无效');
    for (const id of new Set(entry.windowIds)) { const key = `${entry.date}|${id}`; if (seen.has(key)) throw new Error('同一天的相同窗口已设置跳过，请勿重复添加'); seen.add(key); }
    return { date: entry.date, windowIds: [...new Set(entry.windowIds)], reason: String(entry.reason || '临时跳过').slice(0, 100) };
  });
}
function validateWindows(windows, accounts) {
  if (!Array.isArray(windows) || windows.length !== WINDOWS.length || WINDOWS.some(f => !windows.some(w => w.id === f.id && typeof w.enabled === 'boolean'))) throw new Error('需要完整的五个固定时段');
  if (accounts.filter(a => a.enabled).length > 5) throw new Error('最多启用5个账号，请先停用一个账号');
}
function windowsFor(config, date) { return config.dateWindows?.[date] || config.windows; }
function validateDateWindows(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 366) throw new Error('日期窗口配置无效，最多366天');
  return Object.fromEntries(Object.entries(value).map(([date, windows]) => {
    if (!validDate(date)) throw new Error('日期窗口配置含无效日期');
    validateWindows(windows, []);
    return [date, WINDOWS.map(w => ({ id: w.id, enabled: windows.find(b => b.id === w.id).enabled }))];
  }));
}
function validateSelection(config, accounts) {
  validateWindows(config.windows, accounts);
  const count = config.windows.filter(w => w.enabled).length, available = accounts.filter(a => a.enabled).length;
  if (!available) throw new Error('请先启用至少一个账号');
  if (!count) throw new Error('请在“时段与随机分配”勾选至少一个预约窗口');
  if (count > available) throw new Error(`已选${count}个窗口，但只有${available}个启用账号；请取消多余窗口或启用更多账号`);
}
function validateSchedules(config, accounts, now = Date.now()) {
  validateSelection(config, accounts);
  if (!require('./equipment.cjs').equipmentList(config).length) throw new Error('请至少启用一个预约设备');
  for (const [date, windows] of Object.entries(config.dateWindows || {})) if (date >= addDays(shanghaiDate(now), 7)) {
    try { validateSelection({ ...config, windows }, accounts); } catch (e) { throw new Error(`${date} 单日配置：${e.message}`); }
  }
}
function generateJobs(config, accounts, releaseDate, days = 1, includeDisabled = false) {
  const jobs = [];
  for (let d = 0; d < days; d++) {
    const triggerDate = addDays(releaseDate, d);
    const targetDate = addDays(triggerDate, 7);
    for (const equipment of require('./equipment.cjs').equipmentList(config, includeDisabled)) {
    for (const fixed of WINDOWS) {
      const effective = windowsFor(config, targetDate);
      const binding = effective.find(w => w.id === fixed.id) || {};
      const pool = accounts.filter(a => a.enabled);
      const selected = WINDOWS.filter(w => effective.find(b => b.id === w.id)?.enabled);
      const account = pool[selected.findIndex(w => w.id === fixed.id)];
      const exclusion = (config.exclusions || []).find(e => e.date === targetDate && e.windowIds.includes(fixed.id));
      const available = Boolean(equipment.enabled !== false && binding.enabled && account?.enabled && !exclusion);
      if (!includeDisabled && !available) continue;
      for (let i = 0; i < 4; i++) {
        const start = clock(minuteOf(fixed.start) + i * 30);
        const end = clock(minuteOf(fixed.start) + (i + 1) * 30);
        const releaseAt = Date.parse(`${triggerDate}T${end}:00+08:00`);
        jobs.push({
          id: `${equipment.equipmentId}|${targetDate}|${start}|${end}`, equipment, equipmentOrder: equipment.order || 0, equipmentEnabled: equipment.enabled !== false,
          windowId: fixed.id, accountId: account?.id || null, accountLabel: account?.owner || account?.username || '未分配账号', accountOwner: account?.owner || '',
          date: targetDate, start, end, remark: 'cell', releaseAt,
          available, selected: Boolean(binding.enabled), skipped: Boolean(exclusion), skipReason: exclusion?.reason || '', windowLabel: `${fixed.start}–${fixed.end}`,
        });
      }
    }
    }
  }
  return jobs.sort((a, b) => a.releaseAt - b.releaseAt || a.equipmentOrder - b.equipmentOrder);
}
function defaults() {
  return { enabled: false, enabledAt: null, catchUpEnabled:true, reviewRebookEnabled:true, personalAccountId:null, prewarmSeconds: 90, graceSeconds: 60, shuffleDaily: true, dateWindows: {}, exclusions: [], reviewPolicy:{retryIntervalMinutes:5}, retryPolicy: { taskRetries: 2, captchaRetries: 2 },
    equipment: require('./equipment.cjs').defaultEquipment(), theme: 'system', windows: WINDOWS.map(w => ({ id: w.id, enabled: true })) };
}
function shuffleAssignments(config, accounts, locked = {}, randomInt = require('node:crypto').randomInt) {
  const enabled = config.windows.filter(w => w.enabled);
  const pool = accounts.filter(a => a.enabled).map(a => a.id).slice(0, 5);
  const mapping = { ...locked };
  const reserved = new Set(Object.values(locked));
  const candidates = pool.filter(id => !reserved.has(id));
  if (config.shuffleDaily !== false) for (let i = candidates.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  for (const window of enabled.filter(w => !mapping[w.id])) mapping[window.id] = candidates.shift() || null;
  return mapping;
}
module.exports = { WINDOWS, windowsFor, validateDateWindows, shanghaiDate, addDays, generateJobs, validateWindows, validateSelection, validateSchedules, defaults, shuffleAssignments, validDate, validateExclusions, validateRetryPolicy, validateReviewPolicy };
