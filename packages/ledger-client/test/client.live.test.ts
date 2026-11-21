// Live LocalNet test. Run with LOCALNET=1 (and optionally TEST_DAR=/path/to/sealed-auction.dar).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createLedgerClient } from '../src/client'
import { LedgerError } from '../src/errors'
import { mintToken } from '../src/jwt'
import { loadTopology } from '../src/topology'

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
      // The admin user has no CanReadAsAnyParty, so read as the party it can act as (if any).
      const rights = await admin(base, `/v2/users/${ADMIN}/rights`, { method: 'GET' })
      const act = rights.rights.find((r: any) => r.kind?.CanActAs)?.kind.CanActAs.value.party as string | undefined
      if (act) {
        const rows = await c.activeContracts(act, 'ALL', { atOffset: end })
        expect(Array.isArray(rows)).toBe(true)
      }
    })
  }
})

const PROBE = '#ledger-client-probe:Probe:Thing'

describe.skipIf(!live || !DAR)('live: probe flow (needs TEST_DAR = test/probe/.daml/dist/ledger-client-probe-0.0.2.dar)', () => {
  const base = topo?.participants['app-provider'] ?? ''
  const suffix = `t${Math.random().toString(36).slice(2, 8)}`

  async function party(hint: string): Promise<string> {
    const r = await admin(base, '/v2/parties', { json: { partyIdHint: `${suffix}-${hint}`, identityProviderId: '' } })
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

  it('create, exercise with result, ACS at offset, updates, disclosure, error parse', async () => {
    await admin(base, '/v2/packages', { headers: { 'content-type': 'application/octet-stream' }, body: readFileSync(DAR!) as unknown as BodyInit })
    const owner = await party('owner')
    const other = await party('other')
    await user(`${suffix}-owner`, owner)
    await user(`${suffix}-other`, other)
    const co = createLedgerClient(base, `${suffix}-owner`)
    const cx = createLedgerClient(base, `${suffix}-other`)

    const before = await co.ledgerEnd()
    const { contractId } = await co.create(PROBE, { owner, label: 'x' }, [owner])
    expect(contractId).toBeTruthy()
    const after = await co.ledgerEnd()
    expect(after).toBeGreaterThan(before)

    // ACS at an explicit offset, with and without blob
    const rows = await co.activeContracts<{ label: string }>(owner, [PROBE], { atOffset: after })
    expect(rows.map((r) => r.contractId)).toContain(contractId)
    expect(rows[0].createdEventBlob).toBeUndefined()
    expect(await co.activeContracts(owner, 'ALL', { atOffset: before })).toEqual([])

    // exercise with result (non-consuming)
    const r = await co.exercise<string>(PROBE, contractId, 'Ping', { viewer: owner }, [owner])
    expect(r.result).toBe('pong:x')
    expect(r.events.some((e) => e.kind === 'exercised')).toBe(true)

    const txs = await co.updates(owner, before)
    expect(txs.some((t) => t.events.some((e) => e.kind === 'exercised' && e.choice === 'Ping'))).toBe(true)

    // not visible to other without disclosure
    expect(await cx.activeContracts(other, [PROBE])).toEqual([])
    const denied = await cx.exercise(PROBE, contractId, 'Ping', { viewer: other }, [other]).catch((e) => e)
    expect(denied).toBeInstanceOf(LedgerError)

    // disclosed exercise: owner reads blob, other exercises with it
    const [withBlob] = await co.activeContracts(owner, [PROBE], { includeBlob: true })
    expect(withBlob.createdEventBlob).toBeTruthy()
    const dis = await cx
      .exercise<string>(PROBE, contractId, 'Ping', { viewer: other }, [other], {
        disclosed: [{ templateId: withBlob.templateId, contractId, createdEventBlob: withBlob.createdEventBlob! }],
      })
      .catch((e) => e)
    // Either the disclosed exercise succeeds, or it is a parsed LedgerError; never a raw failure.
    if (dis instanceof Error) expect(dis).toBeInstanceOf(LedgerError)
    else expect(dis.result).toBe('pong:x')

    const err = await co.exercise(PROBE, '00' + 'ab'.repeat(33), 'Ping', { viewer: owner }, [owner]).catch((e) => e)
    expect(err).toBeInstanceOf(LedgerError)
    expect(err.httpStatus).toBeGreaterThanOrEqual(400)
    console.log('error sample', JSON.stringify(err.raw), 'disclosed outcome', dis instanceof LedgerError ? dis.code : 'ok')
  })
})
