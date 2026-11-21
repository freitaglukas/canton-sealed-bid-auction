// Wires real dependencies from @sa/ledger-client (Task 5). Not typecheckable until that branch is merged.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ledgerForUser, loadParties, loadTopology } from '@sa/ledger-client'
import { buildServer } from './server'

/** Walk up to the package.json that declares workspaces. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const pj = join(dir, 'package.json')
    if (existsSync(pj) && JSON.parse(readFileSync(pj, 'utf8')).workspaces) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error('repo root (package.json with workspaces) not found')
    dir = up
  }
}

const topology = loadTopology()
const parties = loadParties()
const credentialsPath = process.env.CREDENTIALS ? resolve(process.env.CREDENTIALS) : join(repoRoot(), 'config/credentials.json')
const credentials: Record<string, string> = JSON.parse(readFileSync(credentialsPath, 'utf8'))

const app = await buildServer({ ledgerFor: (u) => ledgerForUser(u, topology), parties, topology, credentials, logger: true })
const port = Number(process.env.PORT ?? 8787)
await app.listen({ port, host: '127.0.0.1' })
console.log(`backend listening on http://127.0.0.1:${port}`)
