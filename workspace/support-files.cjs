'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
function safeError(error) {
  return String(error?.message || error).split('\n')[0].replace(/(password|token|cookie|authorization)\s*[=:]\s*[^\s,;]+/ig, '$1=[redacted]').replace(/https?:\/\/[^\s]+/g, url => { try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return '[url]'; } }).slice(0, 500);
}
async function captureFailure(root, job, phase, error, page) {
  const id = `failure-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const directory = path.join(root, 'outputs', 'diagnostics', id);
  fs.mkdirSync(directory, { recursive: true });
  const report = { version: 2, at: new Date().toISOString(), equipmentId: job.equipment?.equipmentId || 37, equipmentName: job.equipment?.equipmentName || '', jobId: job.id, date: job.date, start: job.start, end: job.end, accountLabel: job.accountLabel, accountOwner: job.accountOwner || '', phase, error: safeError(error), websiteAlert: error.websiteAlert ? safeError(error.websiteAlert) : undefined, screenshot: false, inputFieldsMasked: true };
  if (page && !page.isClosed()) {
    try { const url = new URL(page.url()); report.page = url.origin + url.pathname; } catch {}
    try { await page.screenshot({ path: path.join(directory, 'screenshot.png'), fullPage: false, mask: [page.locator('input,textarea,[contenteditable="true"]')], timeout: 5000 }); report.screenshot = true; report.screenshotAt = Date.now(); } catch (captureError) { report.screenshotError = safeError(captureError); }
  }
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  return id;
}
function diagnosticDirectory(root, id) {
  if (typeof id !== 'string' || !/^failure-\d+-[a-f0-9]{8}$/.test(id)) throw new Error('诊断编号无效');
  const directory = path.resolve(root, 'outputs', 'diagnostics', id);
  if (!fs.existsSync(path.join(directory, 'report.json'))) throw new Error('诊断材料不存在');
  return directory;
}
async function archiveDiagnostics(root, id, destination) {
  const directory = diagnosticDirectory(root, id);
  const python = process.env.CELLSTATION_PYTHON || path.join(__dirname, '.venv', 'Scripts', 'python.exe');
  await execFile(python, ['-B', path.join(__dirname, 'archive-support.py'), directory, destination, root], { windowsHide: true, timeout: 30000, maxBuffer: 100000 });
  return destination;
}
module.exports = { safeError, captureFailure, diagnosticDirectory, archiveDiagnostics };
