import { SignJWT } from 'jose'

export const DEFAULT_SECRET = 'unsafe'
export const DEFAULT_AUDIENCE = 'https://canton.network.global'

/** Mint an HS256 LocalNet token for a ledger user id. */
export async function mintToken(
  userId: string,
  opts: { secret?: string; audience?: string; ttlSec?: number } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setAudience(opts.audience ?? DEFAULT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${opts.ttlSec ?? 3600}s`)
    .sign(new TextEncoder().encode(opts.secret ?? DEFAULT_SECRET))
}
