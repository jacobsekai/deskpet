#!/bin/bash
# Compiles DeskPet into DeskPet.app next to this script.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p build
swiftc -O -swift-version 5 -framework AppKit -o build/DeskPet Sources/*.swift

APP=DeskPet.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp build/DeskPet "$APP/Contents/MacOS/DeskPet"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>DeskPet</string>
    <key>CFBundleIdentifier</key><string>local.deskpet</string>
    <key>CFBundleName</key><string>DeskPet</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "Built $(pwd)/$APP"
