# DeskPet 🐾

Mochi, a desktop cat that reacts to what you're doing and to your AI agents. Runs on macOS (native Swift), Windows, and Linux (Electron).

| Folder | What |
|---|---|
| `Sources/`, `build.sh`, `install-hooks.py` | macOS app (Swift/AppKit) |
| `electron/` | Windows and Linux app (Electron); also runs on macOS for development |
| `.github/workflows/windows.yml`, `linux.yml` | Build and check the Windows and Linux apps on every push; attach them to releases |

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

## Run on Linux

1. Download `DeskPet-linux-x64.AppImage` (or `-arm64`) from the latest release.
2. `chmod +x DeskPet-linux-*.AppImage` and run it. No install needed; it works on any distro with a desktop.
3. Open the control center from the tray icon or by right-clicking the pet, and connect Claude Code (or Kiro) under Agents.

A `tar.gz` is also published for people who prefer unpacking it somewhere. Notes:
- The pet needs a compositing desktop for its transparent window (GNOME, KDE Plasma, Cinnamon, Xfce with compositing, …).
- On X11, `xprop` and `wmctrl` (usually preinstalled) power the focus blocklist, app reactions, and click-to-jump. Wayland sessions don't let apps see other windows, so those features stay off there.
- Quiet-during-calls uses `pactl` (PipeWire or PulseAudio). Walking on windows isn't available on Linux.
- GNOME needs the AppIndicator extension to show tray icons; right-clicking the pet always opens the menu.

### Developing the Windows and Linux app

