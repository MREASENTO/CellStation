'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { work, outputs } = require('./runtime-paths.cjs');
const { planSlot, assessComponents } = require('./booking-logic.cjs');
const readRules = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'booking-rules.json'), 'utf8'));
const dialogForm = page => page.locator('.dialog_block:visible form').filter({ has: page.locator('textarea[name="description"]') });

async function openEquipment(page, rules) {
  const { catalogue, normalizeName } = require('./equipment.cjs');
  const candidates = await catalogue(page, rules.equipmentName);
  if (!candidates.some(c => c.equipmentId === rules.equipmentId && normalizeName(c.equipmentName) === normalizeName(rules.equipmentName))) throw new Error('仪器编号与名称不匹配');
  await page.locator(`a.eq_name[href$="index.${rules.equipmentId}"]`).click();
  if (rules.equipmentModel) await page.getByText(rules.equipmentModel, { exact: true }).first().waitFor({ state: 'visible' });
  await page.locator(`a[href$="index.${rules.equipmentId}.reserv"]`).click();
  await page.locator('table.calendar_week').waitFor({ state: 'visible' });
}

async function checkAvailability(page, plan, options = {}) {
  if (!new URL(page.url()).pathname.includes(`index.${plan.equipmentId}.reserv`)) throw new Error('当前仪器页面不匹配');
  const weekStart = await ensureWeek(page, plan.start);
  const profile = await page.locator('a.user').getAttribute('href');
  const userId = profile.match(/index\.(\d+)/)?.[1];
  if (!userId) throw new Error('无法确认当前登录账号');
  await options.onIdentity?.(userId);
  const components=await calendarComponents(page, weekStart),assessment = assessComponents(components, plan, userId);
  const {coveringOurs,oneOwner,teamMatch}=require('./site-identity.cjs');
  const duplicate=coveringOurs(components,plan,[userId,...(options.profileIds?.()||[])],options.teamMembers?.()||[]);
  if (duplicate) return { ...assessment, duplicate, userId, weekStart };
  if (assessment.conflicts.length) {
    const known=new Set([userId,...(options.profileIds?.()||[])]),conflicts=assessment.conflicts;
    const uncertain=conflicts.some(c=>!oneOwner(c.content)||known.has(oneOwner(c.content))||teamMatch(c.content,options.teamMembers?.()||[]))||!options.identitiesComplete?.();
    const error=new Error(uncertain?'该时段已有预约，账号归属或覆盖范围需要核对':'目标时段已被占用');
    if(uncertain)error.code='OWNERSHIP_UNCERTAIN';error.retryable=false;throw error;
  }
  console.log(`该账号当天现有约 ${assessment.usedMinutes} 分钟；每日120分钟为计划参考。本次仅新增30分钟。`);
  return { ...assessment, userId, weekStart };
}

async function verifyForm(page, plan) {
  const form = dialogForm(page);
  if (await form.count() !== 1) throw new Error('预约表单不唯一');
  const snapshot = await form.evaluate(form => ({
    values: Object.fromEntries([...form.querySelectorAll('input,textarea')].map(e => [e.name || e.id, e.value])),
    start: form.querySelector('#dtstart')?.value, end: form.querySelector('#dtend')?.value,
    calendarHeader: document.querySelector('table.calendar_week th.header[q-static]')?.getAttribute('q-static'),
  }));
  const values = snapshot.values;
  if (Number(values.component_id) !== 0) throw new Error('当前不是新增预约表单');
  if (Number(values.dtstart) !== plan.start || Number(values.dtend) !== plan.end) throw new Error('表单时间戳与目标不一致');
  if (values.dtstart === undefined || values.dtend === undefined) throw new Error('缺少时间字段');
  if (snapshot.start !== `${plan.date} ${plan.startText}:00` || snapshot.end !== `${plan.date} ${plan.endText}:00`) throw new Error('可见时间与目标不一致');
  if (values.description !== plan.remark) throw new Error('备注不匹配');
  const calendarId = new URLSearchParams(snapshot.calendarHeader || '').get('calendarid');
  if (!calendarId || String(values.calendar_id) !== calendarId) throw new Error('表单日历与目标仪器不一致');
  return form;
}

