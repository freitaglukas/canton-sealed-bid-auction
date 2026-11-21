import { randomUUID } from 'node:crypto'
import {
  LedgerError,
  T,
  isTemplate,
  type AuctionPayload,
  type AuctioneerRolePayload,
  type BidPayload,
  type Contract,
  type InvitationPayload,
  type LedgerClient,
  type LedgerEvent,
  type NoBidPayload,
  type OutcomePayload,
  type Parties,
  type ResultPayload,
  type Topology,
  type AuctionCloseArg,
  type CreateAuctionArg,
  type PlaceBidArg,
} from '@sa/ledger-client'
import type {
  AuctionSummary,
  CloseAuctionResponse,
  InvitationView,
  OutcomeView,
  OwnBidView,
} from './contract'
import { HttpError, isCloseRetryable, mapLedgerError, type MapContext } from './http-errors'
import { normalizeDecimal, validateAmount, validateCreateAuction } from './validate'

export const MAX_CLOSE_ATTEMPTS = 3

export interface ServiceDeps {
  ledgerFor(userId: string): LedgerClient
  parties: Parties
  topology: Topology
  hooks?: { beforeCloseSubmit?: () => Promise<void> }
}

const norm = (s: string | null | undefined) => (s == null ? null : normalizeDecimal(s))

