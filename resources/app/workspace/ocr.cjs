'use strict';
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

async function recognizeCaptcha(imagePath) {
  const python = process.env.CELLSTATION_PYTHON || path.join(__dirname, '.venv', 'Scripts', 'python.exe');
  const { stdout } = await execFile(python, ['-B', path.join(__dirname, 'recognize-captcha.py'), imagePath], {
    timeout: 45000,
    windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout.trim());
  if (!result.usable) throw new Error('OCR 未返回有效的四位验证码，请改为手动输入。');
  return result.text;
}
module.exports = { recognizeCaptcha };
