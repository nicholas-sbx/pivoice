#!/usr/bin/env bash
# Builds the app's C libraries as static ones into build/deps (or DEPS_DIR):
# PortAudio and Opus, and for the mic's processing RNNoise (noise
# suppression) and SpeexDSP (echo cancellation). So the app needs nothing
# from the system but its webview and its sound server (on Linux even ALSA
# is only looked for when the app starts: PA_ALSA_DYNAMIC). Then build
# with STATIC_AUDIO=1 ./build.sh. CI does both.
#
# ./deps.sh [library…] builds just those (opus portaudio rnnoise speexdsp);
# CI's tests use the system's PortAudio and Opus and only these two.
#
# Needs cmake, a C compiler, curl and git. CMAKE_ARGS adds to every cmake
# configure (CI: one macOS architecture at a time, each into its own DEPS_DIR).
set -euo pipefail
cd "$(dirname "$0")"

OPUS_VERSION=1.5.2
OPUS_SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
PA_TAG=v19.7.0
PA_COMMIT=147dd722548358763a8b649b3e4b41dfffbcfbb6
RNNOISE_VERSION=0.2
RNNOISE_SHA256=90fce4b00b9ff24c08dbfe31b82ffd43bae383d85c5535676d28b0a2b11c0d37
SPEEXDSP_TAG=SpeexDSP-1.2.1
SPEEXDSP_COMMIT=1b28a0f61bc31162979e1f26f3981fc3637095c8

