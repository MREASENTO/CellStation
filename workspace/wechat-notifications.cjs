'use strict';
const fs = require('node:fs'), path = require('node:path');
const GOOD = new Set(['success','already_exists']), BAD = new Set(['failed','needs_review','missed']);
function normalizeKey(provider,key){
  if(typeof key!=='string')throw new Error('推送密钥格式无效，请完整复制');
  key=key.trim();
  if(provider==='wecom'){
    let u;try{u=new URL(key);}catch{throw new Error('请粘贴企业微信群机器人的完整HTTPS Webhook地址');}
    if(u.protocol!=='https:'||u.hostname!=='qyapi.weixin.qq.com'||u.port||u.username||u.password||u.hash||u.pathname!=='/cgi-bin/webhook/send'||u.searchParams.getAll('key').length!==1||[...u.searchParams.keys()].some(k=>k!=='key')||!/^[A-Za-z0-9_-]{12,200}$/.test(u.searchParams.get('key')||''))throw new Error('企业微信Webhook地址无效，请从内部群“消息推送/群机器人”复制完整地址');
    return 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key='+u.searchParams.get('key');
  }
  if(!/^[A-Za-z0-9_-]{12,300}$/.test(key))throw new Error('推送密钥格式无效，请完整复制');
  if(provider==='serverchan'&&!/^SCT/i.test(key))throw new Error('请使用Server酱Turbo的SCT开头SendKey；SC3为独立App通道');
  return key;
}
function textLimit(value,max=2048){
  const text=String(value),tail='\n…（内容已截断，请在CellStation查看）';if(Buffer.byteLength(text,'utf8')<=max)return text;
  const limit=max-Buffer.byteLength(tail,'utf8');let result='',bytes=0;for(const char of text){const n=Buffer.byteLength(char,'utf8');if(bytes+n>limit)break;result+=char;bytes+=n;}return result+tail;
}
function wait(ms,signal){return new Promise((resolve,reject)=>{if(signal.aborted)return reject(new Error('通知发送已停止'));const abort=()=>{clearTimeout(timer);reject(new Error('通知发送已停止'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});}
const reviewTime = value => Number.isFinite(value)?new Date(value+8*3600000).toISOString().slice(0,23).replace('T',' '):'未记录';
function reviewNotice(job) {
  const review=job.review;
  if(job.status!=='needs_review'||!(review?.protocol>=2))return {key:job.id+'|'+job.status,kind:'ordinary'};
  const key=`${job.id}|needs_review|${review.cycleId||'review-v2'}|${review.notice}`;
  if(review.state==='waiting'&&review.stage==='delayed'&&review.notice==='retry_scheduled')return {
    key,kind:'retry_scheduled',title:review.protocol===3?'CellStation · 补约后复核未确认，已安排最终复核':'CellStation · 首次复核未确认，已安排重查',
    banner:review.protocol===3?'【补约后即时复核未确认 · 已安排最终复核】':'【首次复核未确认 · 程序还会再次复核】',
    summary:review.protocol===3?'本轮补约及即时复核已处理，等待设定秒数后最终复核。':'首次复核未确认，程序将按设置间隔再次查询，尚未要求你自主复核。',
    instructions:[`再次复核时间：${reviewTime(review.nextAt)}（北京时间）`,`当前复核等待：${review.intervalSeconds??review.intervalMinutes*60}秒`,review.protocol===3?'调度运行时将进行最终复核；仍未确认会另发【请自主复核】提醒，后续不会再次自动补约。':'调度运行时程序将再次查询；如果再次复核仍未确认，会另发【请自主复核】提醒。不会重复提交预约。']
  };
  if(review.state==='failed'&&review.manualRequired&&review.notice==='manual_required')return {
    key,kind:'manual_required',title:review.protocol===3?'【请自主复核】CellStation · 最终复核仍未确认':'【请自主复核】CellStation · 两轮复核仍未确认',
    banner:'【需要你亲自处理：请自主复核】',
    summary:review.protocol===3?'补约处理及最终复核仍未确认，已停止自动处理。请打开原账号网页自主复核。':'两轮复核仍未确认，已停止自动复核。请你打开原账号网页自主复核；请勿直接重复预约。',
    instructions:['请你现在打开本机CellStation → 执行记录 →“打开网页核对”，亲自登录原账号自主复核。','程序已停止自动复核；确认网站记录前，请勿直接重复预约。',`首次复核时间：${reviewTime(review.firstCheckedAt)}`,...(review.protocol===3?[`补约处理时间：${reviewTime(review.rebooking?.finishedAt)}`,`补约后即时复核：${reviewTime(review.postRebookCheckedAt)}`]:[]),`再次复核时间：${reviewTime(review.delayedCheckedAt)}`]
  };
  return null;
}
class WechatNotifications {
  constructor(directory, vault, request = fetch, {clock=Date.now,sleep=wait}={}) {
    fs.mkdirSync(directory,{recursive:true});
    this.file=path.join(directory,'wechat-settings.json');this.vault=vault;this.request=request;
    this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{enabled:false,provider:'serverchan',success:true,failure:true,sent:[]};
    this.pending=new Set();this.queue=Promise.resolve();this.error='';
    this.deliveryQueue=Promise.resolve();this.clock=clock;this.sleep=sleep;this.nextWecomAt=0;this.abort=new AbortController();this.closed=false;this.outstanding=0;
  }
  persist(){const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.data,null,2),{mode:0o600});fs.renameSync(temp,this.file);}
  get busy(){return this.pending.size+this.outstanding;}
  publicState(){return {enabled:this.data.enabled,provider:this.data.provider,success:this.data.success,failure:this.data.failure,hasKey:Boolean(this.data.keyCipher),lastSentAt:this.data.lastSentAt||null,error:this.error,queued:this.pending.size};}
  async update(input){
    const next={...this.data};
    for(const k of ['enabled','success','failure'])if(input[k]!==undefined){if(typeof input[k]!=='boolean')throw new Error('通知开关无效');next[k]=input[k];}
    if(input.provider!==undefined){if(!['serverchan','pushplus','wecom'].includes(input.provider))throw new Error('请选择支持的微信推送服务');if(next.provider!==input.provider){delete next.keyCipher;next.provider=input.provider;}}
    if(input.key)next.keyCipher=await this.vault.protect(normalizeKey(next.provider,input.key));
    if(next.enabled&&!next.keyCipher)throw new Error('请先填写推送密钥，再启用微信通知');
    this.data=next;this.error='';this.persist();return this.publicState();
  }
  enqueue(job){
    if(this.closed||!this.data.enabled||!((GOOD.has(job.status)&&this.data.success)||(BAD.has(job.status)&&this.data.failure)))return;
    const notice=reviewNotice(job);if(!notice)return;
    const key=notice.key;
    if(this.data.sent.includes(key)||this.pending.has(key))return;
    this.pending.add(key);
    const good=GOOD.has(job.status), title=notice.title||`CellStation · ${good?'预约成功':job.status==='needs_review'?'请及时核对':'预约未完成'}`;
    const message=[notice.banner,`目标日期：${job.date}`,`时间：${job.start}–${job.end}`,`设备：${job.equipment?.equipmentName||'设备'}`,`使用人：${job.accountOwner||job.accountLabel||'未备注'}`,`结果：${notice.kind==='ordinary'?job.message||job.status:job.review.message}`,job.verifiedAt?`网站确认：${job.verifiedAt}`:'',...(notice.instructions||[]),!good&&notice.kind==='ordinary'?'请打开本机CellStation查看执行记录及失败截图。':''].filter(Boolean).join('\n'),destination={...this.data};
    const eligible=()=>this.data.enabled&&(good?this.data.success:this.data.failure);
    this.queue=this.queue.then(async()=>{try{const sent=await this.send(title,message,destination,eligible);if(!sent)return;this.data.sent.push(key);this.data.sent=this.data.sent.slice(-2000);this.data.lastSentAt=new Date().toISOString();this.error='';this.persist();}catch(error){if(!this.closed)this.error='微信推送失败：'+error.message+'；预约结果已保留在本机。';}finally{this.pending.delete(key);}});
  }
  send(title,content,destination={...this.data},eligible=()=>true){
    this.outstanding++;const action=this.deliveryQueue.then(()=>this.deliver(title,content,destination,eligible)).finally(()=>this.outstanding--);this.deliveryQueue=action.catch(()=>{});return action;
  }
  async deliver(title,content,destination,eligible){
    const current=()=>!this.closed&&eligible()&&this.data.provider===destination.provider&&this.data.keyCipher===destination.keyCipher;
    if(!current())return false;if(!destination.keyCipher)throw new Error('尚未配置推送密钥');
    if(!['serverchan','pushplus','wecom'].includes(destination.provider))throw new Error('通知通道无效，请重新选择');
    let key;try{key=normalizeKey(destination.provider,await this.vault.unprotect(destination.keyCipher));}catch{throw new Error('通知密钥无法读取或格式不正确，请重新填写');}
    let url,body,headers;
    if(destination.provider==='wecom'){
      while(this.nextWecomAt>this.clock()){await this.sleep(Math.min(this.nextWecomAt-this.clock(),3100),this.abort.signal);if(!current())return false;}
      if(!current())return false;this.nextWecomAt=this.clock()+3100;
      url=key;headers={'Content-Type':'application/json'};body=JSON.stringify({msgtype:'text',text:{content:textLimit(title+'\n'+content)}});
    }else if(destination.provider==='pushplus'){
      url='https://www.pushplus.plus/send';headers={'Content-Type':'application/json'};body=JSON.stringify({token:key,title,content,template:'txt',channel:'wechat'});
    }else{url=`https://sctapi.ftqq.com/${key}.send`;headers={'Content-Type':'application/x-www-form-urlencoded'};body=new URLSearchParams({title,desp:content}).toString();}
    if(!current())return false;
    let response;try{response=await this.request(url,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(8000),this.abort.signal])});}catch{throw new Error('网络不可用或推送服务响应超时，请检查网络连接');}
    if(!response.ok)throw new Error('推送服务响应异常');
    let result;try{result=await response.json();}catch{throw new Error('推送服务回执无效，请稍后测试');}
    if(destination.provider==='wecom'){
      if(result?.errcode!==0)throw new Error('企业微信未确认接收'+(Number.isSafeInteger(result?.errcode)?'（错误码 '+result.errcode+'）':'')+'，请检查机器人是否有效及发送频率');
    }else if(destination.provider==='pushplus'?result?.code!==200:result?.code!==0&&result?.data?.errno!==0)throw new Error('推送服务未确认接收，请检查额度和密钥');
    return true;
  }
  async test(){try{const sent=await this.send('CellStation · 通知测试','这是一条连接测试消息，未执行预约。收到后即可开启成功和失败提醒。');if(!sent)throw new Error('通知设置已变化或程序正在退出，请重新测试');this.error='';this.data.lastSentAt=new Date().toISOString();this.persist();return {sent:true,message:'推送服务已接收测试消息，请在接收端确认收到；服务接收不等于手机已送达。'};}catch(error){this.error=error.message;throw error;}}
  async idle(){await this.queue;await this.deliveryQueue;}
  async close(){this.closed=true;this.abort.abort();await this.idle();}
}
module.exports={WechatNotifications,reviewNotice,normalizeKey,textLimit};
