import type { Topology } from '@sa/ledger-client'
import { INVITEE_COUNT } from './contract'

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

const AMOUNT_RE = /^\d+(\.\d{1,10})?$/

/** Strip trailing zeros: "150.0000000000" -> "150", "150.50" -> "150.5". */
export function normalizeDecimal(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

/** Positive Daml Decimal (max 10 fractional digits, no exponent). Returns the normalized amount. */
export function validateAmount(amount: unknown): string {
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) {
    throw new ValidationError(`amount must be a positive decimal with at most 10 fractional digits, got ${JSON.stringify(amount)}`)
  }
  if (/^[0.]*$/.test(amount)) throw new ValidationError(`amount must be greater than zero, got ${JSON.stringify(amount)}`)
  return normalizeDecimal(amount)
}

export function validateCreateAuction(body: unknown, topology: Topology): { item: string; bidders: string[] } {
  const b = (body ?? {}) as { item?: unknown; bidders?: unknown }
  if (typeof b.item !== 'string' || b.item.trim() === '') throw new ValidationError('item must be a non-empty string')
  if (!Array.isArray(b.bidders) || b.bidders.length !== INVITEE_COUNT) {
    throw new ValidationError(`bidders must list exactly ${INVITEE_COUNT} names`)
  }
  const seen = new Set<string>()
  for (const name of b.bidders) {
    if (typeof name !== 'string') throw new ValidationError(`invalid bidder name ${JSON.stringify(name)}`)
    if (seen.has(name)) throw new ValidationError(`duplicate bidder: ${name}`)
    seen.add(name)
    const user = topology.users.find((u) => u.id === name)
    if (!user) throw new ValidationError(`unknown bidder: ${name}`)
    if (user.role !== 'bidder') throw new ValidationError(`${name} cannot be invited (role ${user.role})`)
  }
  return { item: b.item.trim(), bidders: b.bidders as string[] }
}
