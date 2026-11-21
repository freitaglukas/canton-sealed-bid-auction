// Live LocalNet test. Run with LOCALNET=1 (and optionally TEST_DAR=/path/to/sealed-auction.dar).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createLedgerClient } from '../src/client'
import { LedgerError } from '../src/errors'
import { mintToken } from '../src/jwt'
import { loadTopology } from '../src/topology'
import { T } from '../src/templates'

const live = process.env.LOCALNET === '1'
const DAR = process.env.TEST_DAR
const ADMIN = 'ledger-api-user'
const topo = live ? loadTopology() : undefined

async function admin(base: string, path: string, init: RequestInit & { json?: unknown } = {}) {
  const token = await mintToken(ADMIN)
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const r = await fetch(base + path, { method: init.method ?? 'POST', headers: { ...headers, ...(init.headers as object) }, body: init.json !== undefined ? JSON.stringify(init.json) : (init.body as BodyInit) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

describe.skipIf(!live)('live: every participant, admin token', () => {
  for (const [name, base] of Object.entries(topo?.participants ?? {})) {
    it(`${name}: ledgerEnd + wildcard ACS`, async () => {
      const c = createLedgerClient(base, ADMIN)
      const end = await c.ledgerEnd()
      expect(end).toBeGreaterThanOrEqual(0)
      const rows = await c.activeContracts('ANY', 'ALL', { atOffset: end })
      expect(Array.isArray(rows)).toBe(true)
    })
  }
})

describe.skipIf(!live || !DAR)('live: auction flow (needs TEST_DAR)', () => {
  const base = topo?.participants['app-provider'] ?? ''
  const suffix = Date.now().toString(36)

  async function party(hint: string): Promise<string> {
    const r = await admin(base, '/v2/parties', { json: { partyIdHint: `${hint}${suffix}`, identityProviderId: '' } })
    return r.partyDetails.party as string
  }
  async function user(id: string, p: string) {
    await admin(base, '/v2/users', {
      json: {
        user: { id, primaryParty: p, isDeactivated: false, identityProviderId: '' },
        rights: [{ kind: { CanActAs: { value: { party: p } } } }, { kind: { CanReadAs: { value: { party: p } } } }],
      },
    })
  }

  it('create, exercise with result, ACS at offset, updates, error parse', async () => {
    await admin(base, '/v2/packages', { headers: { 'content-type': 'application/octet-stream' }, body: readFileSync(DAR!) as unknown as BodyInit })
    const auctioneer = await party('lt-auctioneer')
    const bidders = await Promise.all(['a', 'b', 'c'].map((h) => party(`lt-${h}`)))
    const uid = `lt-auctioneer-${suffix}`
    await user(uid, auctioneer)
    const c = createLedgerClient(base, uid)

    const before = await c.ledgerEnd()
    const { contractId } = await c.create(T.AuctioneerRole, { auctioneer }, [auctioneer])
    expect(contractId).toBeTruthy()

    const after = await c.ledgerEnd()
    expect(after).toBeGreaterThan(before)
    const rows = await c.activeContracts(auctioneer, [T.AuctioneerRole], { atOffset: after })
    expect(rows.map((r) => r.contractId)).toContain(contractId)

    // Choice name per the frozen Daml model: CreateAuction on AuctioneerRole.
    const r = await c.exercise<string>(T.AuctioneerRole, contractId, 'CreateAuction', { auctionId: `a-${suffix}`, item: 'x', invitees: bidders }, [auctioneer])
    expect(r.result).toBeTruthy()
    expect(r.events.some((e) => e.kind === 'exercised')).toBe(true)

    const txs = await c.updates(auctioneer, before)
    expect(txs.some((t) => t.events.some((e) => e.kind === 'exercised' && e.choice === 'CreateAuction'))).toBe(true)

    const err = await c.exercise(T.AuctioneerRole, '00' + 'ab'.repeat(33), 'CreateAuction', {}, [auctioneer]).catch((e) => e)
    expect(err).toBeInstanceOf(LedgerError)
    expect(err.httpStatus).toBeGreaterThanOrEqual(400)
  })
})
