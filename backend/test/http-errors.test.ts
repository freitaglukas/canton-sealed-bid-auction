import { describe, expect, it } from 'vitest'
import { mapLedgerError } from '../src/http-errors'
import { lerr } from './fake-ledger'

describe('error mapping', () => {
  const rows: Array<[string, ReturnType<typeof lerr>, Parameters<typeof mapLedgerError>[1], number, string]> = [
    ['authorization (DAML_AUTHORIZATION_ERROR)', lerr('DAML_AUTHORIZATION_ERROR', { status: 403 }), { op: 'other' }, 403, 'NOT_AUTHORIZED'],
    ['authorization (contains AUTHORIZATION)', lerr('PARTY_AUTHORIZATION_FAILED'), { op: 'bid' }, 403, 'NOT_AUTHORIZED'],
    ['bid CNF, already bid', lerr('CONTRACT_NOT_FOUND'), { op: 'bid', alreadyBid: true }, 409, 'ALREADY_BID'],
    ['bid CNF, otherwise', lerr('CONTRACT_NOT_FOUND'), { op: 'bid' }, 409, 'AUCTION_CLOSED_OR_NOT_INVITED'],
    ['close CNF', lerr('CONTRACT_NOT_FOUND'), { op: 'close' }, 409, 'AUCTION_CLOSED'],
    ['close CNF exhausted', lerr('CONTRACT_NOT_FOUND'), { op: 'close', closeExhausted: true }, 409, 'CLOSE_CONFLICT'],
    ['close retryable exhausted', lerr('LOCAL_VERDICT_LOCKED_CONTRACTS', { retryable: true }), { op: 'close', closeExhausted: true }, 409, 'CLOSE_CONFLICT'],
    ['close lineage exhausted', lerr('UNHANDLED_EXCEPTION', { errorId: 'SA_INCOMPLETE_CLOSE' }), { op: 'close', closeExhausted: true }, 409, 'CLOSE_CONFLICT'],
    ['errorId', lerr('UNHANDLED_EXCEPTION', { errorId: 'SA_NON_POSITIVE_BID' }), { op: 'bid' }, 409, 'SA_NON_POSITIVE_BID'],
    ['anything else', lerr('SOMETHING_ODD', { status: 500 }), { op: 'other' }, 502, 'LEDGER_ERROR'],
  ]
  for (const [label, err, ctx, status, code] of rows) {
    it(label, () => {
      const m = mapLedgerError(err, ctx)
      expect(m.status).toBe(status)
      expect(m.code).toBe(code)
    })
  }
})
