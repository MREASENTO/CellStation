'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const execFile=require('node:util').promisify(require('node:child_process').execFile);
const {AppUpdater,CURRENT_VERSION}=require('./app-updater.cjs');
class DesktopUpdates extends AppUpdater{
  constructor({app,dataRoot,getManager,quit,progress,isBackground=()=>false}){
    super({dataRoot,installRoot:path.dirname(process.execPath),config:require('./release-config.json'),progress,canInstall:()=>{
      const manager=getManager();if(!manager||manager.scheduler.busy.size||manager.scheduler.prepared.size||manager.operations.checkPromise||manager.reviews?.active||manager.siteAppointments?.active)return false;
      return !manager.store.data.config.enabled||!manager.scheduler.plan(1).some(j=>j.releaseAt>=Date.now()-60000&&j.releaseAt<=Date.now()+240000);
    },onInstall:async(file,release)=>{
      if(!app.isPackaged)throw new Error('开发环境不执行程序替换');
      const install=path.dirname(process.execPath);
      if(path.resolve(dataRoot)!==path.join(install,'data'))throw new Error('自定义数据位置请手动更新');
      const nonce=crypto.randomUUID(),transaction=path.join(dataRoot,'updates','tx-'+nonce),runner=path.join(transaction,'runner');fs.mkdirSync(runner,{recursive:true});
      const pythonRoot=path.dirname(process.env.CELLSTATION_PYTHON);
      for(const entry of fs.readdirSync(pythonRoot,{withFileTypes:true}))if(entry.isFile())fs.copyFileSync(path.join(pythonRoot,entry.name),path.join(runner,entry.name));
      fs.writeFileSync(path.join(runner,'python313._pth'),'python313.zip\n.\n');
      fs.copyFileSync(path.join(__dirname,'update-helper.py'),path.join(runner,'update-helper.py'));
      await execFile(path.join(runner,'python.exe'),['-B',path.join(runner,'update-helper.py'),...(release.kind==='app'?['--validate-app',file,release.version,release.gitRuntimeId,release.gitManifestSha256,install]:['--validate',file,release.version])],{windowsHide:true,timeout:60000});
      const manager=getManager();fs.writeFileSync(path.join(dataRoot,'updates/resume.json'),JSON.stringify({enabled:manager.store.data.config.enabled}));
      const config=path.join(transaction,'transaction.json');fs.writeFileSync(config,JSON.stringify({install,data:dataRoot,archive:file,sha256:release.sha256,version:release.version,nonce,pid:process.pid,background:isBackground(),kind:release.kind||'full',runtimeId:release.gitRuntimeId,manifestSha256:release.gitManifestSha256}));
      const child=spawn(path.join(runner,'python.exe'),['-B',path.join(runner,'update-helper.py'),config],{detached:true,windowsHide:true,stdio:'ignore'});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();await quit();
    }});
    this.dataRoot=dataRoot;
  }
  markHealthy(){const nonce=process.env.CELLSTATION_UPDATE_NONCE;if(nonce&&/^[0-9a-f-]{36}$/.test(nonce))fs.writeFileSync(path.join(this.root,'health.json'),JSON.stringify({nonce,version:CURRENT_VERSION}));}
  consumeResume(){const file=path.join(this.root,'resume.json');if(!fs.existsSync(file))return false;const data=JSON.parse(fs.readFileSync(file));fs.unlinkSync(file);return data.enabled===true;}
}
module.exports={DesktopUpdates};
