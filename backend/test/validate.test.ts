import { describe, expect, it } from 'vitest'
import { normalizeDecimal, validateAmount, validateCreateAuction, ValidationError } from '../src/validate'
import { topology } from './fake-ledger'

describe('createAuction rejects bad invitee lists', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['empty list', [], /exactly 3/],
    ['2 names', ['alice', 'bob'], /exactly 3/],
    ['4 names', ['alice', 'bob', 'carol', 'alice'], /exactly 3/],
    ['duplicate', ['alice', 'bob', 'bob'], /duplicate bidder: bob/],
    ['unknown', ['alice', 'bob', 'zoe'], /unknown bidder: zoe/],
    ['auctioneer', ['alice', 'bob', 'auctioneer'], /auctioneer cannot be invited/],
    ['outsider', ['alice', 'bob', 'dave'], /dave cannot be invited/],
  ]
  for (const [label, bidders, msg] of cases) {
    it(label, () => {
      expect(() => validateCreateAuction({ item: 'Vase', bidders }, topology)).toThrow(ValidationError)
      expect(() => validateCreateAuction({ item: 'Vase', bidders }, topology)).toThrow(msg)
    })
  }
  it('empty item', () => {
    expect(() => validateCreateAuction({ item: '  ', bidders: ['alice', 'bob', 'carol'] }, topology)).toThrow(/item/)
  })
  it('accepts a valid request', () => {
    expect(validateCreateAuction({ item: 'Vase', bidders: ['alice', 'bob', 'carol'] }, topology)).toEqual({
      item: 'Vase',
      bidders: ['alice', 'bob', 'carol'],
    })
  })
})

describe('placeBid rejects malformed amounts', () => {
  for (const bad of ['0', '-5', 'abc', '1e3', '', '1.12345678901', '0.0', 5 as any, undefined]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => validateAmount(bad)).toThrow(ValidationError)
    })
  }
  it('accepts 150 and 150.5', () => {
    expect(validateAmount('150')).toBe('150')
    expect(validateAmount('150.5')).toBe('150.5')
  })
})

describe('normalizeDecimal', () => {
  it('strips trailing zeros', () => {
    expect(normalizeDecimal('150.0000000000')).toBe('150')
    expect(normalizeDecimal('150.5000000000')).toBe('150.5')
    expect(normalizeDecimal('0.1')).toBe('0.1')
    expect(normalizeDecimal('100')).toBe('100')
  })
})
