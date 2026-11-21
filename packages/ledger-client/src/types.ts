// FROZEN cross-track interface (Wave 0). Changes go through the lead.
// Daml JSON encoding (JSON Ledger API v2): Party/Text/Decimal/Time are strings, Optional is `null | value`,
// variants are `{ tag, value }`, tuples are `{ _1, _2 }`.

export type Role = 'auctioneer' | 'bidder' | 'outsider' | 'auditor'

export interface Topology {
  /** participant name -> JSON Ledger API base URL, e.g. "app-user" -> "http://localhost:2975" */
  participants: Record<string, string>
  users: Array<{ id: string; participant: string; role: Role }>
}

/** config/parties.json: ledger user id -> party id */
export type Parties = Record<string, string>

export interface DisclosedContract {
  templateId?: string
  contractId?: string
  createdEventBlob: string
  synchronizerId?: string
}

export type Contract<P> = {
  contractId: string
  templateId: string
  payload: P
  createdEventBlob?: string
}

export type LedgerEvent =
  | {
      kind: 'created'
      contractId: string
      templateId: string
      payload: unknown
      signatories: string[]
      observers: string[]
      witnessParties: string[]
    }
  | {
      kind: 'exercised'
      contractId: string
      templateId: string
      choice: string
      choiceArgument: unknown
      exerciseResult: unknown
      consuming: boolean
      actingParties: string[]
      witnessParties: string[]
    }
  | { kind: 'archived'; contractId: string; templateId: string; witnessParties: string[] }

export interface LedgerTransaction {
  updateId: string
  offset: number
  events: LedgerEvent[]
}

export interface LedgerClient {
  readonly userId: string
  readonly baseUrl: string
  create<P>(templateId: string, args: P, actAs: string[]): Promise<{ contractId: string }>
  exercise<R>(
    templateId: string,
    cid: string,
    choice: string,
    arg: object,
    actAs: string[],
    opts?: { disclosed?: DisclosedContract[] },
  ): Promise<{ result: R; events: LedgerEvent[] }>
  /** party 'ANY' requires CanReadAsAnyParty (auditor only). templateIds 'ALL' = wildcard filter. */
  activeContracts<P>(
    party: string | 'ANY',
    templateIds: string[] | 'ALL',
    opts?: { includeBlob?: boolean; atOffset?: number },
  ): Promise<Contract<P>[]>
  /** LEDGER_EFFECTS transactions in (beginExclusive, endInclusive]; pages past the server cap. endInclusive defaults to ledger end. */
  updates(party: string | 'ANY', beginExclusive: number, endInclusive?: number): Promise<LedgerTransaction[]>
  ledgerEnd(): Promise<number>
}

// ---- Daml payloads (module SealedAuction.Auction, package sealed-auction) ----
export type BidResult = { tag: 'Won'; value: { amountOwed: string } } | { tag: 'Lost'; value: Record<string, never> }

export interface AuctioneerRolePayload { auctioneer: string }
export interface AuctionPayload {
  auctioneer: string
  auctionId: string
  item: string
  invitees: string[]
  invitations: string[]
}
export interface InvitationPayload { auctioneer: string; bidder: string; auctionId: string; item: string }
export interface BidPayload {
  auctioneer: string
  bidder: string
  invitationCid: string
  auctionId: string
  item: string
  amount: string
  submittedAt: string
}
export interface OutcomePayload {
  auctioneer: string
  bidder: string
  auctionId: string
  item: string
  bidAmount: string
  result: BidResult
}
export interface NoBidPayload { auctioneer: string; bidder: string; auctionId: string; item: string }
export interface ResultPayload {
  auctioneer: string
  auctionId: string
  item: string
  winner: string | null
  price: string | null
  bids: Array<{ _1: string; _2: string }>
}

// Choice arguments
export interface CreateAuctionArg { auctionId: string; item: string; invitees: string[] }
export interface AuctionCloseArg { bids: string[]; openInvitations: string[] }
export interface PlaceBidArg { amount: string }
export interface BidConcludeArg { won: boolean }