async function preflightBooking(page, request, options = {}) {
  const rules = options.rules || readRules();
  const plan = planSlot(rules, request || rules.currentRequest, Date.now() / 1000, options);
  const assessment = await checkAvailability(page, plan, options);
  options.onStep?.('availability_checked', '目标周、账号及冲突已核对');
  if (assessment.duplicate) {
    console.log('BOOKING_ALREADY_EXISTS', assessment.duplicate.id);
    return { plan, alreadyExists: true, reservationId: assessment.duplicate.id, userId:assessment.userId };
  }
  return { plan, alreadyExists: false, userId: assessment.userId, weekStart: assessment.weekStart };
}
async function prepareBooking(page, request, options = {}) {
  // The cached context only avoids a redundant query before opening the form.
  // commitBooking always obtains a fresh conflict/duplicate assessment before saving.
  const candidate = planSlot(options.rules || readRules(), request, Date.now() / 1000, options);
  const cached = options.preflight;
  const matches = cached?.plan && ['date', 'start', 'end', 'equipmentId', 'remark'].every(key => cached.plan[key] === candidate[key]);
  const result = matches ? { ...cached, plan: candidate } : await preflightBooking(page, request, options);
  if (result.alreadyExists) return result;
  const { plan } = result;
  if (!await page.getByText('添加使用预约', { exact: true }).isVisible()) await selectSlot(page, plan.date, plan.startText, options);
  await dialogForm(page).locator('textarea[name="description"]').fill(plan.remark);
  await verifyForm(page, plan);
  options.onStep?.('form_verified', '预约时间与备注已填写核对');
  console.log('BOOKING_PREPARED', JSON.stringify({ date: plan.date, start: plan.startText, end: plan.endText, remark: plan.remark }));
  return { ...result, plan, alreadyExists: false };
}

async function commitBooking(page, request, options = {}) {
  const rules = options.rules || readRules();
  const plan = planSlot(rules, request || rules.currentRequest);
  const assessment = await checkAvailability(page, plan, options);
  options.onStep?.('final_availability_checked', '提交前重新读取日历，核实冲突与重复预约');
  if (options.expectedUserId && String(options.expectedUserId) !== String(assessment.userId)) throw new Error('登录账号与提前准备时不一致，未保存');
  if (assessment.duplicate) return { status: 'already_exists', reservationId: assessment.duplicate.id, plan };
  const form = await verifyForm(page, plan);
  let requestSeen = false, resolveResponse, websiteAlert = '';
  const responseReady = new Promise(resolve => { resolveResponse = resolve; });
  const requestListener = request => {
    if (request.method() !== 'POST' || requestSeen) return;
    requestSeen = true;
    options.onStep?.('save_request', '浏览器已发出保存阶段的POST请求');
    request.response().then(async response => {
      if (response) { await response.finished().catch(() => {}); options.onStep?.('save_response', `保存请求响应已返回，HTTP ${response.status()}`); }
      resolveResponse();
    }).catch(() => resolveResponse());
  };
  const onDialog = async dialog => { websiteAlert = require('./support-files.cjs').safeError(dialog.message()); options.onStep?.('website_alert', websiteAlert); await dialog.dismiss().catch(() => {}); };
  page.on('request', requestListener); page.on('dialog', onDialog);
  try {
    // Exactly one save; the scheduler still gates this on the release time.
    if (options.beforeSave) await options.beforeSave();
    options.onStep?.('save_click', '调用保存按钮');
    await form.locator('input[name="save"]').click({ timeout: 10000 });
    options.onStep?.('save_click_returned', '保存按钮点击返回，开始读回核对');
    // Avoid querying before the save response, without blocking verification on a hung response.
    await Promise.race([responseReady, page.waitForTimeout(1000)]);
    let match;
    // Same eight verification passes and total 5250ms backoff as before, with earlier checks first.
    const waits = [100, 200, 350, 600, 1000, 1400, 1600];
    for (let i = 0; i < 8; i++) {
      const components = await calendarComponents(page, assessment.weekStart);
      match = assessComponents(components, plan, assessment.userId).duplicate;
      if (match) break;
      if (i < waits.length) await page.waitForTimeout(waits[i]);
    }
    if (!match) {
      const errors = websiteAlert || await page.locator('.dialog_block:visible').innerText({ timeout: 2000 }).catch(() => '未收到可验证的保存结果');
      const error = new Error(`保存结果未确认，禁止自动重试。页面提示：${errors.slice(-1000)}`); error.websiteAlert = websiteAlert || undefined; throw error;
    }
    if (!match.content.includes(plan.remark)) throw new Error('预约已存在但备注未确认，禁止重复保存，请人工核查');
    const confirmedAt = Date.now();
    options.onStep?.('record_verified', '已读回同账号、同时间、同备注的预约记录');
    const result = { confirmedAt, status: 'created', reservationId: match.id, accountId: assessment.userId, equipment: rules.equipmentName, date: plan.date, start: plan.startText, end: plan.endText, remark: plan.remark, verifiedAt: new Date(confirmedAt).toISOString() };
    // An optional receipt failure must not turn a verified reservation into an uncertain result.
    try {
      fs.mkdirSync(outputs, { recursive: true });
      const prefix = path.join(outputs, `预约成功_${plan.date}_${plan.startText.replace(':', '')}_${Date.now()}`);
      fs.writeFileSync(prefix + '.json', JSON.stringify(result, null, 2));
      await page.screenshot({ path: prefix + '.png', fullPage: false });
    } catch (error) { result.receiptWarning = require('./support-files.cjs').safeError(error); options.onStep?.('receipt_warning', '预约已核实，回执文件生成失败：' + result.receiptWarning); }
    return result;
  } finally { page.off('request', requestListener); page.off('dialog', onDialog); }
}

