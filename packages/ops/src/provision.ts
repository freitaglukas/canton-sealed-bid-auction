import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLedgerClient, loadTopology, T, type Topology } from '@sa/ledger-client'
import {
  allocateParty,
  createUser,
  findParty,
  getUser,
  grantRights,
  listRights,
  listVetted,
  revokeRights,
  rightKey,
  setPrimaryParty,
  type Right,
} from './admin'
import { parseArgs } from './args'

export type RoleStep = 'created' | 'exists' | 'skipped'

export interface ProvisionResult {
  parties: Record<string, string>
  credentials: Record<string, { password: string }>
  auctioneerRole: RoleStep
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const pj = join(dir, 'package.json')
    if (existsSync(pj)) {
      try {
        if (JSON.parse(readFileSync(pj, 'utf8')).workspaces) return dir
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(dir)
    if (up === dir) throw new Error('repo root (package.json with workspaces) not found')
    dir = up
  }
}

function readJsonOr<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

const sameSet = (a: Right[], b: Right[]) =>
  a.length === b.length && new Set(a.map(rightKey)).size === new Set([...a, ...b].map(rightKey)).size

function wantedRights(role: string, party: string): Right[] {
  return role === 'auditor'
    ? [{ kind: 'CanReadAs', party }, { kind: 'CanReadAsAnyParty' }]
    : [{ kind: 'CanActAs', party }, { kind: 'CanReadAs', party }]
}

/** Ensure the user's party and ledger user exist with exactly the wanted rights; return the party id. */
async function ensureUser(base: string, id: string, role: string): Promise<string> {
  const existing = await getUser(base, id)
  const party = existing?.primaryParty || (await findParty(base, id)) || (await allocateParty(base, id))
  const want = wantedRights(role, party)
  if (!existing) {
    await createUser(base, id, party, want)
    return party
  }
  if (existing.primaryParty !== party) await setPrimaryParty(base, id, party)
  const have = await listRights(base, id)
  if (!sameSet(have, want)) {
    const haveKeys = new Set(have.map(rightKey))
    const wantKeys = new Set(want.map(rightKey))
    await grantRights(base, id, want.filter((r) => !haveKeys.has(rightKey(r))))
    await revokeRights(base, id, have.filter((r) => !wantKeys.has(rightKey(r))))
  }
  return party
}

async function ensureAuctioneerRole(topology: Topology, auctioneerId: string, party: string): Promise<RoleStep> {
  const node = topology.users.find((u) => u.id === auctioneerId)!.participant
  const base = topology.participants[node]
  const vetted = (await listVetted(base, { packageNamePrefixes: ['sealed-auction'] })).filter(
    (p) => p.packageName === 'sealed-auction' && !p.validUntilExclusive,
  )
  if (!vetted.length) {
    console.warn(
      `WARNING: package 'sealed-auction' is not vetted on ${node}; skipping the AuctioneerRole step. Run 'make deploy' and then 'make provision' again.`,
    )
    return 'skipped'
  }
  const client = createLedgerClient(base, auctioneerId)
  const roles = await client.activeContracts(party, [T.AuctioneerRole])
  if (roles.length > 1) throw new Error(`expected exactly one AuctioneerRole, found ${roles.length}`)
  if (roles.length === 1) return 'exists'
  await client.create(T.AuctioneerRole, { auctioneer: party }, [party])
  return 'created'
}

/**
 * Idempotently provision every topology user. Re-reads existing state from the ledger and from
 * credentials.json (passwords are kept); parties.json is always rewritten from the ledger.
 */
export async function provision(topology: Topology, opts: { outDir?: string } = {}): Promise<ProvisionResult> {
  const outDir = opts.outDir ?? join(repoRoot(), 'config')
  mkdirSync(outDir, { recursive: true })
  const credFile = join(outDir, 'credentials.json')
  const oldCreds = readJsonOr<Record<string, { password?: string }>>(credFile, {})

  const parties: Record<string, string> = {}
  const credentials: Record<string, { password: string }> = {}
  for (const u of topology.users) {
    const base = topology.participants[u.participant]
    if (!base) throw new Error(`user '${u.id}': participant '${u.participant}' has no URL in topology`)
    parties[u.id] = await ensureUser(base, u.id, u.role)
    if (u.role !== 'auditor') {
      const pw = oldCreds[u.id]?.password
      credentials[u.id] = { password: typeof pw === 'string' && pw ? pw : randomBytes(12).toString('base64url') }
    }
    console.log(`${u.id.padEnd(22)} ${u.participant.padEnd(13)} ${parties[u.id]}`)
  }

  const auct = topology.users.find((u) => u.role === 'auctioneer')
  const auctioneerRole: RoleStep = auct ? await ensureAuctioneerRole(topology, auct.id, parties[auct.id]) : 'skipped'
  console.log(`AuctioneerRole: ${auctioneerRole}`)

  writeJson(credFile, credentials)
  writeJson(join(outDir, 'parties.json'), parties)
  return { parties, credentials, auctioneerRole }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = async () => {
    const args = parseArgs(process.argv.slice(2), ['topology'])
    await provision(loadTopology(args.topology))
  }
  run().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
