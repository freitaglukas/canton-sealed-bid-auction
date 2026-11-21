// Thin admin-API helpers over the Canton JSON API (raw fetch; shapes from the vendored openapi.yaml).
import { mintToken } from '@sa/ledger-client'

export const ADMIN = 'ledger-api-user'

export type Right =
  | { kind: 'CanActAs'; party: string }
  | { kind: 'CanReadAs'; party: string }
  | { kind: 'CanReadAsAnyParty' }

export const rightKey = (r: Right): string => (r.kind === 'CanReadAsAnyParty' ? r.kind : `${r.kind}:${r.party}`)

const toWire = (r: Right) =>
  r.kind === 'CanReadAsAnyParty'
    ? { kind: { CanReadAsAnyParty: { value: {} } } }
    : { kind: { [r.kind]: { value: { party: r.party } } } }

function fromWire(w: any): Right | undefined {
  const k = w?.kind ?? {}
  if (k.CanActAs) return { kind: 'CanActAs', party: k.CanActAs.value.party }
  if (k.CanReadAs) return { kind: 'CanReadAs', party: k.CanReadAs.value.party }
  if (k.CanReadAsAnyParty) return { kind: 'CanReadAsAnyParty' }
  return undefined // ParticipantAdmin etc: not ours to manage
}

export interface Res {
  status: number
  body: any
}

export async function call(
  base: string,
  path: string,
  init: { method?: string; json?: unknown; bytes?: Uint8Array } = {},
): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${await mintToken(ADMIN)}` }
  let body: BodyInit | undefined
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.json)
  } else if (init.bytes) {
    headers['content-type'] = 'application/octet-stream'
    body = init.bytes as unknown as BodyInit
  }
  const r = await fetch(base + path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body })
  const text = await r.text()
  let parsed: any = text
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed }
}

async function ok(base: string, path: string, init: Parameters<typeof call>[2] = {}): Promise<any> {
  const r = await call(base, path, init)
  if (r.status < 200 || r.status >= 300)
    throw new Error(`${init.method ?? (init.json || init.bytes ? 'POST' : 'GET')} ${base}${path} -> ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}

// ---- packages ----

export const uploadDar = (base: string, dar: Uint8Array) => ok(base, '/v2/packages?vetAllPackages=true', { bytes: dar })

/** Raw `packageStatus` literal, or `null` if the participant does not know the package. */
export async function packageStatus(base: string, packageId: string): Promise<string | null> {
  const r = await call(base, `/v2/packages/${packageId}/status`)
  if (r.status === 404) return null
  if (r.status !== 200) throw new Error(`package status ${packageId} on ${base} -> ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.packageStatus as string
}

export interface VettedEntry {
  packageId: string
  packageName?: string
  packageVersion?: string
  validUntilExclusive?: string
}

/** Vetted packages (all synchronizers) on this participant matching the filter. */
export async function listVetted(
  base: string,
  filter: { packageIds?: string[]; packageNamePrefixes?: string[] },
): Promise<VettedEntry[]> {
  const out: VettedEntry[] = []
  let pageToken = ''
  do {
    const b = await ok(base, '/v2/package-vetting/list', {
      json: { packageMetadataFilter: filter, topologyStateFilter: {}, pageToken, pageSize: 0 },
    })
    for (const vp of b.vettedPackages ?? []) out.push(...(vp.packages ?? []))
    pageToken = b.nextPageToken ?? ''
  } while (pageToken)
  return out
}

export async function isVetted(base: string, packageId: string): Promise<boolean> {
  const v = await listVetted(base, { packageIds: [packageId] })
  return v.some((p) => p.packageId === packageId && !p.validUntilExclusive)
}

// ---- parties ----

/** Find a local party whose id is `<hint>::<fingerprint>`. */
export async function findParty(base: string, hint: string): Promise<string | undefined> {
  let pageToken = ''
  do {
    const q = new URLSearchParams({ pageSize: '200' })
    if (pageToken) q.set('pageToken', pageToken)
    const b = await ok(base, `/v2/parties?${q}`)
    for (const d of b.partyDetails ?? []) if (String(d.party).startsWith(`${hint}::`)) return d.party
    pageToken = b.nextPageToken ?? ''
  } while (pageToken)
  return undefined
}

export async function allocateParty(base: string, hint: string): Promise<string> {
  const b = await ok(base, '/v2/parties', { json: { partyIdHint: hint, identityProviderId: '' } })
  return b.partyDetails.party as string
}

// ---- users ----

export async function getUser(base: string, id: string): Promise<{ id: string; primaryParty?: string } | undefined> {
  const r = await call(base, `/v2/users/${encodeURIComponent(id)}`)
  if (r.status === 404) return undefined
  if (r.status !== 200) throw new Error(`get user ${id} on ${base} -> ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.user
}

export async function createUser(base: string, id: string, primaryParty: string, rights: Right[]): Promise<void> {
  await ok(base, '/v2/users', {
    json: { user: { id, primaryParty, isDeactivated: false, identityProviderId: '' }, rights: rights.map(toWire) },
  })
}

export async function setPrimaryParty(base: string, id: string, primaryParty: string): Promise<void> {
  await ok(base, `/v2/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: {
      user: { id, primaryParty, isDeactivated: false, identityProviderId: '' },
      updateMask: { paths: ['primary_party', 'is_deactivated'] },
    },
  })
}

export async function listRights(base: string, id: string): Promise<Right[]> {
  const b = await ok(base, `/v2/users/${encodeURIComponent(id)}/rights`)
  return ((b.rights ?? []) as unknown[]).map(fromWire).filter((r): r is Right => !!r)
}

export async function grantRights(base: string, id: string, rights: Right[]): Promise<void> {
  if (!rights.length) return
  await ok(base, `/v2/users/${encodeURIComponent(id)}/rights`, {
    json: { userId: id, rights: rights.map(toWire), identityProviderId: '' },
  })
}

export async function revokeRights(base: string, id: string, rights: Right[]): Promise<void> {
  if (!rights.length) return
  await ok(base, `/v2/users/${encodeURIComponent(id)}/rights`, {
    method: 'PATCH',
    json: { userId: id, rights: rights.map(toWire), identityProviderId: '' },
  })
}

export async function deleteUser(base: string, id: string): Promise<void> {
  await ok(base, `/v2/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
