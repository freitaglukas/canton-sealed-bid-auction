# sa-probe live LocalNet probes

Run order (cwd `infra/probe`): `dpm build`, then `scripts/01-upload.sh`, `02-vetting.sh`, `node scripts/03-setup-and-auditor.mjs` (creates `.state.json`, required by 04-09), then `04`..`09` (`06` is bash). The package id is derived from the built DAR; the template id uses `#sa-probe:Probe:P`.
Env overrides (defaults in parens): `PROVIDER_URL` (:3975), `USER_URL` (:2975), `SV_URL` (:4975), `LEDGER_SECRET` (unsafe), `DPM` (dpm on PATH, else ~/.dpm/bin/dpm).
