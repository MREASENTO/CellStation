'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process');
const defaults={enabled:true,compressAfterDays:7,deleteAfterDays:30};
function validateRetention(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(defaults,k))||typeof input.enabled!=='boolean'||!Number.isInteger(input.compressAfterDays)||!Number.isInteger(input.deleteAfterDays)||input.compressAfterDays<1||input.deleteAfterDays<=input.compressAfterDays||input.deleteAfterDays>3650)throw new Error('保留天数无效：压缩至少1天，清理天数需大于压缩天数且不超过3650天');
  return {...input};
}
const python=()=>process.env.CELLSTATION_PYTHON||path.join(__dirname,'.venv/Scripts/python.exe');
function archivedPath(root,relative){return path.join(root,'archives',relative+'.zip');}
function screenshotAvailable(root,directory){const relative=path.relative(root,path.join(directory,'screenshot.png'));return fs.existsSync(path.join(directory,'screenshot.png'))||fs.existsSync(archivedPath(root,relative));}
async function readScreenshot(root,directory){
  const file=path.join(directory,'screenshot.png');if(fs.existsSync(file))return fs.readFileSync(file);
  return new Promise((resolve,reject)=>execFile(python(),['-B',path.join(__dirname,'retention_files.py'),'read',root,path.relative(root,file)],{windowsHide:true,encoding:'buffer',timeout:15000,maxBuffer:20000000},(error,stdout)=>error?reject(new Error('压缩截图读取失败或已按保留规则清理')):resolve(stdout)));
}
class Retention{
  constructor(root,clock=Date.now){this.root=root;this.clock=clock;this.child=null;this.running=null;}
  run(policy){
    validateRetention(policy);if(this.running)return this.running;
    if(!policy.enabled)return Promise.resolve({disabled:true});
    this.running=new Promise((resolve,reject)=>{
      const child=execFile(python(),['-B',path.join(__dirname,'retention_files.py'),'maintain',this.root,JSON.stringify(policy),String(this.clock()/1000),'20'],{windowsHide:true,timeout:120000,maxBuffer:1000000},(error,stdout)=>{this.child=null;if(error)return reject(new Error('截图与日志维护未完成：'+error.message.split('\n')[0]));try{resolve(JSON.parse(stdout));}catch{reject(new Error('文件维护结果格式无效'));}});
      this.child=child;try{os.setPriority(child.pid,os.constants.priority.PRIORITY_LOW);}catch{}
    }).finally(()=>{this.running=null;});return this.running;
  }
  stop(){this.child?.kill();}
}
module.exports={Retention,defaults,validateRetention,screenshotAvailable,readScreenshot};
