'use strict';
(() => {
  let deviceKey;
  window.cellStationRenderV100 = current => {
    const w=current.wechat;
    if(w&&!dirty.has('wechat')){for(const [id,key]of [['wechat-enabled','enabled'],['wechat-success','success'],['wechat-failure','failure']])$('#'+id).checked=w[key];$('#wechat-provider').value=w.provider;$('#wechat-key').placeholder=w.hasKey?'密钥已加密保存，留空保留':'粘贴服务网站提供的密钥';}
    $('#wechat-status').textContent=w?.error|| (w?.hasKey?`密钥已保存 · ${w.enabled?'通知已开启':'通知未开启'}${w.lastSentAt?' · 最近发送 '+fmt(Date.parse(w.lastSentAt),true):''}`:'尚未配置微信推送服务');
    const u=current.updates;$('#update-auto').disabled=!u;
    if(u){if(!dirty.has('updates')){$('#update-auto').checked=u.auto;$('#update-mirrors').value=u.mirrors.join('\n');}$('#update-status').textContent=u.message;$('#update-progress').value=u.progress||0;$('#update-install').hidden=!u.availableVersion;$('#update-install').disabled=['installing','downloading','checking'].includes(u.status);}
    else $('#update-status').textContent='自动更新暂不可用。';
    const key=JSON.stringify(current.config.equipments);if(key===deviceKey||dirty.has('equipments'))return;deviceKey=key;
    const root=$('#equipment-list');root.replaceChildren();
    for(const [index,item]of current.config.equipments.entries()){
      const row=make('div','device-item'),label=make('label'),check=make('input');check.type='checkbox';check.checked=item.enabled;check.setAttribute('aria-label','启用设备 '+item.equipmentName);
      const save=items=>autosave('equipments',()=>api('equipments',{equipments:items},'PUT'),0);
      check.addEventListener('change',()=>save(current.config.equipments.map(e=>e.equipmentId===item.equipmentId?{...e,enabled:check.checked}:e)));
      label.append(check,make('b','',`${index+1}. ${item.equipmentName}`));row.append(label);
      for(const [text,step]of [['上移',-1],['下移',1]]){const b=button(text,async()=>{const list=[...current.config.equipments];[list[index],list[index+step]]=[list[index+step],list[index]];await api('equipments',{equipments:list},'PUT');preview=null;await refresh();},'button subtle');b.disabled=index+step<0||index+step>=current.config.equipments.length;row.append(b);}
      const remove=button('移除',async()=>{await api('equipments',{equipments:current.config.equipments.filter(e=>e.equipmentId!==item.equipmentId)},'PUT');preview=null;await refresh();},'button subtle');remove.disabled=current.config.equipments.length===1;row.append(remove);root.append(row);
    }
  };
  function saveWechat(){const key=$('#wechat-key').value.trim(),input={provider:$('#wechat-provider').value,enabled:$('#wechat-enabled').checked,success:$('#wechat-success').checked,failure:$('#wechat-failure').checked,...(key?{key}:{})};autosave('wechat',async()=>{await api('wechat',input,'PUT');$('#wechat-key').value='';},0);}
  for(const id of ['wechat-provider','wechat-enabled','wechat-success','wechat-failure','wechat-key'])$('#'+id).addEventListener('change',saveWechat);
  $('#wechat-test').addEventListener('click',async()=>{try{await window.cellStationFlush();toast((await api('wechat/test',{})).message);}catch(e){toast(e.message,true);}});
  const saveUpdates=()=>{const input={auto:$('#update-auto').checked,mirrors:$('#update-mirrors').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)};autosave('updates',()=>api('updates/settings',input,'PUT'));};
  $('#update-auto').addEventListener('change',saveUpdates);$('#update-mirrors').addEventListener('change',saveUpdates);
  for(const [id,route]of [['update-check','updates/check'],['update-install','updates/install']])$('#'+id).addEventListener('click',async()=>{try{await window.cellStationFlush();await api(route,{});await refresh();}catch(e){toast(e.message,true);}});
})();
