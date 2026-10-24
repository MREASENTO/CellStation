'use strict';
const fs = require('node:fs'), path = require('node:path');
const GOOD = new Set(['success','already_exists']), BAD = new Set(['failed','needs_review','missed']);
const reviewTime = value => Number.isFinite(value)?new Date(value+8*3600000).toISOString().slice(0,23).replace('T',' '):'未记录';
function reviewNotice(job) {
  const review=job.review;
  if(job.status!=='needs_review'||review?.protocol!==2)return {key:job.id+'|'+job.status,kind:'ordinary'};
  const key=`${job.id}|needs_review|${review.cycleId||'review-v2'}|${review.notice}`;
  if(review.state==='waiting'&&review.stage==='delayed'&&review.notice==='retry_scheduled')return {
    key,kind:'retry_scheduled',title:'CellStation · 首次复核未确认，已安排重查',
    banner:'【首次复核未确认 · 程序还会再次复核】',
    summary:'首次复核未确认，程序将按设置间隔再次查询，尚未要求你自主复核。',
    instructions:[`再次复核时间：${reviewTime(review.nextAt)}（北京时间）`,`当前复核间隔：${review.intervalMinutes}分钟`,'调度运行时程序将再次查询；如果再次复核仍未确认，会另发【请自主复核】提醒。不会重复提交预约。']
  };
  if(review.state==='failed'&&review.manualRequired&&review.notice==='manual_required')return {
    key,kind:'manual_required',title:'【请自主复核】CellStation · 两轮复核仍未确认',
    banner:'【需要你亲自处理：请自主复核】',
    summary:'两轮复核仍未确认，已停止自动复核。请你打开原账号网页自主复核；请勿直接重复预约。',
    instructions:['请你现在打开本机CellStation → 执行记录 →“打开网页核对”，亲自登录原账号自主复核。','程序已停止自动复核；确认网站记录前，请勿直接重复预约。',`首次复核时间：${reviewTime(review.firstCheckedAt)}`,`再次复核时间：${reviewTime(review.delayedCheckedAt)}`]
  };
  return null;
}
class WechatNotifications {
  constructor(directory, vault, request = fetch) {
    fs.mkdirSync(directory,{recursive:true});
    this.file=path.join(directory,'wechat-settings.json');this.vault=vault;this.request=request;
    this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{enabled:false,provider:'serverchan',success:true,failure:true,sent:[]};
    this.pending=new Set();this.queue=Promise.resolve();this.error='';
  }
  persist(){const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.data,null,2),{mode:0o600});fs.renameSync(temp,this.file);}
  publicState(){return {enabled:this.data.enabled,provider:this.data.provider,success:this.data.success,failure:this.data.failure,hasKey:Boolean(this.data.keyCipher),lastSentAt:this.data.lastSentAt||null,error:this.error};}
  async update(input){
    const next={...this.data};
    for(const k of ['enabled','success','failure'])if(input[k]!==undefined){if(typeof input[k]!=='boolean')throw new Error('通知开关无效');next[k]=input[k];}
    if(input.provider!==undefined){if(!['serverchan','pushplus'].includes(input.provider))throw new Error('请选择支持的微信推送服务');if(next.provider!==input.provider){delete next.keyCipher;next.provider=input.provider;}}
    if(input.key){if(typeof input.key!=='string'||!/^[A-Za-z0-9_-]{12,300}$/.test(input.key))throw new Error('推送密钥格式无效，请完整复制');if(next.provider==='serverchan'&&!/^SCT/i.test(input.key))throw new Error('请使用Server酱Turbo的SCT开头SendKey；SC3为独立App通道');next.keyCipher=await this.vault.protect(input.key);}
    if(next.enabled&&!next.keyCipher)throw new Error('请先填写推送密钥，再启用微信通知');
    this.data=next;this.error='';this.persist();return this.publicState();
  }
  enqueue(job){
    if(!this.data.enabled||!((GOOD.has(job.status)&&this.data.success)||(BAD.has(job.status)&&this.data.failure)))return;
    const notice=reviewNotice(job);if(!notice)return;
    const key=notice.key;
    if(this.data.sent.includes(key)||this.pending.has(key))return;
    this.pending.add(key);
    const good=GOOD.has(job.status), title=notice.title||`CellStation · ${good?'预约成功':job.status==='needs_review'?'请及时核对':'预约未完成'}`;
    const message=[notice.banner,...(notice.instructions||[]),`目标日期：${job.date}`,`时间：${job.start}–${job.end}`,`设备：${job.equipment?.equipmentName||'设备'}`,`使用人：${job.accountOwner||job.accountLabel||'未备注'}`,`结果：${notice.kind==='ordinary'?job.message||job.status:job.review.message}`,job.verifiedAt?`网站确认：${job.verifiedAt}`:'',!good&&notice.kind==='ordinary'?'请打开本机CellStation查看执行记录及失败截图。':''].filter(Boolean).join('\n');
    this.queue=this.queue.then(async()=>{try{await this.send(title,message);this.data.sent.push(key);this.data.sent=this.data.sent.slice(-2000);this.data.lastSentAt=new Date().toISOString();this.error='';this.persist();}catch{this.error='微信推送失败，请检查网络、密钥、通道绑定及服务额度；预约结果已保留在本机。';}finally{this.pending.delete(key);}});
  }
  async send(title,content){
    if(!this.data.keyCipher)throw new Error('尚未配置推送密钥');
    const key=await this.vault.unprotect(this.data.keyCipher);
    let url,body,headers;
    if(this.data.provider==='pushplus'){
      url='https://www.pushplus.plus/send';headers={'Content-Type':'application/json'};body=JSON.stringify({token:key,title,content,template:'txt',channel:'wechat'});
    }else{url=`https://sctapi.ftqq.com/${key}.send`;headers={'Content-Type':'application/x-www-form-urlencoded'};body=new URLSearchParams({title,desp:content}).toString();}
    const response=await this.request(url,{method:'POST',headers,body,signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('推送服务响应异常');
    const result=await response.json();
    if(this.data.provider==='pushplus'?result.code!==200:result.code!==0&&result.data?.errno!==0)throw new Error('推送服务未确认接收，请检查额度和密钥');
  }
  async test(){await this.send('CellStation · 微信通知测试','这是一条连接测试消息，未执行预约。收到后即可开启成功和失败提醒。');this.error='';this.data.lastSentAt=new Date().toISOString();this.persist();return {sent:true,message:'推送服务已接收测试消息，请在微信确认收到；服务接收不等于手机已送达。'};}
  async idle(){await this.queue;}
}
module.exports={WechatNotifications,reviewNotice};
