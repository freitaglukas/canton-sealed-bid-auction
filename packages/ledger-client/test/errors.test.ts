import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseLedgerError, LedgerError } from '../src/errors'

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'))

describe('parseLedgerError', () => {
  const cases: Array<[string, number, string, string | undefined, boolean]> = [
    ['not-found', 404, 'CONTRACT_NOT_FOUND', undefined, false],
    ['already-archived', 404, 'CONTRACT_NOT_FOUND', undefined, false],
    ['authorization', 400, 'DAML_AUTHORIZATION_ERROR', undefined, false],
    ['authorization-observer', 400, 'DAML_AUTHORIZATION_ERROR', undefined, false],
    ['assertion', 400, 'DAML_FAILURE', 'SA_PROBE', false],
    ['assertion-status', 400, 'DAML_FAILURE', 'SA_PROBE_STATUS', false],
    ['contention', 409, 'LOCAL_VERDICT_LOCKED_CONTRACTS', undefined, true],
    ['upload-conflict', 400, 'KNOWN_PACKAGE_VERSION', undefined, false],
    ['authorization-noright', 403, 'NA', undefined, false],
  ]
  for (const [name, status, code, errorId, retryable] of cases) {
    it(`real fixture ${name}`, () => {
      const body = fx(name)
      expect(body._httpStatus).toBe(status)
      const e = parseLedgerError(status, body)
      expect(e).toBeInstanceOf(LedgerError)
      expect(e.code).toBe(code)
      expect(e.errorId).toBe(errorId)
      expect(e.retryable).toBe(retryable)
      expect(e.httpStatus).toBe(status)
    })
  }
  it('prefers structured errorId in context', () => {
    const e = parseLedgerError(400, { code: 'DAML_FAILURE', cause: 'x SA_OTHER', context: { error_id: 'SA_DUPLICATE_ENTRY' }, errorCategory: 9 })
    expect(e.errorId).toBe('SA_DUPLICATE_ENTRY')
  })
  it('tolerates non-canton bodies', () => {
    expect(parseLedgerError(502, 'bad gateway').code).toBe('HTTP_502')
    expect(parseLedgerError(500, undefined).httpStatus).toBe(500)
  })
})
