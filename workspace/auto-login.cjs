'use strict';
const path = require('node:path');
const { Writable } = require('node:stream');
const readline = require('node:readline/promises');
const { recognizeCaptcha } = require('./ocr.cjs');
const { validateRetryPolicy } = require('./schedule-logic.cjs');

function captchaExhausted(limit) {
  const error = new Error(`验证码/OCR未通过，已用完配置的${limit}次刷新重试，已停止登录`);
  error.code = 'CAPTCHA_RETRIES_EXHAUSTED'; error.retryable = false; return error;
}
async function automaticLogin(page, username, password, work, { recognize = recognizeCaptcha, captchaRetries = 2, deadline = Infinity, now = Date.now, onStep = () => {} } = {}) {
  validateRetryPolicy({ taskRetries: 0, captchaRetries });
  const checkDeadline = () => { if (now() >= deadline) { const error = new Error('登录准备已超过执行时间，未继续提交'); error.retryable = false; throw error; } };
  const url = new URL(page.url());
  if (url.origin !== 'https://healthlab.zs-hospital.sh.cn' || !/\/login$/.test(url.pathname)) {
    throw new Error('当前不是预约系统登录页，已停止自动填写。');
  }
  // Save only the captcha crop. Never save screenshots of populated login forms.
  for (let attempt = 0; attempt <= captchaRetries; attempt++) {
    checkDeadline();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(work, `captcha_auto_${stamp}_${attempt}.png`);
    await page.locator('img[src*="!login_plus/vfcode"]').screenshot({ path: file });
    onStep('captcha_capture', `第${attempt + 1}次验证码截图`);
    let captcha;
    try { onStep('ocr_start', '开始本地OCR'); captcha = await recognize(file); onStep('ocr_complete', '本地OCR完成'); }
    catch (error) {
      if (!/OCR 未返回有效/.test(error.message)) throw error;
      if (attempt >= captchaRetries) throw captchaExhausted(captchaRetries);
      checkDeadline(); onStep('captcha_refresh', '刷新验证码'); await refreshCaptcha(page); continue;
    }
    checkDeadline();
    console.log(`验证码已在本地识别，正在检查登录（首次之外已刷新${attempt}/${captchaRetries}次）。`);
    try {
      await page.locator('input[name="token"]').fill(username, { timeout: 10000 });
      await page.locator('input[name="password"]').fill(password, { timeout: 10000 });
    } catch { throw new Error('账号密码填写失败，日志已省略输入内容。'); }
    await page.locator('input[name="vfcode"]').fill(captcha);
    checkDeadline();
    onStep('login_submit', '提交登录');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
      page.locator('input[type="submit"][name="submit"]').click(),
    ]);
    const current = new URL(page.url());
    const loginVisible = await page.locator('input[type="password"]:visible').count();
    const success = current.origin === url.origin && !/\/login(?:\/|$)/.test(current.pathname) && loginVisible === 0;
    if (!success) {
      const feedback = await page.locator('body').innerText().catch(() => '');
      if (/密码.{0,15}(错误|不正确)|账号.{0,15}(锁定|禁用|不存在)/.test(feedback)) { const error = new Error('账号密码错误或账号不可用，已停止登录'); error.retryable = false; throw error; }
      if (captchaRejected(feedback)) {
        if (attempt >= captchaRetries) throw captchaExhausted(captchaRetries);
        checkDeadline(); onStep('captcha_refresh', '刷新验证码'); await refreshCaptcha(page); continue;
      }
      const error = new Error('登录未通过；未继续提交，请检查账号或验证码'); error.retryable = false; throw error;
    }
    onStep('login_confirmed', '登录成功');
    console.log('AUTO_LOGIN_OK: 验证码自动识别、填写及登录成功。');
    return true;
  }
  throw captchaExhausted(captchaRetries);
}
function captchaRejected(text) { return /验证码.{0,20}(错误|不正确|不匹配|无效|过期)|(?:错误|不正确|无效)的?验证码/i.test(String(text)); }
async function refreshCaptcha(page) {
  const response = page.waitForResponse(r => r.url().includes('!login_plus/vfcode'), { timeout: 5000 }).then(r => r.finished()).catch(() => null);
  await page.locator('img[src*="!login_plus/vfcode"]').click({ timeout: 10000 });
  await response; await page.waitForTimeout(180);
  console.log('已点击刷新验证码，将重新截图并在本地识别。');
}

async function promptAndLogin(page, work) {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const terminal = readline.createInterface({
    input: process.stdin, output,
    terminal: Boolean(process.stdin.isTTY), historySize: 0,
  });
  let username;
  let password;
  try {
    username = (await terminal.question('账号：')).trim();
    process.stdout.write('密码（输入时不显示）：');
    muted = true;
    password = await terminal.question('');
    muted = false;
    process.stdout.write('\n');
  } finally { muted = false; terminal.close(); }
  if (!username || !password) throw new Error('账号或密码为空，请在浏览器中手动登录。');
  try { return await automaticLogin(page, username, password, work); }
  finally { username = password = undefined; }
}
module.exports = { automaticLogin, promptAndLogin, captchaRejected, refreshCaptcha };
