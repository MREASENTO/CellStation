'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { screenshotAvailable, readScreenshot } = require('./retention.cjs');
const { diagnosticDirectory } = require('./support-files.cjs');
const { Operations } = require('./operations.cjs');
const { ManagerStore } = require('./manager-store.cjs');
const { Scheduler } = require('./scheduler.cjs');
const { WINDOWS, windowsFor, validateSchedules, generateJobs, shanghaiDate, addDays } = require('./schedule-logic.cjs');
const { root: ROOT } = require('./runtime-paths.cjs');
const PUBLIC = path.join(__dirname, 'manager-ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('请求需要JSON格式');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 262144) throw new Error('请求内容过长');
  }
  return JSON.parse(text || '{}');
}
async function createManager(options = {}) {
  const clock = options.clock || Date.now;
  const csrf = crypto.randomBytes(32).toString('hex');
  let store;
  let scheduler;
  let worker;
  let shuttingDown = false;
  let application;
  let operations;
  let reviews;
  let siteAppointments;
  let wechat;
  let equipmentTesting=false;
  let autoActivation,startingPromise;let startingSource;let startupReady=!options.desktop;
  const startupNotifications=new Map();
  let controlRevision = 0;
  let pendingStart = false;
  const ensureIdle = () => { if(equipmentTesting)throw new Error('设备检测正在进行，请稍后操作'); if(siteAppointments?.active)throw new Error('正在读取网站预约，请稍后操作'); if (reviews?.active) throw new Error('核对正在进行或网页尚未关闭，请稍后操作'); if (scheduler?.busy.size) throw new Error('上一任务仍在执行或核对结果，请稍后再操作'); };
  const loginTests = new Set();
  const cancelled=()=>Object.assign(new Error('启动已取消，预约保持当前状态'),{code:'START_CANCELLED'});
  async function changeScheduling(enabled,{source='manual',guard=()=>true}={}){
    if(!enabled){controlRevision++;pendingStart=false;autoActivation?.invalidate();store.setEnabled(false,clock());if(source==='manual')store.pauseAutomatically(clock());options.onControl?.(false);await scheduler.pausePrepared();return{config:store.data.config};}
    if(shuttingDown)throw cancelled();
    if(source==='startup'&&store.data.config.autoActivateByPlan&&store.data.autoActivationPause?.resumeAt>clock())return{config:store.data.config,deferred:true};
    if(store.data.config.enabled)return{config:store.data.config};
    if(startingPromise){
      if(source==='manual'&&startingSource!=='manual'){const revision=++controlRevision;autoActivation?.invalidate();await startingPromise.catch(()=>{});if(revision!==controlRevision)throw cancelled();return changeScheduling(true,{source,guard});}
      return startingPromise;
    }
    const revision=++controlRevision;pendingStart=true;startingSource=source;
    const promise=Promise.resolve().then(async()=>{
      try{
        if(source!=='manual')await siteAppointments?.cancel('即将自动开始预约，已暂停日历缓存更新');
        operations.retention.stop();await operations.retentionPromise?.catch(()=>{});
        validateSchedules(store.data.config,store.data.accounts,clock());
        if(!options.skipPreflight){ensureIdle();if(loginTests.size)throw new Error('账号正在检测，请稍后启动');await operations.ensureCheck();}
        if(revision!==controlRevision||shuttingDown||!guard())throw cancelled();
        store.setEnabled(true,clock());options.onControl?.(true);
        if(source!=='manual')store.event('automatic-start',source==='startup'?'程序启动后已自动开始预约':'已自动启用预约调度，按当前设备计划执行');
        await scheduler.tick();return{config:store.data.config};
      }finally{if(startingPromise===promise){startingPromise=null;startingSource=null;pendingStart=false;}}
    });startingPromise=promise;return promise;
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const port = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host)) return send(403, { error: '仅允许本机访问' });
    if (!store || shuttingDown) return send(503, { error: '服务正在启动或退出' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) {
          if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: '跨来源请求已拒绝' });
          const token = req.headers['x-csrf-token'];
          if (typeof token !== 'string' || token.length !== csrf.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) return send(403, { error: '请求校验失败，请刷新页面' });
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const plan = scheduler.plan(7, true);
          const jobs = Object.values(store.data.jobs).sort((a, b) => b.releaseAt - a.releaseAt).slice(0, 200);
          return send(200, { application: 'cellstation-manager', desktop: Boolean(options.desktop), pendingStart, desktopSettings: options.desktopIntegration?.status() || null, operations: operations?.publicState(), siteAppointments:siteAppointments?.publicState(), autoActivation:autoActivation?.publicState(), wechat: wechat?.publicState(), updates: options.updater?.publicState(), csrfToken: csrf, serverTime: clock(), config: store.data.config, accounts: store.accounts(), windows: WINDOWS, plan, jobs, events: store.data.events, bindings: store.data.bindings, assignmentRevision: store.data.assignmentRevision, version: '2.0.1' });
        }
        if (req.method === 'PUT' && url.pathname === '/api/wechat') return send(200, await wechat.update(await body(req)));
        if (req.method === 'POST' && url.pathname === '/api/wechat/test') { await body(req); return send(200, await wechat.test()); }
        if (req.method === 'PUT' && url.pathname === '/api/updates/settings') { if (!options.updater) throw new Error('自动更新仅在独立桌面版可用'); return send(200, options.updater.settings(await body(req))); }
        if (req.method === 'POST' && url.pathname === '/api/updates/check') { await body(req); if (!options.updater) throw new Error('请在桌面版检查更新'); options.updater.check().catch(() => {}); return send(200, {checking:true}); }
        if (req.method === 'POST' && url.pathname === '/api/updates/install') { await body(req); if (!options.updater) throw new Error('请在桌面版更新'); options.updater.install().catch(() => {}); return send(200, {started:true}); }
        if (req.method === 'POST' && url.pathname === '/api/assignments/view') { const input = await body(req); return send(200, store.assignmentView(input.date)); }
        if (req.method === 'POST' && ['/api/assignments/randomize', '/api/assignments/account', '/api/assignments/move', '/api/assignments/reset-windows'].includes(url.pathname)) {
          const input = await body(req); if (typeof input.revision !== 'string') throw new Error('请先读取此日分配，再修改');
          const result = url.pathname.endsWith('/randomize') ? store.rerandomize(input.date, input.revision, clock()) : url.pathname.endsWith('/account') ? store.setAssignment(input.date, input.windowId, input.accountId, input.revision, clock()) : url.pathname.endsWith('/move') ? store.moveAssignment(input.date, input.fromId, input.toId, input.revision, clock()) : store.resetDateWindows(input.date, input.revision, clock());
          return send(200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/healthcheck') {
          ensureIdle();
          const input = await body(req); if (loginTests.size) throw new Error('账号登录检查正在进行');
          if (input.accounts !== undefined && typeof input.accounts !== 'boolean') throw new Error('自检参数无效');
          return send(200, { health: operations.startCheck({ accounts: input.accounts !== false }) });
        }
        if (req.method === 'PUT' && url.pathname === '/api/exclusions') {
          store.setExclusions((await body(req)).entries); return send(200, { exclusions: store.data.config.exclusions });
        }
        if (req.method === 'PUT' && url.pathname === '/api/retention-policy') { store.setRetentionPolicy(await body(req)); return send(200, { retentionPolicy: store.data.config.retentionPolicy }); }
        if(req.method==='POST'&&url.pathname==='/api/team'){const member=store.saveTeamMember(await body(req));siteAppointments?.reclassify?.();return send(200,{member});}
        if(req.method==='DELETE'&&url.pathname==='/api/team'){const {id}=await body(req);store.removeTeamMember(id);siteAppointments?.reclassify?.();return send(200,{removed:true});}
        if(req.method==='PUT'&&url.pathname==='/api/personal-account'){const input=await body(req);store.setPersonalAccount(input.accountId);return send(200,{accountId:store.data.config.personalAccountId});}
        if(req.method==='POST'&&url.pathname==='/api/website/read'){const input=await body(req);return send(200,await siteAppointments.start(input.date,{force:input.force===undefined?false:input.force}));}
        if(req.method==='POST'&&url.pathname==='/api/website/open-personal'){const input=await body(req);await siteAppointments.cancel('已切换至预约日历');return send(200,await reviews.openPersonal(store.data.config.personalAccountId,input.equipmentId));}
        if(req.method==='PUT'&&url.pathname==='/api/auto-activation'){
          const input=await body(req);store.setAutoActivationPolicy(input);controlRevision++;autoActivation.invalidate();return send(200,{policy:input,autoActivation:autoActivation.publicState()});
        }
        if (req.method === 'PUT' && url.pathname === '/api/catch-up') {const input=await body(req);store.setCatchUpEnabled(input.enabled);return send(200,{enabled:store.data.config.catchUpEnabled});}
        if(req.method==='PUT'&&url.pathname==='/api/review-rebook'){const {enabled}=await body(req);store.setReviewRebookEnabled(enabled);return send(200,{enabled});}
        if (req.method === 'PUT' && url.pathname === '/api/review-policy') {store.setReviewPolicy(await body(req));reviews.reschedule?.();return send(200,{reviewPolicy:store.data.config.reviewPolicy});}
        if (req.method === 'PUT' && url.pathname === '/api/retry-policy') {
          store.setRetryPolicy(await body(req)); return send(200, { retryPolicy: store.data.config.retryPolicy });
        }
        if (req.method === 'POST' && ['/api/reviews/recheck','/api/reviews/open'].includes(url.pathname)) { const input=await body(req);await siteAppointments.cancel('已切换至预约核对'); return send(200,await (url.pathname.endsWith('/open')?reviews.openWebsite(input.jobId):reviews.recheck(input.jobId))); }
        if (req.method === 'POST' && url.pathname === '/api/reviews/rebook') {
          const input=await body(req);if(shuttingDown||pendingStart)throw new Error('程序正在启动或退出，请稍后重新预约');
          await siteAppointments.cancel('正在手动重新预约');return send(200,await reviews.rebook(input.jobId,input.requestId));
        }
        if (req.method === 'POST' && url.pathname === '/api/summary') return send(200, operations.summary((await body(req)).date));
        if (req.method === 'POST' && url.pathname === '/api/summary/export') return send(200, operations.exportSummary((await body(req)).date));
        if (req.method === 'POST' && url.pathname === '/api/backup/export') {
          const input = await body(req);
          let destination;
          if (input.chooseLocation && options.desktopIntegration?.chooseBackupPath) {
            destination = await options.desktopIntegration.chooseBackupPath(path.join(operations.exports, `CellStation-config-${new Date(clock()).toISOString().replace(/[:.]/g, '-')}.json`));
            if (!destination) return send(200, { cancelled: true });
          }
          const result = operations.backup('manual', destination); operations.lastBackupExport = result.file;
          return send(200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/backup/reveal') {
          await body(req); if (!operations.lastBackupExport || !options.desktopIntegration?.revealBackup) throw new Error('请先导出配置备份');
          await options.desktopIntegration.revealBackup(operations.lastBackupExport); return send(200, { opened: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/backup/preview') { ensureIdle(); return send(200, await operations.previewRestore((await body(req)).backup)); }
        if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
          ensureIdle();
          const result = operations.restore((await body(req)).token); autoActivation.invalidate();reviews.reschedule?.(); options.onControl?.(false); return send(200, result);
        }
        const diagnosticMatch = url.pathname.match(/^\/api\/diagnostics\/(failure-\d+-[a-f0-9]{8})(\/screenshot)?$/);
        if (req.method === 'GET' && diagnosticMatch) {
          const directory = diagnosticDirectory(operations.root, diagnosticMatch[1]);
          const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
          const file = path.join(directory, 'screenshot.png');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          if (diagnosticMatch[2]) {
            if (!report.screenshot || !screenshotAvailable(operations.root, directory)) return send(404, { error: report.screenshotError || '本次失败时网页不可用，未能生成截图' });
            const bytes = await readScreenshot(operations.root, directory); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(bytes); return;
          }
          return send(200, { ...report, id: diagnosticMatch[1], imageUrl: report.screenshot && screenshotAvailable(operations.root, directory) ? `/api/diagnostics/${diagnosticMatch[1]}/screenshot` : null });
        }
        if (req.method === 'POST' && url.pathname === '/api/diagnostics/export') { const input = await body(req); return send(200, await operations.exportDiagnostic(input.jobId, input.diagnosticId)); }
        if (options.desktopIntegration && req.method === 'POST' && url.pathname === '/api/exports/open') { await body(req); await options.desktopIntegration.openExports(operations.exports); return send(200, { opened: true }); }
        if (options.desktopIntegration && req.method === 'POST' && url.pathname === '/api/desktop/open-website') { await body(req); await options.desktopIntegration.openWebsite(); return send(200, { opened: true }); }
        if (options.desktopIntegration && req.method === 'PUT' && url.pathname === '/api/desktop/settings') {
          const settings = options.desktopIntegration.update(await body(req));
          store.event('desktop', '桌面启动与通知设置已更新');
          return send(200, { settings });
        }
        if (options.desktopIntegration && req.method === 'POST' && url.pathname === '/api/desktop/test-notification') {
          await body(req);
          return send(200, options.desktopIntegration.testNotification());
        }
        if (options.desktopIntegration && req.method === 'POST' && url.pathname === '/api/desktop/quit') {
          await body(req);
          send(200, { exiting: true });
          setImmediate(() => options.desktopIntegration.requestExit());
          return;
        }
        if (req.method === 'PUT' && url.pathname === '/api/theme') {
          const { theme } = await body(req); store.setTheme(theme); options.desktopIntegration?.update({ theme }); return send(200, { theme });
        }
        if(req.method==='POST'&&url.pathname==='/api/equipment/detect'){
          ensureIdle();const {name}=await body(req);
          if(store.data.config.enabled&&scheduler.plan(1).some(j=>j.releaseAt>=clock()-60000&&j.releaseAt<=clock()+180000&&!['success','already_exists','failed','needs_review','missed'].includes(store.data.jobs[j.id]?.status)))throw new Error('临近预约开放，请在任务结束后检测设备');
          equipmentTesting=true;try{return send(200,await worker.detectEquipment(name));}finally{equipmentTesting=false;}
        }
        if (req.method === 'POST' && url.pathname === '/api/equipment/search') {
          const { name } = await body(req); return send(200, { candidates: await worker.searchEquipment(name) });
        }
        if (req.method === 'PUT' && url.pathname === '/api/equipment') {
          const equipment = require('./equipment.cjs').validateEquipment(await body(req));
          const verified = await worker.validateEquipment(equipment);
          store.setEquipment(verified); return send(200, { equipment: store.data.config.equipment });
        }
        if(req.method==='PUT'&&url.pathname==='/api/equipment/schedule'){
          const input=await body(req),current=store.data.config.equipments.find(e=>e.equipmentId===input.equipmentId);if(!current)throw new Error('设备不存在，请刷新列表');
          const bookingSchedule=require('./equipment.cjs').validateBookingSchedule(input.bookingSchedule);
          store.setEquipments(store.data.config.equipments.map(e=>e.equipmentId===input.equipmentId?{...e,bookingSchedule}:e));return send(200,{equipment:store.data.config.equipments.find(e=>e.equipmentId===input.equipmentId)});
        }
        if (req.method === 'PUT' && url.pathname === '/api/equipments') {
          const items = require('./equipment.cjs').validateEquipmentList((await body(req)).equipments);
          for (const item of items) {
            const known = store.data.config.equipments.find(e => e.equipmentId === item.equipmentId && e.equipmentName === item.equipmentName);
            if (!known) await worker.validateEquipment(item);
          }
          store.setEquipments(items); return send(200, { equipments: store.data.config.equipments });
        }
        if (req.method === 'POST' && url.pathname === '/api/accounts') {
          const account = await store.saveAccount(await body(req));
          return send(200, { account });
        }
        if (req.method === 'PUT' && url.pathname === '/api/windows') {
          store.setWindows((await body(req)).windows);
          return send(200, { config: store.data.config });
        }
        if (req.method === 'POST' && url.pathname === '/api/control') {
          const input = await body(req);
          if (typeof input.enabled !== 'boolean') throw new Error('调度状态无效');
          return send(200,await changeScheduling(input.enabled));
        }
        if (req.method === 'POST' && url.pathname === '/api/shutdown') {
          await body(req);
          startupReady=false;await changeScheduling(false,{source:'shutdown'});
          send(200, { stopped: true });
          setImmediate(() => { application.close().catch(() => {}); });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulate') {
          const input = await body(req);
          const date = input.date || addDays(shanghaiDate(clock()), 7);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || shanghaiDate(Date.parse(date + 'T00:00:00+08:00')) !== date) throw new Error('日期无效');
          const mapping = store.assignment(date);
          const jobs = generateJobs(store.data.config, store.accounts(), addDays(date, -7), 1, true).map(job => {
            const id = store.data.bindings[`${date}|${job.windowId}`] || mapping[job.windowId] || null;
            const account = store.accounts().find(a => a.id === id);
            return { ...job, accountId: id, accountLabel: account?.owner || account?.username || '未分配账号', accountOwner: account?.owner || '', available: Boolean(job.equipmentEnabled && windowsFor(store.data.config, date).find(w => w.id === job.windowId).enabled && account?.enabled && !job.skipped) };
          });
          return send(200, { simulation: true, date, total: jobs.length, assigned: jobs.filter(j => j.available).length, jobs });
        }
        const loginMatch = url.pathname.match(/^\/api\/accounts\/([a-f0-9-]+)\/test-login$/);
        if (req.method === 'POST' && loginMatch) {
          if (operations.checkPromise) throw new Error('自检正在检查账号，请稍候');
          if (loginTests.has(loginMatch[1])) throw new Error('该账号正在检查中，请稍候');
          loginTests.add(loginMatch[1]);
          try {
            const result = await worker.testLogin(loginMatch[1]);
            store.event('login', '已完成账号后台登录检查，未进行预约');
            return send(200, result);
          } finally { loginTests.delete(loginMatch[1]); }
        }
        return send(404, { error: '接口不存在' });
      }
      if (req.method !== 'GET') return send(405, { error: '不支持此操作' });
      const assets = { '/': 'index.html', '/index.html': 'index.html', '/date-follow.js': 'date-follow.js', '/app.js': 'app.js', '/settings-v100.js': 'settings-v100.js', '/style.css': 'style.css' };
      const file = assets[url.pathname];
      if (!file) return send(404, { error: '页面不存在' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] });
      fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
    } catch (error) { send(400, { error: String(error.message).slice(0, 900), diagnosticId: error.diagnosticId }); }
  });
  // Claim the listening port before touching persistent state, so a second launcher
  // cannot reset a live scheduler's job state.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8765, '127.0.0.1', resolve); });
  try {
    store = new ManagerStore(options.directory || path.join(ROOT, 'work', 'manager'), options.vault);
    if (options.pauseOnStart) store.setEnabled(false, clock());
    wechat = new (require('./wechat-notifications.cjs').WechatNotifications)(path.dirname(store.file), store.vault, options.notificationFetch);
    store.onJob = job => { if(!reviews){startupNotifications.set(job.id,job);return;}const current=reviews.observe?.(job)||job;try { options.onJob?.(current); } finally { wechat.enqueue(current); } };
    if (options.workerFactory) worker = options.workerFactory(store);
    else {
      const temp = path.join(ROOT, 'work', 'temp');
      fs.mkdirSync(temp, { recursive: true });
      process.env.TEMP = process.env.TMP = temp;
      worker = new (require('./browser-worker.cjs').BrowserWorker)(store, ROOT);
    }
    scheduler = new Scheduler(store, worker, clock);
    operations = new Operations({ root: options.operationsRoot || options.directory || ROOT, store, worker, clock, desktop: options.desktopIntegration, localCheck: options.localCheck, onProgress: options.onStartupProgress, canMaintain: () => !scheduler.busy.size && !pendingStart && !autoActivation?.imminent() && (!store.data.config.enabled || !scheduler.plan(1).some(j => j.releaseAt >= clock() - 60000 && j.releaseAt <= clock() + 120000)) });
    reviews = options.reviewFactory ? options.reviewFactory(store) : new (require('./reviews.cjs').Reviews)(store,options.operationsRoot||ROOT,{clock,controlVersion:()=>controlRevision,canRun:job=>!equipmentTesting&&!siteAppointments?.active&&!operations.checkPromise&&!loginTests.has(job.accountId)&&![...scheduler.activeAccounts.values()].includes(job.accountId)&&![...scheduler.prepared.keys()].some(id=>store.data.jobs[id]?.accountId===job.accountId)&&(!store.data.config.enabled||!scheduler.plan(1).some(j=>j.accountId===job.accountId&&j.releaseAt>=clock()-60000&&j.releaseAt<=clock()+120000&&!['success','already_exists','failed','needs_review','missed'].includes(store.data.jobs[j.id]?.status)))});
    for(const job of startupNotifications.values())store.onJob(store.data.jobs[job.id]||job);startupNotifications.clear();
    for(const job of Object.values(store.data.jobs))if(job.status==='needs_review'&&job.review?.manualRequired&&clock()-(job.review.checkedAt||0)<86400000)wechat.enqueue(job);
    siteAppointments=options.siteAppointmentsFactory?options.siteAppointmentsFactory(store):new (require('./site-appointments.cjs').SiteAppointments)(store,options.operationsRoot||ROOT,{clock,canStart:()=>!pendingStart&&!autoActivation?.imminent()&&!equipmentTesting&&!operations.checkPromise&&!loginTests.size&&!reviews.active&&!scheduler.busy.size&&!scheduler.prepared.size&&(!store.data.config.enabled||!scheduler.plan(1).some(j=>j.releaseAt>=clock()-60000&&j.releaseAt<=clock()+120000&&!['success','already_exists','failed','needs_review','missed'].includes(store.data.jobs[j.id]?.status)))});
    worker.onCalendar=reviews.onCalendar=(job,snapshot)=>siteAppointments.acceptCalendar?.(job,snapshot);
    scheduler.beforeJobs=(now,jobs,records)=>{siteAppointments.interruptIfCritical?.(now,jobs,records);if(Object.values(records).some(j=>j.status==='needs_review'&&j.review?.state==='waiting'&&j.review.nextAt<=now))siteAppointments.cancel('正在核对预约，请稍后刷新网站预约').catch(()=>{});};
    scheduler.externalBusy=accountId=>Boolean(equipmentTesting||siteAppointments.active||reviews.isAccountBusy?.(accountId));
    autoActivation=new (require('./auto-activation.cjs').AutomaticActivation)(store,{clock,plan:()=>scheduler.plan(2),start:change=>changeScheduling(true,change),canStart:()=>startupReady&&!shuttingDown&&!pendingStart&&!equipmentTesting&&!loginTests.size&&!operations.checkPromise&&!reviews.active&&!scheduler.busy.size});
    if (options.runScheduler !== false) reviews.start();
    if (options.runScheduler !== false) operations.start();
    if (options.runScheduler !== false) await scheduler.start();
    if (options.runScheduler !== false) siteAppointments.startDaily?.();
    if(options.runScheduler!==false)autoActivation.startTimer();
  } catch (error) { server.close(); throw error; }
  application = { server, store, scheduler, worker, operations, reviews, siteAppointments, wechat, autoActivation, startScheduling:change=>changeScheduling(true,change),pauseScheduling:()=>changeScheduling(false),isStarting:()=>Boolean(startingPromise),suspendAutomaticStart:()=>{startupReady=false;},allowAutomaticStart:()=>{startupReady=true;autoActivation.tick().catch(()=>{});},controlRevision: () => controlRevision, setStartupPending: value => { pendingStart = Boolean(value); }, cancelPendingStart: () => { controlRevision++; pendingStart = false;autoActivation.invalidate(); }, url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { if (shuttingDown) return; shuttingDown = true; controlRevision++; operations.cancel();const autoClosing=autoActivation?.close(); clearInterval(scheduler.timer); await siteAppointments?.close(); await reviews?.close(); await scheduler.stop();await autoClosing;await startingPromise?.catch(()=>{}); await operations.checkPromise?.catch(() => {}); await operations.retentionPromise?.catch(() => {}); await wechat.idle(); await new Promise(resolve => server.close(resolve)); },
  };
  return application;
}
if (require.main === module) {
  createManager().then(app => {
    console.log(`细胞台管理服务已启动：${app.url}`);
    console.log('请保持此服务运行；关闭网页不影响调度，关闭此服务则停止。按 Ctrl+C 退出。');
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  }).catch(error => {
    console.error(error.code === 'EADDRINUSE' ? '本机管理服务已在运行，请打开 http://127.0.0.1:8765' : `管理服务启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { createManager };



