# Sealed-Bid Auction on Canton — Design

Date: 2026-11-21 · Status: draft, pending approval · Research: `docs/canton-research.md`

## 1. Intent

A full end-to-end sealed-bid (first-price) auction app on the Canton Network, running on a Splice
LocalNet, whose privacy guarantees are enforced **by the ledger**, not by the app. The deliverable proves,
with automated tests against the live LocalNet, that bids are private, outsiders see nothing, and invalid
or unauthorized actions are rejected.

## 2. Requirements (from the spec)

User flows:
- F1 An auctioneer creates an auction for one item and invites bidders by name (demo: three). Several
  auctions can run at once.
- F2 Each invited bidder submits exactly one bid, privately.
- F3 Bidders never see each other's bids, before or after close.
- F4 The auctioneer closes the auction and awards it to the highest bid; the winner pays their own bid
  (first-price).
- F5 The winner learns they won and how much they owe; losers learn only that they lost.
- F6 An outsider on the same network sees nothing about the auction.

Definition of done:
- D1 Fully tested, local, end-to-end flow with 5 users: auctioneer, bidders Alice/Bob/Carol, outsider Dave.
- D2 Full flow (invite → bid → close → award) runs on LocalNet.
- D3 Each bidder sees only their own bid, before and after close.
- D4 Outsider sees nothing.
- D5 Rejected and shown failing: bid after close; changing someone else's bid.
- D6 Rejected and shown failing: non-auctioneer closing; outsider bidding (not invited).
- D7 Automated tests cover a full auction and at least one rejected action (we cover all of D5/D6).

## 3. Goals / non-goals / anti-goals

Goals: the flows and DoD above; ledger-enforced privacy; reproducible `make` targets from empty machine to
green E2E run; a readable demo run that shows each rejection with its ledger error.

Non-goals (MVP): moving real Canton Coin (see open question Q1); reserve prices, timers/deadlines, bid
revision, multi-item lots; production auth (OAuth2/Keycloak); PQS/indexing; DevNet/MainNet deployment;
smart-contract upgrades.

Anti-goals (failure even if it "works"):
- Privacy enforced by backend filtering. Every user-facing read and write goes to the ledger with **that
  user's own token**, whose rights are limited to their own party. No admin token on user paths.
- Any contract where a bidder is a stakeholder or informee of another bidder's bid, or of a transaction
  that contains it (including the close transaction).
- An app-driven close that can silently drop a bid. `Auction_Close` checks that the set of bids and
  invitations is complete. A *malicious* auctioneer could still bypass the close, because only the
  auctioneer sees all bids, so nobody else can verify the maximum. The spec makes the auctioneer the
  trusted awarding party. The ledger still guarantees bidders privacy, one bid each, and that any `Won`
  outcome is co-signed by the winner and carries exactly their own bid amount.

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | **Daml contracts + TypeScript backend (Fastify) on JSON Ledger API v2 + React/Vite UI** | One language for backend, UI and E2E tests; JSON API v2 is the first-class client API in Canton 3.x; no extra infra | **Chosen** |
| B | cn-quickstart stack: Java/Spring + gRPC + PQS + Keycloak | Production-shaped, but heavy (PQS, Keycloak, Gradle, Transcode) for a 5-user demo; slower to iterate | Rejected: cost without DoD value |
| C | Daml + scripts only, no app | Cheapest, but the spec asks for an app with user flows | Rejected: misses spec |

Bid secrecy: plain sealed bids (each bid is shared with bidder + auctioneer only), **not** commit-reveal.
The spec requires secrecy from other bidders and outsiders only. Commit-reveal adds a reveal step that the
flows don't contain, and the auctioneer must learn the amounts at close anyway (see Q3).

## 5. Ledger design (Daml, SDK 3.6.3, LF 2.x default, no contract keys)

Package `sealed-auction` (production), and package `sealed-auction-tests` (Daml Script, never uploaded).

