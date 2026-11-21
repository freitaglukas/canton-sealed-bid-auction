import createClient from 'openapi-fetch'
import { randomUUID } from 'node:crypto'
import type { paths, components } from './generated/openapi'
import { parseLedgerError } from './errors'
import { mintToken } from './jwt'
import type { Contract, DisclosedContract, LedgerClient, LedgerEvent, LedgerTransaction } from './types'

type Schemas = components['schemas']
type Filters = Schemas['Filters']
type EventFormat = Schemas['EventFormat']
type Command = Schemas['Command']

const UPDATES_PAGE = 100

const wildcard = (includeBlob = false): Filters => ({
  cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: includeBlob } } } }],
})

const templateFilters = (ids: string[], includeBlob: boolean): Filters => ({
  cumulative: ids.map((templateId) => ({
    identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: includeBlob } } },
  })),
})

const eventFormatFor = (parties: string[] | 'ANY', filters: Filters): EventFormat =>
  parties === 'ANY'
    ? { filtersForAnyParty: filters, verbose: true }
    : { filtersByParty: Object.fromEntries(parties.map((p) => [p, filters])), verbose: true }

/** `#pkg:Mod:Tpl` or `pkgid:Mod:Tpl` -> `Mod:Tpl` */
const templateSuffix = (templateId: string): string => templateId.split(':').slice(-2).join(':')

/** Unwrap `{ Kind: {...} }` externally-tagged unions. */
function untag(o: unknown): [string, any] | undefined {
  if (!o || typeof o !== 'object') return undefined
  const k = Object.keys(o)[0]
  return k ? [k, (o as Record<string, unknown>)[k]] : undefined
}

function toEvent(e: unknown): LedgerEvent | undefined {
  const t = untag(e)
  if (!t) return undefined
  const [kind, v] = t
  if (kind === 'CreatedEvent')
    return {
      kind: 'created',
      contractId: v.contractId,
      templateId: v.templateId,
      payload: v.createArgument,
      signatories: v.signatories ?? [],
      observers: v.observers ?? [],
      witnessParties: v.witnessParties ?? [],
    }
  if (kind === 'ExercisedEvent')
    return {
      kind: 'exercised',
      contractId: v.contractId,
      templateId: v.templateId,
      choice: v.choice,
      choiceArgument: v.choiceArgument,
      exerciseResult: v.exerciseResult,
      consuming: !!v.consuming,
      actingParties: v.actingParties ?? [],
      witnessParties: v.witnessParties ?? [],
    }
  if (kind === 'ArchivedEvent')
    return { kind: 'archived', contractId: v.contractId, templateId: v.templateId, witnessParties: v.witnessParties ?? [] }
  return undefined
}

function toTransaction(tx: any): LedgerTransaction {
  const events = ((tx.events ?? []) as unknown[]).map(toEvent).filter((e): e is LedgerEvent => !!e)
  return { updateId: tx.updateId, offset: tx.offset, events }
}

