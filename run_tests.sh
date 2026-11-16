#!/bin/sh
set -e
cd "$(dirname "$0")"
python3 tools/embed_web.py --check
node test/unit.js
[ -x test/ref/gfx_ref ] && node test/pixel_exact.js 100 || echo "skip pixel_exact (build test/ref/build.sh)"
node test/e2e.js
