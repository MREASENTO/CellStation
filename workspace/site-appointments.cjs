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
    this.file=path.join(path.dirname(store.file),'site-appointments-cache.json');this.state={status:'idle',rows:[],message:'每日更新一次，读取当天起未来7天预约。'};
    try {
      const c=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(c.checkedAt!==undefined&&c.checkedAt!==null&&(!Number.isFinite(c.checkedAt)||!validDate(c.rangeStart)||!validDate(c.rangeEnd)))throw new Error('缓存时间无效');
      if(c.version!==1||!Array.isArray(c.rows)||c.rows.length>50000||c.rows.some(r=>!r||!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.end<=r.start||!Number.isSafeInteger(r.equipmentId)||typeof r.websiteOwner!=='string'||r.profileId!==null&&typeof r.profileId!=='string'))throw new Error('缓存格式无效');
      this.rawRows=c.rows;this.deviceRanges=c.deviceRanges||{};this.lastAttemptDay=validDate(c.lastAttemptDay)?c.lastAttemptDay:null;
      this.state={status:c.status==='loading'?'partial':['complete','partial','failed','interrupted'].includes(c.status)?c.status:c.checkedAt?'complete':'idle',date:c.rangeStart,rangeStart:c.rangeStart,rangeEnd:c.rangeEnd,checkedAt:c.checkedAt,lastAttemptAt:c.lastAttemptAt,lastAttemptDay:this.lastAttemptDay,cached:true,...classify(this.rawRows,store),deviceRanges:this.deviceRanges,errors:Array.isArray(c.errors)?c.errors.filter(e=>typeof e==='string').slice(0,100):[],message:c.status==='loading'?'上次更新未完成，可手动更新':typeof c.message==='string'?c.message:c.checkedAt?'已加载本地预约缓存':'今日更新未完成，可手动更新'};
    } catch(error){if(error.code!=='ENOENT')this.state.message='预约缓存不可用，将在今日更新时重新读取';}
  }
  get active(){return Boolean(this.task);}
  publicState(){return structuredClone(this.state);}
  persist(){
    const data={version:1,status:this.state.status,message:this.state.message,errors:this.state.errors,rows:this.rawRows,deviceRanges:this.deviceRanges,lastAttemptDay:this.lastAttemptDay,lastAttemptAt:this.state.lastAttemptAt,checkedAt:this.state.checkedAt,rangeStart:this.state.rangeStart,rangeEnd:this.state.rangeEnd};
    const temp=this.file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(data),{encoding:'utf8',mode:0o600});fs.renameSync(temp,this.file);
  }
  async start(date,{force=false}={}) {
    if(this.closed)throw new Error('读取服务已关闭');if(!validDate(date))throw new Error('请选择有效日期');if(typeof force!=='boolean')throw new Error('更新选项无效');
    const request=(this.startChain||Promise.resolve()).catch(()=>{}).then(()=>this.startLocked(force));this.startChain=request;return request;
  }
  async startLocked(force) {
    if(this.closed)throw new Error('读取服务已关闭');if(this.task)return this.publicState();
    const today=shanghaiDate(this.clock());
    if(!force&&this.lastAttemptDay===today){this.reclassify();return this.publicState();}
    if(!this.canStart())throw new Error('预约任务正在准备，稍后将自动更新预约缓存');
    const accounts=this.store.data.accounts.filter(a=>a.passwordCipher).map(a=>structuredClone(a)),devices=equipmentList(this.store.data.config);
    if(!accounts.length)throw new Error('请先添加可用的预约账号');if(!devices.length)throw new Error('请先启用预约设备');
    // One verified account can read all calendars; other accounts only need identity discovery once.
    const known=new Set(knownIdentities(this.store).map(a=>a.accountId)),personal=this.store.data.config.personalAccountId;
    accounts.sort((a,b)=>Number(b.id===personal)-Number(a.id===personal)||Number(known.has(b.id))-Number(known.has(a.id)));
    const worker=this.workerFactory(this.store,this.root),generation=++this.generation;worker.capture=async()=>{};this.worker=worker;
    this.lastAttemptDay=today;this.state={...this.state,status:'loading',lastAttemptDay:today,lastAttemptAt:this.clock(),message:'正在更新当天起未来7天的预约…'};this.persist();
    this.task=this.scan(today,accounts,devices,worker,generation).catch(error=>{if(this.generation===generation){this.state={...this.state,status:this.rawRows.length?'partial':'failed',message:'今日更新失败，保留已有缓存',errors:[safeError(error)]};this.persist();}}).finally(async()=>{await worker.close().catch(()=>{});if(this.generation===generation){this.task=null;this.worker=null;}});
    return this.publicState();
  }
  async scan(date,accounts,devices,worker,generation) {
    const rows=[],errors=[],readDevices=new Set(),deviceErrors=new Map(),rangeEnd=addDays(date,6),weeks=[...new Set([weekStart(date),weekStart(rangeEnd)])];
    const freshAccounts=new Set(knownIdentities(this.store).map(a=>a.accountId));
    for(const account of accounts){
      if(generation!==this.generation)return;let session;
      try {
        const job={id:'site-read-'+account.id,accountId:account.id,releaseAt:Date.now()+30000,runtime:{account}};
        session=await worker.session(account.id,true,false,job);
        for(const device of devices){
          if(generation!==this.generation)return;if(readDevices.has(device.equipmentId))continue;
          try {
            await this.open(session.page,rulesFor(device));const all=[];
            for(const week of weeks){if(generation!==this.generation)return;all.push(...await this.components(session.page,week));}
            const unique=[...new Map(all.map(c=>[String(c.id)+'|'+c.dtStart+'|'+c.dtEnd,c])).values()];
            rows.push(...siteRows(date,device,unique,7));readDevices.add(device.equipmentId);deviceErrors.delete(device.equipmentId);
          }catch(error){deviceErrors.set(device.equipmentId,device.equipmentName+'：'+safeError(error));}
        }
        try{const href=await session.page.locator('a.user').getAttribute('href',{timeout:10000}),profileId=href?.match(/index[.](\d+)/)?.[1];if(!profileId||!recordIdentity(this.store,account.id,profileId,account))throw new Error('账号身份未能确认');freshAccounts.add(account.id);}
        catch(error){errors.push((account.owner||account.username)+'：'+safeError(error));}
      }catch(error){if(generation===this.generation)errors.push((account.owner||account.username)+'：'+safeError(error));}
      finally{if(session){await session.context.close().catch(()=>{});worker.contexts?.delete(session.context);}}
      if(readDevices.size===devices.length&&this.store.data.accounts.every(a=>freshAccounts.has(a.id)))break;
    }
    if(generation!==this.generation)return;
    const at=this.clock(),from=Date.parse(date+'T00:00:00+08:00'),to=from+7*86400000,keepFrom=from-7*86400000;
    // Retain recent past columns, and preserve older data for a device whose update failed.
    const previous=this.rawRows.filter(r=>r.end>keepFrom&&(!readDevices.has(r.equipmentId)||r.end<=from||r.start>=to));
    this.rawRows=[...new Map([...previous,...rows].map(({content,...r})=>[r.equipmentId+'|'+r.id+'|'+r.start+'|'+r.end,r])).values()];
    for(const id of readDevices){const old=this.deviceRanges[id],days=new Set(old?.days||[]);for(let i=0;i<7;i++)days.add(addDays(date,i));this.deviceRanges[id]={start:date,end:rangeEnd,checkedAt:at,days:[...days].filter(d=>validDate(d)&&d>=addDays(date,-7)&&d<=rangeEnd).sort()};}
    errors.push(...deviceErrors.values());const result=classify(this.rawRows,this.store);
    this.state={...this.state,status:readDevices.size===devices.length&&result.complete?'complete':readDevices.size?'partial':'failed',date,rangeStart:readDevices.size?date:this.state.rangeStart,rangeEnd:readDevices.size?rangeEnd:this.state.rangeEnd,checkedAt:readDevices.size?at:this.state.checkedAt,lastAttemptDay:this.lastAttemptDay,...result,deviceRanges:this.deviceRanges,errors,message:readDevices.size?'每日预约缓存已更新':'今日更新失败，保留已有缓存'};this.persist();
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
