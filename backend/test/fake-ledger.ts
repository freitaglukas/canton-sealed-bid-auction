// In-memory fake of the sealed-auction ledger, enough to model visibility, PlaceBid and Auction_Close.
import {
  LedgerError,
  T,
  isTemplate,
  type Contract,
  type LedgerClient,
  type LedgerEvent,
  type Parties,
  type Topology,
} from '@sa/ledger-client'

export const topology: Topology = {
  participants: { p: 'http://x' },
  users: [
    { id: 'auctioneer', participant: 'p', role: 'auctioneer' },
    { id: 'alice', participant: 'p', role: 'bidder' },
    { id: 'bob', participant: 'p', role: 'bidder' },
    { id: 'carol', participant: 'p', role: 'bidder' },
    { id: 'dave', participant: 'p', role: 'outsider' },
    { id: 'auditor-sv', participant: 'p', role: 'auditor' },
  ],
}
export const parties: Parties = {
  auctioneer: 'Auctioneer::1',
  alice: 'Alice::1',
  bob: 'Bob::1',
  carol: 'Carol::1',
  dave: 'Dave::1',
  'auditor-sv': 'Auditor::1',
}
export const credentials: Record<string, string> = {
  auctioneer: 'auc-pw',
  alice: 'alice-pw',
  bob: 'bob-pw',
  carol: 'carol-pw',
  dave: 'dave-pw',
}

export const lerr = (code: string, opts: { errorId?: string; retryable?: boolean; status?: number } = {}) =>
  new LedgerError(`${code} happened`, code, opts.status ?? 409, {}, opts.retryable ?? false, opts.errorId)

interface Stored { cid: string; templateId: string; payload: any; stakeholders: string[] }
export interface Call { userId: string; kind: string; actAs?: string[]; party?: string; choice?: string; arg?: any; cid?: string }

const name = (t: string) => t.split(':').pop()!
const num = (s: string) => parseFloat(s)

export class FakeLedger {
  contracts: Stored[] = []
  calls: Call[] = []
  closeArgs: any[] = []
  private n = 0
  private clock = 0
  /** errors to throw on the next exercise of the named choice (consumed in order) */
  failNext: Record<string, LedgerError[]> = {}

  constructor() {
    this.add(T.AuctioneerRole, { auctioneer: parties.auctioneer }, [parties.auctioneer])
  }

  add(templateId: string, payload: any, stakeholders: string[]): string {
    const cid = `cid-${++this.n}`
    this.contracts.push({ cid, templateId, payload, stakeholders })
    return cid
  }
  private archive(cid: string) {
    this.contracts = this.contracts.filter((c) => c.cid !== cid)
  }
  private find(cid: string) {
    return this.contracts.find((c) => c.cid === cid)
  }
  private created(c: Stored): LedgerEvent {
    return {
      kind: 'created', contractId: c.cid, templateId: c.templateId, payload: c.payload,
      signatories: [], observers: [], witnessParties: c.stakeholders,
    }
  }

