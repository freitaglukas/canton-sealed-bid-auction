import { ledgerForUser, loadParties, T, LedgerError } from '@sa/ledger-client'
import { login, type Api } from './api'

const parties = loadParties()
const P = (u: string) => parties[u]
const ok = (s: string) => console.log(`✓ ${s}`)
const rej = (s: string, status: number | string, code: string, ledgerCode = '-') =>
  console.log(`✗ rejected (${status} ${code} / ledger: ${ledgerCode}) ${s}`)
const ledgerRej = async (s: string, p: Promise<unknown>) => {
  try { await p; console.log(`!! UNEXPECTED SUCCESS: ${s}`) } catch (e) {
    const le = e as LedgerError
    rej(s, le.httpStatus ?? '-', '-', le.code)
  }
}

const bidders = ['alice', 'bob', 'carol']
const users = ['auctioneer', ...bidders, 'dave']
const api: Record<string, Api> = {}
const led: Record<string, ReturnType<typeof ledgerForUser>> = {}
const start: Record<string, number> = {}
for (const u of users) { api[u] = await login(u); led[u] = ledgerForUser(u); start[u] = await led[u].ledgerEnd() }
ok('logged in as ' + users.join(', '))

const item = `Painting-${Date.now()}`
const mk = async (n: string) => (await api.auctioneer.call('POST', '/api/auctions', { item: `${item}-${n}`, bidders })).body.auctionId as string
const A = await mk('A'), B = await mk('B')
ok(`auctioneer opened auctions A=${A.slice(0, 8)} and B=${B.slice(0, 8)}`)

const inv: Record<string, Record<string, string>> = { A: {}, B: {} }
for (const u of [...bidders, 'dave']) for (const i of (await api[u].call('GET', '/api/invitations')).body as any[]) {
  if (i.auctionId === A) inv.A[u] = i.invitationId
  if (i.auctionId === B) inv.B[u] = i.invitationId
}
ok(`dave sees ${Object.keys(inv.A).includes('dave') ? 'an' : 'no'} invitation for these auctions`)

const bid = async (u: string, k: 'A' | 'B', amount: string, expectFail = false) => {
  const r = await api[u].call('POST', `/api/invitations/${encodeURIComponent(inv[k][u])}/bid`, { amount })
  if (r.status === 200 && !expectFail) return ok(`${u} bid ${amount} on ${k} (REST)`)
  if (r.status === 414) { // known backend bug: maxParamLength
    try {
      await led[u].exercise(T.AuctionInvitation, inv[k][u], 'PlaceBid', { amount }, [P(u)])
      return expectFail ? console.log('!! UNEXPECTED SUCCESS') : ok(`${u} bid ${amount} on ${k} (ledger fallback; REST gave 414 FST_ERR_MAX_PARAM_LENGTH)`)
    } catch (e) { return rej(`${u} bid ${amount} on ${k}`, 414, 'FST_ERR_MAX_PARAM_LENGTH', (e as LedgerError).code) }
  }
  rej(`${u} bid ${amount} on ${k}`, r.status, r.body.code, r.body.ledgerCode)
}

console.log('\n-- outsider --')
const d = await api.dave.call('POST', `/api/invitations/${encodeURIComponent(inv.A.alice)}/bid`, { amount: '999' })
rej('dave bids on alice\'s invitation', d.status, d.body.code ?? '-', d.body.ledgerCode)
await ledgerRej('dave forges a Bid on the ledger', led.dave.create(T.Bid, {
  auctioneer: P('auctioneer'), bidder: P('dave'), invitationCid: inv.A.alice, auctionId: A, item,
  amount: '999', submittedAt: new Date().toISOString() }, [P('dave')]))

console.log('\n-- sealed bids --')
for (const [u, k, a] of [['alice','A','100'],['bob','A','150'],['carol','A','120'],['alice','B','50'],['carol','B','60']] as const) await bid(u, k, a)
await bid('alice', 'A', '500', true)

console.log('\n-- tampering --')
const aliceBid = (await led.alice.activeContracts<any>(P('alice'), [T.Bid])).find((c) => c.payload.auctionId === A)!.contractId
await ledgerRej('bob archives alice\'s bid', led.bob.exercise(T.Bid, aliceBid, 'Archive', {}, [P('bob')]))
const c = (await led.auctioneer.activeContracts<any>(P('auctioneer'), [T.Bid], { includeBlob: true })).find((x) => x.contractId === aliceBid)!
await ledgerRej('bob concludes alice\'s bid using disclosure', led.bob.exercise(T.Bid, aliceBid, 'Bid_Conclude', { won: true }, [P('bob')],
  { disclosed: [{ templateId: c.templateId, contractId: c.contractId, createdEventBlob: c.createdEventBlob! }] }))
const bc = await api.bob.call('POST', `/api/auctions/${A}/close`)
rej('bob closes auction A', bc.status, bc.body.code, bc.body.ledgerCode)

console.log('\n-- close --')
const r = await api.auctioneer.call('POST', `/api/auctions/${A}/close`)
ok(`auctioneer closed A: winner ${r.body.winner} price ${r.body.price}`)
await api.auctioneer.call('POST', `/api/auctions/${B}/close`); ok('auctioneer closed B')
await bid('bob', 'B', '70', true)

console.log('\n-- summary: what each user can see --')
for (const u of users) {
  const acs = await led[u].activeContracts<any>(P(u), 'ALL')
  const mine = acs.filter((x) => [A, B].includes(x.payload?.auctionId))
  const by: Record<string, number> = {}
  for (const x of mine) { const n = x.templateId.split(':').pop()!; by[n] = (by[n] ?? 0) + 1 }
  const txs = await led[u].updates(P(u), start[u])
  const outs = u === 'auctioneer' || u === 'dave' ? '' : JSON.stringify(((await api[u].call('GET', '/api/outcomes')).body as any[]).filter((o) => [A, B].includes(o.auctionId)).map((o) => `${o.result}${o.amountOwed ? ':' + o.amountOwed : ''}`))
  console.log(`  ${u.padEnd(10)} ACS ${JSON.stringify(by)} updates=${txs.length} ${outs}`)
}
