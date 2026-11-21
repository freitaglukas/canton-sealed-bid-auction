import { describe, it, expect, beforeAll } from 'vitest'
import { ledgerForUser, loadParties, T, LedgerError } from '@sa/ledger-client'
import { login, type Api } from '../src/api'

const LIVE = process.env.LOCALNET === '1'
const users = ['auctioneer', 'alice', 'bob', 'carol', 'dave'] as const
const bidders = ['alice', 'bob', 'carol'] as const

describe.skipIf(!LIVE)('sealed-bid auction on LocalNet', () => {
  const parties = LIVE ? loadParties() : {}
  const api: Record<string, Api> = {}
  const ledger: Record<string, ReturnType<typeof ledgerForUser>> = {}
  const start: Record<string, number> = {}
  const item = `Painting-${Date.now()}`
  let A = '', B = ''
  const inv: Record<string, Record<string, string>> = { A: {}, B: {} } // key -> user -> invitationId
  const P = (u: string) => parties[u]

  const getInvs = async () => {
    for (const u of bidders) {
      const r = await api[u].call('GET', '/api/invitations')
      for (const i of r.body as any[]) {
        if (i.auctionId === A) inv.A[u] = i.invitationId
        if (i.auctionId === B) inv.B[u] = i.invitationId
      }
    }
  }
  // BUG (backend): fastify default maxParamLength=100 < contract id length (~138) => REST bid gives 414
  // FST_ERR_MAX_PARAM_LENGTH. Helpers fall back to the ledger so the rest of the flow is still verified.
  const restBid = (u: string, id: string, amount: string) =>
    api[u].call('POST', `/api/invitations/${encodeURIComponent(id)}/bid`, { amount })
  /** returns {status, code}; status 200 on success, 409 or ledger-derived 409 on rejection */
  const bid = async (u: string, k: 'A' | 'B', amount: string) => {
    const r = await restBid(u, inv[k][u], amount)
    if (r.status !== 414) return r
    try {
      await ledger[u].exercise(T.AuctionInvitation, inv[k][u], 'PlaceBid', { amount }, [P(u)])
      return { status: 200, body: {} as any }
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e
      return { status: 409, body: { code: 'ALREADY_BID' } as any }
    }
  }
  const rejected = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as any } throw new Error('expected rejection') }
  const auctionCid = async () =>
    (await ledger.auctioneer.activeContracts<any>(P('auctioneer'), [T.Auction])).find((c) => c.payload.auctionId === A)!.contractId
  const bidsOf = async (u: string, id = A) =>
    (await ledger[u].activeContracts<any>(P(u), [T.Bid])).filter((c) => c.payload.auctionId === id)

  beforeAll(async () => {
    for (const u of users) {
      api[u] = await login(u)
      ledger[u] = ledgerForUser(u)
      start[u] = await ledger[u].ledgerEnd()
    }
  })

  it('1. two concurrent auctions are open', async () => {
    const mk = async (suffix: string) => {
      const r = await api.auctioneer.call('POST', '/api/auctions', { item: `${item}-${suffix}`, bidders: [...bidders] })
      expect(r.status).toBe(200)
      return r.body.auctionId as string
    }
    A = await mk('A'); B = await mk('B')
    const list = (await api.auctioneer.call('GET', '/api/auctions')).body as any[]
    for (const id of [A, B]) expect(list.find((a) => a.auctionId === id)?.status).toBe('open')
    await getInvs()
    for (const u of bidders) { expect(inv.A[u]).toBeTruthy(); expect(inv.B[u]).toBeTruthy() }
  })

  it('2. outsider cannot see or bid', async () => {
    const r = await api.dave.call('GET', '/api/invitations')
    expect((r.body as any[]).filter((i) => [A, B].includes(i.auctionId))).toEqual([])
    const res = await restBid('dave', inv.A.alice, '999')
    if (res.status === 414) {
      const e = await rejected(ledger.dave.exercise(T.AuctionInvitation, inv.A.alice, 'PlaceBid', { amount: '999' }, [P('dave')]))
      expect(e).toBeInstanceOf(LedgerError)
    } else {
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('AUCTION_CLOSED_OR_NOT_INVITED')
    }
    const e = await rejected(ledger.dave.create(T.Bid, {
      auctioneer: P('auctioneer'), bidder: P('dave'), invitationCid: inv.A.alice, auctionId: A, item,
      amount: '999', submittedAt: new Date().toISOString(),
    }, [P('dave')]))
    expect(e).toBeInstanceOf(LedgerError)
  })

  it('3. sealed bids are accepted', async () => {
    for (const [u, k, amt] of [['alice','A','100'],['bob','A','150'],['carol','A','120'],['alice','B','50'],['carol','B','60']] as const) {
      expect((await bid(u, k, amt)).status).toBe(200)
    }
  })

  // KNOWN BUG: backend rejects every real invitationId with 414 FST_ERR_MAX_PARAM_LENGTH (fastify maxParamLength).
  it.fails('3b. REST bid endpoint accepts a real invitationId (BUG: 414 param too long)', async () => {
    const r = await restBid('bob', inv.B.bob, '10')
    expect(r.status).toBe(200)
  })

  it('4. privacy before close', async () => {
    const amt: Record<string, string> = { alice: '100', bob: '150', carol: '120' }
    for (const u of bidders) {
      const r = (await api[u].call('GET', '/api/bids')).body as any[]
      const mine = r.filter((b) => b.auctionId === A)
      expect(mine.map((b) => Number(b.amount))).toEqual([Number(amt[u])])
      const acs = await ledger[u].activeContracts<any>(P(u), [T.Bid])
      expect(acs.length).toBeGreaterThan(0)
      for (const c of acs) expect(c.payload.bidder).toBe(P(u))
    }
    expect((await bidsOf('auctioneer')).length).toBe(3)
  })

  it('5. outsider sees nothing', async () => {
    const all = await ledger.dave.activeContracts<any>(P('dave'), 'ALL')
    expect(all.filter((c) => [A, B].includes(c.payload?.auctionId))).toEqual([])
    const aud = await ledgerForUser('auditor-app-user').activeContracts<any>('ANY', [T.Bid])
    expect(aud.some((c) => c.payload.auctionId === A && c.payload.bidder === P('alice'))).toBe(true)
  })

  it('6. cannot change someone else\'s bid', async () => {
    const aliceBid = (await bidsOf('alice'))[0].contractId
    const e1 = await rejected(ledger.bob.exercise(T.Bid, aliceBid, 'Archive', {}, [P('bob')]))
    expect(e1).toBeInstanceOf(LedgerError)
    expect(e1.code).toBe('CONTRACT_NOT_FOUND')
    const withBlob = await ledger.auctioneer.activeContracts<any>(P('auctioneer'), [T.Bid], { includeBlob: true })
    const c = withBlob.find((x) => x.contractId === aliceBid)!
    const e2 = await rejected(ledger.bob.exercise(T.Bid, aliceBid, 'Bid_Conclude', { won: true }, [P('bob')],
      { disclosed: [{ templateId: c.templateId, contractId: c.contractId, createdEventBlob: c.createdEventBlob! }] }))
    expect(e2).toBeInstanceOf(LedgerError)
    expect((await bidsOf('alice')).some((x) => x.contractId === aliceBid)).toBe(true)
  })

  it('7. only the auctioneer can close', async () => {
    const r = await api.bob.call('POST', `/api/auctions/${encodeURIComponent(A)}/close`)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('FORBIDDEN_ROLE')
    await rejected(ledger.bob.exercise(T.Auction, await auctionCid(), 'Auction_Close', { bids: [], openInvitations: [] }, [P('bob')]))
    const list = (await api.auctioneer.call('GET', '/api/auctions')).body as any[]
    expect(list.find((a) => a.auctionId === A).status).toBe('open')
  })

  it('8. no second bid', async () => {
    const r = await bid('alice', 'A', '500')
    expect(r.status).toBe(409)
    expect(['ALREADY_BID', 'AUCTION_CLOSED_OR_NOT_INVITED']).toContain(r.body.code)
  })

  it('9. auctioneer closes A, bob wins and owes 150', async () => {
    const r = await api.auctioneer.call('POST', `/api/auctions/${encodeURIComponent(A)}/close`)
    expect(r.status).toBe(200)
    expect(r.body.winner).toBe('bob')
    expect(String(r.body.price)).toBe('150')
    const out = async (u: string) => ((await api[u].call('GET', '/api/outcomes')).body as any[]).find((o) => o.auctionId === A)
    const ob = await out('bob')
    expect(ob.result).toBe('won'); expect(ob.amountOwed).toBe('150')
    for (const u of ['alice', 'carol']) {
      const o = await out(u)
      expect(o.result).toBe('lost'); expect(o.amountOwed).toBeUndefined()
      const mine = ((await api[u].call('GET', '/api/bids')).body as any[]).filter((b) => b.auctionId === A)
      expect(Number(mine[0].amount)).toBe(u === 'alice' ? 100 : 120)
    }
  })

  it('10. bid after close rejected', async () => {
    expect((await api.auctioneer.call('POST', `/api/auctions/${encodeURIComponent(B)}/close`)).status).toBe(200)
    expect((await bid('bob', 'B', '70')).status).toBe(409)
    const o = ((await api.bob.call('GET', '/api/outcomes')).body as any[]).find((x) => x.auctionId === B)
    expect(o.result).toBe('did_not_bid')
  })

  it('11. privacy after close', async () => {
    for (const [u, other] of [['alice', ['bob', 'carol']], ['carol', ['bob', 'alice']]] as const) {
      const txs = await ledger[u].updates(P(u), start[u])
      const s = JSON.stringify(txs.flatMap((t) => t.events))
      expect(s.length).toBeGreaterThan(2)
      expect(s).not.toContain(P('bob'))
      expect(s).not.toMatch(/"150(\.0+)?"/)
      if (u === 'alice') expect(s).not.toContain(P('carol'))
      void other
    }
    const d = await ledger.dave.updates(P('dave'), start.dave)
    expect(d.flatMap((t) => t.events)).toEqual([])
  })
})
