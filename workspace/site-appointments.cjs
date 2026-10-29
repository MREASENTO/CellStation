'use strict';
const { BrowserWorker }=require('./browser-worker.cjs');
const { openEquipment,calendarComponents }=require('./reservation.cjs');
const { equipmentList,rulesFor }=require('./equipment.cjs');
const { validDate,shanghaiDate,addDays }=require('./schedule-logic.cjs');
const fs=require('node:fs'),path=require('node:path');
const { normalizedEnd }=require('./booking-logic.cjs');
const { oneOwner,ownerName,teamMatch,knownIdentities,recordIdentity }=require('./site-identity.cjs');
const { safeError }=require('./support-files.cjs');
function weekStart(date) {
  const day=Date.parse(date+'T00:00:00+08:00')/1000;
  return day-new Date(day*1000+8*3600000).getUTCDay()*86400;
}
function siteRows(date,equipment,components,days=1) {
  const start=Date.parse(date+'T00:00:00+08:00')/1000,end=start+days*86400;
  return components.flatMap(c=>{
    const from=Number(c.dtStart),to=normalizedEnd(c);
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||from>=end||to<=start)return [];
    return [{id:String(c.id||''),equipmentId:equipment.equipmentId,equipmentName:equipment.equipmentName,start:from*1000,end:to*1000,profileId:oneOwner(c.content),websiteOwner:ownerName(c.content),content:String(c.content||'')}];
  });
}
function classify(rows,store,freshAccounts) {
  const known=knownIdentities(store).filter(a=>!freshAccounts||freshAccounts.has(a.accountId)),byId=new Map(known.map(a=>[a.profileId,a]));
  const complete=store.data.accounts.length>0&&known.length===store.data.accounts.length;
  return {identified:known.length,total:store.data.accounts.length,complete,rows:rows.map(({profileId,...row})=>{
    const account=profileId&&byId.get(profileId),member=profileId&&(store.data.config.teamMembers||[]).find(m=>m.profileId===profileId||!m.profileId&&m.name===row.websiteOwner);
    const {content,...display}=row;return {...display,profileId,owner:row.websiteOwner||account?.owner||member?.name||'未显示',membership:account||member?'ours':profileId&&complete?'other':'unknown'};
  }).sort((a,b)=>a.start-b.start||a.equipmentId-b.equipmentId)};
}
class SiteAppointments {
  constructor(store,root,{clock=Date.now,canStart=()=>true,workerFactory=(s,r)=>new BrowserWorker(s,r),open=openEquipment,components=calendarComponents}={}) {
    Object.assign(this,{store,root,clock,canStart,workerFactory,open,components});this.generation=0;this.rawRows=[];this.deviceRanges={};
    this.file=path.join(path.dirname(store.file),'site-appointments-cache.json');this.state={status:'idle',rows:[],message:'保留过去30天与未来7天预约；预约确认后即时增量同步。'};
    try {
      const c=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(c.checkedAt!==undefined&&c.checkedAt!==null&&(!Number.isFinite(c.checkedAt)||!validDate(c.rangeStart)||!validDate(c.rangeEnd)))throw new Error('缓存时间无效');
      if(![1,2,3].includes(c.version)||!Array.isArray(c.rows)||c.rows.length>50000||c.rows.some(r=>!r||!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.end<=r.start||!Number.isSafeInteger(r.equipmentId)||typeof r.websiteOwner!=='string'||r.profileId!==null&&typeof r.profileId!=='string'))throw new Error('缓存格式无效');
      this.rawRows=c.rows;this.deviceRanges=c.deviceRanges||{};this.lastAttemptDay=validDate(c.lastAttemptDay)?c.lastAttemptDay:null;
      this.state={status:c.status==='loading'?'partial':['complete','partial','failed','interrupted'].includes(c.status)?c.status:c.checkedAt?'complete':'idle',date:c.rangeStart,rangeStart:c.rangeStart,rangeEnd:c.rangeEnd,historyStart:c.historyStart,checkedAt:c.checkedAt,lastAttemptAt:c.lastAttemptAt,lastAttemptDay:this.lastAttemptDay,cached:true,lastUpdateKind:c.lastUpdateKind,...classify(this.rawRows,store),deviceRanges:this.deviceRanges,errors:Array.isArray(c.errors)?c.errors.filter(e=>typeof e==='string').slice(0,100):[],message:c.status==='loading'?'上次更新未完成，可手动更新':typeof c.message==='string'?c.message:c.checkedAt?'已加载本地预约缓存':'今日更新未完成，可手动更新'};
    } catch(error){if(error.code!=='ENOENT')this.state.message='预约缓存不可用，将在今日更新时重新读取';}
    if(this.state.checkedAt&&(this.state.rangeEnd<addDays(shanghaiDate(this.clock()),7)||this.state.historyStart!==addDays(shanghaiDate(this.clock()),-30)))this.lastAttemptDay=null;
    this.rollWindow(false);
  }
  get active(){return Boolean(this.task);}
  publicState(){this.rollWindow();return structuredClone(this.state);}
  persist(){
    const data={version:3,status:this.state.status,message:this.state.message,errors:this.state.errors,rows:this.rawRows,deviceRanges:this.deviceRanges,lastAttemptDay:this.lastAttemptDay,lastAttemptAt:this.state.lastAttemptAt,lastUpdateKind:this.state.lastUpdateKind,checkedAt:this.state.checkedAt,historyStart:this.state.historyStart,rangeStart:this.state.rangeStart,rangeEnd:this.state.rangeEnd};
    const temp=this.file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(data),{encoding:'utf8',mode:0o600});fs.renameSync(temp,this.file);
  }
  async start(date,{force=false}={}) {
    if(this.closed)throw new Error('读取服务已关闭');if(!validDate(date))throw new Error('请选择有效日期');if(typeof force!=='boolean')throw new Error('更新选项无效');
    const request=(this.startChain||Promise.resolve()).catch(()=>{}).then(()=>this.startLocked(force));this.startChain=request;return request;
  }
  async startLocked(force) {
    if(this.closed)throw new Error('读取服务已关闭');if(this.task)return this.publicState();
    this.rollWindow();const today=shanghaiDate(this.clock());
    if(!force&&this.lastAttemptDay===today){this.reclassify();return this.publicState();}
    if(!this.canStart())throw new Error('预约任务正在准备，稍后将自动更新预约缓存');
    const accounts=this.store.data.accounts.filter(a=>a.passwordCipher).map(a=>structuredClone(a)),devices=equipmentList(this.store.data.config);
    if(!accounts.length)throw new Error('请先添加可用的预约账号');if(!devices.length)throw new Error('请先启用预约设备');
    // One verified account can read all calendars; other accounts only need identity discovery once.
    const known=new Set(knownIdentities(this.store).map(a=>a.accountId)),personal=this.store.data.config.personalAccountId;
    accounts.sort((a,b)=>Number(b.id===personal)-Number(a.id===personal)||Number(known.has(b.id))-Number(known.has(a.id)));
    const worker=this.workerFactory(this.store,this.root),generation=++this.generation;worker.capture=async()=>{};this.worker=worker;
    this.lastAttemptDay=today;this.state={...this.state,status:'loading',lastAttemptDay:today,lastAttemptAt:this.clock(),message:'正在更新近期预约并补全缺失的历史周…'};this.persist();
    this.task=this.scan(today,accounts,devices,worker,generation).catch(error=>{if(this.generation===generation){this.state={...this.state,status:this.rawRows.length?'partial':'failed',message:'今日更新失败，保留已有缓存',errors:[safeError(error)]};this.persist();}}).finally(async()=>{await worker.close().catch(()=>{});if(this.generation===generation){this.task=null;this.worker=null;}});
    return this.publicState();
  }
  rollWindow(save=true) {
    const date=shanghaiDate(this.clock()),historyStart=addDays(date,-30),end=addDays(date,7),from=Date.parse(historyStart+'T00:00:00+08:00'),to=from+38*86400000;
    if(this.state.rangeStart===date&&this.state.rangeEnd===end&&this.state.historyStart===historyStart)return;
    this.rawRows=this.rawRows.filter(r=>r.start<to&&r.end>from);
    for(const [id,r] of Object.entries(this.deviceRanges)){
      const days=(r.days||[]).filter(d=>validDate(d)&&d>=historyStart&&d<=end);
      this.deviceRanges[id]={...r,start:days[0]||date,end:days.at(-1)||date,days,dayCheckedAt:Object.fromEntries(Object.entries(r.dayCheckedAt||{}).filter(([d])=>days.includes(d))),weekReadAt:Object.fromEntries(Object.entries(r.weekReadAt||{}).filter(([at])=>Number(at)+7*86400>from/1000&&Number(at)<to/1000))};
    }
    const incomplete=equipmentList(this.store.data.config).some(d=>this.deviceRanges[d.equipmentId]?.days?.length!==38);
    this.state={...this.state,date,historyStart,rangeStart:date,rangeEnd:end,...classify(this.rawRows,this.store),deviceRanges:this.deviceRanges,...(this.state.status==='complete'&&incomplete?{status:'partial',message:'缓存范围已调整，等待补全缺失日期'}:{})};
    if(save&&!this.closed)this.persist();
  }
  mergeCalendar(device,components,from,to,readAt,checkedAt) {
    this.rollWindow(false);
    const windowFrom=Date.parse(this.state.historyStart+'T00:00:00+08:00'),windowTo=windowFrom+38*86400000;
    from=Math.max(from,windowFrom);to=Math.min(to,windowTo);if(to<=from)return false;
    const previousRange=this.deviceRanges[device.equipmentId]||{},weekKey=String(weekStart(shanghaiDate(from)));
    if((previousRange.weekReadAt?.[weekKey]||0)>readAt)return false;
    const fresh=siteRows(this.state.historyStart,device,components,38).filter(r=>r.start<to&&r.end>from).map(({content,...r})=>({...r,observedAt:readAt}));
    const key=r=>r.equipmentId+'|'+r.id+'|'+r.start+'|'+r.end,existing=new Map(this.rawRows.map(r=>[key(r),r]));
    const ours=new Set(classify(this.rawRows,this.store).rows.filter(r=>r.membership==='ours').map(key));
    let reusedOwn=0;
    const rows=this.rawRows.filter(r=>r.equipmentId!==device.equipmentId||r.start>=to||r.end<=from||(r.observedAt||0)>readAt);
    for(const r of fresh){const old=existing.get(key(r));if(old&&(old.observedAt||0)>readAt)continue;
      if(old&&ours.has(key(r))&&['equipmentName','profileId','websiteOwner'].every(k=>old[k]===r[k])){rows.push(old);reusedOwn++;}else rows.push(r);
    }
    this.rawRows=[...new Map(rows.map(r=>[key(r),r])).values()];
    const old=this.deviceRanges[device.equipmentId]||{},days=new Set(old.days||[]),dayCheckedAt={...(old.dayCheckedAt||{})};
    for(let i=0;i<38;i++){const date=addDays(this.state.historyStart,i),at=windowFrom+i*86400000;if(at>=from&&at+86400000<=to){days.add(date);dayCheckedAt[date]=Math.max(dayCheckedAt[date]||0,checkedAt);}}
    const sorted=[...days].filter(d=>d>=this.state.historyStart&&d<=this.state.rangeEnd).sort();
    this.deviceRanges[device.equipmentId]={start:sorted[0]||this.state.rangeStart,end:sorted.at(-1)||this.state.rangeStart,checkedAt:Math.max(old.checkedAt||0,checkedAt),days:sorted,dayCheckedAt,weekReadAt:{...(old.weekReadAt||{}),[weekKey]:readAt}};
    this.state={...this.state,checkedAt:Math.max(this.state.checkedAt||0,checkedAt),...classify(this.rawRows,this.store),deviceRanges:this.deviceRanges,lastMerge:{equipmentId:device.equipmentId,received:fresh.length,reusedOwn,readAt,checkedAt}};
    return true;
  }
  acceptCalendar(job,snapshot) {
    if(this.closed)return false;
    const device=equipmentList(this.store.data.config).find(d=>d.equipmentId===job.equipment?.equipmentId&&d.equipmentName===job.equipment?.equipmentName);
    if(!device||!snapshot||!Array.isArray(snapshot.components)||snapshot.components.length>50000||!Number.isFinite(snapshot.weekStart)||!Number.isFinite(snapshot.checkedAt))return false;
    const changed=this.mergeCalendar(device,snapshot.components,snapshot.weekStart*1000,(snapshot.weekStart+7*86400)*1000,snapshot.readAt??snapshot.checkedAt,snapshot.checkedAt);
    if(!changed)return false;
    if(!this.task)this.state.status=equipmentList(this.store.data.config).every(d=>this.deviceRanges[d.equipmentId]?.days?.length===38)&&this.state.complete?'complete':'partial';
    this.state.lastUpdateKind='booking';this.state.message='已复用网站读回结果，同步预约缓存；相同的本团队记录继续复用';this.persist();return true;
  }
  async scan(date,accounts,devices,worker,generation) {
    const errors=[],readDevices=new Set(),deviceErrors=new Map(),rangeEnd=addDays(date,7),weeks=[...new Set([weekStart(date),weekStart(rangeEnd)])];
    const freshAccounts=new Set(knownIdentities(this.store).map(a=>a.accountId));
    for(const account of accounts){
      if(generation!==this.generation)return;let session;
      try {
        const job={id:'site-read-'+account.id,accountId:account.id,releaseAt:Date.now()+30000,runtime:{account}};
        session=await worker.session(account.id,true,false,job);
        for(const device of devices){
          if(generation!==this.generation)return;if(readDevices.has(device.equipmentId))continue;
          try {
            await this.open(session.page,rulesFor(device));
            const required=[...weeks];for(let d=addDays(date,-30);d<date;d=addDays(d,1)){if(!this.deviceRanges[device.equipmentId]?.days?.includes(d)&&!required.includes(weekStart(d)))required.push(weekStart(d));}
            for(const week of required){
              if(generation!==this.generation)return;const readAt=this.clock(),components=await this.components(session.page,week);
              if(generation!==this.generation)return;
              this.mergeCalendar(device,components,week*1000,(week+7*86400)*1000,readAt,this.clock());this.persist();
            }
            readDevices.add(device.equipmentId);deviceErrors.delete(device.equipmentId);
          }catch(error){deviceErrors.set(device.equipmentId,device.equipmentName+'：'+safeError(error));}
        }
        try{const href=await session.page.locator('a.user').getAttribute('href',{timeout:10000}),profileId=href?.match(/index[.](\d+)/)?.[1];if(!profileId||!recordIdentity(this.store,account.id,profileId,account))throw new Error('账号身份未能确认');freshAccounts.add(account.id);}
        catch(error){errors.push((account.owner||account.username)+'：'+safeError(error));}
      }catch(error){if(generation===this.generation)errors.push((account.owner||account.username)+'：'+safeError(error));}
      finally{if(session){await session.context.close().catch(()=>{});worker.contexts?.delete(session.context);}}
      if(readDevices.size===devices.length&&this.store.data.accounts.every(a=>freshAccounts.has(a.id)))break;
    }
    if(generation!==this.generation)return;
    errors.push(...deviceErrors.values());const result=classify(this.rawRows,this.store);
    this.state={...this.state,status:readDevices.size===devices.length&&devices.every(d=>this.deviceRanges[d.equipmentId]?.days?.length===38)&&result.complete?'complete':this.rawRows.length||readDevices.size?'partial':'failed',lastAttemptDay:this.lastAttemptDay,...result,deviceRanges:this.deviceRanges,errors,lastUpdateKind:'daily',message:readDevices.size?'预约缓存已更新，历史保留30天；相同的本团队记录继续复用':'今日更新失败，保留已有缓存'};this.persist();
  }
  reclassify(){if(!this.rawRows)return;Object.assign(this.state,classify(this.rawRows,this.store),{deviceRanges:this.deviceRanges});}
  async tick(){
    if(this.closed||this.task||this.lastAttemptDay===shanghaiDate(this.clock())||!this.store.data.accounts.some(a=>a.passwordCipher)||!equipmentList(this.store.data.config).length||!this.canStart())return;
    await this.start(shanghaiDate(this.clock())).catch(()=>{});
  }
  startDaily(){if(this.timer||process.env.CELLSTATION_DISABLE_SITE_SYNC==='1')return;this.initialTimer=setTimeout(()=>this.tick(),15000);this.initialTimer.unref?.();this.timer=setInterval(()=>this.tick(),60000);this.timer.unref?.();}
  async cancel(message='已暂停更新') {
    if(this.cancelPromise)return this.cancelPromise;if(!this.task)return;
    const task=this.task,worker=this.worker;this.generation++;
    this.cancelPromise=(async()=>{await worker?.close().catch(()=>{});await task.catch(()=>{});this.task=null;this.worker=null;this.state={...this.state,status:this.state.checkedAt?'partial':'interrupted',message};this.persist();})();
    try{await this.cancelPromise;}finally{this.cancelPromise=null;}
  }
  interruptIfCritical(now,jobs,records) {
    if(this.task&&jobs.some(j=>j.releaseAt>=now-60000&&j.releaseAt<=now+120000&&!['success','already_exists','failed','needs_review','missed'].includes(records[j.id]?.status)))this.cancel('预约任务即将开始，已暂停缓存更新').catch(()=>{});
  }
  async close(){this.closed=true;clearInterval(this.timer);clearTimeout(this.initialTimer);await this.cancel('更新已结束');await this.startChain?.catch(()=>{});}
}
module.exports={SiteAppointments,weekStart,siteRows,classify};
