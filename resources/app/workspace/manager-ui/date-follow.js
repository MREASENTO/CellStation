'use strict';
// Manager dates refer to equipment use, seven days after today in Shanghai.
class DateFollow {
  constructor(daysAhead = 7) { this.manual = new Set(); this.daysAhead=daysAhead; }
  target(now) { return new Date(now + 8 * 3600000 + this.daysAhead * 86400000).toISOString().slice(0, 10); }
  edit(id, value, now) {
    if (value === this.target(now)) this.manual.delete(id);
    else this.manual.add(id);
  }
  resume(id) { this.manual.delete(id); }
  follows(id) { return !this.manual.has(id); }
  next(id, value, now, editing = false) {
    if (editing || !this.follows(id)) return value;
    return this.target(now);
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { DateFollow };
else window.DateFollow = DateFollow;
