import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { LedgerError, type LedgerClient, type Parties, type Role, type Topology } from '@sa/ledger-client'
import type { ApiError, DirectoryResponse, LoginResponse } from './contract'
import { createAuctionService } from './auction-service'
import { HttpError, mapLedgerError } from './http-errors'
import { clearSession, newSecret, passwordMatches, requireUser, setSession } from './session'
import { ValidationError } from './validate'

export interface ServerDeps {
  ledgerFor(userId: string): LedgerClient
  parties: Parties
  topology: Topology
  /** userId -> password */
  credentials: Record<string, string>
  /** test-only hooks */
  hooks?: { beforeCloseSubmit?: () => Promise<void> }
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie, { secret: newSecret() })
  const svc = createAuctionService(deps)

  app.setErrorHandler((err: unknown, _req, reply) => {
    let status: number
    let body: ApiError
    if (err instanceof HttpError) {
      status = err.status
      body = { error: err.message, code: err.code, ...(err.ledgerCode ? { ledgerCode: err.ledgerCode } : {}) }
    } else if (err instanceof ValidationError) {
      status = 400
      body = { error: err.message, code: 'VALIDATION' }
    } else if (err instanceof LedgerError) {
      const m = mapLedgerError(err)
      status = m.status
      body = { error: m.error, code: m.code, ledgerCode: err.code }
    } else if ((err as { statusCode?: number }).statusCode === 400) {
      status = 400
      body = { error: (err as Error).message, code: 'VALIDATION' }
    } else {
      status = 500
      body = { error: 'Internal error', code: 'LEDGER_ERROR' }
    }
    void reply.status(status).send(body)
  })

  const auth = (req: Parameters<typeof requireUser>[0], ...roles: Role[]) => {
    const u = requireUser(req, deps.topology)
    if (roles.length && !roles.includes(u.role)) throw new HttpError(403, 'FORBIDDEN_ROLE', `Role ${u.role} may not do this`)
    return u
  }
  const BIDDERS: Role[] = ['bidder', 'outsider']

  app.post('/api/login', async (req, reply) => {
    const { userId, password } = (req.body ?? {}) as { userId?: unknown; password?: unknown }
    const user = typeof userId === 'string' ? deps.topology.users.find((u) => u.id === userId) : undefined
    const ok = user && Object.hasOwn(deps.credentials, user.id) && passwordMatches(deps.credentials[user.id], password)
    if (!user || !ok) throw new HttpError(401, 'BAD_CREDENTIALS', 'Wrong user or password')
    setSession(reply, user.id)
    const out: LoginResponse = { userId: user.id, role: user.role }
    return out
  })
  app.post('/api/logout', async (_req, reply) => {
    clearSession(reply)
    return reply.status(204).send()
  })
  app.get('/api/me', async (req) => {
    const u = auth(req)
    const out: LoginResponse = { userId: u.id, role: u.role }
    return out
  })
  app.get('/api/directory', async (req) => {
    auth(req)
    const out: DirectoryResponse = { bidders: deps.topology.users.filter((u) => u.role === 'bidder').map((u) => u.id) }
    return out
  })

  app.post('/api/auctions', async (req) => svc.createAuction(auth(req, 'auctioneer').id, req.body))
  app.get('/api/auctions', async (req) => svc.listAuctions(auth(req, 'auctioneer').id))
  app.post('/api/auctions/:auctionId/close', async (req) =>
    svc.closeAuction(auth(req, 'auctioneer').id, (req.params as { auctionId: string }).auctionId),
  )

  app.get('/api/invitations', async (req) => svc.listInvitations(auth(req, ...BIDDERS).id))
  app.post('/api/invitations/:invitationId/bid', async (req) =>
    svc.placeBid(auth(req, ...BIDDERS).id, (req.params as { invitationId: string }).invitationId, req.body),
  )
  app.get('/api/bids', async (req) => svc.listBids(auth(req, ...BIDDERS).id))
  app.get('/api/outcomes', async (req) => svc.listOutcomes(auth(req, ...BIDDERS).id))

  return app
}