  clientFor(userId: string): LedgerClient {
    const self = this
    const me = parties[userId]
    return {
      userId,
      baseUrl: 'http://fake',
      async create(templateId, args, actAs) {
        self.calls.push({ userId, kind: 'create', actAs })
        const cid = self.add(templateId, args, [...actAs])
        return { contractId: cid }
      },
      async exercise(templateId, cid, choice, arg: any, actAs) {
        self.calls.push({ userId, kind: 'exercise', actAs, choice, arg, cid })
        const queued = self.failNext[choice]?.shift()
        if (queued) throw queued
        const c = self.find(cid)
        if (!c) throw lerr('CONTRACT_NOT_FOUND')
        if (!c.stakeholders.includes(actAs[0])) throw lerr('CONTRACT_NOT_FOUND')
        const events: LedgerEvent[] = []
        const mk = (t: string, payload: any, st: string[]) => {
          const id = self.add(t, payload, st)
          events.push(self.created(self.find(id)!))
          return id
        }
        if (choice === 'CreateAuction') {
          const invs = (arg.invitees as string[]).map((b) =>
            mk(T.AuctionInvitation, { auctioneer: me, bidder: b, auctionId: arg.auctionId, item: arg.item }, [me, b]),
          )
          mk(T.Auction, { auctioneer: me, auctionId: arg.auctionId, item: arg.item, invitees: arg.invitees, invitations: invs }, [me])
          return { result: null as any, events }
        }
        if (choice === 'PlaceBid') {
          if (actAs[0] !== c.payload.bidder) throw lerr('DAML_AUTHORIZATION_ERROR', { status: 403 })
          self.archive(cid)
          const id = mk(
            T.Bid,
            { ...c.payload, invitationCid: cid, amount: Number(arg.amount).toFixed(10), submittedAt: String(self.clock++) },
            [c.payload.bidder, c.payload.auctioneer],
          )
          return { result: id as any, events }
        }
        if (choice === 'Auction_Close') {
          self.closeArgs.push(arg)
          if (actAs[0] !== c.payload.auctioneer) throw lerr('DAML_AUTHORIZATION_ERROR', { status: 403 })
          const bids: Stored[] = []
          for (const b of arg.bids as string[]) {
            const s = self.find(b)
            if (!s) throw lerr('CONTRACT_NOT_FOUND')
            bids.push(s)
          }
          const opens: Stored[] = []
          for (const o of arg.openInvitations as string[]) {
            const s = self.find(o)
            if (!s) throw lerr('CONTRACT_NOT_FOUND')
            opens.push(s)
          }
          const accounted = [...bids.map((b) => b.payload.invitationCid), ...opens.map((o) => o.cid)].sort()
          if (JSON.stringify(accounted) !== JSON.stringify([...c.payload.invitations].sort())) {
            throw lerr('UNHANDLED_EXCEPTION', { errorId: 'SA_INCOMPLETE_CLOSE' })
          }
          const win = [...bids].sort((x, y) => num(y.payload.amount) - num(x.payload.amount))[0]
          self.archive(cid)
          for (const b of bids) {
            self.archive(b.cid)
            const won = b === win
            mk(
              T.AuctionOutcome,
              {
                auctioneer: me, bidder: b.payload.bidder, auctionId: b.payload.auctionId, item: b.payload.item,
                bidAmount: b.payload.amount,
                result: won ? { tag: 'Won', value: { amountOwed: b.payload.amount } } : { tag: 'Lost', value: {} },
              },
              [me, b.payload.bidder],
            )
          }
          for (const o of opens) {
            self.archive(o.cid)
            mk(T.NoBidNotice, { auctioneer: me, bidder: o.payload.bidder, auctionId: o.payload.auctionId, item: o.payload.item }, [me, o.payload.bidder])
          }
          mk(
            T.AuctionResult,
            {
              auctioneer: me, auctionId: c.payload.auctionId, item: c.payload.item,
              winner: win ? win.payload.bidder : null, price: win ? win.payload.amount : null,
              bids: bids.map((b) => ({ _1: b.payload.bidder, _2: b.payload.amount })),
            },
            [me],
          )
          return { result: null as any, events }
        }
        throw lerr('UNKNOWN_CHOICE')
      },
      async activeContracts<P>(party: string | 'ANY', templateIds: string[] | 'ALL') {
        self.calls.push({ userId, kind: 'acs', party })
        if (party === 'ANY') throw lerr('PERMISSION_DENIED', { status: 403 })
        return self.contracts
          .filter((c) => c.stakeholders.includes(party))
          .filter((c) => templateIds === 'ALL' || templateIds.some((t) => t === c.templateId || isTemplate(c.templateId, name(t) as any)))
          .map((c) => ({ contractId: c.cid, templateId: c.templateId, payload: c.payload as P })) as Contract<P>[]
      },
      async updates() {
        return []
      },
      async ledgerEnd() {
        return 1
      },
    }
  }

  /** ledgerFor dep that records which user each client was requested for. */
  ledgerFor = (userId: string) => {
    this.requested.push(userId)
    return this.clientFor(userId)
  }
  requested: string[] = []
}
