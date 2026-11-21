# Canton sealed-bid auction — research summary (2026-11-21)

Docs moved: use docs.canton.network (docs.daml.com / docs.dev.sync.global are obsolete/deprecated).

## Versions (pin together)
- SDK `3.6.3`, Splice `0.9.4` (Canton 3.6.4) — what cn-quickstart `main` pins.
- Newer exists (Splice 0.10.x / Canton 3.7, PV37) but unverified against DevNet; stay on the quickstart pair.
- Verified by review: 3.6 line defaults to LF 2.3. cn-quickstart commit `374f2d6` pins 3.6.3 / 0.9.4 (Canton 3.6.4).
  JSON API OpenAPI for 3.6.4: github.com/digital-asset/canton tag v3.6.4, community/ledger/ledger-json-api/src/test/resources/json-api-docs/openapi.yaml.
- `submit-and-wait-for-transaction` defaults to ACS_DELTA (no exercise results): send transactionFormat LEDGER_EFFECTS. ACS needs explicit activeAtOffset.
- (old note) Daml 3.x LF 2.1 default. Contract keys only return in LF 2.3 (non-unique) → don't use keys.

## Contract design (early research — SUPERSEDED by docs/superpowers/specs/2026-11-21-sealed-bid-auction-design.md; no commit-reveal)
- Commit-reveal: auctioneer sees only `sha256(amount|salt|bidder|auctionId)` until close.
- `Auction` (sig auctioneer, obs seller) → `AuctionInvitation` per bidder (sig auctioneer, obs bidder, nonconsuming `PlaceBid`)
  → `SealedBid` (sig bidder+auctioneer, `Reveal`, `Withdraw`) → `RevealedBid` → `Auction_Close` → `AuctionResult` (obs seller, winner, participants).
