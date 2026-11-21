// Live LocalNet tests. Run: LOCALNET=1 TEST_DAR=<abs probe or real dar> npm -w packages/ops test
// Uses unique `t<random>-` user ids / party hints and a temp topology + output dir.
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTopology, type Topology } from '@sa/ledger-client'
import { deploy, deployOk, EXPECTED_STATUS } from '../src/deploy-dar'
import { provision } from '../src/provision'
import { deleteUser, getUser, grantRights, listRights, rightKey } from '../src/admin'
import { parseArgs } from '../src/args'

const live = process.env.LOCALNET === '1'
const DAR = process.env.TEST_DAR

describe('parseArgs', () => {
  it('parses --k v and --k=v, skips --, rejects unknown', () => {
    expect(parseArgs(['--', '--dar', '/a', '--topology=/b'], ['dar', 'topology'])).toEqual({ dar: '/a', topology: '/b' })
    expect(() => parseArgs(['--nope', 'x'], ['dar'])).toThrow(/unknown/)
    expect(() => parseArgs(['--dar'], ['dar'])).toThrow(/missing/)
  })
})

describe.skipIf(!live)('live ops', () => {
  const real = live ? loadTopology() : ({ participants: {}, users: [] } as Topology)
  const s = `t${Math.random().toString(36).slice(2, 8)}`
  const topo: Topology = {
    participants: real.participants,
    users: [
      { id: `${s}-auctioneer`, participant: 'app-provider', role: 'auctioneer' },
      { id: `${s}-alice`, participant: 'app-user', role: 'bidder' },
      { id: `${s}-bob`, participant: 'app-user', role: 'bidder' },
      { id: `${s}-auditor`, participant: 'sv', role: 'auditor' },
    ],
  }
  const outDir = mkdtempSync(join(tmpdir(), 'ops-test-'))
  const read = (f: string) => JSON.parse(readFileSync(join(outDir, f), 'utf8'))
  const base = (id: string) => topo.participants[topo.users.find((u) => u.id === id)!.participant]

  describe.skipIf(!DAR)('with TEST_DAR', () => {
    beforeAll(async () => {
      // provision requires the package to be deployed first; the probe DAR stands in for the real one
      await deploy(DAR!, topo)
    }, 120_000)

    it('deploy verifies package on all participants', async () => {
      const rows = await deploy(DAR!, topo)
      expect(rows.map((r) => r.participant).sort()).toEqual(Object.keys(topo.participants).sort())
      for (const r of rows) {
        expect(r.error).toBeUndefined()
        expect(r.status).toBe(EXPECTED_STATUS)
        expect(r.vetted).toBe(true)
        expect(r.packageId).toMatch(/^[0-9a-f]{64}$/)
        expect(deployOk(r)).toBe(true)
      }
    }, 120_000)

    it('provision grants own-party rights only', async () => {
      await provision(topo, { outDir })
      const parties = read('parties.json')
      for (const u of topo.users) {
        const p = parties[u.id]
        expect(p).toMatch(new RegExp(`^${u.id}::`))
        const user = await getUser(base(u.id), u.id)
        expect(user?.primaryParty).toBe(p)
        const keys = (await listRights(base(u.id), u.id)).map(rightKey).sort()
        const want =
          u.role === 'auditor'
            ? [`CanReadAs:${p}`, 'CanReadAsAnyParty']
            : [`CanActAs:${p}`, `CanReadAs:${p}`]
        expect(keys).toEqual(want.sort())
      }
      const creds = read('credentials.json')
      expect(Object.keys(creds).sort()).toEqual(topo.users.filter((u) => u.role !== 'auditor').map((u) => u.id).sort())
    }, 120_000)

    it('provision is idempotent and repairs partial and stale state', async () => {
      const first = { parties: read('parties.json'), creds: read('credentials.json') }
      await provision(topo, { outDir })
      expect(read('parties.json')).toEqual(first.parties)
      expect(read('credentials.json')).toEqual(first.creds)

      // delete a user but keep its party
      const victim = `${s}-alice`
      await deleteUser(base(victim), victim)
      expect(await getUser(base(victim), victim)).toBeUndefined()
      await provision(topo, { outDir })
      expect(read('parties.json')).toEqual(first.parties)
      const restored = await getUser(base(victim), victim)
      expect(restored?.primaryParty).toBe(first.parties[victim])
      expect((await listRights(base(victim), victim)).map(rightKey).sort()).toEqual(
        [`CanActAs:${first.parties[victim]}`, `CanReadAs:${first.parties[victim]}`].sort(),
      )
      expect(read('credentials.json')[victim]).toEqual(first.creds[victim])

      // stale rights: an extra right on bob is revoked
      const bob = `${s}-bob`
      await grantRights(base(bob), bob, [{ kind: 'CanReadAs', party: first.parties[`${s}-alice`] }])
      await provision(topo, { outDir })
      expect((await listRights(base(bob), bob)).map(rightKey).sort()).toEqual(
        [`CanActAs:${first.parties[bob]}`, `CanReadAs:${first.parties[bob]}`].sort(),
      )

      // corrupt parties.json
      writeFileSync(join(outDir, 'parties.json'), '{"garbage": tru')
      await provision(topo, { outDir })
      expect(read('parties.json')).toEqual(first.parties)

      // corrupt credentials.json: existing users get fresh passwords, file is valid again
      writeFileSync(join(outDir, 'credentials.json'), 'not json')
      await provision(topo, { outDir })
      expect(Object.keys(read('credentials.json')).sort()).toEqual(Object.keys(first.creds).sort())
    }, 180_000)

    it('provision skips the AuctioneerRole step when sealed-auction is not vetted', async () => {
      const r = await provision(topo, { outDir })
      // the probe DAR is not the sealed-auction package; the real DAR makes this 'exists'
      expect(['skipped', 'exists', 'created']).toContain(r.auctioneerRole)
      if (!process.env.TEST_DAR?.includes('sealed-auction')) expect(r.auctioneerRole).toBe('skipped')
    }, 120_000)
  })
})
