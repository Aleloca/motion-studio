#!/usr/bin/env bash
# Builds whisper.cpp's `whisper-cli` for the macOS desktop app (video analysis, spec §7): pinned to v1.9.5, Metal embedded in
# the binary and static libraries (nothing to ship beside it), plus the Silero VAD model and whisper.cpp's licence.
#
#   scripts/build-whisper.sh <arm64|x64> <outDir>      → <outDir>/<arm64|x64>/{whisper-cli, ggml-silero-v6.2.0.bin, LICENSE}
#
# macOS only (Xcode command line tools, cmake, git, curl, shasum). Used by the release workflow before packaging; it can run on
# a maintainer's Mac the same way. The tag must point at the commit recorded below and the VAD model must match its sha256,
# or nothing is written.
set -euo pipefail

WHISPER_CPP_REPO="https://github.com/ggml-org/whisper.cpp.git"
WHISPER_CPP_TAG="v1.9.5"
# The commit the tag points at, checked after the clone (a moved tag fails the build). Record it when the pin changes:
#   git ls-remote https://github.com/ggml-org/whisper.cpp.git 'refs/tags/v1.9.5^{}'
WHISPER_CPP_COMMIT="${WHISPER_CPP_COMMIT_OVERRIDE:-RECORD-THE-V1.9.5-COMMIT}"
# Silero VAD v6.2.0, pinned to the Hugging Face commit the core's manifest uses (packages/core/src/transcription/models.ts).
VAD_FILE="ggml-silero-v6.2.0.bin"
VAD_URL="https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/${VAD_FILE}"
VAD_SHA256="2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"
VAD_BYTES=885098
# The oldest macOS the binary runs on (the Electron app's own minimum).
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"

usage() { echo "usage: $0 <arm64|x64> <outDir>" >&2; exit 2; }
[ "$#" -eq 2 ] || usage
ARCH="$1"
OUT="$2"
case "$ARCH" in
  arm64) CMAKE_ARCH=arm64 ;;
  x64) CMAKE_ARCH=x86_64 ;;
  *) usage ;;
esac
[ "$(uname -s)" = "Darwin" ] || { echo "error: whisper-cli is built for macOS only" >&2; exit 1; }
if ! printf '%s' "$WHISPER_CPP_COMMIT" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "error: record the commit of whisper.cpp ${WHISPER_CPP_TAG} in WHISPER_CPP_COMMIT (scripts/build-whisper.sh)" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ms-whisper-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "whisper.cpp ${WHISPER_CPP_TAG} for ${ARCH}"
git -c advice.detachedHead=false clone --depth 1 --branch "$WHISPER_CPP_TAG" "$WHISPER_CPP_REPO" "$WORK/src"
got="$(git -C "$WORK/src" rev-parse 'HEAD^{commit}')"
if [ "$got" != "$WHISPER_CPP_COMMIT" ]; then
  echo "error: ${WHISPER_CPP_TAG} is ${got}, expected ${WHISPER_CPP_COMMIT}" >&2
  exit 1
fi

cmake -S "$WORK/src" -B "$WORK/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$CMAKE_ARCH" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DGGML_NATIVE=OFF
cmake --build "$WORK/build" --config Release --target whisper-cli -j "$(sysctl -n hw.ncpu)"
BIN="$WORK/build/bin/whisper-cli"
[ -x "$BIN" ] || { echo "error: whisper-cli was not built" >&2; exit 1; }

# The right architecture, and only system libraries and frameworks (static build: no libwhisper/libggml beside it).
lipo -archs "$BIN" | grep -qx "$CMAKE_ARCH" || { echo "error: $(lipo -archs "$BIN") is not ${CMAKE_ARCH}" >&2; exit 1; }
foreign="$(otool -L "$BIN" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/Library/)' || true)"
if [ -n "$foreign" ]; then
  echo "error: whisper-cli links libraries outside the system:" >&2
  echo "$foreign" >&2
  exit 1
fi

curl --fail --silent --show-error --location --proto '=https' --max-redirs 3 -o "$WORK/$VAD_FILE" "$VAD_URL"
size="$(stat -f %z "$WORK/$VAD_FILE")"
sum="$(shasum -a 256 "$WORK/$VAD_FILE" | awk '{print $1}')"
if [ "$size" != "$VAD_BYTES" ] || [ "$sum" != "$VAD_SHA256" ]; then
  echo "error: ${VAD_FILE} is ${size} bytes, sha256 ${sum}; expected ${VAD_BYTES}, ${VAD_SHA256}" >&2
  exit 1
fi

DEST="$OUT/$ARCH"
rm -rf "$DEST"
mkdir -p "$DEST"
install -m 0755 "$BIN" "$DEST/whisper-cli"
install -m 0644 "$WORK/$VAD_FILE" "$DEST/$VAD_FILE"
install -m 0644 "$WORK/src/LICENSE" "$DEST/LICENSE"
# Started once when it is this Mac's architecture (the other one may have no Rosetta on the runner).
if [ "$(uname -m)" = "$CMAKE_ARCH" ]; then
  "$DEST/whisper-cli" --help >/dev/null 2>&1 || { echo "error: the built whisper-cli does not start" >&2; exit 1; }
fi
echo "whisper-cli ${WHISPER_CPP_TAG} (${ARCH}) → ${DEST}"
