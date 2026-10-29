'use strict';
const base = require('./booking-rules.json');
const defaultEquipment = () => ({ equipmentId: base.equipmentId, equipmentName: base.equipmentName, equipmentModel: base.equipmentModel });
const normalizeName = name => String(name || '').normalize('NFKC').replace(/\s+/g, '').replace(/[（(][^()（）]*[）)]$/, '');
function validateEquipmentList(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('请保留至少一个设备；不需要预约时可关闭设备');
  const seen = new Set();
  return items.map((item, order) => {
    const equipment = validateEquipment(item);
    if (seen.has(equipment.equipmentId)) throw new Error('设备列表中存在重复设备');
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('设备启用状态无效');
    seen.add(equipment.equipmentId);
    return { ...equipment, enabled: item.enabled !== false, order };
  });
}
function equipmentList(config, includeDisabled = false) {
  const items = config.equipments || [{ ...config.equipment || defaultEquipment(), enabled: true, order: 0 }];
  return items.filter(item => includeDisabled || item.enabled !== false);
}
const slotKey = job => `${job.equipment?.equipmentId || 37}|${job.date}|${job.start}|${job.end}`;
function validateEquipment(input) {
  if (!input || !Number.isSafeInteger(input.equipmentId) || input.equipmentId <= 0 || typeof input.equipmentName !== 'string' || !input.equipmentName.trim() || input.equipmentName.length > 200) throw new Error('仪器信息无效，请按名称检索并选择实际仪器');
  return { equipmentId: input.equipmentId, equipmentName: input.equipmentName.trim(), equipmentModel: String(input.equipmentModel || '').slice(0, 120),...(input.bookingSchedule?{bookingSchedule:validateBookingSchedule(input.bookingSchedule)}:{}) };
}
function validateBookingSchedule(value) {
  if(value===undefined||value===null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('设备预约计划无效');
  const {validDate,WINDOWS}=require('./schedule-logic.cjs'),dateMode=value.dateMode||'all';
  if(!['all','single','range'].includes(dateMode))throw new Error('请选择有效的设备预约日期方式');
  const dateFrom=dateMode==='all'?'':value.dateFrom,dateTo=dateMode==='single'?dateFrom:dateMode==='all'?'':value.dateTo;
  if(dateMode!=='all'&&(!validDate(dateFrom)||!validDate(dateTo)||dateTo<dateFrom))throw new Error('设备日期范围无效，结束日期不得早于开始日期');
  let windows=null;
  if(value.windows!==undefined&&value.windows!==null){
    if(!Array.isArray(value.windows)||value.windows.length!==5||new Set(value.windows.map(w=>w?.id)).size!==5)throw new Error('设备需保留五个窗口，可分别关闭');
    const minute=s=>{if(typeof s!=='string'||!/^([01]\d|2[0-3]):(00|30)$/.test(s))throw new Error('时段需采用整点或半点，且在同一天内');return Number(s.slice(0,2))*60+Number(s.slice(3));};
    windows=WINDOWS.map(f=>{const w=value.windows.find(w=>w.id===f.id);if(!w||typeof w.enabled!=='boolean'||minute(w.end)<=minute(w.start))throw new Error('设备窗口开始时间需早于结束时间');return{id:f.id,enabled:w.enabled,start:w.start,end:w.end};});
    const selected=windows.filter(w=>w.enabled).sort((a,b)=>minute(a.start)-minute(b.start));
    if(selected.some((w,i)=>i&&minute(w.start)<minute(selected[i-1].end)))throw new Error('同一设备的启用窗口不可重叠');
  }
  return{dateMode,dateFrom,dateTo,windows};
}
function equipmentDateAllowed(equipment,date){const s=equipment?.bookingSchedule;return !s||s.dateMode==='all'||date>=s.dateFrom&&date<=s.dateTo;}
function effectiveWindows(config,date,equipment){
  const {WINDOWS,windowsFor}=require('./schedule-logic.cjs');
  return equipment?.bookingSchedule?.windows||WINDOWS.map(w=>({...w,enabled:Boolean(windowsFor(config,date).find(x=>x.id===w.id)?.enabled)}));
}
function equipmentJobAllowed(config,job){
  const e=equipmentList(config).find(e=>e.equipmentId===(job.equipment?.equipmentId||defaultEquipment().equipmentId));
  if(!e||job.equipment?.equipmentName&&job.equipment.equipmentName!==e.equipmentName||!equipmentDateAllowed(e,job.date))return false;
  return effectiveWindows(config,job.date,e).some(w=>(!job.windowId||w.id===job.windowId)&&w.enabled&&job.start>=w.start&&job.end<=w.end);
}
function rulesFor(equipment) { const e=validateEquipment(equipment||defaultEquipment());return { ...structuredClone(base), ...e,...(e.bookingSchedule?.windows?{dailyWindows:e.bookingSchedule.windows.filter(w=>w.enabled).map(w=>[w.start,w.end])}:{}) }; }
async function catalogue(page, name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('请填写200字以内的仪器名称');
  const menu = page.locator('a.item_content[href$="!equipments/index"]');
  if (!await menu.isVisible()) await page.getByText('实验预约', { exact: true }).click();
  await menu.click();
  const field = page.locator('input[name="name"]');
  await field.waitFor({ state: 'visible', timeout: 10000 });
  const action = await field.evaluate(e => new URL(e.form.action, location.href).pathname);
  await field.fill(name.trim());
  // The site's help panel covers the Search button for some accounts. Enter is
  // the form's normal keyboard submission and does not depend on pointer geometry.
  const [response] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === action, { timeout: 10000 }), field.press('Enter')]);
  await response.finished();
  await page.waitForFunction(() => !window.jQuery || window.jQuery.active === 0, null, { timeout: 10000 });
  await page.locator('input[name="name"]').waitFor({ state: 'visible' });
  const candidates = await page.locator('a.eq_name').evaluateAll(links => links.map(a => ({ equipmentId: Number(a.getAttribute('href')?.match(/index[.](\d+)(?:$|[?#])/)?.[1]), equipmentName: a.textContent.trim(), equipmentModel: '' })).filter(a => a.equipmentId && a.equipmentName));
  return [...new Map(candidates.map(c => [c.equipmentId, c])).values()];
}
async function verifyTarget(page, equipment) {
  const target = validateEquipment(equipment);
  const candidates = await catalogue(page, target.equipmentName);
  const match = candidates.find(c => c.equipmentId === target.equipmentId && normalizeName(c.equipmentName) === normalizeName(target.equipmentName));
  if (!match) throw new Error('仪器编号与名称不匹配，请重新检索');
  await page.locator(`a.eq_name[href$="index.${target.equipmentId}"]`).click();
  await page.locator(`a[href$="index.${target.equipmentId}.reserv"]`).click();
  await page.locator('table.calendar_week').waitFor({ state: 'visible' });
  const header = await page.locator('table.calendar_week th.header[q-static]').first().getAttribute('q-static');
  const calendarId = new URLSearchParams(header).get('calendarid');
  if (!calendarId || !/^\d+$/.test(calendarId)) throw new Error('仪器没有可确认的预约日历');
  return { ...match, calendarId: Number(calendarId) };
}
module.exports = { validateBookingSchedule, equipmentDateAllowed, effectiveWindows, equipmentJobAllowed, defaultEquipment, validateEquipment, validateEquipmentList, equipmentList, slotKey, normalizeName, rulesFor, catalogue, verifyTarget };
