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
function coveringOurs(components,plan,profileIds) {
  const ids=new Set(profileIds.map(String)), intervals=components.filter(c=>ids.has(oneOwner(c.content))&&Number.isFinite(Number(c.dtStart))&&Number.isFinite(normalizedEnd(c)))
    .map(c=>({start:Number(c.dtStart),end:normalizedEnd(c),component:c})).filter(c=>c.end>plan.start&&c.start<plan.end).sort((a,b)=>a.start-b.start||b.end-a.end);
  let cursor=plan.start,first=null;
  for(const item of intervals){if(item.start>cursor)break;if(item.end>cursor){first ||= item.component;cursor=item.end;if(cursor>=plan.end)return first;}}
  return null;
}
module.exports={ownerIds,oneOwner,knownIdentities,recordIdentity,coveringOurs};
