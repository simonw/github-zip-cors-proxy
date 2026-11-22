#!/usr/bin/env bash
# Deploy the Worker to Cloudflare, then optionally smoke-test it.
#
#   ./deploy.sh                      deploy only
#   ./deploy.sh https://NAME.SUBDOMAIN.workers.dev
#                                    deploy, then smoke-test that URL
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx not found. Install Node.js 18 or later first." >&2
  exit 1
fi

echo "Running tests..."
node --test test/index.test.js

if ! npx --yes wrangler@latest whoami >/dev/null 2>&1; then
  echo "Not logged in to Cloudflare; opening login..."
  npx --yes wrangler@latest login
fi

echo "Deploying..."
npx --yes wrangler@latest deploy

URL="${1:-}"
if [ -z "$URL" ]; then
  echo
  echo "Deployed. Re-run with the workers.dev URL printed above to smoke-test:"
  echo "  ./deploy.sh https://github-zip-cors-proxy.YOUR-SUBDOMAIN.workers.dev"
  exit 0
fi

URL="${URL%/}"
SHA="be0ce3e85f3b7d8e811ab01db4f0dc304f09b025"
TARGET="$URL/simonw/datasette/$SHA"

check() { # description, expected status, curl args...
  local desc="$1" want="$2"; shift 2
  local got
  got=$(curl -sS -o /dev/null -w '%{http_code}' "$@")
  if [ "$got" = "$want" ]; then
    echo "  ok    $desc ($got)"
  else
    echo "  FAIL  $desc (wanted $want, got $got)"; FAILED=1
  fi
}

FAILED=0
echo "Smoke-testing $URL"
check "allowed origin gets the zip" 200 -H "Origin: https://lite.datasette.io" "$TARGET"
check "localhost origin is allowed" 200 -H "Origin: http://localhost:8123" "$TARGET"
check "other origins are refused"   403 -H "Origin: https://example.com" "$TARGET"
check "missing origin is refused"   403 "$TARGET"
check "other owners are refused"    403 -H "Origin: https://lite.datasette.io" "$URL/python/cpython/$SHA"
check "datasette org is allowed"    200 -H "Origin: https://lite.datasette.io" "$URL/datasette/datasette-arrows/main"
check "branch names work"           200 -H "Origin: https://lite.datasette.io" "$URL/simonw/datasette/main"
check "tags work"                   200 -H "Origin: https://lite.datasette.io" "$URL/simonw/datasette/1.0a19"
check "unknown refs are a 404"      404 -H "Origin: https://lite.datasette.io" "$URL/simonw/datasette/no-such-branch-or-tag"
check "bad paths are refused"       400 -H "Origin: https://lite.datasette.io" "$URL/simonw/datasette/a//b"
exit $FAILED
