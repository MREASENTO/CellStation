'use strict';
const { BrowserWorker }=require('./browser-worker.cjs');
const { openEquipment,calendarComponents }=require('./reservation.cjs');
const { equipmentList,rulesFor }=require('./equipment.cjs');
const { validDate }=require('./schedule-logic.cjs');
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
    const account=profileId&&byId.get(profileId),member=teamMatch(row.content,store.data.config.teamMembers||[]);
    const {content,...display}=row;return {...display,profileId,owner:row.websiteOwner||account?.owner||member?.name||'未显示',membership:account||member?'ours':profileId&&complete?'other':'unknown'};
  }).sort((a,b)=>a.start-b.start||a.equipmentId-b.equipmentId)};
}
class SiteAppointments {
  constructor(store,root,{clock=Date.now,canStart=()=>true,workerFactory=(s,r)=>new BrowserWorker(s,r),open=openEquipment,components=calendarComponents}={}) {
    Object.assign(this,{store,root,clock,canStart,workerFactory,open,components});this.state={status:'idle',rows:[]};this.generation=0;
  }
  get active(){return Boolean(this.task);}
  publicState(){return structuredClone(this.state);}
  async start(date) {
    if(this.closed)throw new Error('读取服务已关闭');
    if(!validDate(date))throw new Error('请选择有效日期');
    const request=(this.startChain||Promise.resolve()).catch(()=>{}).then(()=>this.startLocked(date));this.startChain=request;return request;
  }
  async startLocked(date) {
    if(this.closed)throw new Error('读取服务已关闭');
    if(this.task&&this.state.date===date)return this.publicState();
    if(this.task)await this.cancel('日期已更改');
    if(this.closed)throw new Error('读取服务已关闭');
    if(!this.canStart())throw new Error('预约任务正在准备，请稍后刷新网站预约');
    const accounts=this.store.data.accounts.map(a=>structuredClone(a)),devices=equipmentList(this.store.data.config);
    if(!accounts.length)throw new Error('请先添加预约账号');if(!devices.length)throw new Error('请先启用预约设备');
    const worker=this.workerFactory(this.store,this.root),generation=++this.generation;worker.capture=async()=>{};this.worker=worker;
    this.state={status:'loading',date,rows:[],message:'正在读取网站预约…'};
    this.task=this.scan(date,accounts,devices,worker,generation).catch(error=>{if(this.generation===generation)this.state={status:'failed',date,rows:[],message:'网站预约读取失败：'+safeError(error)};}).finally(async()=>{await worker.close().catch(()=>{});if(this.generation===generation){this.task=null;this.worker=null;}});
    return this.publicState();
  }
  async scan(date,accounts,devices,worker,generation) {
    const rows=[],errors=[],readDevices=new Set(),deviceErrors=new Map(),freshAccounts=new Set();
    for(const account of accounts){
      if(generation!==this.generation)return;
      let session;
      try {
        const job={id:'site-read-'+account.id,accountId:account.id,releaseAt:Date.now()+30000,runtime:{account}};
        session=await worker.session(account.id,true,false,job);
        for(const device of devices){
          if(generation!==this.generation)return;if(readDevices.has(device.equipmentId))continue;
          try {await this.open(session.page,rulesFor(device));const components=await this.components(session.page,weekStart(date));rows.push(...siteRows(require('./schedule-logic.cjs').shanghaiDate(weekStart(date)*1000),device,components,7));readDevices.add(device.equipmentId);deviceErrors.delete(device.equipmentId);}
          catch(error){deviceErrors.set(device.equipmentId,device.equipmentName+'：'+safeError(error));}
        }
        try{const href=await session.page.locator('a.user').getAttribute('href',{timeout:10000}),profileId=href?.match(/index[.](\d+)/)?.[1];if(!profileId||!recordIdentity(this.store,account.id,profileId,account))throw new Error('账号身份未能确认');freshAccounts.add(account.id);}
        catch(error){errors.push((account.owner||account.username)+'：'+safeError(error));}
      } catch(error){if(generation===this.generation)errors.push((account.owner||account.username)+'：'+safeError(error));}
      finally {if(session){await session.context.close().catch(()=>{});worker.contexts?.delete(session.context);}}
    }
    if(generation!==this.generation)return;
    errors.push(...deviceErrors.values());const readCount=readDevices.size;
    this.rawRows=rows;this.freshAccounts=freshAccounts;const result=classify(rows,this.store,freshAccounts);
    this.state={status:readCount===devices.length&&result.complete?'complete':readCount?'partial':'failed',date,checkedAt:this.clock(),...result,errors,message:readCount?'网站预约已更新':'未能读取网站预约，请检查账号或网络'};
  }
  reclassify(){if(!this.rawRows||!['complete','partial'].includes(this.state.status))return;Object.assign(this.state,classify(this.rawRows,this.store,this.freshAccounts));}
  async cancel(message='已暂停读取') {
    if(this.cancelPromise)return this.cancelPromise;if(!this.task)return;
    const task=this.task,worker=this.worker;this.generation++;
    this.cancelPromise=(async()=>{await worker?.close().catch(()=>{});await task.catch(()=>{});this.task=null;this.worker=null;this.state={status:'interrupted',date:this.state.date,rows:[],message};})();
    try{await this.cancelPromise;}finally{this.cancelPromise=null;}
  }
  interruptIfCritical(now,jobs,records) {
    if(this.task&&jobs.some(j=>j.releaseAt>=now-60000&&j.releaseAt<=now+120000&&!['success','already_exists','failed','needs_review','missed'].includes(records[j.id]?.status)))this.cancel('预约任务即将开始，请稍后刷新网站预约').catch(()=>{});
  }
  async close(){this.closed=true;await this.cancel('读取已结束');await this.startChain?.catch(()=>{});}
}
module.exports={SiteAppointments,weekStart,siteRows,classify};
