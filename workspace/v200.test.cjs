'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DesktopIntegration}=require('./desktop-integration.cjs');
const base=path.resolve(__dirname,'../work/tests');fs.mkdirSync(base,{recursive:true});
function fixture(initial=null,settings={}){
 const root=fs.mkdtempSync(path.join(base,'v200-startup-'));fs.writeFileSync(path.join(root,'desktop-settings.json'),JSON.stringify(settings));
 let entry=initial?structuredClone(initial):null,writes=0,failure=false;
 const native={getLoginItemSettings:({path,args})=>{const matched=entry?.path===path;return {launchItems:matched?[{name:entry.name,scope:entry.scope||'user',enabled:entry.enabled,path:entry.path,args:[]}]:[],openAtLogin:matched&&entry.name==='CellStation'&&JSON.stringify(entry.args)===JSON.stringify(args),executableWillLaunchAtLogin:matched&&entry.enabled};},setLoginItemSettings:s=>{writes++;if(!failure)entry=s.openAtLogin?{...s,enabled:s.enabled}:null;}};
 const opts={app:native,dataRoot:root,executablePath:'F:\\CellStation\\CellStation.exe',show:()=>{},quit:()=>{},sendNotification:()=>{}};
 return {open:()=>new DesktopIntegration(opts),file:path.join(root,'desktop-settings.json'),get entry(){return entry;},get writes(){return writes;},remove:()=>entry=null,block:()=>entry.enabled=false,fail:()=>failure=true,recover:()=>failure=false};
}
const entry={name:'CellStation',path:'F:\\CellStation\\CellStation.exe',args:['--autostart'],enabled:true};
test('v200 fresh launch stays off; enable persists and missing startup item is repaired on reopen',()=>{
 const f=fixture(),a=f.open();assert.equal(f.writes,0);assert.equal(a.status().autoStart,false);
 a.update({autoStart:true});assert.equal(a.status().startupState,'enabled');assert.equal(JSON.parse(fs.readFileSync(f.file)).autoStartEnabled,true);
 f.remove();assert.equal(a.status().startupState,'missing');const b=f.open();assert.equal(b.status().autoStart,true);assert.equal(b.status().startupRepaired,true);assert.deepEqual(f.entry.args,['--autostart']);
 b.update({autoStart:false});const n=f.writes;assert.equal(f.open().status().startupState,'off');assert.equal(f.writes,n);
});
test('v200 legacy enabled or blocked Windows registrations migrate without overwriting Windows choice',()=>{
 const f=fixture(entry),a=f.open();assert.equal(a.status().autoStartEnabled,true);assert.equal(f.writes,0);
 f.block();const b=f.open();assert.equal(b.status().startupBlocked,true);assert.equal(b.status().startupState,'blocked');assert.equal(f.writes,0);
 b.update({autoStart:true});assert.equal(b.status().startupState,'enabled');
});
test('v200 program relocation updates saved path, while disabled old-path entry needs explicit repair',()=>{
 for(const enabled of [true,false]){
  const old='D:\\old path\\CellStation.exe',f=fixture({...entry,path:old,enabled},{autoStartEnabled:true,startupExecutable:old}),a=f.open();
  assert.equal(f.writes,enabled?1:0);assert.equal(a.status().startupState,enabled?'enabled':'blocked');
  a.update({autoStart:true});assert.equal(f.entry.path,'F:\\CellStation\\CellStation.exe');assert.equal(a.status().autoStart,true);
 }
});
test('v200 mismatched arguments never report a working startup and repair restores hidden launch',()=>{
 const f=fixture({...entry,args:['--other']},{autoStartEnabled:false}),a=f.open();assert.equal(a.status().autoStart,false);assert.equal(a.status().startupState,'mismatch');
 a.update({autoStart:true});assert.equal(a.status().autoStart,true);assert.deepEqual(f.entry.args,['--autostart']);
});
test('v200 another application or machine entry does not count as this user startup registration',()=>{
 for(const alien of [{name:'Other'},{scope:'machine'}]){const f=fixture({...entry,...alien}),a=f.open();assert.equal(a.status().autoStart,false);assert.equal(a.status().autoStartEnabled,false);assert.equal(f.writes,0);}
});
test('v200 failed registration keeps intent and reports error; explicit repair or restart retries',()=>{
 const f=fixture(),a=f.open();f.fail();assert.throws(()=>a.update({autoStart:true}),/未通过校验/);assert.equal(a.status().startupState,'error');assert.equal(a.status().autoStartEnabled,true);
 f.recover();const b=f.open();assert.equal(b.status().autoStart,true);assert.equal(b.status().startupRepaired,true);
});
test('v200 startup and booking activation are independent',()=>{
 const f=fixture(),a=f.open();a.update({startBookingOnLaunch:true});assert.equal(f.writes,0);assert.equal(a.shouldResume(false),true);a.update({autoStart:true});a.update({startBookingOnLaunch:false});assert.equal(a.status().autoStart,true);assert.equal(a.shouldResume(false),false);
});
