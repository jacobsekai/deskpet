// Calendar heads-up: upcoming meetings from an ICS URL (anywhere) or classic Outlook (Windows).
// Meeting details stay on this computer; they're only used for the pet's reminders.
const { execFile } = require('child_process');

// MARK: ICS parsing

/** Common Windows time zone names (Outlook/Exchange feeds) → IANA. */
const WINDOWS_ZONES = {
  'Pacific Standard Time': 'America/Los_Angeles', 'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago', 'Eastern Standard Time': 'America/New_York', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'Canada Central Standard Time': 'America/Regina',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev', 'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow', 'Israel Standard Time': 'Asia/Jerusalem', 'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane', 'W. Australia Standard Time': 'Australia/Perth', 'New Zealand Standard Time': 'Pacific/Auckland',
  'SA Pacific Standard Time': 'America/Bogota', 'E. South America Standard Time': 'America/Sao_Paulo', 'Pacific SA Standard Time': 'America/Santiago',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires', 'South Africa Standard Time': 'Africa/Johannesburg', 'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
};

function zoneName(tzid) {
  if (!tzid) return null;
  const name = String(tzid).replace(/^"|"$/g, '').replace(/^\/+/, '');
  const iana = WINDOWS_ZONES[name] || name;
  try { new Intl.DateTimeFormat('en-US', { timeZone: iana }); return iana; } catch (_) { return null; }
}

/** Offset of `zone` from UTC at instant `ts`, in ms. */
function zoneOffset(ts, zone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts))) parts[p.type] = p.value;
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - Math.floor(ts / 1000) * 1000;
}

/** Wall-clock components (as a UTC-based number) in a zone → the real instant. */
function wallToInstant(wall, zone) {
  if (zone === 'Z') return wall;
  if (!zone) {
    const d = new Date(wall);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime();
  }
  let t = wall - zoneOffset(wall, zone);
  t = wall - zoneOffset(t, zone); // second pass gets daylight-saving transitions right
  return t;
}

/** "20261023T090000Z" / "20261023T090000" / "20261023" → { wall, zone, allDay }. */
function parseTime(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const allDay = !m[4] || (params && params.VALUE === 'DATE');
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const zone = m[7] ? 'Z' : zoneName(params && params.TZID);
  return { wall, zone, allDay };
}

const unescape = (s) => String(s).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/** VEVENTs from ICS text: { uid, summary, location, url, description, status, start, end, rrule, exdates, recurrenceId }. */
function parseICS(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (ev && ev.start) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...rawParams] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    const params = {};
    for (const p of rawParams) { const i = p.indexOf('='); if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1); }
    switch (name.toUpperCase()) {
      case 'UID': ev.uid = value; break;
      case 'SUMMARY': ev.summary = unescape(value); break;
      case 'LOCATION': ev.location = unescape(value); break;
      case 'URL': ev.url = value; break;
      case 'DESCRIPTION': ev.description = unescape(value); break;
      case 'STATUS': ev.status = value.toUpperCase(); break;
      case 'DTSTART': ev.start = parseTime(value, params); break;
      case 'DTEND': ev.end = parseTime(value, params); break;
      case 'RRULE': ev.rrule = Object.fromEntries(value.split(';').map((kv) => kv.split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k.toUpperCase(), v])); break;
      case 'EXDATE': for (const v of value.split(',')) { const t = parseTime(v, params); if (t) ev.exdates.push(t); } break;
      case 'RECURRENCE-ID': ev.recurrenceId = parseTime(value, params); break;
      default: break;
    }
  }
  return events;
}

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY = 86400000;

/** Wall-clock start times of an event's occurrences (RRULE DAILY/WEEKLY with INTERVAL, BYDAY, UNTIL, COUNT). */
function occurrenceWalls(ev, untilWall) {
  const start = ev.start.wall;
  const r = ev.rrule;
  if (!r) return [start];
  const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  let until = untilWall;
  if (r.UNTIL) {
    const u = parseTime(r.UNTIL, {});
    // UNTIL in UTC compares against instants; convert to the event's wall clock (close enough for a day boundary).
    if (u) until = Math.min(until, u.zone === 'Z' && ev.start.zone && ev.start.zone !== 'Z' ? u.wall + zoneOffset(u.wall, ev.start.zone) : u.wall);
  }
  const out = [];
  const timeOfDay = start % DAY;
  if (r.FREQ === 'DAILY') {
    for (let t = start, n = 0; t <= until && n < count; t += interval * DAY, n++) out.push(t);
  } else if (r.FREQ === 'WEEKLY') {
    const startDay = new Date(start).getUTCDay();
    const byDay = (r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS[d.slice(-2).toUpperCase()]).filter((d) => d !== undefined) : [startDay]).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    // Weeks start on Monday (WKST default).
    const weekStart = start - timeOfDay - ((startDay + 6) % 7) * DAY;
    let n = 0;
    for (let w = weekStart; w <= until && n < count; w += interval * 7 * DAY) {
      for (const d of byDay) {
        const t = w + ((d + 6) % 7) * DAY + timeOfDay;
        if (t < start) continue;
        if (t > until || n >= count) break;
        out.push(t);
        n++;
      }
    }
  } else {
    out.push(start); // other frequencies: just the first occurrence
  }
  return out;
}

