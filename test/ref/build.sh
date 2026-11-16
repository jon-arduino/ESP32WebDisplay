#!/usr/bin/env bash
# Build the reference receiver against the real Adafruit_GFX sources.
# ADAFRUIT_GFX_DIR may point at an existing checkout's src/ directory; otherwise it is cloned.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="${ADAFRUIT_GFX_DIR:-$here/adafruit-gfx/src}"
if [ ! -f "$src/Adafruit_GFX.cpp" ]; then
  git clone --depth 1 https://github.com/adafruit/Adafruit-GFX-Library "$here/adafruit-gfx"
  src="$here/adafruit-gfx/src"
fi
g++ -std=c++17 -O1 -w -DARDUINO=100 -I "$here/stubs" -I "$src" \
    "$here/gfx_ref.cpp" "$src/Adafruit_GFX.cpp" -o "$here/gfx_ref"
echo "built $here/gfx_ref (Adafruit_GFX from $src)"