want=("$@")
[[ ${#want[@]} -gt 0 ]] || want=(opus portaudio rnnoise speexdsp)
wants() { [[ " ${want[*]} " == *" $1 "* ]]; }

prefix=${DEPS_DIR:-$PWD/deps}
src=$prefix-src
rm -rf "$prefix" "$src"
mkdir -p "$src"
# shellcheck disable=SC2206
common=(-DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_POSITION_INDEPENDENT_CODE=ON ${CMAKE_ARGS:-})

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# A .pc file for a library built here, so build.sh (and cgo) find it like any other.
pc() {
  mkdir -p "$prefix/lib/pkgconfig"
  cat > "$prefix/lib/pkgconfig/$1.pc" <<EOF
prefix=$prefix
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: $1
Description: $2
Version: $3
Libs: -L\${libdir} -l$1
Libs.private: -lm
Cflags: -I\${includedir}
EOF
}

if wants opus; then
echo "== Opus $OPUS_VERSION"
curl -sSfL "https://github.com/xiph/opus/releases/download/v$OPUS_VERSION/opus-$OPUS_VERSION.tar.gz" -o "$src/opus.tar.gz"
got=$(sha256 "$src/opus.tar.gz")
[[ $got == "$OPUS_SHA256" ]] || { echo "opus tarball checksum mismatch: $got" >&2; exit 1; }
tar -xzf "$src/opus.tar.gz" -C "$src"
cmake -S "$src/opus-$OPUS_VERSION" -B "$src/opus-build" "${common[@]}" \
  -DOPUS_BUILD_SHARED_LIBRARY=OFF -DOPUS_BUILD_TESTING=OFF -DOPUS_BUILD_PROGRAMS=OFF
cmake --build "$src/opus-build" --config Release --parallel
cmake --install "$src/opus-build" --config Release
fi

if wants portaudio; then
echo "== PortAudio $PA_TAG"
git -c advice.detachedHead=false clone -q --depth 1 --branch "$PA_TAG" https://github.com/PortAudio/portaudio.git "$src/portaudio"
got=$(git -C "$src/portaudio" rev-parse HEAD)
[[ $got == "$PA_COMMIT" ]] || { echo "portaudio $PA_TAG is $got, expected $PA_COMMIT" >&2; exit 1; }
# Static, and only the host APIs the app uses: ALSA (loaded at run time), CoreAudio, WASAPI/WDM-KS/MME.
# 19.7.0 asks for an older CMake than CMake 4 still speaks to; it builds fine on the newer rules.
cmake -S "$src/portaudio" -B "$src/portaudio-build" "${common[@]}" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DPA_BUILD_SHARED=OFF -DPA_BUILD_STATIC=ON -DPA_LIBNAME_ADD_SUFFIX=OFF \
  -DPA_USE_JACK=OFF -DPA_ALSA_DYNAMIC=ON -DPA_USE_ASIO=OFF -DPA_USE_DS=OFF
cmake --build "$src/portaudio-build" --config Release --parallel
cmake --install "$src/portaudio-build" --config Release
fi

# RNNoise and SpeexDSP come with autotools builds; a few lines of CMake
# instead build the same files the same way on every platform (and MSYS2
# needs no make). RNNoise picks AVX2 or SSE4.1 when it starts, on x86-64.
if wants rnnoise; then
echo "== RNNoise $RNNOISE_VERSION"
curl -sSfL "https://github.com/xiph/rnnoise/releases/download/v$RNNOISE_VERSION/rnnoise-$RNNOISE_VERSION.tar.gz" -o "$src/rnnoise.tar.gz"
got=$(sha256 "$src/rnnoise.tar.gz")
[[ $got == "$RNNOISE_SHA256" ]] || { echo "rnnoise tarball checksum mismatch: $got" >&2; exit 1; }
tar -xzf "$src/rnnoise.tar.gz" -C "$src"
cat > "$src/rnnoise-$RNNOISE_VERSION/CMakeLists.txt" <<'EOF'
cmake_minimum_required(VERSION 3.10)
project(rnnoise C)
add_library(rnnoise STATIC src/denoise.c src/rnn.c src/pitch.c src/kiss_fft.c src/celt_lpc.c src/nnet.c
  src/nnet_default.c src/parse_lpcnet_weights.c src/rnnoise_data.c src/rnnoise_tables.c)
target_include_directories(rnnoise PRIVATE include src)
target_compile_definitions(rnnoise PRIVATE RNNOISE_BUILD HAVE_STDINT_H DISABLE_DEBUG_FLOAT=1)
if(NOT CMAKE_OSX_ARCHITECTURES AND CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64|amd64)$")
  target_sources(rnnoise PRIVATE src/x86/x86_dnn_map.c src/x86/x86cpu.c src/x86/nnet_sse4_1.c src/x86/nnet_avx2.c)
  target_compile_definitions(rnnoise PRIVATE RNN_ENABLE_X86_RTCD=1 CPU_INFO_BY_ASM=1)
  set_source_files_properties(src/x86/nnet_sse4_1.c PROPERTIES COMPILE_OPTIONS "-msse4.1")
  set_source_files_properties(src/x86/nnet_avx2.c PROPERTIES COMPILE_OPTIONS "-mavx;-mfma;-mavx2")
endif()
install(TARGETS rnnoise ARCHIVE DESTINATION lib)
install(FILES include/rnnoise.h DESTINATION include)
EOF
cmake -S "$src/rnnoise-$RNNOISE_VERSION" -B "$src/rnnoise-build" "${common[@]}"
cmake --build "$src/rnnoise-build" --config Release --parallel
cmake --install "$src/rnnoise-build" --config Release
pc rnnoise "RNN-based noise suppression" "$RNNOISE_VERSION"
fi

# Only the echo canceller and the preprocessor (its residual echo suppression), in floating point.
if wants speexdsp; then
echo "== SpeexDSP $SPEEXDSP_TAG"
git -c advice.detachedHead=false clone -q --depth 1 --branch "$SPEEXDSP_TAG" https://github.com/xiph/speexdsp.git "$src/speexdsp"
got=$(git -C "$src/speexdsp" rev-parse HEAD)
[[ $got == "$SPEEXDSP_COMMIT" ]] || { echo "speexdsp $SPEEXDSP_TAG is $got, expected $SPEEXDSP_COMMIT" >&2; exit 1; }
cat > "$src/speexdsp/include/speex/speexdsp_config_types.h" <<'EOF'
#ifndef __SPEEX_TYPES_H__
#define __SPEEX_TYPES_H__
#include <stdint.h>
typedef int16_t spx_int16_t;
typedef uint16_t spx_uint16_t;
typedef int32_t spx_int32_t;
typedef uint32_t spx_uint32_t;
#endif
EOF
cat > "$src/speexdsp/CMakeLists.txt" <<'EOF'
cmake_minimum_required(VERSION 3.10)
project(speexdsp C)
add_library(speexdsp STATIC libspeexdsp/mdf.c libspeexdsp/preprocess.c libspeexdsp/fftwrap.c
  libspeexdsp/filterbank.c libspeexdsp/smallft.c)
target_include_directories(speexdsp PRIVATE include libspeexdsp)
target_compile_definitions(speexdsp PRIVATE FLOATING_POINT USE_SMALLFT VAR_ARRAYS EXPORT=)
install(TARGETS speexdsp ARCHIVE DESTINATION lib)
install(FILES include/speex/speex_echo.h include/speex/speex_preprocess.h include/speex/speexdsp_types.h
  include/speex/speexdsp_config_types.h DESTINATION include/speex)
EOF
cmake -S "$src/speexdsp" -B "$src/speexdsp-build" "${common[@]}"
cmake --build "$src/speexdsp-build" --config Release --parallel
cmake --install "$src/speexdsp-build" --config Release
pc speexdsp "Speex echo canceller and preprocessor" "${SPEEXDSP_TAG#SpeexDSP-}"
fi

rm -rf "$src"
echo "== in $prefix:"
ls "$prefix/lib"
