# DeskPet 🐾

Mochi, a desktop cat that reacts to what you're doing and to your AI agents. Runs on macOS (native Swift) and Windows (Electron).

| Folder | What |
|---|---|
| `Sources/`, `build.sh`, `install-hooks.py` | macOS app (Swift/AppKit) |
| `electron/` | Windows app (Electron); also runs on macOS for development |
| `.github/workflows/windows.yml` | Builds and checks the Windows app on every push; attaches the zip to releases |

## Run on macOS

```bash
./build.sh                 # compile DeskPet.app
open DeskPet.app           # launch (lives in the menu bar as 🐾, no Dock icon)
./install-hooks.py         # Claude Code hooks for exact agent states (--uninstall to remove)
DeskPet.app/Contents/MacOS/DeskPet status   # print detected agents
```

## Run on Windows

1. Download `DeskPet-win32-x64.zip` from the latest GitHub release (or the **Windows build** workflow's artifacts), unzip it anywhere, and run `DeskPet.exe`.
2. Mochi lives in the system tray (bottom-right, maybe under the `^` overflow arrow). Click the tray icon for the menu.
3. In the tray menu, turn on **Claude Code hooks** for exact agent states, then restart Claude Code. Turn on **Start with Windows** to launch it at login.

Windows SmartScreen may warn about an unsigned app the first time; choose **More info → Run anyway**.

The Windows app has the same features as the Mac one: all poses and reactions, throwing, resizing, themes, thought bubble sizes, and sprite packs (`%USERPROFILE%\.deskpet\sprites\`, same format, so a pack folder can be copied between machines). Differences: typing is detected as "input while the mouse is still" since Windows has no permission-free keyboard API, and agent hooks run through PowerShell.

### Developing the Windows app

```bash
cd electron
npm install
npm start                          # run it (works on macOS too)
npm run snapshot                   # render every pose to test-output/snapshot.png
npm run snapshot -- --pack minori  # same, with a sprite pack
npm run package:win                # build dist/DeskPet-win32-x64 (no Windows machine needed)
```

## What Mochi notices

| You / your agents | Mochi |
|---|---|
| Claude submits a prompt / between tools | thought bubble |
| Edit, Write, Bash | typing on a laptop |
| Read, Grep, Glob | reading a book |
| WebFetch, WebSearch, MCP tools | magnifying glass |
| Subagents running | mini helper cats with laptops |
| Permission prompt / question | waves at you with a "!" |
| Turn finished | sparkles + "done!" |
| Tool failure / API error | sweat drop / dizzy stars |
| Compacting | sweeping with a broom |
| Codex, Kiro CLI, Amazon Q, Gemini, … | typing while their process uses CPU (no hooks) |
| You type | bobs along |
| Mouse | eyes follow the cursor |
| Idle 75s / 4 min | sleepy / asleep in a nightcap; startles awake when you return |
| Music / IDE / browser / chat apps | headphones, glasses, comments |
| After 11pm, 50 min without a break | bedtime and stretch reminders |
| Click / drag | purrs with hearts / dangles from the scruff |
| Throw (flick and release) | flies, spins, and bounces off the screen edges; dizzy after a wild throw. With Gravity off it drifts and ricochets instead of falling |

Right-click Mochi or use the 🐾 menu (system tray on Windows) for every option.

### Agents
- **Claude Code:** exact states through hooks (🐾 → Agents → Claude Code hooks, or the setup wizard).
- **Codex:** exact states automatically, read from its session log in `~/.codex/sessions`.
- **Kiro CLI:** exact states through hooks added to `~/.kiro/agents/*.json` (🐾 → Agents → Kiro CLI hooks). Tools like `aim` regenerate those files, so DeskPet re-adds its hooks every 10 minutes while this is on.
- **Others** (Amazon Q, Gemini, Cursor, …): detected by process and CPU use.

### Getting your attention
- **Click to jump:** when an agent is done or needs you, clicking the pet brings its terminal, IDE, or T3 Code window forward. Clicking a session in the menu or hover card does the same.
- **Notifications:** when an agent finishes, needs permission, or errors (skipped if you're already looking at that app).
- **Hover card:** hover the pet for a moment to see each session's state, how long it's been working, and its tokens (output and current context size).

### Fun
- **Walk on windows:** with gravity on, the pet lands on window title bars, rides along when you move them, and falls when they close or minimize.
- **Levels and stats:** earn XP three ways, each shown as a floating "+N XP":
  - *Hanging out:* +1 for every 5 minutes the pet is open, and +10 for the first hello each day.
  - *Playing:* petting +2, a throw +3, a wild throw with 3+ bounces +5 more, catching it mid-air +3, landing on a window +2 (up to 100 play XP a day).
  - *Agents:* +10 per finished task, +15 per focus session, +1 per minute agents are working.

  Today's stats are in the menu and hover card (`~/.deskpet/stats.json`).
- **Levels and prestige:** levels run 1–100 (about 7,900 XP to level 100). At 100 you can **prestige** (🐾 → Rewards → Prestige): back to level 1 with a prestige badge (🥉 1–3, 🥈 4–6, 🥇 7–9) and every reward kept. Prestige 10 is **💎 Prestige Master**, which keeps leveling all the way to 1000.
- **Rewards:** worn automatically when unlocked, mixed and matched in 🐾 → Rewards. All of them work on the built-in cat and on sprite packs (hats find the character's head in each frame):

  | Lv | Reward | Lv | Reward |
  |---|---|---|---|
  | 2 | 🎀 Bow | 35 | 💜 Purple aura |
  | 3 | ✨ Sparkle trail | 40 | 🎩 Top hat |
  | 5 | 🎉 Party hat | 45 | ⭐ Star buddy |
  | 8 | 🎈 Balloon | 50 | 🌈 Rainbow trail |
  | 10 | 🌸 Petal trail | 60 | 😇 Halo |
  | 12 | 🧢 Cap | 70 | ❄️ Snow aura |
  | 15 | 🌟 Golden aura | 80 | 🪐 Orbiting planets |
  | 20 | 👑 Crown | 90 | 💎 Diamond crown |
  | 25 | 🦋 Butterfly | 100 | 🏆 Golden shimmer |
  | 30 | 🔥 Fire trail | | |
- **Rename:** 🐾 → Rename… changes the pet's name or yours any time.
- **Focus timer:** 15/25/50-minute sessions with a break afterwards (🐾 → Focus timer).
  - **Blocklist:** during focus, the pet calls you out when you open a listed site, or closes the tab in strict mode (🐾 → Focus timer → Edit blocklist…). On macOS it reads the active tab in Safari, Chrome, Edge, Brave, Arc, Vivaldi, and Opera (macOS asks once per browser); on Windows it matches the browser window's title.
- **Quiet during calls:** no sounds or chatty remarks while any app uses the microphone or camera.
- **Sounds:** system sounds on macOS, synthesized ones on Windows; a sprite pack can bring its own as `sounds/<event>.(wav|mp3|m4a|aiff|caf|ogg)` with events `pet`, `done`, `needs-you`, `bounce`, `wake`, `level-up`, `focus-done`.

### Moving to another device
🐾 → Move to another device → Export transfer key… gives you one pasteable code (`DESKPET-1:…`) with your names, level and stats, look, size, and settings. Import it on the other machine from the same menu, or with "Have a transfer key?" in setup. Keys work between macOS and Windows. Sprite pack images aren't in the key: move packs with Sprites → Export.

### Updates
DeskPet checks GitHub Releases every 6 hours (🐾 → Check for updates…) and can update itself in place. On macOS, move the app to Applications first.

**Look:** 🐾 → Thought bubble (Large / Small / Off) and 🐾 → Theme color… (any hex code, e.g. `#FF8FB1`; **Default** restores the built-in colors). The theme tints speech and thought bubbles, captions, the "!" alert, and the resize box. You can also set `themeColor` in `config.json`.

**Resizing:** 🐾 → Size → Resize… shows a box with corner handles; drag any corner (the feet stay put), then click the `125% · Done` pill. Presets from 50% to 300% are in the same menu. The cat and each sprite pack remember their own size.

Config: `~/.deskpet/config.json` (`ownerName`, `petName`, `spritePack`). Hook state: `~/.deskpet/sessions/`.

## Custom sprites

Make a folder in `~/.deskpet/sprites/<name>/`, add images, then pick it from 🐾 → Sprites.
Changes are picked up automatically every ~2 seconds.

**File names** are moods: `idle.png` (required), or animation frames `idle_1.png`, `idle_2.png`, …, or an animated `idle.gif`.
PNG, GIF, WebP, JPEG, and HEIC all work. Any mood you skip falls back to a similar one, then to `idle`:

| File | Shown when | Falls back to |
|---|---|---|
| `idle` | nothing going on | (required) |
| `typing` | agent editing / running commands | thinking |
| `thinking` | agent thinking | idle |
| `needs-you` | agent waiting for your permission | startled |
| `done` | agent finished | petted |
| `sleeping` / `sleepy` | you've been away | idle / sleeping |
| `petted` | you clicked it | done |
| `dragged` / `startled` | being carried / woken up | each other |
| `reading`, `searching` | Read/Grep, web/MCP tools | each other, thinking |
| `delegating`, `tidying` | subagents, compacting | typing |
| `oops`, `error` | tool / API failure | each other, startled |
| `flying`, `dizzy` | thrown / after lots of bounces | dragged / error |
| `walking`, `user-typing` | wandering / you typing | idle |

Draw every image at the **same resolution and character scale**, with the feet near the bottom.
Transparent margins are trimmed automatically, and every pose uses idle's pixel size, so a sitting pose stays shorter than a standing one.
Leave out bubbles, Zzz, "!", and hearts: DeskPet draws those over your sprite (set `"effects": false` to turn them off).

**Sharing packs:** drop a pack `.zip`, a pack folder, or images onto the pet (or 🐾 → Sprites → Import pack…) to install it; 🐾 → Sprites → Export… zips the current pack.

**Spritesheets:** drop a `sheet.png` into the pack folder instead of separate files. By default it's read as a 4×4 grid:

| Row | Cells 1–4 |
|---|---|
| 1 | idle_1, idle_2, typing_1, typing_2 |
| 2 | thinking, needs-you, done, petted |
| 3 | sleeping, sleepy, dragged, startled |
| 4 | reading, searching, oops, error |

Poses are found by the empty gaps between them, so uneven AI-generated spacing is fine. If a row can't be separated cleanly, it's split into equal cells instead.
Run `DeskPet.app/Contents/MacOS/DeskPet slice <pack>` to write each cut-out pose to `<pack>/sliced/` and check them.
A loose file (e.g. `done.png`) overrides that pose from the sheet, so you can fix one bad cell without regenerating everything.
For other layouts, or several sheets, describe them in `pack.json`:

```json
{
  "sheets": [
    { "file": "sheet.png", "columns": 4, "cells": [["idle_1", "idle_2", "typing_1", "typing_2"], ["thinking", "", "done", "petted"]] },
    { "file": "walk.png", "columns": 4, "rows": 1, "cells": ["walking_1", "walking_2", "walking_3", "walking_4"], "mode": "grid" }
  ]
}
```

`""` skips a cell. `"mode": "grid"` always splits evenly (useful for pixel-art sheets with no gaps). Sheet backgrounds are removed automatically unless `"removeBackground": false`.

**Optional `pack.json`:**

```json
{
  "height": 120,
  "fps": 6,
  "removeBackground": true,
  "tolerance": 40,
  "facing": "right",
  "effects": true,
  "bounce": true,
  "pixelated": false,
  "moods": { "sleeping": { "scale": 1.0, "offsetX": 0, "offsetY": -4, "fps": 2 } }
}
```

- `height`: on-screen height of `idle` in points (40–220).
- `removeBackground`: makes a flat background (the color touching the image edges) transparent, for generators that can't export transparency. `tolerance` controls how close a color must be to count as background.
- `facing`: which way your art faces, so walking is mirrored correctly.
- `bounce`: hop and bob for still images. `pixelated`: keep pixel art crisp.
