// FROZEN REST contract (Wave 0), shared by backend, frontend and e2e. Types only.
import type { Role } from '@sa/ledger-client'

export const INVITEE_COUNT = 3

export type ErrorCode =
  | 'VALIDATION'
  | 'BAD_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_ROLE'
  | 'NOT_AUTHORIZED'
  | 'ALREADY_BID'
  | 'AUCTION_CLOSED_OR_NOT_INVITED'
  | 'AUCTION_CLOSED'
  | 'CLOSE_CONFLICT'
  | 'NOT_FOUND'
  | 'SA_INCOMPLETE_CLOSE'
  | 'SA_UNKNOWN_INVITATION'
  | 'SA_DUPLICATE_ENTRY'
  | 'SA_NON_POSITIVE_BID'
  | 'LEDGER_ERROR'

export interface ApiError { error: string; code: ErrorCode; ledgerCode?: string }

// POST /api/login
export interface LoginRequest { userId: string; password: string }
export interface LoginResponse { userId: string; role: Role }
// GET /api/me -> LoginResponse (401 UNAUTHENTICATED if no session)
// POST /api/logout -> 204

// GET /api/directory -> bidder display names the auctioneer may invite
export interface DirectoryResponse { bidders: string[] }

// POST /api/auctions (auctioneer)
export interface CreateAuctionRequest { item: string; bidders: [string, string, string] }
export interface CreateAuctionResponse { auctionId: string }

// GET /api/auctions (auctioneer)
export interface AuctionSummary {
  auctionId: string
  item: string
  invitees: string[] // display names
  bidsReceived: number
  status: 'open' | 'closed'
  winner?: string | null // display name, closed only
  price?: string | null // closed only
}

// POST /api/auctions/:auctionId/close (auctioneer)
export interface CloseAuctionResponse { winner: string | null; price: string | null }

// GET /api/invitations (bidder | outsider)
export interface InvitationView { invitationId: string; auctionId: string; item: string }

// POST /api/invitations/:invitationId/bid (bidder | outsider)
export interface PlaceBidRequest { amount: string }
export interface PlaceBidResponse { bidId: string }

// GET /api/bids (bidder | outsider): own bids, open (Bid) and closed (AuctionOutcome.bidAmount)
export interface OwnBidView { auctionId: string; item: string; amount: string; status: 'open' | 'closed' }

// GET /api/outcomes (bidder | outsider)
export interface OutcomeView {
  auctionId: string
  item: string
  result: 'won' | 'lost' | 'did_not_bid'
  amountOwed?: string // won only
}
