import { LedgerError } from '@sa/ledger-client'
import type { ErrorCode } from './contract'

/** An error that maps directly to an HTTP response. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly ledgerCode?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface MapContext {
  op: 'bid' | 'close' | 'other'
  /** bid only: the caller already has a Bid or AuctionOutcome for this auction. */
  alreadyBid?: boolean
  /** close only: all attempts were used up. */
  closeExhausted?: boolean
}

export interface Mapped { status: number; code: ErrorCode; error: string }

// ---- Table-driven classification; extend these lists when live codes are known. ----
export const CONTRACT_NOT_FOUND_CODES = ['CONTRACT_NOT_FOUND']
export const AUTHORIZATION_CODE_PATTERNS = [/AUTHORIZATION/i, /^DAML_AUTHORIZATION_ERROR$/]
/** Missing user right: HTTP 403 with the opaque code `NA` (security-sensitive error). */
export const AUTHORIZATION_OPAQUE_CODES = ['NA']
/** Retryable contention. */
export const CONTENTION_CODES = ['LOCAL_VERDICT_LOCKED_CONTRACTS']
export const LINEAGE_ERROR_IDS = ['SA_INCOMPLETE_CLOSE']

export const isContractNotFound = (e: LedgerError) => CONTRACT_NOT_FOUND_CODES.includes(e.code)
export const isAuthorization = (e: LedgerError) =>
  AUTHORIZATION_CODE_PATTERNS.some((re) => re.test(e.code)) || (e.httpStatus === 403 && AUTHORIZATION_OPAQUE_CODES.includes(e.code))
export const isContention = (e: LedgerError) => CONTENTION_CODES.includes(e.code)
export const isLineage = (e: LedgerError) => e.errorId !== undefined && LINEAGE_ERROR_IDS.includes(e.errorId)
/** Worth re-reading and retrying a close. */
export const isCloseRetryable = (e: LedgerError) => e.retryable || isContention(e) || isLineage(e) || isContractNotFound(e)

interface Rule {
  when: (e: LedgerError, c: MapContext) => boolean
  then: (e: LedgerError, c: MapContext) => Mapped
}

const closed = (): Mapped => ({ status: 409, code: 'AUCTION_CLOSED', error: 'Auction is already closed' })

const RULES: Rule[] = [
  { when: isAuthorization, then: () => ({ status: 403, code: 'NOT_AUTHORIZED', error: 'Not authorized for this action' }) },
  {
    when: (e, c) => c.op === 'bid' && isContractNotFound(e) && !!c.alreadyBid,
    then: () => ({ status: 409, code: 'ALREADY_BID', error: 'You have already bid on this auction' }),
  },
  {
    when: (e, c) => c.op === 'bid' && isContractNotFound(e),
    then: () => ({ status: 409, code: 'AUCTION_CLOSED_OR_NOT_INVITED', error: 'Auction is closed or you are not invited' }),
  },
  {
    when: (e, c) => c.op === 'close' && !!c.closeExhausted && isCloseRetryable(e),
    then: () => ({ status: 409, code: 'CLOSE_CONFLICT', error: 'Close kept conflicting with concurrent activity; try again' }),
  },
  { when: (e, c) => c.op === 'close' && isContractNotFound(e) && !c.closeExhausted, then: closed },
  { when: (e) => !!e.errorId, then: (e) => ({ status: 409, code: e.errorId as ErrorCode, error: e.message }) },
]

export function mapLedgerError(e: LedgerError, ctx: MapContext = { op: 'other' }): Mapped {
  for (const r of RULES) if (r.when(e, ctx)) return r.then(e, ctx)
  return { status: 502, code: 'LEDGER_ERROR', error: e.message || 'Ledger error' }
}
