#!/usr/bin/env bash
# Proves that a sandboxed headless Chrome starts and loads a page (CI, "Ensure Chrome (sandboxed)"), within a deadline.
#
#   scripts/ci-chrome-probe.sh <chrome executable> [deadline in seconds, default 120]
#
# Chromium's own sandbox stays on: never --no-sandbox. The flags keep Chrome from waiting on anything a CI runner cannot
# answer: first-run and default-browser prompts, the keychain (mock keychain, so the real one is never read), the GPU of a
# display-less VM, component and background network traffic. On the macOS runner (Chrome 152, macOS 26) the bare
# `--headless=new --dump-dom about:blank` started and never exited (the job was cancelled after 25 minutes), so the probe
# has a hard deadline for the page load (past it, the step fails) and a short grace for the shutdown; in both cases only
# the Chrome it started (its process group) is killed. macOS has no `timeout`: the deadline is a plain bash loop.
set -euo pipefail

CHROME="${1:?usage: ci-chrome-probe.sh <chrome executable> [deadline seconds]}"
DEADLINE="${2:-120}"
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/ms-chrome-probe.XXXXXX")"
OUT="$PROFILE.dom"
ERR="$PROFILE.err"
cleanup() { rm -rf "$PROFILE" "$OUT" "$ERR"; }
trap cleanup EXIT

# Its own process group (job control), so a timeout kills Chrome's helpers too, and nothing else.
set -m
"$CHROME" --headless=new --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --disable-gpu \
  --disable-extensions --disable-sync --disable-background-networking --disable-component-update \
  --disable-default-apps --no-service-autorun --use-mock-keychain --password-store=basic \
  --dump-dom 'data:text/html,<title>ms-chrome-probe</title>' > "$OUT" 2> "$ERR" &
PID=$!
set +m

# Done when the page's DOM is out: that is the proof. Chrome's own teardown after it is not what is checked here, and it
# is not trusted to end: locally (Chrome 155) it sometimes takes ~20 s and ends by its "teardown watchdog" (exit 2); on the
# macOS runner (Chrome 152) it never ended. So after the DOM, Chrome gets a short grace, then its group is killed.
loaded=""
for ((i = 0; i < DEADLINE * 10; i++)); do
  if grep -q 'ms-chrome-probe' "$OUT" 2> /dev/null; then loaded=1; break; fi
  kill -0 "$PID" 2> /dev/null || break
  sleep 0.1
done
if [ -z "$loaded" ] && grep -q 'ms-chrome-probe' "$OUT" 2> /dev/null; then loaded=1; fi
for ((j = 0; j < 100; j++)); do kill -0 "$PID" 2> /dev/null || break; sleep 0.1; done
if kill -0 "$PID" 2> /dev/null; then
  kill -KILL -- "-$PID" 2> /dev/null || kill -KILL "$PID" 2> /dev/null || true
  STATUS=killed
fi
STATUS_CODE=0
wait "$PID" 2> /dev/null || STATUS_CODE=$?
STATUS="${STATUS:-$STATUS_CODE}"
if [ -z "$loaded" ]; then
  echo "::error::sandboxed headless Chrome did not load a page (deadline ${DEADLINE} s, exit: $STATUS); its stderr follows" >&2
  tail -n 40 "$ERR" >&2 || true
  exit 1
fi
if [ "$STATUS" != 0 ]; then echo "::warning::Chrome loaded the page but did not shut down cleanly (exit: $STATUS)"; fi
echo "Chrome probe: sandboxed headless page load OK in $((i / 10)) s"
