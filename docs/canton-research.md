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