async function ensureWeek(page, timestamp) {
  for (let step = 0; step < 12; step++) {
    const calendar = page.locator('table.calendar_week');
    const className = await calendar.getAttribute('class');
    const weekStart = Number(className.match(/datetime:(\d+)/)?.[1]);
    if (!weekStart) throw new Error('Calendar week not found');
    if (timestamp >= weekStart && timestamp < weekStart + 7 * 86400) return weekStart;
    const direction = timestamp < weekStart ? 'left' : 'right';
    await page.locator(`.calendar_pre.icon-${direction}:visible`).first().click();
    await page.waitForFunction(old => {
      const current = document.querySelector('table.calendar_week')?.className.match(/datetime:(\d+)/)?.[1];
      return current && Number(current) !== old;
    }, weekStart);
  }
  throw new Error('Too many calendar navigation steps');
}

async function calendarComponents(page, weekStart) {
  const header = await page.locator('table.calendar_week th.header[q-static]').first().getAttribute('q-static');
  const calendarId = new URLSearchParams(header).get('calendarid');
  if (!calendarId) throw new Error('Calendar id not found');
  const result = [];
  for (let start = 0; start < 5000; start += 50) {
    const url = new URL('/cf/main/!calendars/calendar', page.url());
    url.search = new URLSearchParams({ _ajax: '1', _object: 'week_components', _event: 'get', dtstart: String(weekStart), dtend: String(weekStart + 7 * 86400 - 1), calendar: calendarId, start: String(start), step: '50' }).toString();
    const response = await page.request.get(url.href);
    if (!response.ok()) throw new Error('Calendar data request failed');
    const data = await response.json();
    if (!Array.isArray(data.components)) throw new Error('Calendar data schema changed');
    result.push(...data.components);
    if (!data.components.length) return result;
  }
  throw new Error('Calendar pagination did not finish');
}

