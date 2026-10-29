'use strict';
(() => {
  let deviceKey;const openDevices=new Set();
  window.cellStationRenderV100 = current => {
    const w=current.wechat;
    if(w&&!dirty.has('wechat')){for(const [id,key]of [['wechat-enabled','enabled'],['wechat-success','success'],['wechat-failure','failure']])$('#'+id).checked=w[key];$('#wechat-provider').value=w.provider;$('#wechat-key').placeholder=w.hasKey?'密钥已加密保存，留空保留':'粘贴服务网站提供的密钥';}
    $('#wechat-status').textContent=w?.error|| (w?.hasKey?`密钥已保存 · ${w.enabled?'通知已开启':'通知未开启'}${w.lastSentAt?' · 最近发送 '+fmt(Date.parse(w.lastSentAt),true):''}`:'尚未配置微信推送服务');
    const u=current.updates;$('#update-auto').disabled=!u;
    if(u){if(!dirty.has('updates')){$('#update-auto').checked=u.auto;$('#update-mirrors').value=u.mirrors.join('\n');}$('#update-status').textContent=u.message;$('#update-progress').value=u.progress||0;$('#update-install').hidden=!u.availableVersion;$('#update-install').disabled=['installing','downloading','checking'].includes(u.status);}
    else $('#update-status').textContent='自动更新暂不可用。';
    const key=JSON.stringify([current.config.equipments,current.config.windows]);if(key===deviceKey||dirty.has('equipments')||[...dirty].some(k=>k.startsWith('equipment-plan-'))||document.activeElement.closest?.('#equipment-list input,#equipment-list select'))return;deviceKey=key;
    const root=$('#equipment-list');root.replaceChildren();
    for(const [index,item]of current.config.equipments.entries()){
      const row=make('div','device-item'),label=make('label','device-title'),check=make('input');check.type='checkbox';check.checked=item.enabled;check.setAttribute('aria-label','启用设备 '+item.equipmentName);
      const save=items=>autosave('equipments',()=>api('equipments',{equipments:items},'PUT'),0);
      check.addEventListener('change',()=>save(current.config.equipments.map(e=>e.equipmentId===item.equipmentId?{...e,enabled:check.checked}:e)));
      label.append(check,make('b','',`${index+1}. ${item.equipmentName}`));row.append(label);const actions=make('div','device-actions');row.append(actions);
      for(const [text,step]of [['上移',-1],['下移',1]]){const b=button(text,async()=>{const list=[...current.config.equipments];[list[index],list[index+step]]=[list[index+step],list[index]];await api('equipments',{equipments:list},'PUT');preview=null;await refresh();},'button subtle');b.disabled=index+step<0||index+step>=current.config.equipments.length;actions.append(b);}
      const remove=button('移除',async()=>{await api('equipments',{equipments:current.config.equipments.filter(e=>e.equipmentId!==item.equipmentId)},'PUT');preview=null;await refresh();},'button subtle');remove.disabled=current.config.equipments.length===1;actions.append(remove);row.append(scheduleEditor(item));root.append(row);
    }
  };
  function scheduleEditor(item){
    const details=make('details','device-schedule');details.dataset.equipmentId=item.equipmentId;details.open=openDevices.has(item.equipmentId);details.addEventListener('toggle',()=>{if(details.open)openDevices.add(item.equipmentId);else openDevices.delete(item.equipmentId);});
    const s=item.bookingSchedule||{},summary=make('summary','',s.dateMode==='single'?'预约计划 · '+s.dateFrom:s.dateMode==='range'?'预约计划 · '+s.dateFrom+' 至 '+s.dateTo:'预约计划 · 不限日期');details.append(summary);
    const form=make('div','device-plan-form'),dates=make('div','device-dates');details.append(form);form.append(dates);
    const field=(title,input)=>{const label=make('label','',title);label.append(input);return label;};
    const mode=make('select');mode.setAttribute('aria-label',item.equipmentName+' 日期方式');for(const [v,text]of [['all','不限日期'],['single','仅指定一天'],['range','起止日期范围']]){const o=make('option','',text);o.value=v;mode.append(o);}mode.value=s.dateMode||'all';
    const from=make('input'),to=make('input');from.type=to.type='date';from.setAttribute('aria-label',item.equipmentName+' 开始日期');to.setAttribute('aria-label',item.equipmentName+' 结束日期');from.value=s.dateFrom||plusDays(day(state.serverTime),7);to.value=s.dateTo||from.value;
    const fromLabel=field('预约使用日期 / 开始日期',from),toLabel=field('结束日期（含当天）',to);dates.append(field('预约日期方式',mode),fromLabel,toLabel);
    const custom=make('input');custom.type='checkbox';custom.checked=Boolean(s.windows);custom.setAttribute('aria-label',item.equipmentName+' 使用独立时段');const choice=field('使用设备独立时段',custom);choice.className='check-label';form.append(choice);
    const times=make('div','device-times'),inputs=[];form.append(times);
    for(const [index,w]of (s.windows||state.windows.map(w=>({...w,enabled:Boolean(state.config.windows.find(x=>x.id===w.id)?.enabled)}))).entries()){
      const row=make('div','device-time-row'),enabled=make('input'),start=make('input'),end=make('input');enabled.type='checkbox';enabled.checked=w.enabled;enabled.setAttribute('aria-label',item.equipmentName+' 窗口'+(index+1)+' 启用');start.type=end.type='time';start.step=end.step='1800';start.value=w.start;end.value=w.end;start.setAttribute('aria-label',item.equipmentName+' 窗口'+(index+1)+' 开始');end.setAttribute('aria-label',item.equipmentName+' 窗口'+(index+1)+' 结束');
      row.append(enabled,make('span','','窗口 '+(index+1)),start,make('span','','至'),end);times.append(row);inputs.push({id:w.id,enabled,start,end});
    }
    form.append(make('p','small','按实际使用日期判断，起止日期均包含；每次仍拆为30分钟预约。关闭独立时段时跟随通用窗口。修改后自动保存。'));
    const visibility=()=>{fromLabel.hidden=mode.value==='all';toLabel.hidden=mode.value!=='range';times.hidden=!custom.checked;};visibility();
    const save=()=>{visibility();const bookingSchedule={dateMode:mode.value,dateFrom:mode.value==='all'?'':from.value,dateTo:mode.value==='single'?from.value:mode.value==='range'?to.value:'',windows:custom.checked?inputs.map(x=>({id:x.id,enabled:x.enabled.checked,start:x.start.value,end:x.end.value})):null};autosave('equipment-plan-'+item.equipmentId,()=>api('equipment/schedule',{equipmentId:item.equipmentId,bookingSchedule},'PUT'),100);};
    mode.addEventListener('change',save);custom.addEventListener('change',save);from.addEventListener('change',()=>{if(to.value<from.value)to.value=from.value;save();});to.addEventListener('change',save);for(const x of inputs)for(const input of [x.enabled,x.start,x.end])input.addEventListener('change',save);
    form.addEventListener('focusout',()=>setTimeout(()=>window.cellStationRenderV100(state),0));return details;
  }
  $('#equipment-detect').addEventListener('click',async()=>{const b=$('#equipment-detect'),status=$('#equipment-detection');b.disabled=true;status.textContent='正在后台检测设备名称和预约日历…';try{const r=await api('equipment/detect',{name:$('#equipment-query').value.trim()});status.textContent=r.message+(r.equipment?' · '+r.equipment.equipmentName+' · 编号'+r.equipment.equipmentId:'');status.className=r.recognized?'good':'review';const root=$('#equipment-results');root.replaceChildren();for(const c of r.candidates||[])if(!state.config.equipments.some(e=>e.equipmentId===c.equipmentId))root.append(windowButton(c));}catch(e){status.textContent='检测未完成：'+e.message;status.className='bad';}finally{b.disabled=false;}});
  function saveWechat(){const key=$('#wechat-key').value.trim(),input={provider:$('#wechat-provider').value,enabled:$('#wechat-enabled').checked,success:$('#wechat-success').checked,failure:$('#wechat-failure').checked,...(key?{key}:{})};autosave('wechat',async()=>{await api('wechat',input,'PUT');$('#wechat-key').value='';},0);}
  for(const id of ['wechat-provider','wechat-enabled','wechat-success','wechat-failure','wechat-key'])$('#'+id).addEventListener('change',saveWechat);
  $('#wechat-test').addEventListener('click',async()=>{try{await window.cellStationFlush();toast((await api('wechat/test',{})).message);}catch(e){toast(e.message,true);}});
  const saveUpdates=()=>{const input={auto:$('#update-auto').checked,mirrors:$('#update-mirrors').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)};autosave('updates',()=>api('updates/settings',input,'PUT'));};
  $('#update-auto').addEventListener('change',saveUpdates);$('#update-mirrors').addEventListener('change',saveUpdates);
  for(const [id,route]of [['update-check','updates/check'],['update-install','updates/install']])$('#'+id).addEventListener('click',async()=>{try{await window.cellStationFlush();await api(route,{});await refresh();}catch(e){toast(e.message,true);}});
})();