```
template AuctioneerRole            signatory auctioneer
  nonconsuming CreateAuction(auctionId, item, invitees) controller auctioneer
    → creates one AuctionInvitation per invitee, then the Auction recording their contract ids
      (one atomic transaction; the role contract exists so the Auction can record its invitation lineage)

template Auction                   signatory auctioneer          (no observers: bidders never informees)
  fields: auctioneer, auctionId, item, invitees : [Party], invitations : [ContractId AuctionInvitation]
  ensure: item /= "", exactly 3 distinct invitees (spec: "invites three bidders"), auctioneer ∉ invitees
  choice Auction_Close(bids : [ContractId Bid], openInvitations : [ContractId AuctionInvitation])
    controller auctioneer
    → lineage check: every recorded invitation cid is accounted for exactly once, either passed as
      still-open or consumed by a passed bid (bid.invitationCid); no input outside the recorded set.
      A substituted or forged invitation, a dropped bid, or an auction mix-up therefore fails the close.
      (If the auctioneer pre-expires or pre-concludes something outside close, the close fails safe.)
    → winner = max amount; tie → earliest submittedAt; still tied → lowest party text
      (submittedAt is the bidder participant's ledger time: coarse, ±skew tolerance — documented limitation)
    → exercise Bid_Conclude(won) on each bid; Invitation_Expire on each open invitation
    → create AuctionResult (auctioneer only)

template AuctionInvitation         signatory auctioneer, observer bidder
  fields: auctioneer, bidder, auctionId, item
  choice PlaceBid(amount : Decimal) controller bidder   (consuming ⇒ exactly one bid per bidder)
    → assert amount > 0; submittedAt <- getTime; create Bid with invitationCid = self
  choice Invitation_Expire controller auctioneer → create NoBidNotice

template Bid                       signatory bidder, auctioneer  (no other observers)
  fields: auctioneer, bidder, invitationCid, auctionId, item, amount, submittedAt
  choice Bid_Conclude(won : Bool) controller auctioneer
    → create AuctionOutcome (Won amount | Lost)       -- amount comes from the bid itself

template AuctionOutcome            signatory auctioneer, bidder   (only creatable with bidder authority,
                                                                    i.e. via Bid_Conclude)
  fields: auctioneer, bidder, auctionId, item, bidAmount : Decimal, result : Won { amountOwed } | Lost
  (bidAmount = the bidder's OWN bid, so each bidder can still check their own bid after close (D3);
   Lost carries no price and no winner)

template NoBidNotice               signatory auctioneer, observer bidder
  fields: auctioneer, bidder, auctionId, item

template AuctionResult             signatory auctioneer
  fields: auctionId, item, winner : Optional Party, price : Optional Decimal, bids : [(Party, Decimal)]
```

Why this shape:
- **Bidders never learn other bidders' existence or bids (at the Ledger API).** Each invitation names one
  bidder. (A participant operator might infer the *number* of sibling views from the transaction's Merkle
  structure, and party hints are public topology. Neither reveals a bid, winner or price.) `Auction` has
  no observers, so the `Auction_Close` root node is visible only to the auctioneer. Each bidder is an
  informee only of the sub-actions on *their own* bid or invitation, and of the creation of *their own*
  outcome (Canton sub-transaction privacy).
- **The winner's amount owed is the bid's own amount**, set inside `Bid_Conclude` (which carries the
  bidder's signatory authority), not a number supplied by the auctioneer. Trust boundary (Q3 = trusted
  auctioneer, Q6): the auctioneer can call `Bid_Conclude`/`Invitation_Expire` outside `Auction_Close`, so
  uniqueness and maximality of the award are trusted to the auctioneer. Preventing that would require the
  bidder's participant to validate the maximum, which means seeing the other bids. The honest path is fail-safe: tampering
  outside close makes the close fail. The ledger guarantees privacy, one
  bid per bidder, and that a co-signed `Won` equals the winner's own bid.
- **"Bid after close" is impossible**: close consumes every bid and every open invitation, and `PlaceBid`
  needs an active invitation. "One bid only": `PlaceBid` consumes the invitation.
- **"Change someone else's bid" is impossible**: `Bid` is signed by bidder + auctioneer. Another bidder is
  not a stakeholder, so they can't see it (`CONTRACT_NOT_FOUND`), and even with explicit disclosure they
  hold no controller/signatory authority (authorization failure). Bids are final once placed (Q4).
- **Concurrency**: one `Auction` per auction, UUID `auctionId`, so many auctions run in parallel. A
  `PlaceBid` racing `Auction_Close` contends on the same invitation, and exactly one wins.
- **Time**: no deadlines. `getTime` is used only to record `submittedAt` for tie-breaking.

## 6. Topology on LocalNet (cn-quickstart `make start-localnet`, Splice 0.9.4 / Canton 3.6.x)

**Decided (Q2 = B): every bidder gets their own node.** Target topology:

| User | Party hint | Participant | Why |
|---|---|---|---|
| auctioneer | `auctioneer` | app-provider (`:3975`) | the app operator |
| alice | `alice` | app-user (`:2975`) | stock LocalNet validator |
| bob | `bob` | **bidder-bob** (new validator; port chosen by the infra track) | own node |
| carol | `carol` | **bidder-carol** (new validator; port chosen by the infra track) | own node |
| dave (outsider) | `dave` | app-user (`:2975`), shared with alice | the hard case: an uninvited party on a node that *does* hold a bid still sees nothing |
| — (audit only) | — | sv (`:4975`) | a node hosting no stakeholder: test-only auditor asserts it holds zero auction events |

