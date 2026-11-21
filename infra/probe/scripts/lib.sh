# Source me. Helpers for live LocalNet probes (HS256 secret "unsafe").
AP=http://localhost:3975; AU=http://localhost:2975; SV=http://localhost:4975
PID=4fe313ea75c585825704535c75a84d299b6c24aaf17282dbe73f9180277a19a4
jwt() { # $1 = sub
  python3 -c '
import sys,hmac,hashlib,base64,json
b=lambda x: base64.urlsafe_b64encode(x).rstrip(b"=")
h=b(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
p=b(json.dumps({"sub":sys.argv[1],"aud":"https://canton.network.global"}).encode())
s=b(hmac.new(b"unsafe",h+b"."+p,hashlib.sha256).digest())
print((h+b"."+p+b"."+s).decode())' "$1"
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
