'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, powerMonitor, net, nativeTheme } = require('electron');
const { DesktopIntegration } = require('./workspace/desktop-integration.cjs');
const fs = require('node:fs');
const path = require('node:path');
const dataRoot = process.env.CELLSTATION_DATA_ROOT || (app.isPackaged ? path.join(path.dirname(process.execPath), 'data') : path.resolve(__dirname, '..', 'work', 'desktop-dev-data'));
const temp = path.join(dataRoot, 'temp');
fs.mkdirSync(temp, { recursive: true });
for (const directory of ['profile', 'crash-dumps', 'logs']) fs.mkdirSync(path.join(dataRoot, directory), { recursive: true });
process.env.CELLSTATION_DATA_ROOT = dataRoot;
process.env.CELLSTATION_PYTHON = path.join(__dirname, 'runtime', 'python', 'python.exe');
process.env.TEMP = process.env.TMP = temp;
app.setPath('userData', path.join(dataRoot, 'profile'));
app.setPath('sessionData', path.join(dataRoot, 'profile'));
app.setPath('crashDumps', path.join(dataRoot, 'crash-dumps'));
app.setAppLogsPath(path.join(dataRoot, 'logs'));
const logDirectory = path.join(dataRoot, 'logs'); fs.mkdirSync(logDirectory, { recursive: true });
for (const name of ['log', 'error']) {
  const original = console[name].bind(console);
  console[name] = (...args) => { fs.appendFileSync(path.join(logDirectory, 'desktop-' + new Date(Date.now()+28800000).toISOString().slice(0,10) + '.log'), `${new Date().toISOString()} ${require('node:util').format(...args)}\n`); original(...args); };
}
let mainWindow;
let startupWindow;
let updates;
let tray;
let manager;
let quitting = false;
let exitStarted = false;
let desktop;
let balloonClick;
let networkTimer;
const autoStarted = process.argv.includes('--autostart');
app.setAppUserModelId('CellStation');
async function quit() {
  if (exitStarted) return;
  exitStarted = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { await mainWindow.webContents.executeJavaScript('window.cellStationFlush?.()'); } catch (error) { exitStarted = false; show(); dialog.showErrorBox('更改尚未保存', error.message); return; }
  }
  if (manager) {
    manager.cancelPendingStart();
    desktop.schedulerIntent(manager.store.data.config.enabled);
    manager.store.setEnabled(false);
    await manager.scheduler.pausePrepared();
    await manager.close();
  }
  quitting = true;
  updates?.close();
  desktop?.dispose();
  clearInterval(networkTimer);
  tray?.destroy();
  app.exit(0);
}
function show(view) { if (!mainWindow) return; if (view === 'history') mainWindow.loadURL(manager.url + '/#history'); mainWindow.show(); if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => { if (!argv.includes('--autostart')) show(); });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); quit().catch(() => app.exit(1)); } });
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    startupWindow = new BrowserWindow({ width: 520, height: 355, resizable: false, title: 'CellStation 启动检查', show: !autoStarted, backgroundColor: '#f6f8f3', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await startupWindow.loadFile(path.join(__dirname, 'workspace/startup.html'));
    const startupProgress = value => { if(startupWindow && !startupWindow.isDestroyed()) startupWindow.webContents.executeJavaScript('window.startupProgress?.('+JSON.stringify(value)+')').catch(()=>{}); };
    updates = new (require('./workspace/desktop-updates.cjs').DesktopUpdates)({ app, dataRoot, getManager: () => manager, quit, isBackground: () => autoStarted || Boolean(mainWindow && !mainWindow.isVisible()), progress: value => startupProgress({message:value.message,percent:value.status==='downloading'?Math.round(70+(value.progress||0)*.25):75}) });
    desktop = new DesktopIntegration({ app, dataRoot, show, chooseBackupPath: async defaultPath => {
      const result = await dialog.showSaveDialog(mainWindow, { title: '导出 CellStation 配置备份', defaultPath, filters: [{ name: 'CellStation 配置备份（含加密密码）', extensions: ['json'] }] });
      return result.canceled ? null : result.filePath;
    }, revealBackup: file => shell.showItemInFolder(file), openDirectory: directory => shell.openPath(directory), openExternal: url => shell.openExternal(url), quit: () => { quit().catch(() => app.exit(1)); }, startupName: process.env.CELLSTATION_STARTUP_NAME || 'CellStation', sendNotification: message => {
      if (!tray || tray.isDestroyed()) throw new Error('系统托盘未就绪');
      balloonClick = message.click;
      tray.displayBalloon({ title: message.title, content: message.content, iconType: 'warning', noSound: false, respectQuietTime: true });
    } });
    manager = await require('./workspace/manager-server.cjs').createManager({ port: 0, desktop: true, pauseOnStart: true, desktopIntegration: desktop, updater: updates, onStartupProgress: check => { const finished=check.items.filter(i=>i.status!=='running').length;startupProgress({message:check.items.at(-1)?.title||'本地检查',percent:Math.round(10+finished/3*50),detail:check.items.at(-1)?.detail}); }, onJob: job => desktop.notify(job), onControl: enabled => desktop.schedulerIntent(enabled) });
    // Required checks complete before the main management window exists.
    await manager.operations.checkLocal();
    startupProgress({message:'本地检查通过，正在检查更新…',percent:65});
    await updates.startup();
    nativeTheme.themeSource = manager.store.data.config.theme || 'system';
    mainWindow = new BrowserWindow({ width: 1400, height: 940, minWidth: 940, minHeight: 680, title: 'CellStation · 实验预约', backgroundColor: '#f5f6f1', icon: path.join(__dirname, 'assets', 'icon.ico'), show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => { try { const target=new URL(url);if(target.protocol==='https:'&&['github.com','sct.ftqq.com','www.pushplus.plus'].includes(target.hostname)) shell.openExternal(url); } catch {} return { action: 'deny' }; });
    mainWindow.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== manager.url) event.preventDefault(); });
    mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
    mainWindow.on('minimize', event => { if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
    const image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    tray = new Tray(image);
    tray.setToolTip('CellStation · 实验预约');
    const refreshTrayMenu = () => tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开预约管理', click: show },
      { label: '暂停定时预约', click: async () => { manager.cancelPendingStart(); manager.store.setEnabled(false); desktop.schedulerIntent(false); await manager.scheduler.pausePrepared(); } },
      { label: '开机自启动', type: 'checkbox', checked: desktop.status().autoStart, click: item => { try { desktop.update({ autoStart: item.checked }); } catch (error) { item.checked = desktop.status().autoStart; dialog.showErrorBox('启动项设置失败', error.message); } } },
      { label: '发送测试提醒', click: () => desktop.testNotification() },
      { type: 'separator' },
      { label: '退出程序并停止任务', click: () => { quit().catch(() => app.exit(1)); } },
    ]));
    desktop.onSettingsChanged = status => { nativeTheme.themeSource = status.theme || 'system'; refreshTrayMenu(); };
    refreshTrayMenu();
    tray.on('double-click', show);
    tray.on('balloon-click', () => balloonClick?.());
    tray.on('balloon-show', () => { manager.store.event('notification', 'Windows已显示系统提醒'); });
    desktop.replayUncertain(Object.values(manager.store.data.jobs));
    powerMonitor.on('suspend', () => manager.operations.suspend());
    powerMonitor.on('resume', () => { manager.operations.resume(); manager.scheduler.tick().catch(() => {}); });
    manager.operations.networkStatus(net.isOnline());
    networkTimer = setInterval(() => manager.operations.networkStatus(net.isOnline()), 30000);
    startupProgress({message:'正在加载预约管理界面…',percent:95});
    await mainWindow.loadURL(manager.url);
    updates.markHealthy();
    startupWindow.destroy(); startupWindow=null;
    if (!autoStarted) mainWindow.show();
    if (updates.consumeResume() || desktop.shouldResume(autoStarted)) {
      const revision = manager.controlRevision();
      manager.setStartupPending(true);
      try { await manager.operations.ensureCheck(); if (!exitStarted && revision === manager.controlRevision()) { manager.store.setEnabled(true); await manager.scheduler.tick(); } }
      catch { tray.displayBalloon({ title: 'CellStation · 调度未恢复', content: '请打开管理窗口检查账号和时段配置，预约仍保持暂停。', iconType: 'warning', respectQuietTime: true }); }
      finally { manager.setStartupPending(false); }
    }
  }).catch(error => { console.error('DESKTOP_START_ERROR', error.message); dialog.showErrorBox('CellStation启动失败', error.message); quitting = true; app.exit(1); });
}

