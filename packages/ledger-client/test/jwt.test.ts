import { describe, it, expect } from 'vitest'
import { jwtVerify, decodeJwt } from 'jose'
import { mintToken } from '../src/jwt'

describe('mintToken', () => {
  it('verifies under the unsafe secret with aud and sub', async () => {
    const t = await mintToken('alice')
    const { payload, protectedHeader } = await jwtVerify(t, new TextEncoder().encode('unsafe'), {
      audience: 'https://canton.network.global',
    })
    expect(payload.sub).toBe('alice')
    expect(protectedHeader.alg).toBe('HS256')
  })
  it('honours opts', async () => {
    const t = await mintToken('bob', { secret: 's', audience: 'x', ttlSec: 60 })
    const p = decodeJwt(t)
    expect(p.aud).toBe('x')
    expect(p.exp! - p.iat!).toBe(60)
    await jwtVerify(t, new TextEncoder().encode('s'))
  })
})
