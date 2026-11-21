import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server'
import { FakeLedger, credentials, lerr, parties, topology } from './fake-ledger'

let fake: FakeLedger
let app: FastifyInstance
let beforeClose: (() => Promise<void>) | undefined

beforeEach(async () => {
  fake = new FakeLedger()
  beforeClose = undefined
  app = await buildServer({
    ledgerFor: fake.ledgerFor,
    parties,
    topology,
    credentials,
    hooks: { beforeCloseSubmit: async () => beforeClose?.() },
  })
})

async function login(userId: string, password = credentials[userId]) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { userId, password } })
  const c = res.cookies.find((x) => x.name === 'sa_session')
  const cookies: Record<string, string> = c ? { sa_session: c.value } : {}
  return { res, cookies }
}
const as = async (u: string) => (await login(u)).cookies

async function createAuction(item = 'Vase') {
  const res = await app.inject({
    method: 'POST', url: '/api/auctions', cookies: await as('auctioneer'),
    payload: { item, bidders: ['alice', 'bob', 'carol'] },
  })
  return res
}
async function bid(user: string, amount: string) {
  const cookies = await as(user)
  const inv = (await app.inject({ method: 'GET', url: '/api/invitations', cookies })).json()
  return app.inject({ method: 'POST', url: `/api/invitations/${inv[0].invitationId}/bid`, cookies, payload: { amount } })
}

describe('login', () => {
  it("login requires the user's password", async () => {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { userId: 'auctioneer', password: 'dave-pw' } })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('BAD_CREDENTIALS')
    expect(res.cookies).toHaveLength(0)
  })
  it('correct password sets session; /api/me and logout work', async () => {
    const { res, cookies } = await login('alice')
    expect(res.json()).toEqual({ userId: 'alice', role: 'bidder' })
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies })
    expect(me.json()).toEqual({ userId: 'alice', role: 'bidder' })
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: { sa_session: 'alice' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/logout', cookies })).statusCode).toBe(204)
  })
  it('directory lists bidders', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/directory', cookies: await as('auctioneer') })
    expect(res.json()).toEqual({ bidders: ['alice', 'bob', 'carol'] })
  })
})

describe('roles and validation', () => {
  it('wrong role is 403 FORBIDDEN_ROLE', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auctions', cookies: await as('alice') })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('FORBIDDEN_ROLE')
    const r2 = await app.inject({ method: 'GET', url: '/api/invitations', cookies: await as('auctioneer') })
    expect(r2.statusCode).toBe(403)
  })
  it('unauthenticated is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auctions' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('UNAUTHENTICATED')
  })
  it('bad create body is 400 VALIDATION naming the offender', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auctions', cookies: await as('auctioneer'),
      payload: { item: 'Vase', bidders: ['alice', 'bob', 'dave'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('VALIDATION')
    expect(res.json().error).toContain('dave')
  })
  it('bad amount is 400', async () => {
    await createAuction()
    expect((await bid('alice', '1e3')).statusCode).toBe(400)
  })
})

describe('full flow', () => {
  it('create, bid, close, outcomes', async () => {
    const created = await createAuction('Vase')
    expect(created.statusCode).toBe(200)
    const { auctionId } = created.json()
    expect(auctionId).toMatch(/^[0-9a-f-]{36}$/)

    expect((await bid('alice', '100')).statusCode).toBe(200)
    expect((await bid('bob', '150')).json().bidId).toBeTruthy()

    const auc = await as('auctioneer')
    const list = (await app.inject({ method: 'GET', url: '/api/auctions', cookies: auc })).json()
    expect(list).toEqual([{ auctionId, item: 'Vase', invitees: ['alice', 'bob', 'carol'], bidsReceived: 2, status: 'open' }])

    const close = await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies: auc })
    expect(close.json()).toEqual({ winner: 'bob', price: '150' })

    const closed = (await app.inject({ method: 'GET', url: '/api/auctions', cookies: auc })).json()
    expect(closed[0]).toMatchObject({ status: 'closed', winner: 'bob', price: '150', bidsReceived: 2 })
    expect(closed[0].invitees.sort()).toEqual(['alice', 'bob', 'carol'])

    const out = async (u: string) => (await app.inject({ method: 'GET', url: '/api/outcomes', cookies: await as(u) })).json()
    expect(await out('bob')).toEqual([{ auctionId, item: 'Vase', result: 'won', amountOwed: '150' }])
    expect(await out('alice')).toEqual([{ auctionId, item: 'Vase', result: 'lost' }])
    expect(await out('carol')).toEqual([{ auctionId, item: 'Vase', result: 'did_not_bid' }])
    expect(await out('dave')).toEqual([])

    const bids = (await app.inject({ method: 'GET', url: '/api/bids', cookies: await as('alice') })).json()
    expect(bids).toEqual([{ auctionId, item: 'Vase', amount: '100', status: 'closed' }])
  })

  it('open bids are listed as open with normalized amounts', async () => {
    const { auctionId } = (await createAuction()).json()
    await bid('alice', '10.50')
    const bids = (await app.inject({ method: 'GET', url: '/api/bids', cookies: await as('alice') })).json()
    expect(bids).toEqual([{ auctionId, item: 'Vase', amount: '10.5', status: 'open' }])
  })

  it('close with no bids returns nulls', async () => {
    const { auctionId } = (await createAuction()).json()
    const close = await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies: await as('auctioneer') })
    expect(close.json()).toEqual({ winner: null, price: null })
  })
})

