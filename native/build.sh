#!/usr/bin/env bash
# Builds the app for this machine: ./build.sh [output] (default: ./pivoice,
# or pivoice.exe on Windows). The site it opens comes from PIVOICE_URL
# (CI passes the repo's VITE_PUBLIC_URL); without it, pass --url when you
# run it.
#
# Needs Go, a C compiler and pkg-config, PortAudio and Opus (static
# libraries if you want a binary that runs anywhere: CI builds its own, see
# .github/workflows/release-native.yml), and on Linux WebKitGTK 4.1 and GTK 3.
# NOWEBVIEW=1 builds without the window (--browser and --headless only).
set -euo pipefail
cd "$(dirname "$0")"

out=${1:-pivoice}
case "$(go env GOOS)" in windows) [[ $out == *.exe ]] || out+=.exe ;; esac

# webview_go asks for webkit2gtk-4.0; build/pkgconfig maps that to 4.1.
export PKG_CONFIG_PATH="$PWD/build/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export CGO_ENABLED=1

tags=()
[[ ${NOWEBVIEW:-} == 1 ]] && tags=(-tags nowebview)
ldflags="-s -w -X main.siteURL=${PIVOICE_URL:-}"
# Link PortAudio and Opus statically when asked (CI), so all the binary
# needs from the system is its webview and sound server.
if [[ ${STATIC_AUDIO:-} == 1 ]]; then
  export PKG_CONFIG="pkg-config --static"
fi
# No console window on Windows.
[[ "$(go env GOOS)" == windows ]] && ldflags+=" -H windowsgui"

go build -trimpath "${tags[@]}" -ldflags "$ldflags" -o "$out" .
echo "built $out ($(du -h "$out" | cut -f1))"
