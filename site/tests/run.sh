#!/bin/sh
# Local tests of the whole website (build, local Cloudflare server, browsers). From site/: npm test
set -e
cd "$(dirname "$0")/.."
python3 ../tools/build_site.py
pkill -f "wrangler dev --local --port 8787" 2>/dev/null || true
./node_modules/.bin/wrangler dev --local --port 8787 --ip 127.0.0.1 > /tmp/wrangler-dev.log 2>&1 &
for i in $(seq 1 60); do sleep 1; curl -s -o /dev/null http://127.0.0.1:8787/ && break; done
echo "== website (browsers)"; (cd ../tests/pw && node site.pw.mjs all | tail -1)
echo "== languages and right-to-left"; (cd ../tests/pw && node i18n.pw.mjs all | tail -1)
