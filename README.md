# Sealed-Bid Auction on Canton

A first-price sealed-bid auction app on the Canton Network. The Daml ledger enforces privacy, so the app doesn't have to.
The DAR is deployed to a Splice LocalNet (cn-quickstart). A TypeScript backend talks to each user's participant
over the JSON Ledger API v2, and every request uses **that user's own token**. A React UI sits on top.

- An auctioneer creates an auction for one item and invites bidders by name. Several auctions can run at the same time.
- Each invited bidder places **one** sealed bid. Bidders never see each other's bids, before or after close.
- The auctioneer closes the auction and awards it to the highest bid. The winner owes their own bid. Losers learn only that they lost.
- An outsider on the same network sees nothing.

## How privacy works

| Contract | Signatories | Observers | Who can see it |
|---|---|---|---|
| `AuctionInvitation` | auctioneer | that one bidder | auctioneer + that bidder |
| `Bid` | bidder, auctioneer | — | auctioneer + that bidder |
| `Auction`, `AuctionResult` | auctioneer | — | auctioneer only |
| `AuctionOutcome` (Won amount / Lost) | auctioneer, bidder | — | auctioneer + that bidder |

Canton's sub-transaction privacy means each bidder's participant receives only the parts of a transaction
that involve that bidder. That holds for the close transaction too.

- **Bid amounts.** A `Won` outcome is co-signed by the winner. The amount it records comes from the bid itself.
- **Close lineage.** `Auction_Close` checks that every recorded invitation is accounted for exactly once.
- **Trust boundary.** The auctioneer is trusted to award honestly. See `docs/superpowers/specs/`.

## Layout

```
daml/sealed-auction/          Daml model (SealedAuction.Auction)
daml/sealed-auction-tests/    Daml Script tests: rules, privacy, rejections (never uploaded)
packages/ledger-client/       typed JSON Ledger API v2 client (JWT, paging, error parsing)
packages/ops/                 deploy DAR to every participant + provision parties/users
backend/                      Fastify API (per-user ledger tokens, password demo login)
frontend/                     React + Vite UI
e2e/                          live LocalNet E2E suite, narrated demo, Chrome acceptance suite
infra/probe/                  live probes that captured real LocalNet error shapes
docs/                         research, design spec, implementation plan
```

## Run it

You need Docker (16 GB or more for LocalNet), Node 22 or newer, and macOS or Linux.

```bash
make tools            # dpm + Daml SDK 3.6.3, npm install
make localnet-up      # Splice LocalNet 0.9.4 (cn-quickstart, pinned)
make localnet-status  # wait for all participants to report ready
make deploy           # build + upload + vet the DAR on every participant
make provision        # 5 users + auditors; writes config/parties.json and config/credentials.json
make backend          # API on :8787
npm -w frontend run dev   # UI on :5173. Passwords are in config/credentials.json
```

## Tests

```bash
make test-daml                       # Daml Script: happy path, close rules, ties, privacy, rejections
npm -w backend test                  # backend unit tests
npm -w packages/ledger-client test   # client unit tests
LOCALNET=1 npm -w e2e run e2e        # live E2E on LocalNet
LOCALNET=1 npm -w e2e run demo       # narrated run showing every rejected action
cd e2e && npx playwright test -c playwright/playwright.config.ts   # acceptance suite in headed Chrome
```

## Topology (LocalNet)

| User | Participant |
|---|---|
| auctioneer | app-provider |
| alice, bob, carol (bidders) | app-user. Isolated by per-user ledger rights; per-bidder nodes are in progress |
| dave (outsider) | app-user. Sees nothing, even though alice's bid lives on the same node |
