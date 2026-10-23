// Seasonal events and quiet hours (same rules as the macOS app; see docs/v1.5-features.md).

/** Events with limited-time rewards, earned by 60 minutes together while the event is on. */
const EVENTS = [
  { id: 'halloween', title: '🎃 Halloween', emoji: '🎃', from: '10-24', to: '11-01', rewards: ['witchHat', 'pumpkin'] },
  { id: 'winter', title: '❄️ Winter holidays', emoji: '❄️', from: '12-15', to: '01-01', rewards: ['santaHat', 'snowman'] },
  { id: 'valentine', title: '💗 Valentine', emoji: '💗', from: '02-07', to: '02-14', rewards: ['heartAura'] },
];
const EVENT_GOAL = 60;

const pad = (n) => String(n).padStart(2, '0');
const monthDay = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The event on `date` and the year it started in (winter runs over New Year), or null. */
function activeEvent(date = new Date()) {
  const md = monthDay(date);
  for (const e of EVENTS) {
    const wraps = e.from > e.to;
    const on = wraps ? md >= e.from || md <= e.to : md >= e.from && md <= e.to;
    if (!on) continue;
    const year = wraps && md <= e.to ? date.getFullYear() - 1 : date.getFullYear();
    return { ...e, year, key: `${e.id}.${year}` };
  }
  return null;
}

/** The next event to start after `date`. */
function nextEvent(date = new Date()) {
  const md = monthDay(date);
  const sorted = [...EVENTS].sort((a, b) => (a.from < b.from ? -1 : 1));
  return sorted.find((e) => e.from > md) || sorted[0];
}

const minutesOf = (hhmm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : fallback;
};

const QUIET_DEFAULTS = { enabled: false, days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', notifications: true };

function quietSettings(raw) {
  const q = { ...QUIET_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  q.enabled = !!q.enabled;
  q.days = Array.isArray(q.days) ? q.days.map(Number).filter((d) => d >= 0 && d <= 6) : QUIET_DEFAULTS.days;
  q.from = /^\d{1,2}:\d{2}$/.test(q.from) ? q.from : QUIET_DEFAULTS.from;
  q.to = /^\d{1,2}:\d{2}$/.test(q.to) ? q.to : QUIET_DEFAULTS.to;
  q.notifications = q.notifications !== false;
  return q;
}

/** Whether quiet hours are on at `date`. `from > to` crosses midnight (the days are when it starts). */
function quietHoursActive(raw, date = new Date()) {
  const q = quietSettings(raw);
  if (!q.enabled) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const from = minutesOf(q.from, 540), to = minutesOf(q.to, 1020);
  const today = date.getDay(), yesterday = (today + 6) % 7;
  if (from === to) return q.days.includes(today);
  if (from < to) return q.days.includes(today) && now >= from && now < to;
  return (q.days.includes(today) && now >= from) || (q.days.includes(yesterday) && now < to);
}

module.exports = { EVENTS, EVENT_GOAL, activeEvent, nextEvent, monthDay, quietSettings, quietHoursActive };
