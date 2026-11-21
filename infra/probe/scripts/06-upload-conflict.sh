#!/usr/bin/env bash
# Re-upload a CHANGED sa-probe (extra field) under the same version 0.1.0; capture the error.
# Works on a scratch copy so the committed source stays unchanged.
set -u
cd "$(dirname "$0")/.." && . scripts/lib.sh
T=${TMPDIR:-/tmp}/sa-probe-conflict-$$
mkdir -p "$T" && cp -R daml.yaml daml "$T"/
sed -i.bak 's/    obs : \[Party\]/    obs : [Party]\n    extra : Int/' "$T/daml/Probe.daml"
(cd "$T" && "$DPM" build >/dev/null 2>&1) || { echo "build failed"; exit 1; }
OUT=../../packages/ledger-client/test/fixtures/upload-conflict.json
RESP=$(curl -s -w '\n%{http_code}' -X POST "$AP/v2/dars?vetAllPackages=true" -H "Authorization: Bearer $(jwt ledger-api-user)" -H 'Content-Type: application/octet-stream' --data-binary @"$T/.daml/dist/sa-probe-0.1.0.dar")
CODE=${RESP##*$'\n'}; BODY=${RESP%$'\n'*}
echo "HTTP $CODE"; echo "$BODY" | cut -c1-1500
# Fail loudly unless the body is JSON and the status is an error (>= 400); write the fixture only then.
python3 -c '
import sys,json
try: b=json.loads(sys.argv[1])
except Exception: sys.exit("upload-conflict: response body is not JSON: "+sys.argv[1][:200])
c=int(sys.argv[2])
if c<400: sys.exit("upload-conflict: expected an error but got HTTP %d (already uploaded?)"%c)
b["_httpStatus"]=c
open(sys.argv[3],"w").write(json.dumps(b,indent=2)+"\n")' "$BODY" "$CODE" "$OUT" || exit 1
