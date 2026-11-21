import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LedgerClient, Parties, Topology } from './types'
import { createLedgerClient } from './client'

function findRoot(): string {
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

const resolveFromRoot = (p: string) => (isAbsolute(p) ? p : resolve(findRoot(), p))

export function loadTopology(path?: string): Topology {
  const file = resolveFromRoot(path ?? process.env.TOPOLOGY ?? 'config/topology.json')
  if (!existsSync(file)) throw new Error(`topology file not found: ${file}`)
  return JSON.parse(readFileSync(file, 'utf8')) as Topology
}

export function loadParties(): Parties {
  const file = resolveFromRoot('config/parties.json')
  if (!existsSync(file)) {
    throw new Error(`config/parties.json not found at ${file}; run provisioning first`)
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Parties
}

/** Client for the user's participant, authenticated with a token minted for that user. */
export function ledgerForUser(userId: string, topology: Topology = loadTopology()): LedgerClient {
  const u = topology.users.find((x) => x.id === userId)
  if (!u) throw new Error(`unknown user '${userId}' in topology`)
  const baseUrl = topology.participants[u.participant]
  if (!baseUrl) throw new Error(`participant '${u.participant}' for user '${userId}' has no URL`)
  return createLedgerClient(baseUrl, userId)
}
