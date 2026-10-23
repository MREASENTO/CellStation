'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
const CURRENT_VERSION='1.0.4';
const {eligibleGitUpdate,fetchGitUpdate}=require('./git-updates.cjs');
const canonical=value=>JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])));
const newer=(a,b)=>{if(!/^\d+\.\d+\.\d+$/.test(a)||!/^\d+\.\d+\.\d+$/.test(b))return false;const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;};
function verifiedRelease(document,config){
  const r=document?.release;
  if(!r||!newer(r.version,'0.0.0')||!/^https:\/\/github\.com\/MREASENTO\/CellStation\/releases\/download\/v\d+\.\d+\.\d+\/CellStation-v\d+\.\d+\.\d+-win64\.zip$/.test(r.url)||!r.url.endsWith(`/CellStation-v${r.version}-win64.zip`)||!r.url.includes(`/v${r.version}/`)||!/^[a-f0-9]{64}$/.test(r.sha256)||!Number.isSafeInteger(r.size)||r.size<=0||r.size>2*1024**3)throw new Error('更新清单格式无效');
  const fields=['gitRevision','gitRef','gitRuntimeId','gitManifestSha256'];
  if(fields.some(k=>r[k]!==undefined)&&(!/^[a-f0-9]{40}$/.test(r.gitRevision||'')||r.gitRef!==`app-v${r.version}`||!fields.slice(2).every(k=>/^[a-f0-9]{64}$/.test(r[k]||''))))throw new Error('Git更新清单格式无效');
  if(!crypto.verify(null,Buffer.from(canonical(r)),config.publicKey,Buffer.from(document.signature||'','base64')))throw new Error('更新签名验证失败');
  return r;
}
class AppUpdater{
  constructor({dataRoot,config,version=CURRENT_VERSION,request=fetch,canInstall=()=>true,onInstall=async()=>{},progress=()=>{},installRoot,gitFetch=fetchGitUpdate}){
    this.root=path.join(dataRoot,'updates');fs.mkdirSync(this.root,{recursive:true});this.file=path.join(this.root,'settings.json');this.config=config;this.version=version;this.request=request;this.canInstall=canInstall;this.onInstall=onInstall;this.progress=progress;this.installRoot=installRoot;this.gitFetch=gitFetch;
    this.preferences=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{auto:true,mirrors:[]};this.state={status:'idle',message:'尚未检查更新',progress:0};this.checkPromise=null;this.installPromise=null;this.deferredTimer=null;
  }
  publicState(){return {...this.state,version:this.version,auto:this.preferences.auto,mirrors:this.preferences.mirrors,availableVersion:this.release?.version||null};}
  setState(patch){if(Object.keys(patch).length===1&&patch.progress===this.state.progress)return;Object.assign(this.state,patch);this.progress(this.publicState());}
  settings(input){
    if(typeof input.auto!=='boolean'||!Array.isArray(input.mirrors)||input.mirrors.length>8||input.mirrors.some(v=>{try{const u=new URL(v);return u.protocol!=='https:'||u.username||u.password||v.length>2000;}catch{return true;}}))throw new Error('更新设置无效，镜像须为HTTPS清单地址');
    this.preferences={auto:input.auto,mirrors:[...new Set(input.mirrors)]};fs.writeFileSync(this.file,JSON.stringify(this.preferences));if(!input.auto){clearTimeout(this.deferredTimer);this.deferredTimer=null;}return this.publicState();
  }
  async check(){
    if(this.checkPromise)return this.checkPromise;
    this.checkPromise=this._check().finally(()=>{this.checkPromise=null;});return this.checkPromise;
  }
  async _check(){
    this.setState({status:'checking',message:'正在检查签名更新清单…',progress:0});let lastError='';
    for(const url of [...this.preferences.mirrors,...this.config.feeds]){
      try{const response=await this.request(url,{signal:AbortSignal.timeout(4500),headers:{'User-Agent':'CellStation/'+this.version}});if(!response.ok)throw new Error('更新源暂不可用');if(Number(response.headers?.get?.('content-length')||0)>262144)throw new Error('清单过大');const text=await response.text();if(Buffer.byteLength(text)>262144)throw new Error('清单过大');const release=verifiedRelease(JSON.parse(text),this.config);
        if(newer(release.version,this.version)){this.release=release;this.setState({status:'available',message:`发现新版本 ${release.version}`,checkedAt:new Date().toISOString()});}
        else{this.release=null;this.setState({status:'up_to_date',message:`当前 ${this.version} 已是最新版本`,checkedAt:new Date().toISOString()});}return this.publicState();
      }catch(error){lastError=/签名/.test(error.message)?'更新签名验证失败':'更新源暂不可用';}
    }
    this.setState({status:'unavailable',message:lastError+'，继续使用当前版本；可稍后重试。'});return this.publicState();
  }
  async startup(){if(process.env.CELLSTATION_DISABLE_UPDATES==='1'||process.argv.includes('--skip-update-once')||!this.preferences.auto)return this.publicState();await this.check();if(this.release)await this.install();return this.publicState();}
  async install(){if(this.installPromise)return this.installPromise;this.installPromise=this._install().finally(()=>{this.installPromise=null;});return this.installPromise;}
  async _install(){
    if(!this.release)throw new Error('请先检查并找到新版本');
    if(!this.canInstall()){this.setState({status:'deferred',message:'临近预约或任务进行中，更新将延后至空闲时安装'});clearTimeout(this.deferredTimer);if(this.preferences.auto){this.deferredTimer=setTimeout(()=>this.install().catch(()=>{}),30000);this.deferredTimer.unref?.();}return this.publicState();}
    const release=this.release,dir=path.join(this.root,release.version);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'package.zip'),partial=file+'.download';
    this.setState({status:'downloading',message:`正在下载 ${release.version}，预约配置保留`,progress:0});
    let downloaded=false,selectedFile=file,selectedRelease=release;
    if(eligibleGitUpdate(release,this.installRoot)){try{const artifact=await this.gitFetch({release,config:this.config,install:this.installRoot,dataRoot:path.dirname(this.root),progress:patch=>this.setState(patch)});selectedFile=artifact.file;selectedRelease=artifact.release;downloaded=true;this.setState({progress:100,message:'应用更新已拉取，正在验证并安排安装…',applicationPackageBytes:artifact.bytes});}catch{this.setState({message:'增量源暂不可用，回退完整更新包…',transport:'full',source:null});}}
    else this.setState({transport:'full',source:null});
    for(const prefix of downloaded?[]:this.config.downloadPrefixes){
      try{const response=await this.request(prefix+release.url,{signal:AbortSignal.timeout(180000),headers:{'User-Agent':'CellStation/'+this.version}});if(!response.ok||!response.body)throw new Error('下载失败');let count=0;const hash=crypto.createHash('sha256');
        const source=Readable.fromWeb(response.body);source.on('data',chunk=>{count+=chunk.length;if(count>release.size){source.destroy(new Error('下载大小超限'));return;}hash.update(chunk);this.setState({progress:Math.floor(count/release.size*100)});});
        await pipeline(source,fs.createWriteStream(partial,{flags:'w'}));if(count!==release.size||hash.digest('hex')!==release.sha256)throw new Error('下载校验失败');fs.renameSync(partial,file);downloaded=true;break;
      }catch{if(fs.existsSync(partial))fs.unlinkSync(partial);}
    }
    if(!downloaded){this.setState({status:'failed',message:'下载或SHA256校验未通过，当前版本和数据保持可用'});return this.publicState();}
    if(!this.canInstall()){this.setState({status:'deferred',message:'下载完成，临近预约，等待空闲后安装'});if(this.preferences.auto){this.deferredTimer=setTimeout(()=>this.install().catch(()=>{}),30000);this.deferredTimer.unref?.();}return this.publicState();}
    this.setState({status:'installing',message:'更新包校验通过，正在安排重启…',progress:100});
    try{await this.onInstall(selectedFile,selectedRelease);}catch{this.setState({status:'failed',message:'更新未完成，当前版本仍可使用，请稍后重试'});}return this.publicState();
  }
  close(){clearTimeout(this.deferredTimer);}
}
module.exports={AppUpdater,CURRENT_VERSION,verifiedRelease,newer,canonical};