- Deadlines: `assertWithinDeadline` / `assertDeadlineExceeded` (not `getTime`); leave minutes of margin (ledger time skew ~1 min).
- Salt ≥128 bits, kept off-ledger. Canonical amount formatting shared by client + choice.
- Privacy is per participant node: put bidders on different participants (app-user vs app-provider) to demonstrate real confidentiality.
- Settlement: plain-Daml MVP first; phase 2 = Token Standard V1 `AllocationRequest` (see splice `TradingApp.daml`).
- Separate `auction-tests` package (don't upload test code). Copy layout from cn-quickstart `quickstart/daml/licensing`.

## Toolchain
```sh
curl https://get.digitalasset.com/install/install.sh | sh
export PATH="$HOME/.dpm/bin:$PATH"; dpm install 3.6.3
dpm build --all ; dpm test --junit out.xml --show-coverage
dpm sandbox --dar <dar> --json-api-port 7575 --static-time   # gRPC 6865
```
`daml ledger upload-dar` etc. are gone — use JSON API / console.

## LocalNet
- `git clone cn-quickstart; cd quickstart; make start-localnet` (standalone, no Nix/Keycloak).
- Ports `<prefix><suffix>`: prefix 2=app-user, 3=app-provider, 4=sv; 901 gRPC, 902 admin, 903 validator admin, 975 JSON v2.
- Auth: HS256 shared secret `unsafe`, `aud=https://canton.network.global`, `sub=ledger-api-user`.
  Admin ≠ actAs: grant rights or pass `userId` when allocating parties.
- Memory: ~12.5 GB limits; Docker here has ~35 GB / 18 CPU — fine.

## Deploy + verify
- Upload to BOTH participants: `POST localhost:{3975,2975}/v2/dars?vetAllPackages=true` (octet-stream).
- Verify: `GET /v2/packages`, `GET /v2/packages/<id>/status`, `POST /v2/package-vetting/list`, `POST /v2/state/active-contracts`
  (template filter `#sealed-auction:Module:Template`).
- Parties: `POST /v2/parties {partyIdHint,userId}`; users `POST /v2/users`; rights `POST /v2/users/<id>/rights`.

## Testing pyramid
1. Daml Script unit tests (`dpm test`): auth (`submitMustFail`), deadlines (`setTime`/`passTime`), privacy (`queryContractId` → None for non-owners), winner/tie/no-bid.
2. Sandbox (`--static-time`) + `dpm script`.
3. LocalNet smoke script: readyz → token → upload/verify DAR on both participants → allocate parties across participants →
   `dpm script --participant-config` (wall-clock; deadlines now+N s) → assert winner + no cross-bidder leak via `/v2/updates` LEDGER_EFFECTS.
- LocalNet is wall-clock: `setTime` fails there; deadlines must be contract params.

## Integration (if we add an app)
- cn-quickstart: Java/Spring + gRPC + PQS. Lighter option: Node/TS backend on JSON API v2 (OpenAPI client from `/docs/openapi`) + `dpm codegen-js`.
- Keep a backend in front of the ledger (don't give ledger tokens to the browser). `@daml/react` / JSON API v1 removed.

## Verified on this machine (LocalNet 0.9.4, Canton 3.6.4, dpm SDK 3.6.3; probes in `infra/probe/scripts/`)
- **Build:** `dpm build` -> `sa-probe-0.1.0.dar`, main package LF **2.3** (`dpm damlc inspect`), stdlib `daml-stdlib-3.6.2`. No `--target`.
  Package id of probe: `4fe313ea75c585825704535c75a84d299b6c24aaf17282dbe73f9180277a19a4`.
- **Upload:** `POST /v2/dars?vetAllPackages=true` returns `200 {}` on app-provider, app-user AND **sv** (sv accepts the DAR).
  `GET /v2/packages/<id>/status` -> `{"packageStatus":"PACKAGE_STATUS_REGISTERED"}` (exact literal; same on all 3).
  `POST /v2/package-vetting/list` with body `{}` -> `{"vettedPackages":[{"packages":[{packageId,packageName,packageVersion,...}]}]}`; sa-probe vetted on all 3 (3 entries each, by participant/synchronizer view).
- **sv hosts parties:** `POST /v2/parties {"partyIdHint":"probe-x-sv","identityProviderId":""}` on :4975 -> 200. A user on sv with CanActAs can create `P` there (200). A sv-party contract with `obs=[app-user party]` is visible on app-user's participant (cross-participant ok).
- **Auditor** (`POST /v2/users` with `rights:[{"kind":{"CanReadAsAnyParty":{"value":{}}}}]`, created separately on each node; users are per-participant):
  `POST /v2/state/active-contracts {activeAtOffset, eventFormat:{filtersForAnyParty:{cumulative:[TemplateFilter]}, verbose}}` works.
  Positive control: auditor on sv sees the sv-party contract (only that one); on app-provider sees provider contracts; on app-user sees its own + the sv contract it observes. Per-node only: sv auditor never sees provider-only contracts.
  Negatives: a normal user (CanActAs/ReadAs own party) using `filtersForAnyParty` -> **403 `code:"NA"`**. The admin user `ledger-api-user` also cannot use `filtersForAnyParty`/`/v2/updates` with any-party filter (403 NA): create an explicit auditor user.
- **JSON types:** Decimal = `Numeric 10`, rendered as a string with exactly 10 fraction digits: `150` / `"150"` -> `"150.0000000000"`, `"0.1"` -> `"0.1000000000"`; 18 integer digits ok. Input accepts JSON number or string; `"1e2"` -> 400 `INVALID_ARGUMENT` (could not read Numeric); `"1.00000000005"` -> 400 `COMMAND_PREPROCESSING_FAILED` (precision loss). **Int is a string** both ways (`"7"`; JSON number `7` -> 500 `LEDGER_API_INTERNAL_ERROR` "Expected ujson.Str"). Time = ISO string `"2026-11-21T10:00:00Z"`.
- **Result cap (`/v2/updates`, `/v2/state/active-contracts`):** node limit **200** elements. If more match, the call FAILS (no truncation): **HTTP 413 `JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED`** ("matching elements (201) is greater than the node limit (200)", errorCategory 2, retryInfo "1 second"). A `?limit=N` query param with N<=200 returns exactly N; N>200 still 413. Paging works: `?limit=100`, then `beginExclusive = update.Transaction.value.offset` of the last item (verified 100+100+85). ACS: use the same cap rule (or `streamContinuationToken` in the schema).
- **Restart persistence (inferred, not tested):** participants use `storage type = postgres` (`conf/canton/app.conf`), DB in named volume `postgres` (docker volume `localnet_postgres`). `make localnet-down` = `stop-localnet` = `compose down` WITHOUT `-v` -> volume kept -> parties, users, uploaded DARs and contracts should survive down/up. `localnet-clean`/`reset` = `down -v` wipes everything.
- **failWithStatus works on 3.6.3:** `import DA.Fail; failWithStatus FailureStatus{errorId="SA_PROBE_STATUS", category=InvalidGivenCurrentSystemStateOther, message="SA_PROBE_STATUS: ...", meta=TextMap.empty}` compiles. The errorId surfaces in **`context.error_id`** (= `"SA_PROBE_STATUS"`), also in `cause` ("User failure: SA_PROBE_STATUS (error category 9): <message>"). `code` is plain `DAML_FAILURE`. `assertMsg`: `code` `DAML_FAILURE`, `context.error_id` = `"UNHANDLED_EXCEPTION/DA.Exception.AssertionFailed:AssertionFailed"`, custom text only at the end of `cause`. So `failWithStatus` is the structured option: read `context.error_id`.
- **Error `code` values (fixtures in `packages/ledger-client/test/fixtures/`; each has `_httpStatus`):**

  | case | HTTP | `code` | notes |
  |---|---|---|---|
  | not-found (well-formed unknown cid, or already archived) | 404 | `CONTRACT_NOT_FOUND` | errorCategory 11; `resources[0]=["CONTRACT_ID",cid]`. A malformed cid (bad hash/suffix) gives 404 `UNSUPPORTED_CONTRACT_ID` instead |
  | authorization (not a controller; also with disclosed contract) | 400 | `DAML_AUTHORIZATION_ERROR` | errorCategory 8; cause "requires authorizers X, but only Y were given". |
  | authorization, no CanActAs right on the party | 403 | `NA` | "security-sensitive error", errorCategory -1; no detail |
  | assertion (`assertMsg`) | 400 | `DAML_FAILURE` | `context.error_id` UNHANDLED_EXCEPTION/...AssertionFailed |
  | assertion (`failWithStatus`) -> `assertion-status.json` | 400 | `DAML_FAILURE` | `context.error_id` = your errorId |
  | contention (2 concurrent consumes; loser) | 409 | `LOCAL_VERDICT_LOCKED_CONTRACTS` | errorCategory 2; reproduced 12/12 races, winner 200. Sequential re-consume gives CONTRACT_NOT_FOUND (`already-archived.json`) |
  | upload-conflict (same name+version 0.1.0, changed content) | 400 | `KNOWN_PACKAGE_VERSION` | errorCategory 8; "Tried to vet two packages with the same name and version"; vetted package unchanged |
- Extra fixtures: `authorization-observer.json` (observer exercises, no disclosure), `authorization-noright.json`, `already-archived.json`.
- Admin token note: `ledger-api-user` can allocate parties/users/upload DARs but needs a created user (own-party rights) for commands. Commands need `userId` equal to the token `sub`.
