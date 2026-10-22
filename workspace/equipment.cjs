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
  return { equipmentId: input.equipmentId, equipmentName: input.equipmentName.trim(), equipmentModel: String(input.equipmentModel || '').slice(0, 120) };
}
function rulesFor(equipment) { return { ...structuredClone(base), ...validateEquipment(equipment || defaultEquipment()) }; }
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
module.exports = { defaultEquipment, validateEquipment, validateEquipmentList, equipmentList, slotKey, normalizeName, rulesFor, catalogue, verifyTarget };
