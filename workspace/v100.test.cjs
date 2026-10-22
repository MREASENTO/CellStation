'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const{ManagerStore}=require('./manager-store.cjs'),{Scheduler}=require('./scheduler.cjs'),{Operations}=require('./operations.cjs'),{WechatNotifications}=require('./wechat-notifications.cjs'),{AppUpdater,verifiedRelease,canonical,newer}=require('./app-updater.cjs');
const base=path.resolve(__dirname,'../work/tests');fs.mkdirSync(base,{recursive:true});
const dir=()=>fs.mkdtempSync(path.join(base,'v100-')),vault={protect:async s=>'encrypted:'+s,unprotect:async s=>s.slice(10)};
async function fixture(){const root=dir(),store=new ManagerStore(root,vault);await store.saveAccount({username:'mock-account',owner:'模拟使用人',password:'not-real'});return{root,store};}
test('multiple devices have independent task ids and summary results; a successful first device never masks a second',async()=>{
  const{root,store}=await fixture();store.setEquipments([{equipmentId:51,equipmentName:'模拟设备A'},{equipmentId:52,equipmentName:'模拟设备B'}]);
  const now=Date.parse('2026-10-22T07:00:00+08:00'),sc=new Scheduler(store,{},()=>now),plan=sc.plan(1);assert.equal(plan.length,8);assert.equal(new Set(plan.map(j=>j.id)).size,8);
  store.job(plan[0],{...plan[0],status:'success',reservationId:'mock'});const op=new Operations({root,store,worker:{},clock:()=>now});const summary=op.summary('2026-10-29');
  assert.equal(summary.success,1);assert.equal(summary.pending,7);assert.equal(summary.rows.find(j=>j.equipment.equipmentId===52&&j.start===plan[0].start).status,'planned');
});
test('prepares every selected device before release and commits all in priority order without sharing sessions',async()=>{
  const{store}=await fixture();store.setEquipments([{equipmentId:52,equipmentName:'优先设备'},{equipmentId:51,equipmentName:'第二设备'}]);
  let now=Date.parse('2026-10-22T08:58:30+08:00'),prepared=[],saved=[],released=[];
  const sc=new Scheduler(store,{prepare:async j=>{prepared.push(j.id);return{};},commit:async(j,before)=>{before();saved.push(j.equipment.equipmentId);return{status:'created'};},releaseSession:async(a,id)=>released.push(id)},()=>now);
  store.setEnabled(true,now);for(let i=0;i<3;i++){await sc.tick();await sc.idle();}assert.equal(prepared.length,2);assert.equal(sc.prepared.size,2);
  now=Date.parse('2026-10-22T09:00:00+08:00');for(let i=0;i<4;i++){await sc.tick();await sc.idle();}
  assert.deepEqual(saved,[52,51]);assert.equal(new Set(released).size,2);await sc.tick();await sc.idle();assert.equal(saved.length,2);
});
test('one failed device does not cancel the next device; disabling a device stops its future plan',async()=>{
  const{store}=await fixture();const list=[{equipmentId:51,equipmentName:'设备A'},{equipmentId:52,equipmentName:'设备B'}];store.setEquipments(list);
  let now=Date.parse('2026-10-22T08:58:30+08:00'),saved=[];
  const sc=new Scheduler(store,{prepare:async j=>{if(j.equipment.equipmentId===51)throw new Error('设备占用');return{};},commit:async(j,before)=>{before();saved.push(j.equipment.equipmentId);return{status:'created'};},releaseSession:async()=>{}},()=>now);store.setEnabled(true,now);
  for(let i=0;i<3;i++){await sc.tick();await sc.idle();}now=Date.parse('2026-10-22T09:00:00+08:00');for(let i=0;i<3;i++){await sc.tick();await sc.idle();}assert.deepEqual(saved,[52]);
  store.setEquipments(list.map(e=>({...e,enabled:e.equipmentId===52})));assert.ok(sc.plan(1).every(j=>j.equipment.equipmentId===52));
});
test('multi-device list and order round-trip through configuration backup while legacy backups remain readable',async()=>{
  const{root,store}=await fixture();store.setEquipments([{equipmentId:52,equipmentName:'第二设备',enabled:false},{equipmentId:51,equipmentName:'第一设备'}]);const op=new Operations({root,store,worker:{}}),backup=JSON.parse(fs.readFileSync(op.backup().file));
  const preview=await op.previewRestore(backup);op.restore(preview.token);assert.deepEqual(store.data.config.equipments.map(e=>[e.equipmentId,e.enabled]),[[52,false],[51,true]]);
  delete backup.equipments;const old=await op.previewRestore(backup);op.restore(old.token);assert.equal(store.data.config.equipments.length,1);
});
test('WeChat keys stay encrypted and out of public state, success/failure are background deduplicated messages',async()=>{
  const calls=[],n=new WechatNotifications(dir(),vault,async(url,options)=>{calls.push({url,body:options.body});return new Response('{"code":0}');});
  const secret='SCT_mock-key-for-local-test';await n.update({provider:'serverchan',key:secret,enabled:true,success:true,failure:true});assert.ok(!JSON.stringify(n.publicState()).includes(secret));assert.ok(JSON.parse(fs.readFileSync(n.file)).keyCipher.startsWith('encrypted:'));
  const job={id:'mock',status:'success',date:'2026-10-29',start:'08:30',end:'09:00',equipment:{equipmentName:'模拟设备'},accountOwner:'模拟人',message:'网站确认成功'};
  n.enqueue(job);n.enqueue(job);await n.idle();assert.equal(calls.length,1);n.enqueue({...job,id:'mock-2',status:'needs_review',message:'请核对'});await n.idle();assert.equal(calls.length,2);
  const reloaded=new WechatNotifications(path.dirname(n.file),vault,async()=>{throw new Error('must not resend');});reloaded.enqueue(job);await reloaded.idle();assert.equal(reloaded.error,'');
});
test('push notification errors do not affect booking state and switching provider requires a new key',async()=>{
  const n=new WechatNotifications(dir(),vault,async()=>{throw new Error('network');});await n.update({provider:'pushplus',key:'mock-pushplus-token',enabled:true});n.enqueue({id:'one',status:'failed'});await n.idle();assert.match(n.publicState().error,/微信推送失败/);
  await assert.rejects(n.update({provider:'serverchan',enabled:true}),/密钥/);await n.update({provider:'serverchan',enabled:false});assert.equal(n.publicState().hasKey,false);
});
function updateFixture(payload=Buffer.from('mock-update')){
  const pair=crypto.generateKeyPairSync('ed25519');const publicKey=pair.publicKey.export({type:'spki',format:'pem'});
  const release={version:'1.0.1',url:'https://github.com/MREASENTO/CellStation/releases/download/v1.0.1/CellStation-v1.0.1-win64.zip',sha256:crypto.createHash('sha256').update(payload).digest('hex'),size:payload.length};
  return{config:{publicKey,feeds:['https://mirror.test/latest.json','https://origin.test/latest.json'],downloadPrefixes:['']},document:{release,signature:crypto.sign(null,Buffer.from(canonical(release)),pair.privateKey).toString('base64')},payload};
}
test('signed release manifests reject tampering, wrong repositories, traversal-like versions, and semantic downgrades',()=>{
  const f=updateFixture();assert.equal(verifiedRelease(f.document,f.config).version,'1.0.1');const bad=structuredClone(f.document);bad.release.sha256='a'.repeat(64);assert.throws(()=>verifiedRelease(bad,f.config),/签名/);
  bad.release.url='https://evil.test/update.zip';assert.throws(()=>verifiedRelease(bad,f.config),/格式/);assert.equal(newer('1.0.10','1.0.2'),true);assert.equal(newer('1.0.0','1.0.1'),false);assert.equal(newer('../1.0.2','1.0.1'),false);
});
test('update checks fall back, defer during reservations and install only a size/hash verified package',async()=>{
  const f=updateFixture();let safe=false,installed=0,requests=[];
  const u=new AppUpdater({version:'1.0.0',dataRoot:dir(),config:f.config,canInstall:()=>safe,onInstall:async()=>installed++,request:async url=>{requests.push(url);if(url.includes('mirror.test'))throw new Error('offline');return url.endsWith('.zip')?new Response(f.payload):new Response(JSON.stringify(f.document));}});
  await u.check();assert.equal(u.publicState().status,'available');await u.install();assert.equal(u.publicState().status,'deferred');assert.equal(installed,0);u.settings({auto:false,mirrors:[]});safe=true;await u.install();assert.equal(installed,1);assert.equal(requests.length,3);u.close();
});
test('corrupted update downloads and invalid signatures never launch the installer',async()=>{
  const f=updateFixture();let installed=0;const u=new AppUpdater({version:'1.0.0',dataRoot:dir(),config:f.config,onInstall:async()=>installed++,request:async url=>url.endsWith('.zip')?new Response('corrupt'):new Response(JSON.stringify(f.document))});await u.check();await u.install();assert.equal(installed,0);assert.equal(u.publicState().status,'failed');u.close();
});

