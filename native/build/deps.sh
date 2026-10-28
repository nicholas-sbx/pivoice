#!/usr/bin/env bash
# Builds PortAudio and Opus as static libraries into build/deps, so the app
# needs nothing from the system but its webview and its sound server (on
# Linux even ALSA is only looked for when the app starts: PA_ALSA_DYNAMIC).
# Then build with STATIC_AUDIO=1 ./build.sh. CI does both.
#
# Needs cmake, a C compiler, curl and git. CMAKE_ARGS adds to every cmake
# configure (CI: universal macOS libraries).
set -euo pipefail
cd "$(dirname "$0")"

OPUS_VERSION=1.5.2
OPUS_SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
PA_TAG=v19.7.0
PA_COMMIT=147dd722548358763a8b649b3e4b41dfffbcfbb6

prefix=$PWD/deps
src=$PWD/deps-src
rm -rf "$prefix" "$src"
mkdir -p "$src"
# shellcheck disable=SC2206
common=(-DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_POSITION_INDEPENDENT_CODE=ON ${CMAKE_ARGS:-})

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

echo "== Opus $OPUS_VERSION"
curl -sSfL "https://github.com/xiph/opus/releases/download/v$OPUS_VERSION/opus-$OPUS_VERSION.tar.gz" -o "$src/opus.tar.gz"
got=$(sha256 "$src/opus.tar.gz")
[[ $got == "$OPUS_SHA256" ]] || { echo "opus tarball checksum mismatch: $got" >&2; exit 1; }
tar -xzf "$src/opus.tar.gz" -C "$src"
cmake -S "$src/opus-$OPUS_VERSION" -B "$src/opus-build" "${common[@]}" \
  -DOPUS_BUILD_SHARED_LIBRARY=OFF -DOPUS_BUILD_TESTING=OFF -DOPUS_BUILD_PROGRAMS=OFF
cmake --build "$src/opus-build" --config Release --parallel
cmake --install "$src/opus-build" --config Release

echo "== PortAudio $PA_TAG"
git -c advice.detachedHead=false clone -q --depth 1 --branch "$PA_TAG" https://github.com/PortAudio/portaudio.git "$src/portaudio"
got=$(git -C "$src/portaudio" rev-parse HEAD)
[[ $got == "$PA_COMMIT" ]] || { echo "portaudio $PA_TAG is $got, expected $PA_COMMIT" >&2; exit 1; }
# Static, and only the host APIs the app uses: ALSA (loaded at run time), CoreAudio, WASAPI/WDM-KS/MME.
cmake -S "$src/portaudio" -B "$src/portaudio-build" "${common[@]}" \
  -DPA_BUILD_SHARED=OFF -DPA_BUILD_STATIC=ON -DPA_LIBNAME_ADD_SUFFIX=OFF \
  -DPA_USE_JACK=OFF -DPA_ALSA_DYNAMIC=ON -DPA_USE_ASIO=OFF -DPA_USE_DS=OFF
cmake --build "$src/portaudio-build" --config Release --parallel
cmake --install "$src/portaudio-build" --config Release

rm -rf "$src"
echo "== in $prefix:"
ls "$prefix/lib"
