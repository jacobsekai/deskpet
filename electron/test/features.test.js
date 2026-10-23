// 1.5 host features: agent summaries, ICS calendars, quiet hours, seasonal events, the gallery, and presence.
// Run: node test/features.test.js (uses a throwaway home folder).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-features-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { summarize, lastAssistantText } = require('../src/summary');
const { parseICS, expand, meetingLink, wallToInstant, CalendarWatcher } = require('../src/calendar');
const seasons = require('../src/seasons');
const gallery = require('../src/gallery');
const presence = require('../src/presence');
const { REWARDS } = require('../src/extras');

let checks = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { checks++; console.log(`ok - ${name}`); });

(async () => {
  await ok('summaries: first sentence, markdown stripped, 90 characters', () => {
    assert.strictEqual(summarize('**Fixed** the `login` test and pushed a branch. Then more.'), 'Fixed the login test and pushed a branch.');
    assert.strictEqual(summarize('## Summary\n- Updated [the README](README.md)\n- Added tests'), 'Updated the README.');
    assert.strictEqual(summarize("Here's what I did:\n1. Bumped the version"), "Here's what I did: Bumped the version");
    assert.strictEqual(summarize('```\nonly code\n```'), '');
    assert.strictEqual(summarize(''), '');
    const long = summarize(`${'word '.repeat(40)}end.`);
    assert(long.length <= 90 && long.endsWith('…'), long);
  });

  await ok('summaries: newest Claude reply (all its text blocks) and Codex agent message', () => {
    const claude = path.join(home, 'claude.jsonl');
    const rec = (o) => JSON.stringify(o);
    fs.writeFileSync(claude, [
      rec({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Old reply.' }] } }),
      rec({ type: 'user', message: { content: 'next' } }),
      rec({ type: 'assistant', message: { id: 'b', content: [{ type: 'text', text: 'Renamed the helper and updated the callers.' }] } }),
      rec({ type: 'assistant', message: { id: 'b', content: [{ type: 'tool_use', name: 'Edit' }] } }),
      rec({ type: 'assistant', message: { id: 'b', content: [{ type: 'text', text: 'All tests pass.' }] } }),
    ].join('\n'));
    assert.strictEqual(lastAssistantText(claude, false), 'Renamed the helper and updated the callers.\nAll tests pass.');
    assert.strictEqual(summarize(lastAssistantText(claude, false)), 'Renamed the helper and updated the callers.');
    const codex = path.join(home, 'codex.jsonl');
    fs.writeFileSync(codex, [
      rec({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Earlier.' }] } }),
      rec({ type: 'event_msg', payload: { type: 'agent_message', message: 'Added the **retry** logic. Tests pass.' } }),
      rec({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n'));
    assert.strictEqual(summarize(lastAssistantText(codex, true)), 'Added the retry logic.');
    assert.strictEqual(lastAssistantText(path.join(home, 'missing.jsonl'), false), '');
  });

  await ok('ICS: time zones (IANA and Windows names), UTC, floating, folding, escapes, links', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'UID:1', 'SUMMARY:Standup\\, team', 'DTSTART;TZID=America/Los_Angeles:20261023T090000', 'DTEND;TZID=America/Los_Angeles:20261023T091500',
      'LOCATION:https://chime.aws/1234567890', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:2', 'SUMMARY:Design review', 'DTSTART;TZID="Pacific Standard Time":20261023T130000', 'DTEND;TZID="Pacific Standard Time":20261023T140000',
      'DESCRIPTION:Join: https://zoom.us/j/123?pwd=x', ' continued', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:3', 'SUMMARY:UTC call', 'DTSTART:20261023T200000Z', 'DTEND:20261023T203000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:4', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261023', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:5', 'SUMMARY:Cancelled', 'STATUS:CANCELLED', 'DTSTART:20261023T210000Z', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const evs = parseICS(ics);
    assert.strictEqual(evs.length, 5);
    assert.strictEqual(evs[0].summary, 'Standup, team');
    const occ = expand(evs, Date.UTC(2026, 9, 23), Date.UTC(2026, 9, 24, 12));
    assert.deepStrictEqual(occ.map((o) => o.title), ['Standup, team', 'Design review', 'UTC call']);
    assert.strictEqual(occ[0].start, Date.UTC(2026, 9, 23, 16, 0)); // 9:00 PDT = 16:00 UTC
    assert.strictEqual(occ[0].end - occ[0].start, 15 * 60000);
    assert.strictEqual(occ[1].start, Date.UTC(2026, 9, 23, 20, 0)); // Windows zone name → PDT
    assert.strictEqual(occ[0].link, 'https://chime.aws/1234567890');
    assert.strictEqual(occ[1].link, 'https://zoom.us/j/123?pwd=xcontinued');
    assert.strictEqual(occ[2].start, Date.UTC(2026, 9, 23, 20, 0));
    assert.strictEqual(meetingLink('nothing here', 'http://zoom.us/insecure'), null);
  });

  await ok('ICS: weekly RRULE with BYDAY across daylight saving, EXDATE, overrides, COUNT/UNTIL, daily', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      // Mon/Wed/Fri 10:00 New York, starting Mon Oct 26 2026; DST ends Nov 1.
      'BEGIN:VEVENT', 'UID:w', 'SUMMARY:Sync', 'DTSTART;TZID=America/New_York:20261026T100000', 'DTEND;TZID=America/New_York:20261026T103000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261110T000000Z', 'EXDATE;TZID=America/New_York:20261028T100000', 'END:VEVENT',
      // The Friday Oct 30 meeting moved to 15:00.
      'BEGIN:VEVENT', 'UID:w', 'SUMMARY:Sync (moved)', 'RECURRENCE-ID;TZID=America/New_York:20261030T100000',
      'DTSTART;TZID=America/New_York:20261030T150000', 'DTEND;TZID=America/New_York:20261030T153000', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Daily', 'DTSTART:20261026T120000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');
    const occ = expand(parseICS(ics), Date.UTC(2026, 9, 25), Date.UTC(2026, 10, 20));
    const sync = occ.filter((o) => o.title.startsWith('Sync')).map((o) => [o.title, new Date(o.start).toISOString()]);
    assert.deepStrictEqual(sync, [
      ['Sync', '2026-10-26T14:00:00.000Z'], // EDT
      ['Sync (moved)', '2026-10-30T19:00:00.000Z'],
      ['Sync', '2026-11-02T15:00:00.000Z'], // EST: same 10:00 local time
      ['Sync', '2026-11-04T15:00:00.000Z'],
      ['Sync', '2026-11-06T15:00:00.000Z'],
      ['Sync', '2026-11-09T15:00:00.000Z'],
    ]);
    const daily = occ.filter((o) => o.title === 'Daily').map((o) => new Date(o.start).toISOString().slice(0, 10));
    assert.deepStrictEqual(daily, ['2026-10-26', '2026-10-28', '2026-10-30']);
    // Floating times are the computer's local time.
    assert.strictEqual(wallToInstant(Date.UTC(2026, 0, 2, 9, 0), null), new Date(2026, 0, 2, 9, 0).getTime());
  });

  await ok('calendar watcher: fetches the feed, reports errors, ignores a bad link', async () => {
    const t0 = Date.now() + 20 * 60000;
    const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const body = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:Soon\nDTSTART:${stamp(t0)}\nDTEND:${stamp(t0 + 1800000)}\nEND:VEVENT\nEND:VCALENDAR`;
    const w = new CalendarWatcher({ fetcher: async () => ({ ok: true, text: async () => body }) });
    await w.refresh({ source: 'ics', icsUrl: 'webcal://example.com/cal.ics' }, { force: true });
    assert.strictEqual(w.status, 'ok');
    assert.strictEqual(w.next().title, 'Soon');
    const bad = new CalendarWatcher({ fetcher: async () => ({ ok: false, status: 404 }) });
    await bad.refresh({ source: 'ics', icsUrl: 'https://example.com/x.ics' }, { force: true });
    assert.match(bad.status, /404/);
    await bad.refresh({ source: 'ics', icsUrl: 'file:///etc/passwd' }, { force: true });
    assert.match(bad.status, /https/);
    await bad.refresh({ source: 'off' });
    assert.strictEqual(bad.status, 'off');
  });

  await ok('quiet hours: weekdays, overnight ranges, off', () => {
    const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi);
    const work = { enabled: true, days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' };
    assert.strictEqual(seasons.quietHoursActive(work, at(2026, 10, 23, 10, 0)), true); // Friday
    assert.strictEqual(seasons.quietHoursActive(work, at(2026, 10, 23, 17, 0)), false);
    assert.strictEqual(seasons.quietHoursActive(work, at(2026, 10, 24, 10, 0)), false); // Saturday
    const night = { enabled: true, days: [5], from: '22:00', to: '07:00' };
    assert.strictEqual(seasons.quietHoursActive(night, at(2026, 10, 23, 23, 0)), true); // Fri night
    assert.strictEqual(seasons.quietHoursActive(night, at(2026, 10, 24, 6, 59)), true); // into Saturday morning
    assert.strictEqual(seasons.quietHoursActive(night, at(2026, 10, 24, 23, 0)), false);
    assert.strictEqual(seasons.quietHoursActive({ ...work, enabled: false }, at(2026, 10, 23, 10, 0)), false);
    assert.deepStrictEqual(seasons.quietSettings({ from: 'nope' }).from, '09:00');
  });

  await ok('seasonal events: dates, the year a winter event belongs to, rewards exist', () => {
    assert.strictEqual(seasons.activeEvent(new Date(2026, 9, 23)), null);
    const h = seasons.activeEvent(new Date(2026, 9, 24));
    assert.strictEqual(h.id, 'halloween');
    assert.strictEqual(h.key, 'halloween.2026');
    assert.strictEqual(seasons.activeEvent(new Date(2026, 10, 1)).id, 'halloween');
    assert.strictEqual(seasons.activeEvent(new Date(2026, 10, 2)), null);
    assert.strictEqual(seasons.activeEvent(new Date(2027, 0, 1)).key, 'winter.2026');
    assert.strictEqual(seasons.activeEvent(new Date(2026, 11, 20)).key, 'winter.2026');
    assert.strictEqual(seasons.nextEvent(new Date(2026, 9, 23)).id, 'halloween');
    assert.strictEqual(seasons.nextEvent(new Date(2026, 11, 31)).id, 'valentine');
    for (const e of seasons.EVENTS) for (const id of e.rewards) assert(REWARDS.some((r) => r.id === id && r.event === e.id), id);
  });

  await ok('gallery: lists packs, installs only safe paths, failed downloads leave nothing behind', async () => {
    const sprites = path.join(home, 'sprites');
    fs.mkdirSync(sprites, { recursive: true });
    const files = { 'midnight/idle_1.png': 'PNG1', 'midnight/pack.json': '{}', 'midnight/sub/x.png': 'PNG2' };
    const index = [
      { id: 'midnight', name: 'Midnight', author: 'DeskPet', preview: 'preview.png', files: ['idle_1.png', 'pack.json', 'sub/x.png', '../../evil', '/abs'] },
      { id: '../bad', name: 'Bad', files: ['a.png'] },
      { id: 'broken', name: 'Broken', files: ['missing.png'] },
    ];
    const fetcher = async (url) => {
      const rel = url.replace('https://example.test/', '');
      if (rel === 'index.json') return { ok: true, json: async () => index };
      if (files[rel] !== undefined) return { ok: true, arrayBuffer: async () => Buffer.from(files[rel]) };
      return { ok: false, status: 404 };
    };
    const opts = { fetcher, base: 'https://example.test/' };
    const listed = await gallery.list(sprites, opts);
    assert.deepStrictEqual(listed.map((p) => p.id), ['midnight', 'broken']);
    assert.strictEqual(listed[0].preview, 'https://example.test/midnight/preview.png');
    assert.strictEqual(listed[0].installed, false);
    await gallery.install('midnight', sprites, opts);
    assert.strictEqual(fs.readFileSync(path.join(sprites, 'midnight', 'sub', 'x.png'), 'utf8'), 'PNG2');
    assert(!fs.existsSync(path.join(home, 'evil')));
    assert.strictEqual((await gallery.list(sprites, opts))[0].installed, true);
    await assert.rejects(gallery.install('broken', sprites, opts), /missing\.png/);
    assert(!fs.existsSync(path.join(sprites, 'broken')) && !fs.existsSync(path.join(sprites, '.broken.download')));
    await assert.rejects(gallery.install('../bad', sprites, opts), /gallery pack/);
    assert.strictEqual(gallery.safeFile('a/../b'), null);
    assert.strictEqual(gallery.safeFile('walking_1.png'), 'walking_1.png');
  });

  await ok('presence: other pets are seen, stale and own files are not', () => {
    const dir = path.join(home, '.deskpet', 'presence');
    presence.write({ pet: 'Me', x: 100, y: 500 });
    assert(fs.existsSync(path.join(dir, `${process.pid}.json`)));
    fs.writeFileSync(path.join(dir, '999991.json'), JSON.stringify({ pid: 999991, pet: 'Biscuit', x: 400, at: Date.now() }));
    fs.writeFileSync(path.join(dir, '999992.json'), JSON.stringify({ pid: 999992, pet: 'Old', x: 400, at: Date.now() - 10000 }));
    fs.writeFileSync(path.join(dir, '999993.json'), JSON.stringify({ pid: 999993, pet: 'Gone', x: 400, at: Date.now() - 120000 }));
    assert.deepStrictEqual(presence.others().map((p) => p.pet), ['Biscuit']);
    assert(!fs.existsSync(path.join(dir, '999993.json')), 'very old files are cleaned up');
    presence.remove();
    assert(!fs.existsSync(path.join(dir, `${process.pid}.json`)));
  });

  await ok('playdates: walk over, play when close, wait between, skip while busy, give up', () => {
    const met = new Set();
    const me = { x: 1000, halfWidth: 46, mood: 'idle', busy: false, blocked: false };
    const other = { pid: 7, pet: 'Biscuit', x: 600, width: 92, mood: 'idle' };
    let r = presence.playdateStep({ me, other, state: null, met, t: 10, nextAt: 0 });
    assert.strictEqual(r.action, 'walk');
    assert.strictEqual(r.center, 600 + 46 + 46 + 18); // just to the right of the other pet
    assert.strictEqual(r.state.first, true);
    r = presence.playdateStep({ me: { ...me, x: 720, mood: 'walking' }, other, state: r.state, met, t: 14, nextAt: 0 });
    assert.strictEqual(r.action, 'play');
    assert.strictEqual(r.direction, -1);
    assert.strictEqual(r.first, true);
    met.add(7);
    // Next time: only after the wait, and only if the other pet is free too.
    assert.strictEqual(presence.playdateStep({ me, other, state: null, met, t: 100, nextAt: 194 }).action, 'none');
    assert.strictEqual(presence.playdateStep({ me, other: { ...other, mood: 'thinking' }, state: null, met, t: 200, nextAt: 194 }).action, 'none');
    assert.strictEqual(presence.playdateStep({ me, other, state: null, met, t: 200, nextAt: 194 }).action, 'walk');
    // Typing along with you is free time; an agent at work isn't.
    assert.strictEqual(presence.playdateStep({ me: { ...me, mood: 'typing' }, other, state: null, met: new Set(), t: 1, nextAt: 0 }).action, 'walk');
    assert.strictEqual(presence.playdateStep({ me: { ...me, mood: 'typing', busy: true }, other, state: null, met: new Set(), t: 1, nextAt: 0 }).action, 'none');
    assert.strictEqual(presence.playdateStep({ me: { ...me, blocked: true }, other, state: null, met: new Set(), t: 1, nextAt: 0 }).action, 'none');
    // Couldn't get there in 25 s.
    assert.strictEqual(presence.playdateStep({ me, other, state: { pid: 7, first: false, since: 0 }, met, t: 26, nextAt: 0 }).action, 'giveUp');
    assert.strictEqual(presence.playdateStep({ me, other: null, state: { pid: 7 }, met, t: 1, nextAt: 0 }).state, null);
  });

  console.log(`\n${checks} checks passed`);
  fs.rmSync(home, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
