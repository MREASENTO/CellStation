'use strict';
const $ = s => document.querySelector(s);
const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const day = ms => new Date(ms + 28800000).toISOString().slice(0, 10);
const fmt = (ms, full = false) => Number.isFinite(Number(ms)) ? new Date(Number(ms) + 28800000).toISOString().slice(full ? 0 : 11, 23).replace('T', ' ') : '—';
const identity = a => a.accountOwner || a.owner || a.username || a.accountLabel || '未分配账号';
const labels = { queued:'等待准备', preparing:'登录准备中', ready:'等待开放', saving:'正在保存', success:'预约成功', already_exists:'已存在', failed:'执行失败', needs_review:'需核对', missed:'已错过', retrying:'等待重试', skipped:'已跳过', disabled:'未分配', planned:'计划中' };
const steps = { server_release_wait:'等待服务器开放', slot_warmed:'时间已提前预选',final_availability_checked:'保存前新日历核对',save_response:'保存响应返回',receipt_warning:'回执生成提示', website_alert:'网站拒绝原因', open_form:'打开表单', form_opened:'表单已打开', prepare_start:'任务开始', browser_open:'后台浏览器就绪', login_page:'登录页加载', captcha_capture:'验证码截图', ocr_start:'OCR开始', ocr_complete:'OCR完成', captcha_refresh:'验证码刷新', login_submit:'提交登录', login_confirmed:'登录成功', equipment_open:'仪器日历加载', availability_checked:'目标周及冲突核对', ready:'准备就绪', release_reached:'到达开放时刻', form_verified:'表单填写与核对', save_click:'调用保存按钮', save_request:'保存阶段POST请求', save_click_returned:'保存点击返回', record_verified:'网站记录核实成功', result_confirmed:'结果确认完成' };
let state, preview, restoreToken, view = 'overview', controlPending = false, offset = 0;
let previewRequest = 0, summaryRequest = 0;
const dateFollow = new DateFollow(), dateIds = ['plan-date','summary-date','exclusion-date','assignment-date'];
const dateButtons = new Map();
function syncDates(now = Date.now() + offset) {
  const changed = [];
  for (const id of dateIds) {
    const input = $('#'+id), value = dateFollow.next(id,input.value,now,document.activeElement===input);
    if (value !== input.value) { input.value = value; changed.push(id); }
    const follow = dateFollow.follows(id), action = dateButtons.get(id);
    action.textContent = follow ? '跟随今天＋7天' : '恢复跟随今天＋7天';
    action.setAttribute('aria-pressed',String(follow));
    action.title = follow ? '按北京时间，跨天自动翻到当天＋7天；可手动查看其他日期' : '当前为手动日期；点击恢复跨天自动翻页';
  }
  if (!state) return;
  if (changed.includes('plan-date')) { preview = null; previewRequest++; renderPlan(); previewPlan(); }
  if (changed.includes('summary-date')) loadSummary();
  if (changed.includes('assignment-date')) loadAssignment(true).catch(e=>toast(e.message,true));
}
for (const id of dateIds) {
  const input = $('#'+id), action = button('跟随今天＋7天',()=>{dateFollow.resume(id);syncDates();},'date-follow-button');
  action.setAttribute('aria-label',(input.getAttribute('aria-label')||input.closest('label')?.childNodes[0]?.textContent.trim()||'目标预约日期')+'：恢复自动跟随');
  input.insertAdjacentElement('afterend',action);dateButtons.set(id,action);
  input.addEventListener('change',()=>{dateFollow.edit(id,input.value,Date.now()+offset);syncDates();});
  input.addEventListener('blur',()=>syncDates());
}
const dirty = new Set(), timers = new Map(), revisions = new Map();
let queue = Promise.resolve(), toastTimer, saveErrors = new Map();
function toast(text, error = false) { $('#toast').textContent = text; $('#toast').className = error ? 'error' : ''; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 3500); }
async function api(route, body, method = 'POST') {
  const response = await fetch('/api/' + route, { method, headers:{'Content-Type':'application/json','X-CSRF-Token':state?.csrfToken || ''}, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作未完成'); return result;
}
function savedState() { const e = $('#autosave-state'); const errors = [...saveErrors.values()]; e.textContent = errors.length ? '保存失败 · ' + errors[0] : dirty.size ? '正在保存…' : '所有更改已保存'; e.className = errors.length ? 'save-error' : dirty.size ? 'saving' : 'saved'; }
function autosave(key, action, delay = 450) {
  const revision = (revisions.get(key) || 0) + 1; revisions.set(key, revision);
  dirty.add(key); saveErrors.delete(key); savedState();
  if (timers.has(key)) clearTimeout(timers.get(key).timer);
  const run = () => {
    timers.delete(key);
    queue = queue.then(async () => { try { await action(); if (revisions.get(key) === revision) { dirty.delete(key); saveErrors.delete(key); } preview = null; } catch (e) { if (revisions.get(key) === revision) saveErrors.set(key,e.message); toast('未保存：' + e.message,true); } finally { savedState(); await refresh(); } });
  };
  timers.set(key,{ timer:setTimeout(run,delay),run });
}
window.cellStationFlush = async () => { for (const item of [...timers.values()]) { clearTimeout(item.timer); item.run(); } await queue; if (saveErrors.size) throw new Error('有修改未保存，请检查红色保存提示'); };
function theme() { const selected = $('#setting-theme').value || state?.config.theme || 'system'; document.documentElement.dataset.theme = selected; }
async function refresh() {
  try {
    const response = await fetch('/api/state'); if (!response.ok) throw new Error(); state = await response.json(); offset = state.serverTime - Date.now(); $('#connection-warning').hidden = true;
    syncDates(state.serverTime);
    render();
  } catch { $('#connection-warning').hidden = false; }
}
function button(text, action, cls = 'table-action') { const e = make('button',cls,text); e.type='button'; e.addEventListener('click',async()=>{ e.disabled=true; try { await action(); } catch(err) { toast(err.message,true); } finally { e.disabled=false; } }); return e; }
function render() {
  const enabled = state.accounts.filter(a=>a.enabled);
  $('#nav-account-count').textContent=state.accounts.length;
  $('#enabled-account-count').textContent=`${enabled.length} / 5 已启用`;
  $('#stat-accounts').textContent=enabled.length; $('#stat-windows').textContent=Math.min(enabled.length,state.config.windows.filter(w=>w.enabled).length);
  $('#stat-success').textContent=state.jobs.filter(j=>day(j.releaseAt)===day(state.serverTime)&&['success','already_exists'].includes(j.status)).length;
  $('#equipment-name').textContent=state.config.equipments?.filter(e=>e.enabled).map(e=>e.equipmentName).join(' → ')||state.config.equipment.equipmentName;
  $('#equipment-detail').textContent=`启用 ${state.config.equipments?.filter(e=>e.enabled).length||0} 个设备 · 按列表顺序依次预约 · 备注：cell`;
  $('#equipment-current').textContent='当前：'+state.config.equipment.equipmentName;
  let active = state.jobs.find(j=>j.status==='saving') || state.jobs.find(j=>j.status==='preparing') || state.jobs.find(j=>j.status==='ready') || state.jobs.find(j=>j.status==='retrying');
  const selectedCount=state.config.windows.filter(w=>w.enabled).length;
  let caption = state.pendingStart || controlPending ? '启动检测中' : state.config.enabled ? active ? labels[active.status] : !selectedCount ? '运行中 · 未选择预约窗口' : selectedCount>enabled.length ? '运行中 · 账号不足' : '运行中 · 等待下次开放' : '已暂停 · 不执行预约';
  $('#persistent-run-status').textContent=caption;$('#persistent-run-status').dataset.active=String(state.config.enabled);
  const chip=$('#running-state'); chip.textContent=caption; chip.className='state-chip '+((state.pendingStart||controlPending)?'checking':state.config.enabled?(active?.status==='saving'?'saving':'running'):'paused');
  const control=$('#control-button'); control.textContent=(state.pendingStart||controlPending)?'取消启动':state.config.enabled?'暂停调度':'启动调度'; control.disabled=false;
  const network=state.operations?.network;
  const notices=[];if(network==='offline')notices.push('网络已断开，可能影响预约。请检查连接。');if(state.config.enabled&&!selectedCount)notices.push('尚未勾选预约窗口；请前往“时段与随机分配”选择。');if(selectedCount>enabled.length)notices.push('所选窗口多于启用账号，未分配的窗口不会执行；请调整窗口或启用更多账号。');$('#runtime-warning').hidden=!notices.length;$('#runtime-warning').textContent=notices.join(' ');
  window.cellStationRenderV100?.(state); renderSettings(); renderAccounts(); renderWindows(); renderAssignment(); if(view==='windows')loadAssignment().catch(e=>toast(e.message,true)); renderPlan(); renderHistory(); renderHealth(); renderExclusions(); renderActivity(); updateClock();
  $('#desktop-settings-hint').hidden=state.desktop;
  $('.local-badge').textContent=state.desktop?'桌面版':'本机服务';
}
function renderSettings() {
  const d=state.desktopSettings;
  const importingBlocked=Boolean(state.config.enabled||state.pendingStart||controlPending||state.operations?.health?.running);
  $('#restore-file').disabled=importingBlocked; $('#restore-file').parentElement.classList.toggle('disabled', importingBlocked);
  $('#backup-import-hint').textContent=importingBlocked?'当前正在运行或检测，请先暂停并等待任务结束后导入。':'按登录账号合并；本机其他账号、执行记录和截图保留。';
  for (const [id,key] of [['setting-autostart','autoStart'],['setting-resume','resumeSchedule'],['setting-notifications','failureNotifications']]) {
    $('#'+id).disabled=!d; if(!dirty.has('desktop-'+key)) $('#'+id).checked=d?.[key] || false;
  }
  if(!dirty.has('theme')) $('#setting-theme').value=state.config.theme || 'system'; theme();
  if(!dirty.has('retention')){const policy=state.config.retentionPolicy;$('#setting-retention-enabled').checked=policy.enabled;$('#setting-compress-days').value=policy.compressAfterDays;$('#setting-delete-days').value=policy.deleteAfterDays;}
  const maintenance=state.operations?.retention;$('#retention-status').textContent=maintenance?maintenance.error?'上次维护未完成：'+maintenance.error:`上次维护 ${fmt(maintenance.at,true)} · 压缩 ${maintenance.compressed||0} 项 · 清理 ${maintenance.deleted||0} 项；后台维护避开临近预约时段。`:'默认7天压缩、30天清理；后台低优先级维护，避开临近预约时段。';
  if(!dirty.has('retry')) { $('#setting-task-retries').value=state.config.retryPolicy.taskRetries; $('#setting-captcha-retries').value=state.config.retryPolicy.captchaRetries; }
  $('#startup-status').textContent=d?.startupBlocked?'启动项已被Windows禁用':d?.autoStart?'已启用 · 当前Windows用户':'已关闭';
  $('#retry-policy-note').textContent='修改后自动保存；当前任务沿用开始时的次数，后续任务使用新设置。0表示首次失败后不重试。';
  $('#retry-explanation').textContent=`保存前短暂错误额外重试${state.config.retryPolicy.taskRetries}次；验证码点击刷新后额外重试${state.config.retryPolicy.captchaRetries}次。保存结果不明确时停止重试。`;
}
let accountsSignature;
function renderAccounts() {
  if(dirty.has('account-toggle')) return;
  const signature=JSON.stringify(state.accounts);if(signature===accountsSignature)return;accountsSignature=signature;
  const root=$('#account-table'); root.replaceChildren(); $('#accounts-empty').hidden=state.accounts.length>0;
  for(const a of state.accounts) {
    const row=make('tr'), enabled=make('input'); enabled.type='checkbox'; enabled.checked=a.enabled; enabled.setAttribute('aria-label','启用 '+a.username);
    enabled.addEventListener('change',()=>{ const value=enabled.checked; autosave('account-toggle',()=>api('accounts',{id:a.id,username:a.username,enabled:value}),0); });
    const cell=make('td');cell.append(enabled,make('span','small',a.enabled?'已加入随机账号池':'已停用'));
    const actions=make('td'); actions.append(button('编辑',()=>editAccount(a)),button('测试登录',async()=>{ toast('正在后台检测登录…'); const r=await api(`accounts/${a.id}/test-login`,{});toast(r.message); }));
    const owner=make('td');owner.append(make('strong','',a.owner||'未备注使用人'),make('span','small',a.hasPassword?'密码已加密保存':'需补录密码'));
    row.append(owner,make('td','',a.username),cell,actions);root.append(row);
  }
}
function planJobs() { return preview?.date===$('#plan-date').value?preview.jobs:state.plan.filter(j=>j.date===$('#plan-date').value); }
const planOpen = new Map();
let planSignature;
function renderPlan() {
  const jobs=planJobs(),root=$('#plan-list');
  const signature=JSON.stringify([jobs,state.jobs,$('#plan-date').value,state.config.enabled]);
  if(signature===planSignature)return;planSignature=signature;
  root.replaceChildren();
  $('#plan-release-date').textContent=jobs.length?day(jobs[0].releaseAt)+' 开放':'选择日期后预览';
  for(const [index,w] of state.windows.entries()) {
    const key=$('#plan-date').value+'|'+w.id,list=jobs.filter(j=>j.windowId===w.id),group=make('details','plan-group'),head=make('summary','plan-group-head');
    group.dataset.windowId=w.id;group.open=planOpen.get(key)??false;
    const statusFor=j=>{const record=state.jobs.find(r=>r.id===j.id);return record?.status||(j.skipped?'skipped':j.available?(state.config.enabled?'planned':'queued'):'disabled');};
    const good=list.filter(j=>['success','already_exists'].includes(statusFor(j))).length,bad=list.filter(j=>['failed','needs_review','missed'].includes(statusFor(j))).length;
    head.append(make('span','window-number',String(index+1).padStart(2,'0')),make('strong','',w.start+' — '+w.end),make('small','',list[0]?identity(list[0]):'未分配账号'),make('span',bad?'plan-result bad':'plan-result good',`成功 ${good} / ${list.filter(j=>j.available).length} · 失败 ${bad}`));group.append(head);
    group.addEventListener('toggle',()=>planOpen.set(key,group.open));
    const slots=make('div','plan-slots');
    for(const j of list) { const status=statusFor(j),good=['success','already_exists'].includes(status),bad=['failed','needs_review','missed'].includes(status),r=make('div','slot-row');
      const indicator=make('span','result-indicator '+(good?'good':bad?'bad':'muted'),good?'✓':bad?'✕':'·');indicator.setAttribute('aria-label',good?'预约成功':bad?'预约未成功':'尚未执行');
      r.append(indicator,make('span','',j.start+' – '+j.end),make('span','slot-device',j.equipment?.equipmentName||'设备'),make('span','release','开放于 '+fmt(j.releaseAt).slice(0,5)),make('span','slot-status '+(good?'good':bad?'bad':''),status==='disabled'&&!j.selected?'未勾选':labels[status]));slots.append(r); }
    group.append(slots);root.append(group);
  }
}

let windowSignature;
function renderWindows() {
  const root=$('#window-editor'),n=state.accounts.filter(a=>a.enabled).length;
  const signature=JSON.stringify([state.config.windows,n]);
  if(!dirty.has('windows')&&signature!==windowSignature){
    windowSignature=signature;root.replaceChildren();
    for(const w of state.windows){
      const e=make('div','window-edit'),text=make('div'),label=make('label','window-choice'),check=make('input');
      check.type='checkbox';check.dataset.windowId=w.id;check.checked=Boolean(state.config.windows.find(b=>b.id===w.id)?.enabled);check.setAttribute('aria-label','预约 '+w.start+'–'+w.end);
      label.append(check,make('strong','',w.start+' — '+w.end));text.append(label,make('p','','四次 × 30 分钟 · 同日使用同一随机账号'));
      const badge=make('strong',check.checked?'good window-choice-state':'muted window-choice-state',check.checked?'已选择':'不预约');
      const slots=make('div','window-slots');for(let i=0;i<4;i++){const rows=state.plan.filter(j=>j.date===state.plan[0]?.date&&j.windowId===w.id);if(rows[i])slots.append(make('span','',rows[i].start+'–'+rows[i].end));}
      check.addEventListener('change',()=>{
        const windows=[...root.querySelectorAll('input[data-window-id]')].map(c=>({id:c.dataset.windowId,enabled:c.checked}));
        if(windows.filter(b=>b.enabled).length>state.accounts.filter(a=>a.enabled).length){check.checked=false;toast('窗口数量不能超过启用账号数，请先取消原窗口或启用更多账号',true);return;}
        badge.className=check.checked?'good window-choice-state':'muted window-choice-state';badge.textContent=check.checked?'已选择':'不预约';updateWindowCount();
        autosave('windows',()=>api('windows',{windows},'PUT'),0);
      });
      e.append(text,badge,slots);root.append(e);
    }
  }
  updateWindowCount();
}
function updateWindowCount(){
  const selected=document.querySelectorAll('#window-editor input:checked').length,n=state.accounts.filter(a=>a.enabled).length;
  $('#window-selection-count').textContent=`已选 ${selected} 个 / 启用 ${n} 个账号`;
  const warning=$('#window-selection-warning');warning.hidden=selected>0&&selected<=n;
  warning.textContent=selected>n?`所选窗口多于启用账号，请取消多余窗口或启用更多账号。未分配到账号的窗口不会执行。`:n?'请勾选至少一个窗口后启动预约。':'请先在账号管理启用账号，再勾选预约窗口。';
}

let assignmentState, assignmentLoadKey, assignmentRequest=0, assignmentRenderKey;
async function loadAssignment(force=false){
  if(!state||!$('#assignment-date').value)return;
  const date=$('#assignment-date').value;
  const key=JSON.stringify([date,state.assignmentRevision,state.config.windows,state.config.dateWindows,state.bindings,state.accounts]);
  if(!force&&key===assignmentLoadKey)return;
  assignmentLoadKey=key;const request=++assignmentRequest;
  try{const result=await api('assignments/view',{date});if(request!==assignmentRequest||date!==$('#assignment-date').value)return;assignmentState=result;renderAssignment(force);}
  catch(e){if(request===assignmentRequest){assignmentLoadKey=null;$('#assignment-summary').textContent=e.message;}throw e;}
}
function renderAssignment(force=false){
  if(!state)return;
  const date=$('#assignment-date');date.removeAttribute('min');date.removeAttribute('max');
  const current=assignmentState;if(!current||current.date!==date.value)return;
  const key=JSON.stringify([current,state.accounts]);if(!force&&(key===assignmentRenderKey||dirty.has('assignment')))return;assignmentRenderKey=key;
  const root=$('#assignment-table');root.replaceChildren();const selected=current.windows.filter(w=>w.enabled);
  $('#assignment-summary').textContent=`${current.date} 使用仪器 · ${selected.length}个窗口 · ${current.customWindows?'此日自定义窗口':'每日通用窗口'} · ${{auto:'每日随机',random:'已重新随机',manual:'已手动调整'}[current.mode]||'每日随机'} · 随时可调整`;
  $('#reset-date-windows').hidden=!current.customWindows;$('#reset-date-windows').disabled=false;$('#reset-date-windows').title='';$('#rerandomize-accounts').disabled=!selected.length;
  for(const w of state.windows.filter(w=>current.windows.some(b=>b.id===w.id&&b.enabled))){
    const row=make('tr'),isSelected=current.windows.some(b=>b.id===w.id&&b.enabled);
    const owner=make('select');owner.setAttribute('aria-label',w.start+'–'+w.end+' 使用人');
    const missing=make('option','','未分配账号');missing.value='';missing.disabled=true;owner.append(missing);
    for(const a of state.accounts.filter(a=>a.enabled||a.id===current.mapping[w.id])){const option=make('option','',(a.owner||'未备注使用人')+' / '+a.username);option.value=a.id;option.disabled=!a.enabled||!a.hasPassword;owner.append(option);}
    owner.value=current.mapping[w.id]||'';owner.disabled=!isSelected;
    owner.addEventListener('change',()=>{const accountId=owner.value,at=current.date;autosave('assignment',()=>changeAssignment('account',{date:at,windowId:w.id,accountId}),0);});
    const time=make('select');time.setAttribute('aria-label',w.start+'–'+w.end+' 调整时间段');
    for(const target of state.windows){const option=make('option','',target.start+'–'+target.end+(target.id!==w.id?(current.windows.find(b=>b.id===target.id).enabled?'（交换账号）':'（仅此日移动）'):''));option.value=target.id;time.append(option);}
    time.value=w.id;time.disabled=!isSelected||!current.mapping[w.id];time.addEventListener('change',()=>{const toId=time.value,at=current.date;autosave('assignment',()=>changeAssignment('move',{date:at,fromId:w.id,toId}),0);});
    const accountCell=make('td');accountCell.append(owner);const timeCell=make('td');timeCell.append(time);
    row.append(make('td','',w.start+'–'+w.end),accountCell,timeCell,make('td','good',current.mapping[w.id]?'随时可调整':'账号不足，请启用账号'));root.append(row);
  }
  if(!root.children.length){const row=make('tr'),cell=make('td','','请先在上方勾选每日预约窗口');cell.colSpan=4;row.append(cell);root.append(row);}
}
async function changeAssignment(route,data){
  if(!assignmentState||assignmentState.date!==data.date)throw new Error('目标日期已变化，请重新选择');
  ++assignmentRequest;
  try{const result=await api('assignments/'+route,{...data,revision:assignmentState.revision});assignmentState=result;assignmentLoadKey=null;preview=null;toast(result.message);return result;}
  catch(e){await loadAssignment(true).catch(()=>{});throw e;}
}
$('#assignment-date').addEventListener('change',async()=>{try{await window.cellStationFlush();await loadAssignment(true);}catch(e){toast(e.message,true);}});
for(const [id,route] of [['rerandomize-accounts','randomize'],['reset-date-windows','reset-windows']])$('#'+id).addEventListener('click',async()=>{
  const button=$('#'+id);button.disabled=true;
  try{await window.cellStationFlush();await changeAssignment(route,{date:$('#assignment-date').value});await refresh();renderAssignment(true);}
  catch(e){toast(e.message,true);}finally{button.disabled=false;}
});

let historySignature;
function renderHistory() {
  const signature=JSON.stringify(state.jobs);if(signature===historySignature)return;historySignature=signature;
  const root=$('#history-table');const expanded = new Set([...root.querySelectorAll('details[open]')].map(e=>e.dataset.id));root.replaceChildren();$('#history-empty').hidden=state.jobs.length>0;$('#history-count').textContent=state.jobs.length+' 条记录';
  for(const j of state.jobs) {
    const row=make('tr'),time=make('td');time.append(make('strong','',j.date+' '+j.start+'–'+j.end),make('span','small',j.equipment?.equipmentName||'历史仪器'));
    const detail=make('td','',String(j.message||'').replace(/\x1b\[[0-9;]*m/g,'').split('\n')[0]);detail.title=j.message||'';
    if(j.savingAt) detail.append(make('span','small','保存调用 '+fmt(j.savingAt,true)));
    if(j.confirmedAt) detail.append(make('strong','confirmation','网站读回确认 '+fmt(j.confirmedAt,true)),make('span','small',`开放→确认 ${j.confirmationDelayMs} ms · 保存→确认 ${j.submissionToConfirmationMs ?? '—'} ms`));
    if(j.reservationId) detail.append(make('span','small','预约编号 '+j.reservationId));
    const timeline=make('details','timeline'),summary=make('summary','','查看步骤时间与耗时（毫秒）');timeline.dataset.id=j.id;timeline.open=expanded.has(j.id);timeline.append(summary);
    for(const t of j.timeline||[]) { const line=make('div','timeline-row');line.append(make('time','',fmt(t.at,true)),make('b','',steps[t.step]||t.step),make('span','',t.detail),make('span','mono',`+${t.elapsedMs.toFixed(3)} ms`));timeline.append(line); } if(!(j.timeline||[]).length)timeline.append(make('p','muted','旧版记录未采集步骤时间。'));detail.append(timeline);
    if(j.diagnosticId){time.append(button('查看失败截图',()=>showFailure(j)));detail.append(button('导出诊断ZIP',async()=>exportResult(await api('diagnostics/export',{jobId:j.id}))));}
    row.append(time,make('td','',identity(j)),make('td','mono',fmt(j.releaseAt,true)),make('td','status-'+j.status,labels[j.status]||j.status),detail);root.append(row);
  }
}
let failureSelection;
async function showFailure(job, selected = job.diagnosticId) {
  const dialog = $('#failure-dialog');
  if (!dialog.open) dialog.showModal();
  $('#failure-image').hidden = true; $('#failure-empty').hidden = false; $('#failure-empty').textContent = '正在读取失败截图…';
  const response = await fetch('/api/diagnostics/' + selected);
  const report = await response.json(); if (!response.ok) { $('#failure-empty').textContent = report.error; return; }
  failureSelection = report.id;
  $('#failure-caption').textContent = `${job.date || ''} ${job.start || ''}–${job.end || ''} · ${identity(job)} · ${report.phase}`;
  $('#failure-detail').textContent = `${fmt(Date.parse(report.at), true)} · ${report.error}`;
  const attempts = $('#failure-attempts'); attempts.replaceChildren();
  const ids = [...new Set([...(job.diagnosticIds || []), job.diagnosticId].filter(Boolean))];
  ids.forEach((id, i) => attempts.append(button(`第${i + 1}次失败`, () => showFailure(job, id), 'button subtle')));
  if (report.imageUrl) { $('#failure-image').src = report.imageUrl; $('#failure-image').hidden = false; $('#failure-empty').hidden = true; }
  else $('#failure-empty').textContent = report.screenshotError || '本次失败时浏览器尚未启动或已经关闭，未能生成截图；诊断原因已保留。';
}
$('#close-failure').addEventListener('click', () => $('#failure-dialog').close());
$('#failure-export').addEventListener('click', async () => { try { exportResult(await api('diagnostics/export', { diagnosticId: failureSelection })); } catch (e) { toast(e.message, true); } });
function renderHealth() {
  const op=state.operations,check=op?.health,local=op?.startup;
  $('#startup-check').textContent=local?`程序打开前必要自检：${local.status==='pass'?'通过':'未通过'} · ${local.items.map(i=>i.title+' '+(i.status==='pass'?'✓':'×')).join('；')}`:'本地必要自检将在桌面程序打开前运行。';
  $('#health-status').textContent=check?.running?'正在检测…':check?.canStart?(check.status==='warning'?'可启动调度；网站或登录提示见下方':'检测通过，可启动调度'):check?.status==='fail'?'检测失败，请检查下列项目':'可直接启动等待；网站和账号在实际任务准备时检查';
  $('#run-healthcheck').disabled=Boolean(check?.running||state.config.enabled);$('#cancel-start').hidden=!(state.pendingStart||controlPending);
  const root=$('#health-items');root.replaceChildren(); for(const item of check?.items||[]) { const e=make('div','health-item '+item.status);e.append(make('b','',item.title),make('span','',item.status==='pass'?'通过':item.status==='fail'?'失败':item.status==='warn'?'提示':'检查中'),make('p','',item.detail));if(item.diagnosticId)e.append(button('查看失败截图',()=>showFailure({date:'自检',accountLabel:item.title,diagnosticId:item.diagnosticId})));root.append(e); }
}
function renderActivity() {const root=$('#activity-list');root.replaceChildren();for(const e of state.events.slice(0,5)){const row=make('div','activity-item');row.append(make('p','',e.message),make('time','',fmt(Date.parse(e.at),true)));root.append(row);} }
function renderExclusions(){const root=$('#exclusion-list');root.replaceChildren();for(const [i,e] of state.config.exclusions.entries()){const row=make('div','exclusion-entry');row.append(make('b','',e.date+' · '+(e.windowIds.length===5?'整天':e.windowIds.map(id=>state.windows.find(w=>w.id===id)?.start).join('、'))),make('span','',e.reason),button('移除',async()=>{await api('exclusions',{entries:state.config.exclusions.filter((_,n)=>n!==i)},'PUT');preview=null;await refresh();}));root.append(row);} }
function updateClock(){if(!state)return;const now=Date.now()+offset;syncDates(now);$('#clock').textContent=fmt(now);const next=state.plan.find(j=>j.available&&j.releaseAt>now&&!['success','already_exists'].includes(state.jobs.find(r=>r.id===j.id)?.status));$('#stat-next').textContent=next?fmt(next.releaseAt).slice(0,5):'—';$('#stat-next-sub').textContent=next?day(next.releaseAt)+' · '+identity(next):'启用账号后生成计划';$('#next-countdown').textContent=next?'距开放 '+Math.floor((next.releaseAt-now)/60000)+' 分钟':'';}
function editAccount(a){const f=$('#account-form');f.reset();f.elements.id.value=a?.id||'';f.elements.username.value=a?.username||'';f.elements.username.readOnly=Boolean(a);f.elements.owner.value=a?.owner||'';f.elements.enabled.checked=a?a.enabled:state.accounts.filter(x=>x.enabled).length<5;f.elements.password.required=!a;f.elements.password.placeholder=a?'留空保留密码；输入后移开自动保存':'输入密码以添加账号';$('#account-dialog-title').textContent=a?'编辑账号 · 自动保存':'添加账号';$('#save-account-button').hidden=Boolean(a);$('#password-note').textContent=a?'使用人、密码及启用状态在修改后自动保存，无需确认。':'填写登录账号与密码后点击添加。最多同时启用5个账号。';$('#account-dialog').showModal();}
function editField(name){const f=$('#account-form');if(!f.elements.id.value)return;const input={id:f.elements.id.value,username:f.elements.username.value};input[name]=name==='enabled'?f.elements.enabled.checked:f.elements[name].value;if(name==='password'&&!input.password)return;autosave('account-'+name,async()=>{await api('accounts',input);if(name==='password')f.elements.password.value='';},name==='password'?0:450);}
$('#account-form').elements.owner.addEventListener('input',()=>editField('owner'));
$('#account-form').elements.enabled.addEventListener('change',()=>editField('enabled'));
$('#account-form').elements.password.addEventListener('change',()=>editField('password'));
for(const id of ['close-dialog','cancel-dialog'])$('#'+id).addEventListener('click',async()=>{try{await window.cellStationFlush();$('#account-dialog').close();}catch(e){toast(e.message,true);}});
$('#account-dialog').addEventListener('cancel',e=>{e.preventDefault();$('#close-dialog').click();});
$('#account-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;try{const data={username:f.elements.username.value,owner:f.elements.owner.value,password:f.elements.password.value,enabled:f.elements.enabled.checked};await api('accounts',data);f.elements.password.value='';$('#account-dialog').close();preview=null;await refresh();toast('账号已添加');}catch(e){toast(e.message,true);}});
$('#add-account').addEventListener('click',()=>editAccount());$('#empty-add-account').addEventListener('click',()=>editAccount());
for(const node of document.querySelectorAll('.nav'))node.addEventListener('click',()=>{view=node.dataset.view;document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n===node));document.querySelectorAll('.view').forEach(n=>n.classList.toggle('active',n.id==='view-'+view));const text=node.textContent.replace(/[◈◎▦⊘≡✓▤⚙0-9]/g,'').trim();$('#page-title').textContent=text;$('#breadcrumb').textContent=text;$('#page-description').textContent=view==='settings'?'修改后自动保存；运行过程中也可编辑，后续任务使用新配置。':view==='windows'?'勾选预约窗口后，每日从启用账号中随机分配，无需固定绑定账号。':'本机后台运行，每次半小时，按时预约。';if(view==='reports')loadSummary();if(view==='windows')loadAssignment().catch(e=>toast(e.message,true));});
async function control(enabled){await window.cellStationFlush();if(enabled){controlPending=true;render();}try{await api('control',{enabled});toast(enabled?'调度已启动；实际任务准备时连接网站并登录':'调度已暂停');}finally{controlPending=false;await refresh();}}
$('#control-button').addEventListener('click',()=>control(!(state.config.enabled||state.pendingStart||controlPending)).catch(e=>toast(e.message,true)));
$('#cancel-start').addEventListener('click',()=>control(false).catch(e=>toast(e.message,true)));
async function previewPlan(){const date=$('#plan-date').value,request=++previewRequest;try{const result=await api('simulate',{date});if(request!==previewRequest||date!==$('#plan-date').value)return;preview=result;renderPlan();}catch(e){if(request===previewRequest)toast(e.message,true);}}
$('#simulate-button').addEventListener('click',previewPlan);$('#plan-date').addEventListener('change',previewPlan);
for(const [id,key] of [['setting-autostart','autoStart'],['setting-resume','resumeSchedule'],['setting-notifications','failureNotifications']])$('#'+id).addEventListener('change',()=>{const value=$('#'+id).checked;autosave('desktop-'+key,()=>api('desktop/settings',{[key]:value},'PUT'),0);});
$('#setting-theme').addEventListener('change',()=>{theme();const value=$('#setting-theme').value;autosave('theme',()=>api('theme',{theme:value},'PUT'),0);});
function saveRetries(){const a=$('#setting-task-retries'),b=$('#setting-captcha-retries');if(!a.value||!b.value||!a.checkValidity()||!b.checkValidity()){const pending=timers.get('retry');if(pending)clearTimeout(pending.timer);timers.delete('retry');revisions.set('retry',(revisions.get('retry')||0)+1);dirty.add('retry');saveErrors.set('retry','重试次数需为0至20的整数');savedState();return;}const policy={taskRetries:Number(a.value),captchaRetries:Number(b.value)};autosave('retry',()=>api('retry-policy',policy,'PUT'));}
for(const id of ['setting-task-retries','setting-captcha-retries'])$('#'+id).addEventListener('input',saveRetries);
function saveRetention(){
  const a=$('#setting-compress-days'),b=$('#setting-delete-days'),policy={enabled:$('#setting-retention-enabled').checked,compressAfterDays:Number(a.value),deleteAfterDays:Number(b.value)};
  if(!a.value||!b.value||!a.checkValidity()||!b.checkValidity()||policy.deleteAfterDays<=policy.compressAfterDays){const pending=timers.get('retention');if(pending)clearTimeout(pending.timer);timers.delete('retention');revisions.set('retention',(revisions.get('retention')||0)+1);dirty.add('retention');saveErrors.set('retention','清理天数必须大于压缩天数');savedState();return;}
  autosave('retention',()=>api('retention-policy',policy,'PUT'));
}
$('#setting-retention-enabled').addEventListener('change',saveRetention);
for(const id of ['setting-compress-days','setting-delete-days'])$('#'+id).addEventListener('input',saveRetention);
$('#equipment-search').addEventListener('click',async()=>{const button=$('#equipment-search');button.disabled=true;$('#equipment-results').textContent='正在后台登录并检索…';try{const result=await api('equipment/search',{name:$('#equipment-query').value});const root=$('#equipment-results');root.replaceChildren();if(!result.candidates.length)root.textContent='未找到仪器，请检查完整名称。';for(const c of result.candidates)root.append(windowButton(c));}catch(e){$('#equipment-results').textContent=e.message;toast(e.message,true);}finally{button.disabled=false;}});
function windowButton(c){return button(c.equipmentName+' · 编号'+c.equipmentId+' · 添加',async()=>{await api('equipments',{equipments:[...state.config.equipments,c]},'PUT');$('#equipment-results').textContent='设备已添加，可在列表中调整预约顺序。';preview=null;await refresh();},'button subtle device-result');}
$('#run-healthcheck').addEventListener('click',async()=>{try{await api('healthcheck',{accounts:true});await refresh();}catch(e){toast(e.message,true);}});
$('#test-notification').addEventListener('click',async()=>{try{toast((await api('desktop/test-notification',{})).message);}catch(e){toast(e.message,true);}});
$('#quit-desktop').addEventListener('click',async()=>{try{await window.cellStationFlush();await api('desktop/quit',{});}catch(e){toast(e.message,true);}});
$('#exclusion-form').addEventListener('submit',async e=>{e.preventDefault();const w=$('#exclusion-window').value;try{await api('exclusions',{entries:[...state.config.exclusions,{date:$('#exclusion-date').value,windowIds:w==='all'?state.windows.map(w=>w.id):[w],reason:$('#exclusion-reason').value||'临时跳过'}]},'PUT');preview=null;await refresh();toast('跳过规则已保存');}catch(e){toast(e.message,true);}});
async function loadSummary(){if(!state)return;const date=$('#summary-date').value,request=++summaryRequest;try{const r=await api('summary',{date});if(request!==summaryRequest||date!==$('#summary-date').value)return;const stats=$('#summary-stats');stats.textContent=`成功 ${r.success} · 已存在 ${r.alreadyExists} · 失败 ${r.failed} · 待核对 ${r.uncertain} · 待执行 ${r.pending} · 跳过 ${r.skipped}`;const a=$('#summary-accounts'),rows=$('#summary-rows');a.replaceChildren();rows.replaceChildren();for(const x of r.byAccount){const tr=make('tr');tr.append(make('td','',identity(x)),make('td','',x.plannedMinutes/60),make('td','',x.confirmedHours));a.append(tr);}for(const x of [...r.rows].sort((a,b)=>b.start.localeCompare(a.start)||(a.equipmentOrder||0)-(b.equipmentOrder||0))){const tr=make('tr');tr.append(make('td','',x.start+'–'+x.end),make('td','',x.equipment?.equipmentName||'历史设备'),make('td','',identity(x)),make('td','status-'+x.status,labels[x.status]||x.status),make('td','',x.message));rows.append(tr);}}catch(e){if(request===summaryRequest)toast(e.message,true);}}
function exportResult(r){$('#last-export').textContent=(r.files||[r.file]).join('\n');toast('已导出至本机文件夹');}
$('#refresh-summary').addEventListener('click',loadSummary);$('#summary-date').addEventListener('change',loadSummary);
$('#export-summary').addEventListener('click',async()=>{try{exportResult(await api('summary/export',{date:$('#summary-date').value}));}catch(e){toast(e.message,true);}});
$('#export-backup').addEventListener('click',async()=>{
  const button=$('#export-backup');button.disabled=true;
  try{
    await window.cellStationFlush();const r=await api('backup/export',{chooseLocation:true});if(r.cancelled){toast('已取消导出，未生成新备份');return;}
    $('#backup-export-summary').textContent=`备份已保存 · ${r.accounts}个账号 · ${r.selectedWindows.length}个所选窗口 · ${r.customDates||0}天自定义时间段 · ${r.assignmentDays||0}天已调整分配`;
    $('#backup-export-path').textContent=r.file;$('#backup-export-result').hidden=false;$('#reveal-backup').hidden=!state.desktop;$('#last-export').textContent=r.file;toast('配置备份已保存');
  }catch(e){toast(e.message,true);}finally{button.disabled=false;}
});
$('#reveal-backup').addEventListener('click',async()=>{try{await api('backup/reveal',{});}catch(e){toast(e.message,true);}});
function clearRestore(){restoreToken=null;$('#restore-preview').hidden=true;$('#restore-preview').replaceChildren();$('#confirm-restore').hidden=true;$('#cancel-restore').hidden=true;}
$('#cancel-restore').addEventListener('click',()=>{clearRestore();toast('预览已取消，配置未修改');});
$('#restore-file').addEventListener('change',async e=>{
  clearRestore();$('#restore-result').hidden=true;const file=e.target.files?.[0];if(!file)return;
  try{
    await window.cellStationFlush();if(file.size>250000)throw new Error('备份文件超过250KB，请选择程序导出的配置JSON');
    let backup;try{backup=JSON.parse(await file.text());}catch{throw new Error('文件不是有效的JSON配置备份');}
    const r=await api('backup/preview',{backup});restoreToken=r.token;
    const root=$('#restore-preview');root.hidden=false;
    root.append(make('h3','','导入预览 · 尚未修改配置'),make('p','',file.name+' · 备份时间 '+(r.sourceCreatedAt?fmt(Date.parse(r.sourceCreatedAt),true):'旧版未记录')),
      make('p','',`新增 ${r.newAccounts} 个账号 · 更新 ${r.updatedAccounts} 个同名账号 · 保留 ${r.retainedAccounts} 个本机其他账号 · ${r.needsPassword} 个需重录密码`));
    const wrap=make('div','table-wrap'),table=make('table'),head=make('thead'),tr=make('tr');for(const text of ['账号 / 使用人','处理方式','密码处理','导入后状态'])tr.append(make('th','',text));head.append(tr);table.append(head);
    const body=make('tbody');for(const a of r.accountChanges){const row=make('tr');row.append(make('td','',a.username+(a.owner?' / '+a.owner:'')),make('td','',a.action),make('td','',a.password),make('td','',a.enabled?'启用':'停用'));body.append(row);}table.append(body);wrap.append(table);root.append(wrap);
    root.append(make('p','',`将替换：预约窗口 ${r.selectedWindows.join('、')||'未选择'}；跳过日期 ${r.exclusions} 条；预约重试 ${r.retryPolicy.taskRetries} 次；验证码重试 ${r.retryPolicy.captchaRetries} 次；仪器 ${r.equipment}；主题 ${{light:'白天',dark:'黑夜',system:'随系统'}[r.theme]}。`),make('p','',r.message));if(r.retentionPolicy)root.append(make('p','',`截图与文件日志：${r.retentionPolicy.enabled?'启用':'关闭'}自动维护，${r.retentionPolicy.compressAfterDays}天压缩、${r.retentionPolicy.deleteAfterDays}天清理。`));
    if(r.dateDetails?.length){const details=make('details','backup-date-plans'),summary=make('summary','',`查看单日调整：${r.customDates}天自定义时间段、${r.assignmentDays}天已保存分配`);details.append(summary);for(const d of r.dateDetails){details.append(make('p','',d.date+' · '+d.windows.join('、')+' · '+d.accounts.map(a=>(state.windows.find(w=>w.id===a.windowId)?.start||a.windowId)+' '+a.username).join('；')));}root.append(details);}
    if(r.selectionWarning)root.append(make('p','bad',r.selectionWarning));$('#confirm-restore').hidden=false;$('#cancel-restore').hidden=false;
  }catch(error){clearRestore();$('#restore-result').hidden=false;$('#restore-result').textContent='无法预览：'+error.message;toast(error.message,true);}finally{e.target.value='';}
});
$('#confirm-restore').addEventListener('click',async()=>{
  const button=$('#confirm-restore');button.disabled=true;
  try{await window.cellStationFlush();const r=await api('backup/restore',{token:restoreToken});clearRestore();const result=$('#restore-result');result.replaceChildren(make('strong','','配置导入成功'),make('p','',`${r.message} 合并${r.importedAccounts}个账号，${r.needsPassword}个需要重录密码，每日通用窗口${r.selectedWindows}个，单日自定义${r.customDates||0}天，已保存分配${r.assignmentDays||0}天。`),make('p','','导入前配置的恢复备份：'),make('p','export-path',r.previousBackup));result.hidden=false;await refresh();toast('配置已导入，调度保持暂停');}
  catch(e){clearRestore();$('#restore-result').hidden=false;$('#restore-result').textContent='导入未完成：'+e.message+'。请重新选择文件预览。';toast(e.message,true);}finally{button.disabled=false;}
});
for(const [id,route] of [['open-exports','exports/open'],['open-booking-site','desktop/open-website']])$('#'+id).addEventListener('click',async()=>{try{await api(route,{});}catch(e){toast(e.message,true);}});
function hashView(){const n=document.querySelector('.nav[data-view="'+location.hash.slice(1).replace(/[^a-z]/g,'')+'"]');if(n)n.click();}
window.addEventListener('focus',()=>{if(state)syncDates();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state)syncDates();});
window.addEventListener('hashchange',hashView);hashView();refresh();setInterval(refresh,2000);setInterval(updateClock,100);
