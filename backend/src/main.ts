// Wires real dependencies. Depends on Task 5 exports of @sa/ledger-client (signatures assumed, verify at merge).
import { readFileSync } from 'node:fs'
import { createLedgerClient, loadParties, loadTopology, mintToken } from '@sa/ledger-client'
import { buildServer } from './server'

const topology = loadTopology()
const parties = loadParties()
const credentials: Record<string, string> = JSON.parse(
  readFileSync(process.env.CREDENTIALS ?? 'config/credentials.json', 'utf8'),
)

const ledgerFor = (userId: string) => {
  const user = topology.users.find((u) => u.id === userId)
  if (!user) throw new Error(`unknown user ${userId}`)
  return createLedgerClient({ baseUrl: topology.participants[user.participant], userId, token: mintToken(userId) })
}

const app = await buildServer({ ledgerFor, parties, topology, credentials })
const port = Number(process.env.PORT ?? 3001)
await app.listen({ port, host: '127.0.0.1' })
console.log(`backend listening on http://127.0.0.1:${port}`)
