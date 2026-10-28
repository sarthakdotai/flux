#!/bin/zsh
# Builds Flux.app (native window, notifications, bundled server) and installs it to /Applications.
# config.env is optional: without it the app runs its server on this Mac; FLUX_HOST makes a
# remote server the default, and FLUX_BUNDLE_ID sets the app's identifier.
set -e
cd "${0:A:h}"

[[ -f ../config.env ]] && source ../config.env
FLUX_BUNDLE_ID=${FLUX_BUNDLE_ID:-com.example.flux}

APP=build/Flux.app
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/Flux.iconset

# Icon: draw at 1024, scale to every size macOS wants, pack into .icns.
swift make-icon.swift ../design/asterisk.path build/icon-1024.png
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon-1024.png --out build/Flux.iconset/icon_${s}x${s}.png >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon-1024.png --out build/Flux.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns build/Flux.iconset -o "$APP/Contents/Resources/Flux.icns"

# The server, bundled so the app works on its own. Personal files (rules.json, config, data) stay out.
[[ -d ../node_modules ]] || (cd .. && npm ci --omit=dev)
rsync -a ../*.js ../package.json ../rules.example.json ../public ../node_modules "$APP/Contents/Resources/server/"

# Remote-server defaults come from config.env, never from the source.
cat > build/FluxConfig.swift <<SWIFT
enum FluxConfig {
    static let host = "${FLUX_HOST:-}"
    static let sshKey = "${FLUX_SSH_KEY:-~/.ssh/id_ed25519}"
}
SWIFT

swiftc -O -swift-version 5 -target arm64-apple-macos13.0 \
  -framework AppKit -framework WebKit -framework UserNotifications -framework ServiceManagement \
  main.swift build/FluxConfig.swift -o "$APP/Contents/MacOS/Flux"
cp Info.plist "$APP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$FLUX_BUNDLE_ID" "$APP/Contents/Info.plist"

# Signing: macOS only allows notifications from apps with a real signing identity. Use
# FLUX_SIGN_IDENTITY if set, else the first "Apple Development" identity on this Mac (free:
# Xcode → Settings → Accounts → add your Apple ID → Manage Certificates → +). With none,
# sign ad-hoc: the app works, but macOS blocks its notifications.
if [[ -z "${FLUX_SIGN_IDENTITY:-}" ]]; then
  FLUX_SIGN_IDENTITY=$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ {print $2; exit}')
fi
if [[ -n "${FLUX_SIGN_IDENTITY:-}" ]]; then
  echo "Signing with: $FLUX_SIGN_IDENTITY"
else
  echo "WARNING: no Apple Development identity found. Flux will run, but macOS will block its notifications." >&2
  echo "         Fix: Xcode → Settings → Accounts → add your Apple ID → Manage Certificates → + Apple Development, then rebuild." >&2
fi
codesign --force --deep --sign "${FLUX_SIGN_IDENTITY:--}" "$APP"

rm -rf /Applications/Flux.app
cp -R "$APP" /Applications/Flux.app
echo "Installed /Applications/Flux.app"
