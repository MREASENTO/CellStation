'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DateFollow}=require('./manager-ui/date-follow.js');
const time=s=>Date.parse(s+'+08:00');
test('all four date views follow Shanghai midnight, including a sleeping window',()=>{
 const f=new DateFollow(),ids=['plan-date','assignment-date','summary-date','exclusion-date'];
 for(const id of ids){assert.equal(f.next(id,'',time('2026-10-23T23:59:59.999')),'2026-10-30');assert.equal(f.next(id,'2026-10-30',time('2026-10-24T00:00:00')),'2026-10-31');assert.equal(f.next(id,'2026-10-31',time('2026-10-28T08:00:00')),'2026-11-04');}
});
test('calendar follows month/year/leap-day boundaries and backwards clock corrections',()=>{
 const f=new DateFollow();
 for(const [now,want] of [['2026-12-28T00:00:00','2027-01-04'],['2028-02-22T00:00:00','2028-02-29'],['2028-02-23T00:00:00','2028-03-01'],['2026-10-22T00:00:00','2026-10-29']])assert.equal(f.next('plan-date','2026-10-30',time(now)),want);
});
test('manual dates stay unrestricted and independent; returning to target resumes following',()=>{
 const f=new DateFollow(),now=time('2026-10-23T23:59:59');
 f.edit('plan-date','2025-01-01',now);f.edit('summary-date','2035-12-31',now);
 assert.equal(f.next('plan-date','2025-01-01',now+2000),'2025-01-01');
 assert.equal(f.next('summary-date','2035-12-31',now+2000),'2035-12-31');
 assert.equal(f.next('assignment-date','2026-10-30',now+2000),'2026-10-31');
 f.resume('plan-date');assert.equal(f.next('plan-date','2025-01-01',now+2000),'2026-10-31');
 f.edit('summary-date','2026-10-31',now+2000);assert.ok(f.follows('summary-date'));
});
test('date editing is not interrupted by midnight; clearing is preserved until resume',()=>{
 const f=new DateFollow(),now=time('2026-10-24T00:00:00');
 assert.equal(f.next('plan-date','2026-10-30',now,true),'2026-10-30');
 assert.equal(f.next('plan-date','2026-10-30',now,false),'2026-10-31');
 f.edit('plan-date','',now);assert.equal(f.next('plan-date','',now),'');f.resume('plan-date');assert.equal(f.next('plan-date','',now),'2026-10-31');
});
