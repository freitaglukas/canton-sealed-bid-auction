import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Topology } from '@sa/ledger-client'
import { HttpError } from './http-errors'

export const COOKIE = 'sa_session'
export const newSecret = () => randomBytes(32).toString('hex')

export function passwordMatches(expected: string | undefined, given: unknown): boolean {
  if (expected === undefined || typeof given !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function setSession(reply: FastifyReply, userId: string) {
  reply.setCookie(COOKIE, userId, { signed: true, httpOnly: true, sameSite: 'lax', path: '/' })
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: '/' })
}

export function sessionUser(req: FastifyRequest, topology: Topology) {
  const raw = req.cookies[COOKIE]
  if (!raw) return undefined
  const un = req.unsignCookie(raw)
  if (!un.valid || !un.value) return undefined
  return topology.users.find((u) => u.id === un.value)
}

export function requireUser(req: FastifyRequest, topology: Topology) {
  const u = sessionUser(req, topology)
  if (!u) throw new HttpError(401, 'UNAUTHENTICATED', 'Not logged in')
  return u
}