- The LocalNet participants are separate participant nodes, each with its own identity, storage and
  sequencer subscription, co-located in one `canton` container. That is protocol-level isolation, not
  separate machines.
- The topology lives in `config/topology.json` (user → participant URL). Code never hardcodes ports.
  - Until the extra validators exist, bob and carol run on app-user: the interim topology, isolated by
    user rights only.
  - Moving to the target topology is a config change plus re-provisioning, so the MVP never waits on
    the infra work.
- With the target topology, the E2E suite adds **node-level** checks: each bidder node holds exactly one
  `Bid` (its own), and the sv node holds no auction events at all. Each probe has a positive control:
  the same probe must see the expected non-zero events elsewhere, e.g. the auditor on app-user sees alice's
  bid, so an empty result can't pass because of a bad filter. An auditor user with
  `CanReadAsAnyParty` exists on each node for this, in tests only.
- The DAR is uploaded with vetting to **every** participant, so outsider submissions fail for
  authorization and visibility reasons, not `PACKAGE_NOT_FOUND`.
- Each user is a Ledger API user on its participant with `CanActAs` + `CanReadAs` for **its own party
  only**.

## 7. Application

- `backend/` — Node 24, TypeScript, Fastify. Uses a typed JSON Ledger API v2 client generated from the
  participant's OpenAPI spec (`openapi-typescript` + `openapi-fetch`), plus hand-written Daml payload types
  for our six templates (the surface is small). We switch to `dpm codegen-js` if Task 1 confirms it works
  on 3.6.3.
  - Demo login: pick one of the 5 users and get a signed session cookie. Per request, the backend mints
    an HS256 LocalNet token for **that** ledger user (`sub=<user>`, secret `unsafe`) and routes the call
    to that user's participant. Real auth is out of scope.
  - REST endpoints:
    - `POST /auctions` (create + invite by bidder name), `GET /auctions` (auctioneer: open and closed,
      bid count), `POST /auctions/:id/close`.
    - `GET /invitations`, `POST /invitations/:cid/bid`, `GET /bids` (own bids), `GET /outcomes`.
  - Ledger errors map to readable HTTP errors, e.g. `CONTRACT_NOT_FOUND` → 409 "auction closed or not
    invited". Each error carries the original ledger error code, so the demo can show it.
  - Party directory: maps display names to party IDs, loaded from `config/parties.json`, which
    provisioning generates.
- `frontend/` — React + Vite + TypeScript:
  - Login (pick user).
  - Auctioneer: create auction (item + choose bidders by name), list open and closed auctions, close
    button.
  - Bidder: invitations with a bid form, my bid, outcome ("You won — you owe X" / "You lost").
  - Outsider: the same bidder screens, which show empty.
- `scripts/`:
  - `localnet-up` / `localnet-down`: clone cn-quickstart at a pinned commit into `.localnet/`, then
    `make start-localnet`.
  - `deploy-dar`: upload the DAR to 3 participants, then verify package listing, status and vetting.
  - `provision`: idempotently create parties and users with rights, and write `config/parties.json`.
  - `demo`: narrated full scenario, printing ✓/✗ and the ledger error code for each rejected action.

## 8. Testing

| Layer | Tool | What | Where it runs |
|---|---|---|---|
| L1 | Daml Script, `dpm test` (+ coverage, JUnit) | Every choice and every rule: happy path, multi-auction isolation, ties, no-bids, close completeness, privacy (`queryContractId`/`query` → none for other bidders and outsider, before and after close), all D5/D6 rejections, each matched on its `SubmitError` kind (not visible vs `AuthorizationError`), incl. mandatory disclosure-based variants; lineage and tamper cases; tie independent of close-input order | in-memory, seconds |
| L2 | Vitest unit | backend error mapping, token minting, input validation, party directory | no ledger |
| L3 | Vitest E2E | the DoD on **live LocalNet** through the backend HTTP API: 5 users, 2 concurrent auctions, full flow, every rejection asserted with its ledger error and an unchanged state, privacy checked per user with their own token via ACS **and** `/v2/updates` (LEDGER_EFFECTS, decoded events) so transaction-witness leaks are caught too; positive controls on every "empty" probe | LocalNet |
| L4 | Playwright | UI smoke: auctioneer creates, 3 bidders bid, close, winner/loser screens, outsider sees nothing | LocalNet + app |

