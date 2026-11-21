#!/usr/bin/env bash
# Re-upload a CHANGED sa-probe (extra field) under the same version 0.1.0; capture the error.
# Works on a scratch copy so the committed source stays unchanged.
set -u
cd "$(dirname "$0")/.." && . scripts/lib.sh
T=${TMPDIR:-/tmp}/sa-probe-conflict-$$
mkdir -p "$T" && cp -R daml.yaml daml "$T"/
sed -i.bak 's/    obs : \[Party\]/    obs : [Party]\n    extra : Int/' "$T/daml/Probe.daml"
(cd "$T" && ~/.dpm/bin/dpm build >/dev/null 2>&1) || { echo "build failed"; exit 1; }
OUT=../../packages/ledger-client/test/fixtures/upload-conflict.json
RESP=$(curl -s -w '\n%{http_code}' -X POST "$AP/v2/dars?vetAllPackages=true" -H "Authorization: Bearer $(jwt ledger-api-user)" -H 'Content-Type: application/octet-stream' --data-binary @"$T/.daml/dist/sa-probe-0.1.0.dar")
CODE=${RESP##*$'\n'}; BODY=${RESP%$'\n'*}
echo "HTTP $CODE"; echo "$BODY" | cut -c1-1500
python3 -c 'import sys,json; b=json.loads(sys.argv[1]); b["_httpStatus"]=int(sys.argv[2]); print(json.dumps(b,indent=2))' "$BODY" "$CODE" > $OUT