/** Meeting link (Chime, Zoom, Meet, Teams, Webex) in any of the texts. */
function meetingLink(...texts) {
  const re = /https:\/\/[^\s<>"']*(chime\.aws|zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)[^\s<>"')]*/i;
  for (const t of texts) { const m = re.exec(String(t || '')); if (m) return m[0]; }
  return null;
}

/** Occurrences overlapping [from, to] (ms), sorted: { title, start, end, link }. All-day and cancelled events are skipped. */
function expand(events, from, to) {
  const overridden = new Map();
  for (const ev of events) {
    if (ev.recurrenceId && ev.uid) {
      if (!overridden.has(ev.uid)) overridden.set(ev.uid, new Set());
      overridden.get(ev.uid).add(wallToInstant(ev.recurrenceId.wall, ev.recurrenceId.zone));
    }
  }
  const out = [];
  for (const ev of events) {
    if (!ev.start || ev.start.allDay || ev.status === 'CANCELLED') continue;
    const zone = ev.start.zone;
    const duration = ev.end && !ev.end.allDay ? wallToInstant(ev.end.wall, ev.end.zone) - wallToInstant(ev.start.wall, zone) : 30 * 60000;
    const exdates = new Set(ev.exdates.map((x) => wallToInstant(x.wall, x.zone || zone)));
    const skip = (!ev.recurrenceId && overridden.get(ev.uid)) || new Set();
    // Generate in wall-clock time a little past the window, then convert (keeps meetings at the same local time across DST).
    for (const wall of occurrenceWalls(ev, to + 2 * DAY)) {
      const start = wallToInstant(wall, zone);
      if (start > to) break;
      if (start + duration < from || exdates.has(start) || skip.has(start)) continue;
      out.push({ title: ev.summary || 'Meeting', start, end: start + duration, link: meetingLink(ev.location, ev.url, ev.description) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

async function fetchICS(url, fetcher = fetch) {
  const u = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(u)) throw new Error('paste an https:// (or webcal://) calendar link');
  const res = await fetcher(u, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`the calendar link answered ${res.status}`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("that link isn't an iCalendar (.ics) feed");
  return text;
}

// MARK: Outlook (Windows, classic Outlook)

const OUTLOOK_SCRIPT = `
$ErrorActionPreference = 'Stop'
if (-not (Get-Process OUTLOOK -ErrorAction SilentlyContinue)) { '{"error":"Outlook isn''t running"}'; exit }
try {
  $ol = New-Object -ComObject Outlook.Application
  $items = $ol.GetNamespace('MAPI').GetDefaultFolder(9).Items
  $items.IncludeRecurrences = $true
  $items.Sort('[Start]')
  $from = (Get-Date).AddMinutes(-60); $to = (Get-Date).AddHours(6)
  $found = $items.Restrict("[Start] <= '" + $to.ToString('g') + "' AND [End] >= '" + $from.ToString('g') + "'")
  $out = @()
  foreach ($a in $found) {
    if ($a.AllDayEvent -or $a.ResponseStatus -eq 4 -or $a.MeetingStatus -eq 5 -or $a.MeetingStatus -eq 7) { continue }
    $body = [string]$a.Body; if ($body.Length -gt 3000) { $body = $body.Substring(0, 3000) }
    $out += [pscustomobject]@{ title = [string]$a.Subject; start = $a.Start.ToUniversalTime().ToString('o'); end = $a.End.ToUniversalTime().ToString('o'); location = [string]$a.Location; body = $body }
    if ($out.Count -ge 40) { break }
  }
  ConvertTo-Json -Compress -InputObject @{ events = $out }
} catch { ConvertTo-Json -Compress -InputObject @{ error = $_.Exception.Message } }
`;

function outlookEvents() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ error: 'Outlook is only read on Windows' });
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', OUTLOOK_SCRIPT],
      { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve({ error: "couldn't read Outlook" });
        try {
          const r = JSON.parse(String(stdout).trim() || '{}');
          if (r.error) return resolve({ error: r.error });
          const list = Array.isArray(r.events) ? r.events : r.events ? [r.events] : [];
          resolve({ events: list.map((e) => ({ title: e.title || 'Meeting', start: Date.parse(e.start), end: Date.parse(e.end), link: meetingLink(e.location, e.body) })) });
        } catch (_) { resolve({ error: "couldn't read Outlook" }); }
      });
  });
}

// MARK: Watcher

/** Keeps the next few hours of meetings, refreshing the ICS feed every 10 minutes and Outlook every 5. */
class CalendarWatcher {
  constructor({ fetcher } = {}) {
    this.fetcher = fetcher || fetch;
    this.events = [];
    this.status = 'off';
    this.lastFetch = 0;
    this.key = '';
    this.busy = false;
  }

  /** Call often; it only refetches when due. */
  async refresh(cfg, { force = false } = {}) {
    const source = cfg && cfg.source;
    const key = `${source}|${cfg && cfg.icsUrl}`;
    if (!source || source === 'off') { this.events = []; this.status = 'off'; this.key = key; return this; }
    if (key !== this.key) { this.key = key; this.lastFetch = 0; this.events = []; }
    const every = source === 'system' ? 5 * 60000 : 10 * 60000;
    if (this.busy || (!force && Date.now() - this.lastFetch < every)) return this;
    this.busy = true;
    this.lastFetch = Date.now();
    try {
      if (source === 'ics') {
        const text = await fetchICS(cfg.icsUrl, this.fetcher);
        this.events = expand(parseICS(text), Date.now() - 3600000, Date.now() + 12 * 3600000);
        this.status = 'ok';
      } else if (source === 'system') {
        const r = await outlookEvents();
        if (r.error) { this.status = r.error; this.events = []; } else { this.events = r.events; this.status = 'ok'; }
      }
    } catch (e) {
      this.status = e.message || 'error';
    } finally {
      this.busy = false;
    }
    return this;
  }

  next(now = Date.now()) {
    return this.events.find((e) => e.end > now && e.start > now - 10 * 60000) || null;
  }
}

module.exports = { parseICS, expand, meetingLink, fetchICS, outlookEvents, CalendarWatcher, zoneName, wallToInstant };
