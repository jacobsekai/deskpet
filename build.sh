#!/bin/bash
# Compiles DeskPet into DeskPet.app next to this script.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p build
# Universal binary: Apple Silicon and Intel.
for arch in arm64 x86_64; do
    swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" -framework AppKit -framework WebKit -framework ServiceManagement \
        -o "build/DeskPet-$arch" Sources/*.swift
done
lipo -create -output build/DeskPet build/DeskPet-arm64 build/DeskPet-x86_64

APP=DeskPet.app
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
mkdir -p "$WEB/wizard" "$WEB/renderer"
cp electron/src/wizard/index.html electron/src/wizard/wizard.css electron/src/wizard/wizard.js "$WEB/wizard/"
cp electron/src/renderer/color.js electron/src/renderer/pet.js electron/src/renderer/sprites.js "$WEB/renderer/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>DeskPet</string>
    <key>CFBundleIdentifier</key><string>local.deskpet</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
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
