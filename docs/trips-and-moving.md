# Trips and moving homes (developer notes)

Both apps (Sources/ for macOS, electron/ for Windows/Linux) implement this identically so files move between them.

## Moving-homes file: `<Pet>.chr`

UTF-8 JSON:

```json
{ "app": "deskpet", "kind": "home", "v": 1, "packed": "<ISO date>", "from": "macOS|Windows|Linux", "device": "<device name>",
  "profile": { "...": "the transfer-key payload (app, v, config, settings, stats, companion)" },
  "pack": null | { "name": "minori", "files": { "pack.json": "<base64>", "sheet.png": "<base64>", "sub/x.png": "<base64>" } } }
```

- `pack` is the active sprite pack: every regular file under it, recursively, skipping `sliced/` and dotfiles. Omitted (null, with a note) above 40 MB.
- Import: check `app == "deskpet" && kind == "home"`. Preview = transfer summary + " · brings the <name> look". Applying writes the pack to `sprites/<name>/` (overwriting same-named files), then applies `profile` exactly like a transfer key, then `companion.event('movedIn')`.
- Opening: drag the file onto the pet, the control center's Move in button, the wizard, and opening the file (macOS document type; Windows/Linux: a `.chr` path in argv or the second-instance argv).
- Text keys (`DESKPET-1:`) still import everywhere.

## Trip folder: `<drive>/DeskPet Trip/`

```
trip.json
sprites/<pack>/...            copy of the active pack (absent for the built-in cat)
DeskPet.app | DeskPet-Windows/ | DeskPet-Linux.AppImage   optional portable copy of the current app
Read me.txt
```

`trip.json` (written atomically: `trip.json.tmp`, then rename):

```json
{ "app": "deskpet", "kind": "trip", "v": 1, "id": "<uuid>", "status": "away|home",
  "home": { "device": "<syncDeviceID>", "name": "<device name>", "os": "macOS|Windows|Linux" },
  "pet": "Minori", "owner": "Luna", "leftAt": "<ISO>", "returnedAt": "<ISO, once home>",
  "departure": { "stats": { "...": "exported stats at departure" } },
  "profile": { "...": "transfer payload; visitors keep it up to date" },
  "pack": "minori",
  "visits": [ { "device": "<name>", "os": "Windows", "at": "<ISO>", "minutes": 12 } ],
  "updatedAt": "<ISO>" }
```

`syncDeviceID` is the existing per-device id (generated if missing). It identifies home.

### Home device

- State key `trip` = `{ id, path, volume, leftAt (ms), sawGone }`.
- Take on a trip: not allowed while visiting or already away. Write the folder, set state, `companion.event('tripLeave')`, hide the pet after ~3.5 s, status icon 🧳, offer to eject the drive.
- Every ~3 s while away (plus mount notifications on macOS), look for `trip.json` at `state.path` and at `<each removable volume>/DeskPet Trip/`:
  - Same id, status away: if the drive was seen gone since departure (`sawGone`), or this launch found it more than 10 minutes after `leftAt` → **return**. A missing folder sets `sawGone`.
  - Mine but a different id (called home earlier) and status away → absorb silently, mark home, `companion.event('tripLuggage')`.
  - Someone else's (home.device ≠ mine), status away → "visitor at the door": say + notification, menu/control-center action "Let <Pet> out", which launches a visitor instance. Never automatic.
- Return: add the **stats delta** (trip `profile.stats` minus `departure.stats`: XP, and each day's counters, floored at 0; prestige rank taken from the trip if higher), `companion.mergeData(profile.companion)`, take names from `profile.config` if they changed, mark trip.json `status: home` + `returnedAt`, clear state, show the pet, then `companion.event('tripReturn', { minutes, visits: [device names] })`. The engine awards bonus XP and opens the "how was your day?" talk.
- Call home without the drive: clear state, show the pet, `companion.event('tripCalledHome')`. The trip's progress is absorbed later as luggage.

### Visitor instance

Started with `--trip <folder>`, or when the running executable sits inside a folder that has `trip.json` (portable copy).

- Data root is a fresh temp dir (`<tmp>/DeskPet-trip-<id>`); agent sessions still come from the real `~/.deskpet/sessions`. macOS uses `UserDefaults(suiteName: "deskpet.trip")` (cleared at launch); Electron sets `userData` to the temp dir and skips the single-instance lock. The normal instance must not quit because a visitor is running (visitors write `~/.deskpet/visitors/<pid>`).
- Sprites come from `<trip>/sprites`.
- If `home.device` is this device's id, or status is home: say so and quit (the pet lives here; plug the drive in instead).
- Startup: apply `profile` like a transfer key (no welcome line), append a visit, `companion.event('tripArrive', { host, homeName, first })`.
- Off in visitor mode: setup wizard, hook install/heal, Kiro hooks, auto-update, start at login, sync, taking trips, moving in, notifications.
- Every 20 s and on quit: `profile` = current transfer payload, update the visit's minutes and `updatedAt`. If the folder disappears, quit. macOS: on will-unmount of that volume, save and quit.
- Menu: 🧳 icon, "<Pet> is visiting <host>", Talk, "Go home" (say a line, save, quit).

## Companion engine (shared)

- Hidden topic category `trip`. Topic `trip.home` (in friend.json) asks how your day was, what you did, and one thing that happened, then `{ "action": "logTrip" }`.
- Events: `tripLeave`, `tripReturn {minutes, visits}`, `tripArrive {host, homeName, first}`, `tripCalledHome`, `tripLuggage`, `movedIn`, `movingOut`.
- New effects hosts handle: `{ type: 'openTalk', topic }` opens the talk window on that topic (`'offer'`), and `{ type: 'trip' }` opens the take-on-a-trip flow (from "🧳 Come with me!" in the Goodbye menu).
- `summary().trips`: recent trips `{ id, day, minutes, places, mood, activity, moment }`.

## Control center bridge

`state.trip` = `{ mode: 'home'|'away'|'visiting', drives: [{ path, name }], away: { volume, leftAt, minutes, present } | null, visiting: { host, homeName } | null, visitors: [{ path, pet, homeName }], appCopy: { possible, size } }`.

Actions: `tripDrives` → `{ drives }`; `tripChooseFolder` → `{ path } | null`; `tripTake { path, copyApp }` → `{ ok, error?, ejectable }`; `tripEject` → `{ ok }`; `tripCallHome` → `{ ok }`; `tripWelcome` (folder present, manual) → `{ ok }`; `tripLetOut { path }` → `{ ok }`; `movingPack` → save dialog → `{ ok, path, note }`; `movingOpen` → open dialog → `{ ok, path, summary }`; `movingApply { path }` → `{ ok, note }`. The wizard uses `moving-open` / `moving-apply`.
