import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BASE = process.env.BACKEND_URL ?? 'http://localhost:8787'
const root = resolve(fileURLToPath(import.meta.url), '../../..')
const creds: Record<string, string> = JSON.parse(readFileSync(resolve(root, 'config/credentials.json'), 'utf8'))

export interface Res<T = any> { status: number; body: T }
export interface Api { userId: string; call<T = any>(method: string, path: string, body?: unknown): Promise<Res<T>> }

/** Logs in and returns a client with its own cookie jar. */
export async function login(userId: string): Promise<Api> {
  let cookie = ''
  const call = async <T = any>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const r = await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const sc = (r.headers as any).getSetCookie?.() as string[] | undefined
    if (sc?.length) cookie = sc.map((c) => c.split(';')[0]).join('; ')
    const text = await r.text()
    let b: any = text
    try { b = text ? JSON.parse(text) : null } catch {}
    return { status: r.status, body: b }
  }
  const res = await call('POST', '/api/login', { userId, password: creds[userId] })
  if (res.status !== 200) throw new Error(`login ${userId} failed: ${res.status} ${JSON.stringify(res.body)}`)
  return { userId, call }
}