export function createAuctionService(deps: ServiceDeps) {
  const { parties, topology, hooks } = deps
  const nameOf = new Map(Object.entries(parties).map(([user, party]) => [party, user]))
  const display = (party: string) => nameOf.get(party) ?? party
  const partyOf = (userId: string) => {
    const p = parties[userId]
    if (!p) throw new HttpError(502, 'LEDGER_ERROR', `No party provisioned for ${userId}`)
    return p
  }
  const ofTemplate = <P>(cs: Contract<unknown>[], name: keyof typeof T) =>
    cs.filter((c) => isTemplate(c.templateId, name)) as Contract<P>[]

  function toHttp(e: unknown, ctx: MapContext): never {
    if (e instanceof LedgerError) {
      const m = mapLedgerError(e, ctx)
      throw new HttpError(m.status, m.code, m.error, e.code)
    }
    throw e
  }

  async function createAuction(userId: string, body: unknown): Promise<{ auctionId: string }> {
    const { item, bidders } = validateCreateAuction(body, topology)
    const ledger = deps.ledgerFor(userId)
    const me = partyOf(userId)
    const roles = await ledger.activeContracts<AuctioneerRolePayload>(me, [T.AuctioneerRole])
    const roleCid = roles[0]?.contractId ?? (await ledger.create<AuctioneerRolePayload>(T.AuctioneerRole, { auctioneer: me }, [me])).contractId
    const auctionId = randomUUID()
    const arg: CreateAuctionArg = { auctionId, item, invitees: bidders.map(partyOf) }
    await ledger.exercise(T.AuctioneerRole, roleCid, 'CreateAuction', arg, [me])
    return { auctionId }
  }

  async function listAuctions(userId: string): Promise<AuctionSummary[]> {
    const ledger = deps.ledgerFor(userId)
    const me = partyOf(userId)
    const acs = await ledger.activeContracts<unknown>(me, [T.Auction, T.AuctionResult, T.Bid, T.AuctionOutcome, T.NoBidNotice])
    const bids = ofTemplate<BidPayload>(acs, 'Bid')
    const outcomes = ofTemplate<OutcomePayload>(acs, 'AuctionOutcome')
    const notices = ofTemplate<NoBidPayload>(acs, 'NoBidNotice')

    const open: AuctionSummary[] = ofTemplate<AuctionPayload>(acs, 'Auction').map((a) => ({
      auctionId: a.payload.auctionId,
      item: a.payload.item,
      invitees: a.payload.invitees.map(display),
      bidsReceived: bids.filter((b) => b.payload.auctionId === a.payload.auctionId).length,
      status: 'open',
    }))
    const closed: AuctionSummary[] = ofTemplate<ResultPayload>(acs, 'AuctionResult').map((r) => {
      const id = r.payload.auctionId
      const invitees = new Set<string>([
        ...outcomes.filter((o) => o.payload.auctionId === id).map((o) => o.payload.bidder),
        ...notices.filter((n) => n.payload.auctionId === id).map((n) => n.payload.bidder),
      ])
      return {
        auctionId: id,
        item: r.payload.item,
        invitees: [...invitees].map(display),
        bidsReceived: r.payload.bids.length,
        status: 'closed',
        winner: r.payload.winner == null ? null : display(r.payload.winner),
        price: norm(r.payload.price),
      }
    })
    return [...open, ...closed]
  }

  async function readCloseInputs(ledger: LedgerClient, me: string, auctionId: string) {
    const acs = await ledger.activeContracts<unknown>(me, [T.Auction, T.Bid, T.AuctionInvitation, T.AuctionResult])
    const auction = ofTemplate<AuctionPayload>(acs, 'Auction').find((a) => a.payload.auctionId === auctionId)
    const closedAlready = ofTemplate<ResultPayload>(acs, 'AuctionResult').some((r) => r.payload.auctionId === auctionId)
    if (!auction) return { auction: undefined, closedAlready, bids: [], open: [] }
    const bids = ofTemplate<BidPayload>(acs, 'Bid').filter((b) => b.payload.auctionId === auctionId)
    const recorded = new Set(auction.payload.invitations)
    const open = ofTemplate<InvitationPayload>(acs, 'AuctionInvitation').filter(
      (i) => i.payload.auctionId === auctionId && recorded.has(i.contractId),
    )
    return { auction, closedAlready, bids, open }
  }

  function closeResult(events: LedgerEvent[]): CloseAuctionResponse {
    for (const ev of events) {
      if (ev.kind === 'created' && isTemplate(ev.templateId, 'AuctionResult')) {
        const p = ev.payload as ResultPayload
        return { winner: p.winner == null ? null : display(p.winner), price: norm(p.price) }
      }
    }
    throw new HttpError(502, 'LEDGER_ERROR', 'Close succeeded but returned no AuctionResult')
  }

  async function closeAuction(userId: string, auctionId: string): Promise<CloseAuctionResponse> {
    const ledger = deps.ledgerFor(userId)
    const me = partyOf(userId)
    let last: LedgerError | undefined
    for (let attempt = 1; attempt <= MAX_CLOSE_ATTEMPTS; attempt++) {
      const inputs = await readCloseInputs(ledger, me, auctionId)
      if (!inputs.auction) {
        if (attempt === 1 && !inputs.closedAlready) throw new HttpError(404, 'NOT_FOUND', `Unknown auction ${auctionId}`)
        throw new HttpError(409, 'AUCTION_CLOSED', 'Auction is already closed', last?.code)
      }
      await hooks?.beforeCloseSubmit?.()
      const arg: AuctionCloseArg = {
        bids: inputs.bids.map((b) => b.contractId),
        openInvitations: inputs.open.map((i) => i.contractId),
      }
      try {
        const { events } = await ledger.exercise(T.Auction, inputs.auction.contractId, 'Auction_Close', arg, [me])
        return closeResult(events)
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e
        last = e
        const exhausted = attempt === MAX_CLOSE_ATTEMPTS
        if (!isCloseRetryable(e) || exhausted) toHttp(e, { op: 'close', closeExhausted: exhausted })
      }
    }
    throw new HttpError(409, 'CLOSE_CONFLICT', 'Close kept conflicting; try again', last?.code)
  }

  async function listInvitations(userId: string): Promise<InvitationView[]> {
    const me = partyOf(userId)
    const acs = await deps.ledgerFor(userId).activeContracts<InvitationPayload>(me, [T.AuctionInvitation])
    return ofTemplate<InvitationPayload>(acs, 'AuctionInvitation').map((i) => ({
      invitationId: i.contractId,
      auctionId: i.payload.auctionId,
      item: i.payload.item,
    }))
  }

  async function placeBid(userId: string, invitationId: string, body: unknown): Promise<{ bidId: string }> {
    const amount = validateAmount((body as { amount?: unknown } | undefined)?.amount)
    const ledger = deps.ledgerFor(userId)
    const me = partyOf(userId)
    const arg: PlaceBidArg = { amount }
    try {
      const { result, events } = await ledger.exercise<string>(T.AuctionInvitation, invitationId, 'PlaceBid', arg, [me])
      const created = events.find((e) => e.kind === 'created' && isTemplate(e.templateId, 'Bid'))
      return { bidId: created ? created.contractId : String(result) }
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e
      let alreadyBid = false
      if (e.code === 'CONTRACT_NOT_FOUND' || /NOT_FOUND/.test(e.code)) {
        // invitation is gone: did the caller already bid on (or conclude) that auction?
        const acs = await ledger.activeContracts<unknown>(me, [T.AuctionInvitation, T.Bid, T.AuctionOutcome])
        const bids = ofTemplate<BidPayload>(acs, 'Bid')
        const auctionId =
          ofTemplate<InvitationPayload>(acs, 'AuctionInvitation').find((i) => i.contractId === invitationId)?.payload.auctionId ??
          bids.find((b) => b.payload.invitationCid === invitationId)?.payload.auctionId
        alreadyBid =
          auctionId !== undefined &&
          (bids.some((b) => b.payload.auctionId === auctionId) ||
            ofTemplate<OutcomePayload>(acs, 'AuctionOutcome').some((o) => o.payload.auctionId === auctionId))
      }
      return toHttp(e, { op: 'bid', alreadyBid })
    }
  }

  async function listBids(userId: string): Promise<OwnBidView[]> {
    const me = partyOf(userId)
    const acs = await deps.ledgerFor(userId).activeContracts<unknown>(me, [T.Bid, T.AuctionOutcome])
    return [
      ...ofTemplate<BidPayload>(acs, 'Bid').map((b) => ({
        auctionId: b.payload.auctionId, item: b.payload.item, amount: normalizeDecimal(b.payload.amount), status: 'open' as const,
      })),
      ...ofTemplate<OutcomePayload>(acs, 'AuctionOutcome').map((o) => ({
        auctionId: o.payload.auctionId, item: o.payload.item, amount: normalizeDecimal(o.payload.bidAmount), status: 'closed' as const,
      })),
    ]
  }

  async function listOutcomes(userId: string): Promise<OutcomeView[]> {
    const me = partyOf(userId)
    const acs = await deps.ledgerFor(userId).activeContracts<unknown>(me, [T.AuctionOutcome, T.NoBidNotice])
    return [
      ...ofTemplate<OutcomePayload>(acs, 'AuctionOutcome').map((o): OutcomeView =>
        o.payload.result.tag === 'Won'
          ? { auctionId: o.payload.auctionId, item: o.payload.item, result: 'won', amountOwed: normalizeDecimal(o.payload.result.value.amountOwed) }
          : { auctionId: o.payload.auctionId, item: o.payload.item, result: 'lost' },
      ),
      ...ofTemplate<NoBidPayload>(acs, 'NoBidNotice').map((n): OutcomeView => ({
        auctionId: n.payload.auctionId, item: n.payload.item, result: 'did_not_bid',
      })),
    ]
  }

  return { createAuction, listAuctions, closeAuction, listInvitations, placeBid, listBids, listOutcomes }
}

export type AuctionService = ReturnType<typeof createAuctionService>
