#!/usr/bin/env python3
"""Add DeskPet's Claude Code hooks to ~/.claude/settings.json (or remove them with --uninstall).

Existing hooks (e.g. other pets) are left untouched; a timestamped backup is written first.
"""
import json
import os
import shutil
import sys
import time

SETTINGS = os.path.expanduser("~/.claude/settings.json")
APP_LOCATIONS = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "DeskPet.app"),
    "/Applications/DeskPet.app",
    os.path.expanduser("~/Applications/DeskPet.app"),
]
EVENTS = {
    "SessionStart": "",
    "UserPromptSubmit": "",
    "PreToolUse": "",
    "PostToolUse": "",
    "PostToolUseFailure": "",
    "PermissionRequest": "",
    "Notification": "permission_prompt",
    "SubagentStart": "",
    "SubagentStop": "",
    "Stop": "",
    "StopFailure": "",
    "PreCompact": "",
    "SessionEnd": "",
}


def find_binary():
    """The first DeskPet.app found next to this script or in an Applications folder."""
    for app in APP_LOCATIONS:
        binary = os.path.join(app, "Contents/MacOS/DeskPet")
        if os.path.exists(binary):
            return binary
    return None


def is_deskpet(group):
    return any("DeskPet.app" in h.get("command", "") for h in group.get("hooks", []))


def main():
    uninstall = "--uninstall" in sys.argv
    binary = find_binary()
    if not uninstall and not binary:
        sys.exit("DeskPet.app not found next to this script or in /Applications; run ./build.sh or move the app there first")
    command = f'"{binary}" hook --agent claude'

    settings = {}
    if os.path.exists(SETTINGS):
        with open(SETTINGS) as f:
            settings = json.load(f)
        backup = f"{SETTINGS}.deskpet-backup-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(SETTINGS, backup)
        print(f"Backed up settings to {backup}")

    hooks = settings.setdefault("hooks", {})
    for event, matcher in EVENTS.items():
        groups = [g for g in hooks.get(event, []) if not is_deskpet(g)]
        if not uninstall:
            groups.append({"matcher": matcher, "hooks": [{"type": "command", "command": command, "timeout": 2}]})
        if groups:
            hooks[event] = groups
        else:
            hooks.pop(event, None)
    if not hooks:
        settings.pop("hooks")

    tmp = SETTINGS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    os.replace(tmp, SETTINGS)
    print("Removed DeskPet hooks." if uninstall else "Installed DeskPet hooks. Restart Claude Code sessions to pick them up.")


if __name__ == "__main__":
    main()
