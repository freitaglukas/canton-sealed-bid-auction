import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseLedgerError } from '@sa/ledger-client'
import { isCloseRetryable, mapLedgerError } from '../src/http-errors'
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

describe('error mapping with real LocalNet fixtures', () => {
  const real = (n: string) => {
    const body = JSON.parse(readFileSync(new URL(`../../packages/ledger-client/test/fixtures/${n}.json`, import.meta.url), 'utf8'))
    return parseLedgerError(body._httpStatus, body)
  }
  it('DAML_AUTHORIZATION_ERROR -> NOT_AUTHORIZED', () => {
    expect(mapLedgerError(real('authorization'))).toMatchObject({ status: 403, code: 'NOT_AUTHORIZED' })
  })
  it('403 NA (missing user right) -> NOT_AUTHORIZED', () => {
    expect(mapLedgerError(real('authorization-noright'))).toMatchObject({ status: 403, code: 'NOT_AUTHORIZED' })
  })
  it('CONTRACT_NOT_FOUND maps per operation', () => {
    expect(mapLedgerError(real('not-found'), { op: 'bid' }).code).toBe('AUCTION_CLOSED_OR_NOT_INVITED')
    expect(mapLedgerError(real('already-archived'), { op: 'close' }).code).toBe('AUCTION_CLOSED')
  })
  it('LOCAL_VERDICT_LOCKED_CONTRACTS is retryable and ends as CLOSE_CONFLICT when exhausted', () => {
    const e = real('contention')
    expect(e.retryable).toBe(true)
    expect(isCloseRetryable(e)).toBe(true)
    expect(mapLedgerError(e, { op: 'close', closeExhausted: true }).code).toBe('CLOSE_CONFLICT')
  })
  it('DAML_FAILURE carries the SA_ errorId through', () => {
    expect(mapLedgerError(real('assertion-status'), { op: 'bid' })).toMatchObject({ status: 409, code: 'SA_PROBE_STATUS' })
  })
})
