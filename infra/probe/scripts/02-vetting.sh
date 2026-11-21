#!/usr/bin/env bash
# Is sa-probe vetted on each participant? (grep the vetting list)
cd "$(dirname "$0")/.." && . scripts/lib.sh
for b in $AP $AU $SV; do echo "== $b"; api $b ledger-api-user POST /v2/package-vetting/list '{}' | grep -o '"packageId":"'$PID'[^}]*}' ; done
