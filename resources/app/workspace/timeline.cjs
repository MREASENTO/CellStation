'use strict';
const { performance } = require('node:perf_hooks');
function recorder(store, job, clock = Date.now) {
  const origin = performance.now();
  return (step, detail = '') => {
    const at = clock();
    const record = store.data.jobs[job.id];
    const timeline = [...(record?.timeline || []), { step, at, time: new Date(at).toISOString(), elapsedMs: Math.round((performance.now() - origin) * 1000) / 1000, detail: String(detail).slice(0, 200) }];
    store.job(job, { timeline: timeline.slice(-300) });
    return at;
  };
}
module.exports = { recorder };
