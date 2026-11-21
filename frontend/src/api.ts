import type {
  ApiError, AuctionSummary, CloseAuctionResponse, CreateAuctionRequest, CreateAuctionResponse,
  DirectoryResponse, InvitationView, LoginResponse, OutcomeView, OwnBidView, PlaceBidResponse,
} from '../../backend/src/contract'

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string; ledgerCode?: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 204) return { ok: true, data: undefined as T }
    const json = await res.json().catch(() => null)
    if (res.ok) return { ok: true, data: json as T }
    const e = (json ?? {}) as Partial<ApiError>
    return { ok: false, error: e.error ?? `HTTP ${res.status}`, code: e.code ?? 'LEDGER_ERROR', ledgerCode: e.ledgerCode }
  } catch (err) {
    return { ok: false, error: `Network error: ${(err as Error).message}`, code: 'LEDGER_ERROR' }
  }
}

export const api = {
  login: (userId: string, password: string) => call<LoginResponse>('POST', '/api/login', { userId, password }),
  logout: () => call<void>('POST', '/api/logout'),
  me: () => call<LoginResponse>('GET', '/api/me'),
  directory: () => call<DirectoryResponse>('GET', '/api/directory'),
  createAuction: (r: CreateAuctionRequest) => call<CreateAuctionResponse>('POST', '/api/auctions', r),
  auctions: () => call<AuctionSummary[]>('GET', '/api/auctions'),
  close: (id: string) => call<CloseAuctionResponse>('POST', `/api/auctions/${encodeURIComponent(id)}/close`),
  invitations: () => call<InvitationView[]>('GET', '/api/invitations'),
  bid: (invitationId: string, amount: string) =>
    call<PlaceBidResponse>('POST', `/api/invitations/${encodeURIComponent(invitationId)}/bid`, { amount }),
  bids: () => call<OwnBidView[]>('GET', '/api/bids'),
  outcomes: () => call<OutcomeView[]>('GET', '/api/outcomes'),
}

/** Banner text: error message plus code and ledgerCode (tests match on both). */
export function errorText(r: { error: string; code: string; ledgerCode?: string }): string {
  return `${r.error} [${r.code}${r.ledgerCode ? ` / ${r.ledgerCode}` : ''}]`
}
