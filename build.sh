#!/bin/bash
# Compiles DeskPet into DeskPet.app next to this script.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p build
# Universal binary: Apple Silicon and Intel.
for arch in arm64 x86_64; do
    swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" -framework AppKit -framework WebKit -framework ServiceManagement -framework SwiftUI -framework UserNotifications -framework CoreAudio -framework CoreMediaIO \
        -o "build/DeskPet-$arch" Sources/*.swift
done
lipo -create -output build/DeskPet build/DeskPet-arm64 build/DeskPet-x86_64

APP=DeskPet.app
# One version for both apps, from the Electron package.
VERSION="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' electron/package.json | head -1)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp build/DeskPet "$APP/Contents/MacOS/DeskPet"

# App icon from the same cat artwork the Windows build uses.
ICONSET=build/AppIcon.iconset
rm -rf "$ICONSET" && mkdir -p "$ICONSET" "$APP/Contents/Resources"
for size in 16 32 128 256 512; do
    sips -z $size $size electron/assets/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) electron/assets/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# The setup wizard is the same HTML the Windows app uses, drawn with the shared pet renderer.
WEB="$APP/Contents/Resources/web"
mkdir -p "$WEB/wizard" "$WEB/renderer" "$WEB/panel" "$WEB/companion/personalities"
cp electron/src/wizard/index.html electron/src/wizard/wizard.css electron/src/wizard/wizard.js "$WEB/wizard/"
cp electron/src/panel/index.html electron/src/panel/panel.css electron/src/panel/panel.js "$WEB/panel/"
cp electron/src/renderer/color.js electron/src/renderer/pet.js electron/src/renderer/sprites.js "$WEB/renderer/"
# The companion engine runs in JavaScriptCore; the talk window is shared HTML too.
cp electron/src/companion/engine.js electron/src/companion/talk.html electron/src/companion/talk.css electron/src/companion/talk.js electron/src/companion/games.js "$WEB/companion/"
cp electron/src/companion/personalities/*.json "$WEB/companion/personalities/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>DeskPet</string>
    <key>CFBundleIdentifier</key><string>local.deskpet</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleName</key><string>DeskPet</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSAppleEventsUsageDescription</key><string>DeskPet checks which website is open during focus sessions, so it can keep you off your blocklist.</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key><string>DeskPet moving-homes file</string>
            <key>CFBundleTypeRole</key><string>Editor</string>
            <key>LSHandlerRank</key><string>Owner</string>
            <key>LSItemContentTypes</key><array><string>local.deskpet.moving</string></array>
        </dict>
    </array>
    <key>UTExportedTypeDeclarations</key>
    <array>
        <dict>
            <key>UTTypeIdentifier</key><string>local.deskpet.moving</string>
            <key>UTTypeDescription</key><string>DeskPet moving-homes file</string>
            <key>UTTypeConformsTo</key><array><string>public.json</string></array>
            <key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>deskpet</string></array></dict>
        </dict>
    </array>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "Built $(pwd)/$APP"