E2E scenario (the D1–D7 acceptance run). Every assertion is scoped to this run's `auctionId`s and start
offsets, so the suite can be re-run on a non-empty LocalNet. Every "sees nothing" probe has a positive
control. Every rejection targets a **currently active** contract, asserts that the state is unchanged
afterwards, and then shows that the authorized party *can* do the action.
1. Deploy and verify the DAR on all participants; provision 5 users.
2. Auction A ("Painting") and auction B ("Vase"), each inviting alice, bob and carol. Both are open at the
   same time.
3. Rejections before anyone bids on A:
   - dave bids using alice's still-active A invitation: not visible, rejected. With disclosure, still
     rejected as unauthorized. dave's forged `Bid` create fails for missing authorization.
4. A: alice 100, bob 150, carol 120. B: alice 50 and carol 60; bob leaves his B invitation unused.
5. Privacy before close: each bidder sees exactly their own bid. A positive control confirms the probe
   works. dave sees nothing, even though his node also hosts alice.
6. More rejections on live contracts:
   - bob changes alice's live bid (Archive, `Bid_Conclude`): not visible, then unauthorized when disclosed;
   - bob closes A: rejected at both the API and the ledger level, with the auctioneer's own close then
     succeeding later;
   - alice bids twice on A: 409 `ALREADY_BID`.
7. The auctioneer closes A. bob wins and owes 150. alice and carol see "lost" with their own bid amount,
   and no price or winner.
8. Bob's B invitation is shown active, then the auctioneer closes B, then bob bids on B: rejected (bid after
   close). Bob sees "did not bid".
9. Privacy after close, from decoded events rather than string matching:
   - no bidder's view or update stream contains another bidder's contract, amount or the winner;
   - each bidder still sees their own bid amount;
   - dave sees nothing;
   - the sv node holds zero auction events (with a positive control);
   - with the target topology, each bidder node holds only its own bidder's data.
10. Race: a bid is injected deterministically between the close's read and its submit. The close retries
    and includes the bid. Two competing closes give exactly one result, and the loser gets 409.
11. Login: dave cannot log in as the auctioneer without the auctioneer's password.

## 9. Decisions I made (correct me)

1. Approach A (TypeScript + JSON Ledger API v2), not cn-quickstart's Java stack.
2. Plain sealed bids; no commit-reveal.
3. No contract keys; UUID `auctionId` and explicit contract IDs.
4. First-price; ties go to the earliest bid, then the lowest party ID.
5. Bids are final (one per bidder).
6. Invitee count: exactly 3 distinct bidders, enforced in the ledger and the API (spec text; one constant
   to relax).
7. Payment recorded as an amount owed on the winner's outcome; no token movement.
8. Topology as in §6: config-driven, with interim and target layouts.
9. Demo login with per-user passwords that provisioning generates (`config/credentials.json`,
   gitignored). Ledger tokens and the JWT secret stay inside the backend and test harness. The LocalNet
   shared secret is a LocalNet property, and real OAuth is out of scope.
10. SDK 3.6.3 / Splice 0.9.4, pinned to what cn-quickstart `main` uses.
11. No sandbox layer: L1 covers logic, and L3 runs on LocalNet directly.

## 10. Decisions on the open questions (user, 2026-11-21)

- **Q1 Payment → A.** The winner's co-signed `AuctionOutcome` records the amount owed. No Canton Coin
  moves; that is phase 2.
- **Q2 Node isolation → B.** Each bidder runs on their own validator node. An infra agent builds the
  extra validators in parallel, and the interim shared-node topology keeps the MVP unblocked (§6).
- **Q3 Auctioneer visibility → A.** The auctioneer is trusted and sees bids as they arrive. No
  commit-reveal.
- **Q4 Bid revision → A.** Bids are final.
- **Q5 Ties → A.** The earliest bid wins; the last-resort tie-break is the lowest party id. Caveat (both
  reviewers): `submittedAt` is the ledger effective time chosen by the bidder's participant, so it shows
  rough submission order, not arrival order. The result must be independent of the order of close inputs
  (tested).
- **Q6 (new, from review) Trust in the auctioneer's award.** Pending user confirmation: the auctioneer is
  trusted to run the close honestly. See "Why this shape".

Delivery constraint: parallelize the build wherever possible, so the demo/MVP is ready as soon as
possible (see the plan's "Execution waves").

## 11. Left to the builder

Exact REST payload shapes, UI layout and styling, error-message wording, file-level module split, and the
pinned cn-quickstart commit hash (Task 1 pins the commit that matches 3.6.3 / 0.9.4).
