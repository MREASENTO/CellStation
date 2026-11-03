'use strict';
const {safeError}=require('./support-files.cjs');
const FINAL=new Set(['success','already_exists','failed','needs_review','missed','skipped']);
class AutomaticActivation {
  constructor(store,{clock=Date.now,plan,start,canStart=()=>true}={}){Object.assign(this,{store,clock,plan,start,canStart});this.revision=0;this.retryAt=0;this.error=null;}
  get active(){return Boolean(this.pending);}
  invalidate(){this.revision++;this.retryAt=0;this.error=null;}
  target(){
    const config=this.store.data.config;if(!config.autoActivateByPlan||config.enabled)return null;
    const pause=this.store.data.autoActivationPause;if(pause)return{kind:'resume',at:pause.resumeAt,key:'pause-'+pause.pausedAt};
    const now=this.clock(),job=this.plan().filter(j=>j.available!==false&&j.releaseAt+(config.graceSeconds||60)*1000>=now&&!FINAL.has(this.store.data.jobs[j.id]?.status)).sort((a,b)=>a.releaseAt-b.releaseAt||(a.equipmentOrder||0)-(b.equipmentOrder||0))[0];
    return job?{kind:'plan',at:job.releaseAt-(config.prewarmSeconds||0)*1000,key:job.id,releaseAt:job.releaseAt,date:job.date,start:job.start,end:job.end}:null;
  }
  imminent(ms=120000){try{const t=this.target();return Boolean(t&&t.at<=this.clock()+ms);}catch{return false;}}
  publicState(){
    const config=this.store.data.config;let target;try{target=this.target();}catch(error){return{status:'error',enabled:Boolean(config.autoActivateByPlan),message:'无法生成自动开始计划：'+safeError(error)};}
    const status=config.enabled?'running':!config.autoActivateByPlan?'disabled':this.pending?'starting':this.error?'error':target?.kind==='resume'?'paused':'armed';
    const message=status==='running'?'预约调度正在运行':status==='disabled'?'自动开始已关闭，暂停后需手动启动':status==='starting'?'正在检查本地环境并自动开始预约':this.error?'自动开始未完成：'+this.error+'；稍后重试':target?.kind==='resume'?(target.at<=this.clock()&&!this.canStart()?'暂停等待已结束，当前操作完成后自动恢复':'手动暂停倒计时，到期后自动恢复预约'):target?'等待计划开放前自动启用并预热':'暂无待开放计划，等待日期或设备计划更新';
    return{status,enabled:Boolean(config.autoActivateByPlan),message,nextAt:target?.at||null,kind:target?.kind||null,releaseAt:target?.releaseAt||null,pauseSeconds:config.autoActivationPauseSeconds,retryAt:this.retryAt||null};
  }
  async tick(){
    if(this.closed||this.pending||process.env.CELLSTATION_DISABLE_AUTO_ACTIVATION==='1')return;
    const target=this.target(),now=this.clock();if(!target||target.at>now||this.retryAt>now||!this.canStart())return;
    const revision=this.revision,guard=()=>!this.closed&&revision===this.revision&&this.store.data.config.autoActivateByPlan&&this.target()?.key===target.key;
    this.pending=Promise.resolve().then(()=>this.start({source:'automatic',guard,reason:target.kind})).catch(error=>{
      if(error.code==='START_CANCELLED'||!guard())return;
      const message=safeError(error);if(message!==this.error)this.store.event('automatic-start','自动开始未完成：'+message);this.error=message;this.retryAt=this.clock()+30000;
    }).finally(()=>{this.pending=null;});
    await this.pending;
  }
  startTimer(){if(this.timer||process.env.CELLSTATION_DISABLE_AUTO_ACTIVATION==='1')return;this.timer=setInterval(()=>this.tick().catch(()=>{}),500);this.timer.unref?.();}
  async close(){this.closed=true;this.invalidate();clearInterval(this.timer);await this.pending?.catch(()=>{});}
}
module.exports={AutomaticActivation};
