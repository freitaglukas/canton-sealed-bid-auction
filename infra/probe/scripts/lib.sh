# Source me. Helpers for live LocalNet probes (HS256 secret "unsafe").
# Run order: 01 -> 02 -> 03 (creates ../.state.json) -> 04..09 (04-09 mjs need it). Overridable via env.
AP=${PROVIDER_URL:-http://localhost:3975}; AU=${USER_URL:-http://localhost:2975}; SV=${SV_URL:-http://localhost:4975}
LEDGER_SECRET=${LEDGER_SECRET:-unsafe}
DPM=${DPM:-$(command -v dpm || echo ~/.dpm/bin/dpm)}
# Package id derived from the built DAR (run `dpm build` in infra/probe first).
PID=$("$DPM" damlc inspect-dar --json "$(dirname "${BASH_SOURCE[0]}")/../.daml/dist/sa-probe-0.1.0.dar" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["main_package_id"])')
jwt() { # $1 = sub
  python3 -c '
import sys,hmac,hashlib,base64,json
b=lambda x: base64.urlsafe_b64encode(x).rstrip(b"=")
h=b(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
p=b(json.dumps({"sub":sys.argv[1],"aud":"https://canton.network.global"}).encode())
s=b(hmac.new(sys.argv[2].encode(),h+b"."+p,hashlib.sha256).digest())
print((h+b"."+p+b"."+s).decode())' "$1" "$LEDGER_SECRET" "$LEDGER_SECRET"
}
# api BASE SUB METHOD PATH [JSON-BODY]  -> prints body, then "_HTTP <status>" line
api() {
  local base=$1 sub=$2 m=$3 path=$4 body=${5:-}
  if [ -n "$body" ]; then
    curl -s -w '\n_HTTP %{http_code}\n' -X "$m" "$base$path" -H "Authorization: Bearer $(jwt "$sub")" -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n_HTTP %{http_code}\n' -X "$m" "$base$path" -H "Authorization: Bearer $(jwt "$sub")"
  fi
}
upload() { # BASE DAR
  curl -s -w '\n_HTTP %{http_code}\n' -X POST "$1/v2/dars?vetAllPackages=true" -H "Authorization: Bearer $(jwt ledger-api-user)" -H 'Content-Type: application/octet-stream' --data-binary @"$2"
}