export function createLedgerClient(baseUrl: string, userId: string, token?: string): LedgerClient {
  let tokenPromise: Promise<string> | undefined
  const getToken = () => (token ? Promise.resolve(token) : (tokenPromise ??= mintToken(userId)))

  const http = createClient<paths>({
    baseUrl,
    fetch: async (req: Request) => {
      req.headers.set('authorization', `Bearer ${await getToken()}`)
      return fetch(req)
    },
  })

  const check = <T>(r: { data?: T; error?: unknown; response: Response }): T => {
    if (r.error !== undefined || !r.response.ok) throw parseLedgerError(r.response.status, r.error)
    return r.data as T
  }

  async function ledgerEnd(): Promise<number> {
    const d = check(await http.GET('/v2/state/ledger-end'))
    return d.offset ?? 0
  }

  async function submit(commands: Command[], actAs: string[], disclosed?: DisclosedContract[]) {
    const body = {
      commands: {
        commands,
        commandId: randomUUID(),
        actAs,
        ...(disclosed?.length ? { disclosedContracts: disclosed } : {}),
      },
      transactionFormat: {
        eventFormat: eventFormatFor(actAs, wildcard()),
        transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS' as const,
      },
    }
    const d = check(await http.POST('/v2/commands/submit-and-wait-for-transaction', { body }))
    return toTransaction(d.transaction)
  }

  return {
    userId,
    baseUrl,
    ledgerEnd,

    async create<P>(templateId: string, args: P, actAs: string[]) {
      const tx = await submit([{ CreateCommand: { templateId, createArguments: args } }], actAs)
      const want = templateSuffix(templateId)
      const created = tx.events.filter((e) => e.kind === 'created')
      const hit = created.find((e) => templateSuffix(e.templateId) === want) ?? created[0]
      if (!hit) throw new Error(`create ${templateId}: no created event in transaction ${tx.updateId}`)
      return { contractId: hit.contractId }
    },

    async exercise<R>(
      templateId: string,
      cid: string,
      choice: string,
      arg: object,
      actAs: string[],
      opts?: { disclosed?: DisclosedContract[] },
    ) {
      const tx = await submit(
        [{ ExerciseCommand: { templateId, contractId: cid, choice, choiceArgument: arg } }],
        actAs,
        opts?.disclosed,
      )
      // The submitted command is the first root node; events are in node order.
      const hit = tx.events.find((e) => e.kind === 'exercised' && e.contractId === cid && e.choice === choice)
      if (!hit || hit.kind !== 'exercised') throw new Error(`exercise ${choice}: no matching exercised event in ${tx.updateId}`)
      return { result: hit.exerciseResult as R, events: tx.events }
    },

    async activeContracts<P>(
      party: string | 'ANY',
      templateIds: string[] | 'ALL',
      opts?: { includeBlob?: boolean; atOffset?: number },
    ) {
      const includeBlob = opts?.includeBlob ?? false
      const filters = templateIds === 'ALL' ? wildcard(includeBlob) : templateFilters(templateIds, includeBlob)
      const activeAtOffset = opts?.atOffset ?? (await ledgerEnd())
      const rows = check(
        await http.POST('/v2/state/active-contracts', {
          body: { activeAtOffset, eventFormat: eventFormatFor(party === 'ANY' ? 'ANY' : [party], filters) },
        }),
      )
      const out: Contract<P>[] = []
      for (const row of rows as Schemas['JsGetActiveContractsResponse'][]) {
        const entry = untag(row.contractEntry)
        if (!entry || entry[0] !== 'JsActiveContract') continue
        const ev = entry[1].createdEvent
        out.push({
          contractId: ev.contractId,
          templateId: ev.templateId,
          payload: ev.createArgument as P,
          ...(ev.createdEventBlob ? { createdEventBlob: ev.createdEventBlob } : {}),
        })
      }
      return out
    },

    async updates(party: string | 'ANY', beginExclusive: number, endInclusive?: number) {
      const end = endInclusive ?? (await ledgerEnd())
      const eventFormat = eventFormatFor(party === 'ANY' ? 'ANY' : [party], wildcard())
      const txs: LedgerTransaction[] = []
      let begin = beginExclusive
      while (begin < end) {
        const rows = check(
          await http.POST('/v2/updates', {
            params: { query: { limit: UPDATES_PAGE } },
            body: {
              beginExclusive: begin,
              endInclusive: end,
              updateFormat: {
                includeTransactions: { eventFormat, transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS' },
              },
            },
          }),
        ) as Schemas['JsGetUpdatesResponse'][]
        let last = begin
        for (const row of rows) {
          const u = untag(row.update)
          if (!u) continue
          const v = u[1]?.value ?? u[1]
          if (typeof v?.offset === 'number') last = Math.max(last, v.offset)
          if (u[0] === 'Transaction') txs.push(toTransaction(v))
        }
        if (rows.length < UPDATES_PAGE || last <= begin) break
        begin = last
      }
      return txs
    },
  }
}
