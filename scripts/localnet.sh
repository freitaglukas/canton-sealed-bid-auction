#!/usr/bin/env bash
# Pinned Splice LocalNet (cn-quickstart 374f2d6: Splice 0.9.4 / Daml 3.6.3).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CNQS_COMMIT=374f2d6
CNQS_DIR="$ROOT/.localnet/cn-quickstart"
TOPOLOGY="${TOPOLOGY:-$ROOT/config/topology.json}"

ensure_clone() {
  if [ ! -d "$CNQS_DIR" ]; then
    git clone -q https://github.com/digital-asset/cn-quickstart "$CNQS_DIR"
  fi
  git -C "$CNQS_DIR" checkout -q "$CNQS_COMMIT"
}

qs() { ensure_clone; make -C "$CNQS_DIR/quickstart" "$@"; }

status() {
  local deadline=$(( $(date +%s) + ${READY_TIMEOUT:-600} ))
  local urls
  urls=$(node -e 'const t=require(process.argv[1]);console.log(Object.values(t.participants).join("\n"))' "$TOPOLOGY")
  for u in $urls; do
    until curl -fsS -o /dev/null "$u/readyz"; do
      if [ "$(date +%s)" -gt "$deadline" ]; then echo "NOT READY: $u"; exit 1; fi
      sleep 5
    done
    echo "200 $u"
  done
}

case "${1:-}" in
  up) qs start-localnet ;;
  down) qs stop-localnet ;;
  clean) qs clean-localnet ;;
  ps) qs status-localnet ;;
  status) status ;;
  reset) qs clean-localnet; qs start-localnet; status; make -C "$ROOT" deploy provision ;;
  *) echo "usage: $0 up|down|clean|ps|status|reset"; exit 2 ;;
esac