describe('error mapping over HTTP', () => {
  it('second bid on same invitation is 409 ALREADY_BID with ledgerCode', async () => {
    await createAuction()
    const cookies = await as('alice')
    const inv = (await app.inject({ method: 'GET', url: '/api/invitations', cookies })).json()
    const url = `/api/invitations/${inv[0].invitationId}/bid`
    await app.inject({ method: 'POST', url, cookies, payload: { amount: '5' } })
    const again = await app.inject({ method: 'POST', url, cookies, payload: { amount: '6' } })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'ALREADY_BID', ledgerCode: 'CONTRACT_NOT_FOUND' })
  })
  it('bid after close is 409 AUCTION_CLOSED_OR_NOT_INVITED', async () => {
    const { auctionId } = (await createAuction()).json()
    const cookies = await as('carol')
    const inv = (await app.inject({ method: 'GET', url: '/api/invitations', cookies })).json()
    await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies: await as('auctioneer') })
    const res = await app.inject({ method: 'POST', url: `/api/invitations/${inv[0].invitationId}/bid`, cookies, payload: { amount: '5' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('AUCTION_CLOSED_OR_NOT_INVITED')
  })
  it("bidding on someone else's invitation is refused", async () => {
    await createAuction()
    const inv = (await app.inject({ method: 'GET', url: '/api/invitations', cookies: await as('alice') })).json()
    const res = await app.inject({
      method: 'POST', url: `/api/invitations/${inv[0].invitationId}/bid`, cookies: await as('dave'), payload: { amount: '5' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('AUCTION_CLOSED_OR_NOT_INVITED')
  })
  it('authorization failure is 403 NOT_AUTHORIZED', async () => {
    await createAuction()
    const inv = (await app.inject({ method: 'GET', url: '/api/invitations', cookies: await as('alice') })).json()
    fake.failNext.PlaceBid = [lerr('DAML_AUTHORIZATION_ERROR', { status: 403 })]
    const res = await app.inject({
      method: 'POST', url: `/api/invitations/${inv[0].invitationId}/bid`, cookies: await as('alice'), payload: { amount: '5' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'NOT_AUTHORIZED', ledgerCode: 'DAML_AUTHORIZATION_ERROR' })
  })
  it('unknown ledger error is 502 LEDGER_ERROR', async () => {
    fake.failNext.CreateAuction = [lerr('WEIRD', { status: 500 })]
    const res = await createAuction()
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ code: 'LEDGER_ERROR', ledgerCode: 'WEIRD' })
  })
  it('closing twice: 409 AUCTION_CLOSED; unknown id: 404 NOT_FOUND', async () => {
    const { auctionId } = (await createAuction()).json()
    const cookies = await as('auctioneer')
    await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies })
    const again = await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('AUCTION_CLOSED')
    const unknown = await app.inject({ method: 'POST', url: '/api/auctions/nope/close', cookies })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().code).toBe('NOT_FOUND')
  })
  it('persistent lineage failure after 3 attempts is 409 CLOSE_CONFLICT', async () => {
    const { auctionId } = (await createAuction()).json()
    fake.failNext.Auction_Close = [1, 2, 3, 4].map(() => lerr('UNHANDLED_EXCEPTION', { errorId: 'SA_INCOMPLETE_CLOSE' }))
    const res = await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies: await as('auctioneer') })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'CLOSE_CONFLICT', ledgerCode: 'UNHANDLED_EXCEPTION' })
    expect(fake.closeArgs.length).toBe(0) // failures were injected before the fake ran
    expect(fake.calls.filter((c) => c.choice === 'Auction_Close')).toHaveLength(3)
  })
})

