// Dev-only in-browser mock of the REST contract (VITE_MOCK=1). Intercepts window.fetch for /api/*.
import type { ApiError, AuctionSummary, ErrorCode, LoginResponse, OutcomeView } from '../../backend/src/contract'

type Role = LoginResponse['role']
const USERS: Record<string, Role> = { auctioneer: 'auctioneer', alice: 'bidder', bob: 'bidder', carol: 'bidder', dave: 'outsider' }
const BIDDERS = ['alice', 'bob', 'carol']

interface Auction { id: string; item: string; invitees: string[]; status: 'open' | 'closed'; winner: string | null; price: string | null }
interface Bid { auctionId: string; bidder: string; amount: string; seq: number }

export interface Reply { status: number; body?: unknown }

export function createMock() {
  const auctions: Auction[] = []
  const bids: Bid[] = []
  let session: string | null = null
  let n = 0

  const fail = (status: number, code: ErrorCode, error: string, ledgerCode?: string): Reply =>
    ({ status, body: { error, code, ...(ledgerCode ? { ledgerCode } : {}) } satisfies ApiError })
  const ok = (body?: unknown, status = 200): Reply => ({ status, body })

  function handle(method: string, path: string, body: any): Reply {
    if (method === 'POST' && path === '/api/login') {
      const role = USERS[body?.userId]
      if (!role || !body?.password) return fail(401, 'BAD_CREDENTIALS', 'Invalid user or password')
      session = body.userId
      return ok({ userId: session, role })
    }
    if (method === 'POST' && path === '/api/logout') { session = null; return { status: 204 } }
    if (!session) return fail(401, 'UNAUTHENTICATED', 'Not logged in')
    const me = session
    const role = USERS[me]
    if (method === 'GET' && path === '/api/me') return ok({ userId: me, role })
    if (method === 'GET' && path === '/api/directory') return ok({ bidders: BIDDERS })

    const isAuctioneer = role === 'auctioneer'
    let m: RegExpMatchArray | null

    if (method === 'POST' && path === '/api/auctions') {
      if (!isAuctioneer) return fail(403, 'FORBIDDEN_ROLE', 'Only the auctioneer can create auctions')
      const inv: string[] = body?.bidders ?? []
      if (!body?.item || inv.length !== 3 || new Set(inv).size !== 3 || inv.some((b) => !BIDDERS.includes(b)))
        return fail(400, 'VALIDATION', 'Need an item and exactly 3 distinct bidders')
      const id = `auction-${++n}`
      auctions.push({ id, item: body.item, invitees: inv, status: 'open', winner: null, price: null })
      return ok({ auctionId: id }, 201)
    }
    if (method === 'GET' && path === '/api/auctions') {
      if (!isAuctioneer) return fail(403, 'FORBIDDEN_ROLE', 'Auctioneer only')
      return ok(auctions.map((a): AuctionSummary => ({
        auctionId: a.id, item: a.item, invitees: a.invitees, status: a.status,
        bidsReceived: bids.filter((b) => b.auctionId === a.id).length,
        ...(a.status === 'closed' ? { winner: a.winner, price: a.price } : {}),
      })))
    }
    if ((m = path.match(/^\/api\/auctions\/([^/]+)\/close$/)) && method === 'POST') {
      if (!isAuctioneer) return fail(403, 'FORBIDDEN_ROLE', 'Auctioneer only')
      const a = auctions.find((x) => x.id === decodeURIComponent(m![1]))
      if (!a) return fail(404, 'NOT_FOUND', 'Auction not found')
      if (a.status === 'closed') return fail(409, 'AUCTION_CLOSED', 'Auction already closed', 'CONTRACT_NOT_FOUND')
      // Highest bid wins; ties go to the earliest bid.
      let best: Bid | null = null
      for (const b of bids.filter((x) => x.auctionId === a.id))
        if (!best || Number(b.amount) > Number(best.amount)) best = b
      a.status = 'closed'
      a.winner = best?.bidder ?? null
      a.price = best?.amount ?? null
      return ok({ winner: a.winner, price: a.price })
    }

    if (isAuctioneer) return fail(403, 'FORBIDDEN_ROLE', 'Bidder or outsider only')
    const hasBid = (a: Auction) => bids.some((b) => b.auctionId === a.id && b.bidder === me)
    const mine = auctions.filter((a) => a.invitees.includes(me))

    if (method === 'GET' && path === '/api/invitations')
      return ok(mine.filter((a) => a.status === 'open' && !hasBid(a)).map((a) => ({ invitationId: `inv:${a.id}`, auctionId: a.id, item: a.item })))
    if ((m = path.match(/^\/api\/invitations\/([^/]+)\/bid$/)) && method === 'POST') {
      const a = auctions.find((x) => `inv:${x.id}` === decodeURIComponent(m![1]))
      if (!a || a.status === 'closed' || !a.invitees.includes(me))
        return fail(409, 'AUCTION_CLOSED_OR_NOT_INVITED', 'Auction is closed or you are not invited', 'CONTRACT_NOT_FOUND')
      if (hasBid(a)) return fail(409, 'ALREADY_BID', 'You have already bid on this auction')
      const amt = String(body?.amount ?? '')
      if (!/^\d+(\.\d+)?$/.test(amt) || Number(amt) <= 0) return fail(400, 'SA_NON_POSITIVE_BID', 'Bid must be a positive number', 'SA_NON_POSITIVE_BID')
      bids.push({ auctionId: a.id, bidder: me, amount: amt, seq: ++n })
      return ok({ bidId: `bid-${n}` }, 201)
    }
    if (method === 'GET' && path === '/api/bids')
      return ok(bids.filter((b) => b.bidder === me).map((b) => {
        const a = auctions.find((x) => x.id === b.auctionId)!
        return { auctionId: a.id, item: a.item, amount: b.amount, status: a.status }
      }))
    if (method === 'GET' && path === '/api/outcomes')
      return ok(mine.filter((a) => a.status === 'closed').map((a): OutcomeView => {
        const base = { auctionId: a.id, item: a.item }
        const own = bids.find((b) => b.auctionId === a.id && b.bidder === me)
        if (!own) return { ...base, result: 'did_not_bid' }
        return a.winner === me ? { ...base, result: 'won', amountOwed: a.price! } : { ...base, result: 'lost' }
      }))
    return fail(404, 'NOT_FOUND', `No route ${method} ${path}`)
  }
  return { handle }
}

export function installMock() {
  const mock = createMock()
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
    if (!url.pathname.startsWith('/api/')) return real(input, init)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const r = mock.handle((init?.method ?? 'GET').toUpperCase(), url.pathname, body)
    await new Promise((res) => setTimeout(res, 80))
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status, headers: { 'Content-Type': 'application/json' },
    })
  }
  console.info('[mock-server] /api/* is served in-browser (VITE_MOCK=1)')
}
