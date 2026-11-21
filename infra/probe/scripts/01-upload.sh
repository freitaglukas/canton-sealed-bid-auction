#!/usr/bin/env bash
# Upload sa-probe DAR to all 3 participants, then check status + vetting.
cd "$(dirname "$0")/.." && . scripts/lib.sh
DAR=.daml/dist/sa-probe-0.1.0.dar
for b in $AP $AU $SV; do echo "== upload $b"; upload $b $DAR; done
for b in $AP $AU $SV; do echo "== status $b"; api $b ledger-api-user GET /v2/packages/$PID/status; done
echo "== vetting (sv)"; api $SV ledger-api-user POST /v2/package-vetting/list '{}' | head -c 1500
