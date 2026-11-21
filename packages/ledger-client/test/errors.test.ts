import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseLedgerError, LedgerError } from '../src/errors'

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'))

describe('parseLedgerError', () => {
  it('not found', () => {
    const e = parseLedgerError(404, fx('not-found'))
    expect(e).toBeInstanceOf(LedgerError)
    expect(e.code).toBe('CONTRACT_NOT_FOUND')
    expect(e.errorId).toBeUndefined()
    expect(e.retryable).toBe(false)
    expect(e.httpStatus).toBe(404)
  })
  it('authorization', () => {
    const e = parseLedgerError(403, fx('authorization'))
    expect(e.code).toBe('DAML_AUTHORIZATION_ERROR')
    expect(e.retryable).toBe(false)
  })
  it('assertion carries SA_ id', () => {
    const e = parseLedgerError(409, fx('assertion'))
    expect(e.code).toBe('UNHANDLED_EXCEPTION')
    expect(e.errorId).toBe('SA_INCOMPLETE_CLOSE')
    expect(e.retryable).toBe(false)
  })
  it('contention is retryable', () => {
    const e = parseLedgerError(409, fx('contention'))
    expect(e.code).toBe('LOCAL_VERDICT_LOCKED_CONTRACTS')
    expect(e.retryable).toBe(true)
  })
  it('prefers structured errorId in context', () => {
    const e = parseLedgerError(400, { code: 'DAML_FAILURE', cause: 'x SA_OTHER', context: { error_id: 'SA_DUPLICATE_ENTRY' }, errorCategory: 9 })
    expect(e.errorId).toBe('SA_DUPLICATE_ENTRY')
  })
  it('tolerates non-canton bodies', () => {
    expect(parseLedgerError(502, 'bad gateway').code).toBe('HTTP_502')
    expect(parseLedgerError(500, undefined).httpStatus).toBe(500)
  })
})