```bash
cd electron
npm install
npm start                          # run it (works on macOS too)
npm run snapshot                   # render every pose to test-output/snapshot.png
npm run snapshot -- --pack minori  # same, with a sprite pack
npm test                           # play through every conversation, plus reputation, reminders, and sync
npx electron . --talk-snapshot --personality minori   # screenshot the talk window and games
npm run package:win                # build dist/DeskPet-win32-x64 (no Windows machine needed)
npm run package:linux              # build the AppImages and tar.gz (on Linux; CI does this)
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
| Music / IDE / browser / chat / video / game apps | headphones, glasses, comments in its own voice |
| Water, breaks, late nights, mornings, evenings | water and stretch reminders, bedtime nudges, daily motivation, an evening recap |
| Click / double-click / drag | purrs with hearts / opens the talk window / dangles from the scruff |
| Throw (flick and release) | flies, spins, and bounces off the screen edges; dizzy after a wild throw. With Gravity off it drifts and ricochets instead of falling |

**Control center:** 🐾 → **Open DeskPet…** (⌘, / Ctrl+,) has everything, in the same style as setup: Home (your pet, rank, today's stats, live agents), Companion (your bond, reminders, and what the pet remembers), Rewards (live previews of each reward on your pet, prestige), Look (sprite packs, theme, thought bubble, size), Focus (timer and blocklist), Agents (connections and live sessions), Behavior, Trips (take the pet with you on a drive), Account (rename, sync, moving homes), and About (updates). The 🐾 menu and right-clicking the pet give a quick menu: status, agents, quick focus, 🔄 Refresh character, and Open DeskPet.

**Getting characters:** Look → Import pack (a `.zip`, a folder, or images), Browse the gallery, or **Import from a Drive link**: paste a Google Drive link to a pack `.zip` shared with "Anyone with the link" (no sign-in needed; up to 50 MB; zips with files that would land outside the pack folder are refused). Packs reload by themselves when their files change; **🔄 Refresh character** (Look or the quick menu) reloads right away, pulling from Google Drive first when you sync that way.

### Talking with your pet
Inspired by Monika After Story. **Double-click the pet** (or 🐾 → 💬 Talk to …) to open a dialogue box beside it:
- **Talk to me:** a random topic. **Ask … about…:** topics by category (the pet itself, life, work and focus, fun stuff, plus character ones).
- **Ask me about me:** the pet asks about you (favorite food, color, music, birthday, work or school, pets, dreams…) and **remembers your answers**, bringing them up later. **What do you know about me?** lists them; edit or forget them in the control center → Companion.
- **I'm feeling…:** happy, sad, stressed, tired, anxious, bored, lonely, angry, proud. **Tell …:** I love you, thank you, you're cute, I'm sorry… (and one unkind option).
- **Play a game:** rock, paper, scissors, tic-tac-toe, word guess, and pong. Games count toward XP and your bond.
- **Goodbye…:** going to sleep, to work, to school, out. The pet says goodbye, closes DeskPet, and greets you accordingly next time.
- Every so often the pet **starts a conversation** itself ("psst… click me 💬"): click it within two minutes to hear it. Choose how often (or never) in Companion.
- **Reminders:** drink water, stretch breaks, bedtime nudges, daily motivation, encouragement, and an evening recap of your day. Each can be changed or turned off in the control center → Companion. Everything stays quiet during focus sessions and calls. Water, stretch, bedtime, and check-in reminders also show as notifications that stay on screen until you press **Done ✓** or **Snooze 10 min**. If you ignore one, it comes back every 10 minutes while you're at the computer. Done on water or a check-in opens the chat that logs it, and answering the pet counts too. On macOS, set System Settings → Notifications → DeskPet to **Alerts** to keep them on screen; Windows has the buttons; on Linux, clicking counts as Done. Turn this off with Companion → ⏰.
- **Holidays and birthdays:** New Year, Valentine's Day, Halloween, Christmas, your birthday, and your anniversary with the pet (plus Minori's birthday on April 14).

**Your bond (reputation):** affection grows a little with every conversation, game, pet, and goodbye (up to 12 a day, so it reflects time together). It goes down if you're unkind, quit without saying goodbye, throw the pet around too much, or disappear for a week or more. When it drops below zero the pet is **Upset** or **Hurt** and talks coldly until you make up (Tell → I'm sorry helps). The tiers are New friends → Friends → Good friends → Close friends → Best friends → Inseparable. Each one changes how warmly the pet greets and talks to you and unlocks more personal topics, and reaching one plays a **milestone conversation** (at Close friends the pet asks for a nickname to call you). Replay them from **Our special moments**.

**Personalities:** the built-in cat talks like a cat (tiers from *Curious stranger* to *Purr-manent family*). Sprite packs named Minori get Minori's personality (*New fan* to *Like family*): fan-made, upbeat lines about idols, MORE MORE JUMP!, and never giving up. Her bond stays platonic because she's a high school student. Other packs get a warm, friendly personality. A pack can choose one with `"personality": "minori"` in `pack.json`, or ship its own `dialogue.json` that extends a built-in one:

```json
{
  "extends": "friend",
  "name": "Tama",
  "tierNames": { "best": "Partners in crime" },
  "pools": { "petted": ["nya~ 💕", "*happy wiggle*"], "greeting.morning": ["Morning, {owner}!"] },
  "topics": [
    { "id": "tama_fish", "category": "pet", "title": "Fish", "random": true,
      "steps": ["I like fish.", { "ask": "Do you?", "choices": [
        { "label": "Yes!", "say": "Best friends forever 🐟", "affection": 1 },
        { "label": "Not really", "say": "More for me, then." }
      ] }] }
  ]
}
```

The full format (steps, questions, remembered answers, conditions, moods, games, milestones) is shown by the built-in personalities in `electron/src/companion/personalities/`. Conversations, affection, and memories are stored in `~/.deskpet/companion.json`, and they travel with transfer keys and cloud sync.

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
- **Levels and prestige:** levels run 1–100 (about 84,000 XP to level 100, a few months of daily use; each level costs a bit more than the last). At 100 you can **prestige** (🐾 → Rewards → Prestige): back to level 1 with a prestige badge (🥉 1–3, 🥈 4–6, 🥇 7–9) and every reward kept. Prestige 10 is **💎 Prestige Master**, which keeps leveling all the way to 1000.
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
- **Quiet during calls:** no sounds, remarks, or reminders while any app uses the microphone or camera.
- **Sounds:** system sounds on macOS, synthesized ones on Windows; a sprite pack can bring its own as `sounds/<event>.(wav|mp3|m4a|aiff|caf|ogg)` with events `pet`, `done`, `needs-you`, `bounce`, `wake`, `level-up`, `focus-done`.

### Sync across devices
Control center → Account → **Sync across devices**: pick a folder your cloud drive syncs (iCloud Drive, OneDrive, Dropbox, Google Drive, Nextcloud, Syncthing, … DeskPet lists the ones it finds). Each device writes only its own file in `DeskPet/devices/`, so devices never overwrite each other: XP and daily stats add up across all of them, while names, settings, worn rewards, and prestige follow whichever device changed them last. Works between macOS, Windows, and Linux, offline included (devices catch up when the folder syncs). Optionally keep sprite packs in the sync folder too. Nothing goes through a server.

**Sign in with Google Drive** works without the Google Drive app (handy on Linux). Sign in in your browser, and DeskPet keeps the same per-device files, plus your sprite packs, in its private app-data space in your Drive. Only DeskPet can see that space, and DeskPet can't see your other Drive files. It syncs about once a minute. Turning sync off signs this device out; your other devices keep syncing. Builds need a Google OAuth client first: see [docs/google-drive-setup.md](docs/google-drive-setup.md).

If the folder already has progress when you join, you choose **Combine** (add both) or **Use synced progress** (start this device fresh, with a backup), so progress you already moved with a transfer key isn't counted twice.

### Trips: take your pet with you
Control center → **Trips** (or 🐾 → 🧳 Take … on a trip, or Talk → Goodbye → "Come with me!"): pick a USB drive (or any folder) and the pet packs into `DeskPet Trip/` on it and leaves your screen. Turn on **Put DeskPet on the drive too** to add a portable copy of the app.

- **On another computer:** plug the drive in. If that computer runs DeskPet, it says someone's at the door and offers **Let … out**. Otherwise, open the portable copy from the drive (`DeskPet.app`, `DeskPet-Windows\DeskPet.exe`, or `DeskPet-Linux.AppImage`). The visiting pet keeps its own level, bond, and memories, sees that computer's agents, and saves everything back to the drive every 20 seconds. Choose **Go home** before ejecting.
- **Back home:** plug the drive in. The pet comes home with what it earned on the trip (plus a little XP for coming along) and asks how your day was, what you did, and one thing that happened. Past trips are listed on the Trips page.
- **Forgot the drive?** **Call … home without the drive** brings the pet back now; the trip's progress is unpacked the next time that drive is plugged in.

### Moving homes
Account → **Moving homes** → **Pack up for moving…** saves one `<Pet>.chr` file with your names, level, prestige, stats, bond, memories, settings, and the sprite pack. On the new computer (macOS, Windows, or Linux), open the file (double-click on macOS), drop it onto the pet, use **Move in from a file…**, or pick it in setup. Text keys (`DESKPET-1:…`) still work under **Use a text key instead**, for everything except the sprite pack.

### Insights
Control center → **Insights**: this week vs last week (time together, agent time, focus sessions, sips), two weeks of daily charts (hover a bar for the day's value), and a six-week mood calendar from the evening journal.

### Check-ins and the mood journal
- **Check-ins** (Companion page): turn on built-ins (20-20-20 eye break, posture, stand up, stretch, medication at a set time) or add your own, either "done / not yet" or a fill-in sentence with a goal ("I took __ deep breaths"). When one comes up, click the pet; or log it any time from Talk → Tell → Check in.
- **Journal:** in the evening the pet asks how the day was (and if you want to note anything). After a rough or tiring day it checks on you the next morning.
- **Energy and fun** (off by default): breaks restore energy and playing restores fun. Coins never run out, so treats are always there (your pet just gets full if you feed it more than a few in a row). Nothing bad happens when they run low.

### Agents, meetings, and quiet hours
- When an agent finishes, the bubble and notification say what it did ("Claude: Fixed the login test ✓"), taken from the session's last reply.
- **Calendar heads-up** (Behavior, opt-in): warnings 1–15 minutes before meetings from the macOS Calendar app, classic Outlook on Windows, or any ICS calendar link; click the pet at meeting time to open its Chime/Zoom/Meet/Teams link. Titles never leave your computer.
- **Quiet hours** (Behavior): no remarks or sounds on a schedule, optionally still showing agent notifications.

### Gifts
Like Monika After Story: make a file named after the gift, ending in `.gift` (for example `salmon_bento.gift` or `Haruka Merch.gift`; an empty file is fine, and Companion → Gifts can make one), then Talk → **🎁 I'd like to give you a gift** and choose it, or drop it onto the pet. Given gifts move to `~/.deskpet/gifts/given/`.
- Gifts unlock once you're **Friends**; a few special ones need a closer bond (the pet says it's too soon and you keep the file).
- Each character has their own favorites with their own reactions: the cat loves salmon, tuna, catnip mice, yarn, cardboard boxes, laser pointers… (and has opinions about cucumbers). Minori loves Haruka-chan merch, salmon bento, MORE MORE JUMP! penlights and CDs, hair clips, idol magazines, Airi-chan and Shizuku-chan merch, and, once you're close, a friendship bracelet. Anything else still gets a sweet thank-you.
- Sprite packs can add or replace gifts in their `dialogue.json` (`"gifts": { "id": { "name", "aliases", "tier", "affection", "steps" } }`, `"replaceGifts": true`).

### Playdates, events, and the gallery
- **Playdates:** when a pet visits from a trip drive, the two walk over and play together.
- **Seasonal events:** Halloween (Oct 24–Nov 1), winter (Dec 15–Jan 1), and Valentine's week, each with an outfit you earn by spending an hour together during the event (shown on Home). On your birthday the pet wears a party hat.
- **Gallery** (Look → Browse the gallery): install free original packs (Midnight, Snowball, Ginger) from `packs/` in this repo.

### Stay in one place
🐾 menu → **📌 Stay in one place** (or Behavior): the pet stops wandering, falling, riding windows, and walking over for playdates (a visiting pet still comes to it). Drag it anywhere and it stays exactly where you drop it.

### Emergency hide
Press **⌃⌥H** (Mac) or **Ctrl+Alt+H** (Windows/Linux) anywhere to hide the pet, its bubbles, the talk window, the hover card, and the control center at once. Sounds and notifications stay quiet until you press it again (or choose Show from the 🐾/tray menu). Pick a different shortcut, or turn it off, under Behavior → Emergency hide.

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