async function warmSlot(page, date, start) {
  const timestamp = Date.parse(`${date}T${start}:00+08:00`) / 1000;
  const weekStart = await ensureWeek(page, timestamp);
  const existing = page.locator('.hour_components .block_hover:visible');
  if (await existing.count() === 1 && await existing.evaluate((e, expected) => {
    const $ = window.jQuery, c = $(e).data('Q.Calendar.Week.Component');
    return c?.dtStart === expected && c?.dtEnd === expected + 1800 && Boolean($._data(e, 'events')?.dblclick?.length);
  }, timestamp)) return existing;
  const [hour, minute] = start.split(':').map(Number);
  const row = hour * 2 + minute / 30;
  const day = Math.floor((timestamp - weekStart) / 86400);
  const cell = page.locator(`table.calendar_week td.R${row}C${day}`);
  await cell.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center' }));
  // The site's scroll handler disables hover selection for 100 ms.
  await page.waitForTimeout(180);
  const box = await cell.boundingBox();
  if (!box) throw new Error('Target time cell is not visible');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 3 });
  // Calendar hover blocks are created dynamically. livequery attaches their
  // dblclick handler later; immediate physical double-clicks can be silently lost.
  await page.waitForFunction(expected => {
    const $ = window.jQuery;
    return [...document.querySelectorAll('.hour_components .block_hover')].some(e => {
      const c = $(e).data('Q.Calendar.Week.Component');
      return e.getClientRects().length && c?.dtStart === expected && c?.dtEnd === expected + 1800 && $._data(e, 'events')?.dblclick?.length;
    });
  }, timestamp, { timeout: 5000 });
  const hover = page.locator('.hour_components .block_hover:visible');
  const selection = await hover.evaluate(e => {
    const c = window.jQuery(e).data('Q.Calendar.Week.Component');
    return { start: c.dtStart, end: c.dtEnd };
  });
  if (selection.start !== timestamp || selection.end !== timestamp + 1800) throw new Error('Calendar hover time does not match target');
  return hover;
}
async function selectSlot(page, date, start, options = {}) {
  const hover = await warmSlot(page, date, start);
  let rejectDialog;
  const rejected = new Promise((_, reject) => { rejectDialog = reject; });
  const onDialog = async dialog => {
    const error = new Error('网站提示：' + require('./support-files.cjs').safeError(dialog.message()));
    error.code = 'WEBSITE_REJECTED'; error.retryable = false; error.websiteAlert = error.message;
    options.onStep?.('website_alert', error.message);
    await dialog.dismiss().catch(() => {});
    rejectDialog(error);
  };
  page.on('dialog', onDialog);
  try {
    options.onStep?.('open_form', '日历事件已就绪，打开新增预约表单');
    const opened = hover.dispatchEvent('dblclick').then(() => dialogForm(page).locator('textarea[name="description"]').waitFor({ state: 'visible', timeout: 6000 }));
    await Promise.race([opened, rejected]);
    options.onStep?.('form_opened', '新增预约表单已打开');
  } finally { page.off('dialog', onDialog); }
  console.log('BOOKING_DIALOG_OPEN', date, start);
}
// Booking workflow is developed against the observed UI. Only explicit save commits.
async function control(page, command) {
  if (command.operation === 'prepare') {
    await prepareBooking(page, command.request);
  } else if (command.operation === 'save') {
    await commitBooking(page, command.request);
  } else if (command.operation === 'probe') {
    const report = await page.evaluate(() => ({
      url: location.origin + location.pathname,
      text: document.body.innerText,
      elements: [...document.querySelectorAll('a,button,input,select,textarea,[q-object],[role="button"]')]
        .filter(e => e.getClientRects().length).map(e => ({
          tag: e.tagName, text: e.innerText?.slice(0, 200),
          attrs: Object.fromEntries([...e.attributes].filter(a => !['value','style'].includes(a.name)).map(a => [a.name,a.value])),
        })),
    }));
    const file = path.join(work, `booking-probe_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log('BOOKING_PROBE', file);
  } else if (command.operation === 'click') {
    let locator = command.selector ? page.locator(command.selector) : page.getByText(command.text, { exact: true });
    if (Number.isInteger(command.index)) locator = locator.nth(command.index);
    if (await locator.count() !== 1) throw new Error('Click target is not unique');
    await locator.click();
    console.log('BOOKING_CLICK_OK');
  } else if (command.operation === 'structure') {
    if (await page.locator('input[type="password"]:visible').count()) throw new Error('Cannot record login page HTML');
    const file = path.join(work, `booking-dom_${Date.now()}.html`);
    fs.writeFileSync(file, await page.content());
    console.log('BOOKING_DOM', file);
  } else if (command.operation === 'select-slot') {
    await selectSlot(page, command.date, command.start);
  } else if (command.operation === 'calendar-data') {
    const timestamp = Date.parse(command.date + 'T00:00:00+08:00') / 1000;
    const weekStart = await ensureWeek(page, timestamp);
    const components = await calendarComponents(page, weekStart);
    const file = path.join(work, `calendar-data_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(components, null, 2));
    console.log('CALENDAR_DATA', file, 'COUNT', components.length, 'FIRST_KEYS', Object.keys(components[0] || {}));
  } else if (command.operation === 'navigate') {
    const url = new URL(command.url);
    if (url.origin !== 'https://healthlab.zs-hospital.sh.cn' || !url.pathname.startsWith('/cf/main/!equipments/')) throw new Error('Unsupported navigation');
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    console.log('BOOKING_NAVIGATE_OK');
  } else if (command.operation === 'screenshot') {
    const file = path.join(work, `booking-screen_${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log('BOOKING_SCREENSHOT', file);
  } else throw new Error('Unsupported booking operation');
}
module.exports = { control, ensureWeek, calendarComponents, warmSlot, selectSlot, openEquipment, preflightBooking, prepareBooking, commitBooking };
