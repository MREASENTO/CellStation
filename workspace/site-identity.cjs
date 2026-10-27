'use strict';
const { normalizedEnd } = require('./booking-logic.cjs');
function ownerIds(content) {
  return [...new Set([...String(content||'').matchAll(/profile\/index[.](\d+)(?!\d)/g)].map(m=>m[1]))];
}
function oneOwner(content) { const ids=ownerIds(content);return ids.length===1?ids[0]:null; }
function knownIdentities(store) {
  return store.data.accounts.flatMap(account=>{
    const row=store.data.siteIdentities?.[account.id];
    return row&&row.username===account.username&&row.revision===account.revision&&/^\d+$/.test(row.profileId)?[{accountId:account.id,profileId:row.profileId,owner:account.owner||account.username}]:[];
  });
}
function recordIdentity(store,accountId,profileId,expected) {
  const account=store.data.accounts.find(a=>a.id===accountId);
  if(!account||typeof profileId!=='string'||!/^\d+$/.test(profileId))throw new Error('账号身份无法确认');
  if(expected&&(account.username!==expected.username||account.revision!==expected.revision))return false;
  store.data.siteIdentities ||= {};
  const previous=store.data.siteIdentities[accountId];
  if(previous?.profileId===profileId&&previous.username===account.username&&previous.revision===account.revision)return true;
  store.data.siteIdentities[accountId]={username:account.username,revision:account.revision,profileId};store.persist();
  return true;
}
function ownerName(content) {
  const match=String(content||'').match(/<a\b[^>]*href\s*=\s*["'][^"']*profile\/index[.]\d+[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  return match?match[1].replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').trim().slice(0,100):'';
}
function validateTeam(members) {
  if(!Array.isArray(members)||members.length>1000)throw new Error('团队人员列表无效');
  const ids=new Set(),profiles=new Set(),names=new Set();
  return members.map(m=>{
    if(!m||typeof m!=='object'||typeof m.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(m.id)||ids.has(m.id)||typeof m.name!=='string'||!m.name.trim()||m.name.trim().length>100||/[\x00-\x1f]/.test(m.name))throw new Error('团队人员信息无效');
    const name=m.name.trim(),profileId=String(m.profileId||'').trim();
    if(profileId&&!/^\d{1,30}$/.test(profileId))throw new Error('网站身份编号应为数字');
    if(names.has(name)||profileId&&profiles.has(profileId))throw new Error('团队人员姓名或网站身份编号重复');
    ids.add(m.id);names.add(name);if(profileId)profiles.add(profileId);return{id:m.id,name,profileId};
  });
}
function teamMatch(content,members) {
  const profileId=oneOwner(content);if(!profileId)return null;
  const byId=(members||[]).find(m=>m.profileId===profileId);if(byId)return byId;
  const name=ownerName(content);return name?(members||[]).find(m=>!m.profileId&&m.name===name)||null:null;
}
function coveringOurs(components,plan,profileIds,members=[]) {
  const ids=new Set(profileIds.map(String)), intervals=components.filter(c=>(ids.has(oneOwner(c.content))||teamMatch(c.content,members))&&Number.isFinite(Number(c.dtStart))&&Number.isFinite(normalizedEnd(c)))
    .map(c=>({start:Number(c.dtStart),end:normalizedEnd(c),component:c})).filter(c=>c.end>plan.start&&c.start<plan.end).sort((a,b)=>a.start-b.start||b.end-a.end);
  let cursor=plan.start,first=null;
  for(const item of intervals){if(item.start>cursor)break;if(item.end>cursor){first ||= item.component;cursor=item.end;if(cursor>=plan.end)return first;}}
  return null;
}
module.exports={ownerIds,oneOwner,ownerName,validateTeam,teamMatch,knownIdentities,recordIdentity,coveringOurs};
