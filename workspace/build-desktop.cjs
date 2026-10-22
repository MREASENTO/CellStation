'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function main() {
  const { packager } = require('@electron/packager');
  const result = await packager({
    dir: path.join(root, 'work', 'desktop-stage-v1.0.0'), name: 'CellStation',
    platform: 'win32', arch: 'x64', electronVersion: '45.0.0',
    electronZipDir: path.join(root, 'work', 'electron-download'),
    out: path.join(root, 'outputs', 'release-v1.0.0'), asar: false, prune: false, overwrite: false,
    icon: path.join(root, 'work', 'desktop-stage-v1.0.0', 'assets', 'icon.ico'),
    win32metadata: { CompanyName: 'CellStation', ProductName: 'CellStation', FileDescription: 'CellStation 细胞台预约管理' },
  });
  console.log('DESKTOP_BUILD_OK', result);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
