'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
// Windows DPAPI CurrentUser: encrypted data stays local and is tied to this Windows user.
async function transform(operation, input) {
  if (process.platform !== 'win32') throw new Error('账号保险库需要 Windows 当前用户环境');
  const method = operation === 'protect' ? 'Protect' : 'Unprotect';
  const script = `Add-Type -AssemblyName System.Security; $payload=[Console]::In.ReadToEnd().Trim(); $bytes=[Convert]::FromBase64String($payload); $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  const exe = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('账号保险库操作超时')); }, 15000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timeout); reject(new Error('无法启动 Windows 账号保险库')); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error('无法读取加密账号；请在创建账号的 Windows 用户下运行'));
      else resolve(Buffer.from(output.trim(), 'base64'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input.toString('base64'));
  });
}
module.exports = {
  protect: async text => (await transform('protect', Buffer.from(text, 'utf8'))).toString('base64'),
  unprotect: async cipher => (await transform('unprotect', Buffer.from(cipher, 'base64'))).toString('utf8'),
};