describe('bid conflicts after close', () => {
  it('bid -> close -> re-bid is ALREADY_BID', async () => {
    const { auctionId } = (await createAuction()).json()
    const cookies = await as('alice')
    const inv = (await app.inject({ method: 'GET', url: '/api/invitations', cookies })).json()
    const url = `/api/invitations/${inv[0].invitationId}/bid`
    expect((await app.inject({ method: 'POST', url, cookies, payload: { amount: '5' } })).statusCode).toBe(200)
    await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies: await as('auctioneer') })
    const again = await app.inject({ method: 'POST', url, cookies, payload: { amount: '6' } })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('ALREADY_BID')
  })
  it('no bid -> close -> bid is AUCTION_CLOSED_OR_NOT_INVITED', async () => {
    const { auctionId } = (await createAuction()).json()
    const cookies = await as('carol')
    const inv = (await app.inject({ method: 'GET', url: '/api/invitations', cookies })).json()
    await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies: await as('auctioneer') })
    const res = await app.inject({ method: 'POST', url: `/api/invitations/${inv[0].invitationId}/bid`, cookies, payload: { amount: '6' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('AUCTION_CLOSED_OR_NOT_INVITED')
  })
})

describe('close conflict', () => {
  it('CONTRACT_NOT_FOUND persisting 3 attempts while Auction stays active is CLOSE_CONFLICT', async () => {
    const { auctionId } = (await createAuction()).json()
    fake.failNext.Auction_Close = [1, 2, 3].map(() => lerr('CONTRACT_NOT_FOUND'))
    const res = await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies: await as('auctioneer') })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'CLOSE_CONFLICT', ledgerCode: 'CONTRACT_NOT_FOUND' })
    expect(fake.calls.filter((c) => c.choice === 'Auction_Close')).toHaveLength(3)
  })
})

describe('isolation', () => {
  it("routes use only the caller's ledger client", async () => {
    await createAuction()
    fake.requested.length = 0
    fake.calls.length = 0
    const cookies = await as('alice')
    await app.inject({ method: 'GET', url: '/api/invitations', cookies })
    await bid('alice', '10')
    await app.inject({ method: 'GET', url: '/api/bids', cookies })
    await app.inject({ method: 'GET', url: '/api/outcomes', cookies })
    expect(fake.calls.length).toBeGreaterThan(0)
    expect(new Set(fake.requested)).toEqual(new Set(['alice']))
    for (const c of fake.calls) {
      expect(c.userId).toBe('alice')
      if (c.party) expect(c.party).toBe(parties.alice)
      if (c.actAs) expect(c.actAs).toEqual([parties.alice])
    }
  })
  it('auctioneer requests act only as the auctioneer', async () => {
    fake.calls.length = 0
    await createAuction()
    const aucCalls = fake.calls.filter((c) => c.userId === 'auctioneer')
    expect(aucCalls.length).toBe(fake.calls.length)
    for (const c of fake.calls) {
      if (c.party) expect(c.party).toBe(parties.auctioneer)
      if (c.actAs) expect(c.actAs).toEqual([parties.auctioneer])
    }
  })
})

describe('close passes complete inputs and retries', () => {
  it('a bid injected between read and submit triggers a retry with fresh inputs', async () => {
    const { auctionId } = (await createAuction()).json()
    await bid('alice', '100')
    let injected = false
    beforeClose = async () => {
      if (injected) return
      injected = true
      await bid('bob', '200')
    }
    const res = await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies: await as('auctioneer') })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ winner: 'bob', price: '200' })
    const closes = fake.calls.filter((c) => c.choice === 'Auction_Close')
    expect(closes).toHaveLength(2)
    expect(closes[0].arg.bids).toHaveLength(1)
    expect(closes[0].arg.openInvitations).toHaveLength(2)
    expect(closes[1].arg.bids).toHaveLength(2)
    expect(closes[1].arg.openInvitations).toHaveLength(1)
  })
  it('a retryable error is retried then succeeds', async () => {
    const { auctionId } = (await createAuction()).json()
    fake.failNext.Auction_Close = [lerr('LOCAL_VERDICT_LOCKED_CONTRACTS', { retryable: true })]
    const res = await app.inject({ method: 'POST', url: `/api/auctions/${auctionId}/close`, cookies: await as('auctioneer') })
    expect(res.statusCode).toBe(200)
    expect(fake.calls.filter((c) => c.choice === 'Auction_Close')).toHaveLength(2)
  })
})
