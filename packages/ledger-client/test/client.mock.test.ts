import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLedgerClient } from '../src/client'
import { LedgerError } from '../src/errors'
import { ledgerForUser, loadTopology } from '../src/topology'

type Rec = { url: string; auth?: string; body: any }
let server: Server
let base = ''
const reqs: Rec[] = []
let handler: (r: Rec) => { status?: number; json: unknown } = () => ({ json: {} })

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const rec: Rec = { url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined }
      reqs.push(rec)
      const out = handler(rec)
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out.json))
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

const ex = (cid: string, choice: string, result: unknown) => ({
  ExercisedEvent: { contractId: cid, templateId: 'pk:SealedAuction.Auction:Auction', choice, choiceArgument: {}, exerciseResult: result, consuming: false, actingParties: ['a'], witnessParties: ['a'] },
})

describe('client request/response shapes', () => {
  it('exercise uses LEDGER_EFFECTS and returns the exercise result', async () => {
    reqs.length = 0
    handler = () => ({
      json: { transaction: { updateId: 'u1', offset: 5, events: [ex('c1', 'Other', 1), ex('c1', 'Close', { tag: 'x' })] } },
    })
    const c = createLedgerClient(base, 'auctioneer', 'tok')
    const r = await c.exercise<{ tag: string }>('#sealed-auction:SealedAuction.Auction:Auction', 'c1', 'Close', { bids: [] }, ['p1'])
    expect(r.result).toEqual({ tag: 'x' })
    expect(r.events).toHaveLength(2)
    expect(reqs[0].url).toBe('/v2/commands/submit-and-wait-for-transaction')
    expect(reqs[0].auth).toBe('Bearer tok')
    expect(reqs[0].body.transactionFormat.transactionShape).toBe('TRANSACTION_SHAPE_LEDGER_EFFECTS')
    expect(reqs[0].body.commands.actAs).toEqual(['p1'])
  })

  const acsRow = (i: number) => ({ contractEntry: { JsActiveContract: { createdEvent: { contractId: `c${i}`, templateId: 't', createArgument: { i } } } } })

  it('activeContracts passes explicit offset and wildcard / any-party filters', async () => {
    reqs.length = 0
    handler = (r) =>
      r.url.includes('ledger-end')
        ? { json: { offset: 42 } }
        : { json: { activeAtOffset: 42, activeContracts: [{ contractEntry: { JsActiveContract: { createdEvent: { contractId: 'c', templateId: 't', createArgument: { x: 1 }, createdEventBlob: 'blob' } } } }] } }
    const c = createLedgerClient(base, 'auditor')
    const rows = await c.activeContracts('ANY', 'ALL', { includeBlob: true })
    expect(rows).toEqual([{ contractId: 'c', templateId: 't', payload: { x: 1 }, createdEventBlob: 'blob' }])
    const acs = reqs.find((r) => r.url.startsWith('/v2/state/active-contracts'))!
    expect(acs.url).toBe('/v2/state/active-contracts-page')
    expect(acs.body.activeAtOffset).toBe(42)
    expect(acs.body.eventFormat.filtersForAnyParty.cumulative[0].identifierFilter.WildcardFilter.value.includeCreatedEventBlob).toBe(true)
    expect(reqs[0].auth).toMatch(/^Bearer ey/) // minted token
  })

  it('activeContracts pages 450 contracts across 3 pages with a pinned offset', async () => {
    reqs.length = 0
    const all = Array.from({ length: 450 }, (_, i) => i)
    handler = (r) => {
      if (r.url.includes('ledger-end')) return { json: { offset: 99 } }
      const start = r.body.pageToken ? Number(r.body.pageToken) : 0
      const size = r.body.maxPageSize as number
      if (!(size <= 200)) return { status: 413, json: { code: 'JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED', cause: 'too many', context: {}, errorCategory: 2 } }
      const end = Math.min(start + size, 450)
      return { json: { activeAtOffset: 99, activeContracts: all.slice(start, end).map(acsRow), ...(end < 450 ? { nextPageToken: String(end) } : {}) } }
    }
    const rows = await createLedgerClient(base, 'a', 't').activeContracts('p', 'ALL')
    expect(rows).toHaveLength(450)
    expect(rows.map((x) => x.contractId)).toEqual(all.map((i) => `c${i}`))
    const pages = reqs.filter((r) => r.url.startsWith('/v2/state/active-contracts'))
    expect(pages).toHaveLength(3)
    expect(pages.every((p) => p.body.activeAtOffset === 99)).toBe(true)
    expect(pages[0].body.pageToken).toBeUndefined()
  })

  it('updates pages until endInclusive', async () => {
    reqs.length = 0
    const tx = (o: number) => ({ update: { Transaction: { value: { updateId: `u${o}`, offset: o, events: [] } } } })
    handler = (r) => {
      if (r.url.includes('ledger-end')) return { json: { offset: 250 } }
      const b = r.body.beginExclusive as number
      const lim = Number(new URL(r.url, 'http://x').searchParams.get('limit'))
      const end = Math.min(b + lim, 250)
      return { json: Array.from({ length: end - b }, (_, i) => tx(b + i + 1)) }
    }
    const c = createLedgerClient(base, 'alice', 't')
    const txs = await c.updates('p', 0)
    expect(txs).toHaveLength(250)
    expect(txs.at(-1)!.offset).toBe(250)
    expect(reqs.filter((r) => r.url.startsWith('/v2/updates'))).toHaveLength(2)
  })

  it('updates halves the limit on 413 and retries the same range', async () => {
    reqs.length = 0
    const tx = (o: number) => ({ update: { Transaction: { value: { updateId: `u${o}`, offset: o, events: [] } } } })
    handler = (r) => {
      if (r.url.includes('ledger-end')) return { json: { offset: 30 } }
      const lim = Number(new URL(r.url, 'http://x').searchParams.get('limit'))
      if (lim > 10) return { status: 413, json: { code: 'JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED', cause: 'x', context: {}, errorCategory: 2 } }
      const b = r.body.beginExclusive as number
      const end = Math.min(b + lim, 30)
      return { json: Array.from({ length: end - b }, (_, i) => tx(b + i + 1)) }
    }
    const txs = await createLedgerClient(base, 'alice', 't').updates('p', 0)
    expect(txs.map((t) => t.offset)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    const limits = reqs.filter((r) => r.url.startsWith('/v2/updates')).map((r) => Number(new URL(r.url, 'http://x').searchParams.get('limit')))
    expect(limits[0]).toBeLessThanOrEqual(200)
    expect(limits.slice(0, 4)).toEqual([200, 100, 50, 25])
    expect(reqs.filter((r) => r.url.startsWith('/v2/updates')).slice(0, 5).every((r) => r.body.beginExclusive === 0)).toBe(true)
  })

  it('updates gives up when 413 persists at limit 1', async () => {
    handler = (r) => (r.url.includes('ledger-end') ? { json: { offset: 5 } } : { status: 413, json: { code: 'JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED', cause: 'x', context: {} } })
    const e = await createLedgerClient(base, 'a', 't').updates('p', 0).catch((x) => x)
    expect(e).toBeInstanceOf(LedgerError)
    expect(e.httpStatus).toBe(413)
  })

  it('sends disclosedContracts with createdEventBlob', async () => {
    reqs.length = 0
    handler = () => ({ json: { transaction: { updateId: 'u', offset: 1, events: [ex('c1', 'Close', 'ok')] } } })
    const c = createLedgerClient(base, 'bob', 't')
    await c.exercise('#p:M:T', 'c1', 'Close', {}, ['p'], { disclosed: [{ templateId: 'pk:M:T', contractId: 'c1', createdEventBlob: 'BLOB' }] })
    expect(reqs[0].body.commands.disclosedContracts).toEqual([{ templateId: 'pk:M:T', contractId: 'c1', createdEventBlob: 'BLOB' }])
    reqs.length = 0
    await c.exercise('#p:M:T', 'c1', 'Close', {}, ['p'])
    expect(reqs[0].body.commands.disclosedContracts).toBeUndefined()
  })

  it('INACTIVE_CONTRACTS is not retryable', async () => {
    handler = () => ({ status: 409, json: { code: 'INACTIVE_CONTRACTS', cause: 'archived', context: {}, errorCategory: 9 } })
    const e = await createLedgerClient(base, 'a', 't').create('#p:M:T', {}, ['p']).catch((x) => x)
    expect(e.retryable).toBe(false)
  })

  it('re-mints the token after a 401 and retries once', async () => {
    reqs.length = 0
    let n = 0
    handler = (r) => (r.url.includes('ledger-end') && n++ === 0 ? { status: 401, json: { code: 'UNAUTHENTICATED', cause: 'expired', context: {} } } : { json: { offset: 7 } })
    const c = createLedgerClient(base, 'a')
    expect(await c.ledgerEnd()).toBe(7)
    expect(reqs).toHaveLength(2)
  })

  it('maps HTTP errors to LedgerError', async () => {
    handler = () => ({ status: 409, json: { code: 'LOCAL_VERDICT_LOCKED_CONTRACTS', cause: 'locked', context: {}, errorCategory: 2 } })
    const c = createLedgerClient(base, 'alice', 't')
    const e = await c.create('#p:M:T', {}, ['p']).catch((x) => x)
    expect(e).toBeInstanceOf(LedgerError)
    expect(e.retryable).toBe(true)
    expect(e.httpStatus).toBe(409)
  })
})

describe('topology', () => {
  it('loads default topology and builds per-user clients', () => {
    const t = loadTopology()
    expect(ledgerForUser('alice', t).baseUrl).toBe(t.participants['app-user'])
    expect(ledgerForUser('auctioneer', t).userId).toBe('auctioneer')
    expect(() => ledgerForUser('nobody', t)).toThrow(/unknown user/)
  })
})
