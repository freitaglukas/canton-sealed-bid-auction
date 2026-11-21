// FROZEN class shape (Wave 0).
export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly raw: unknown,
    public readonly retryable: boolean = false,
    public readonly errorId?: string,
    public readonly category?: string,
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}

const SA_RE = /SA_[A-Z_]+/
const RETRY_CODE_RE = /LOCKED|CONTENTION/
// Canton ErrorCategory id 2 = ContentionOnSharedResources (best-effort; code and retryInfo are the primary signals).
const CONTENTION_CATEGORY = 2

/** Map an HTTP error body (JsCantonError shape) to a LedgerError. Never throws. */
export function parseLedgerError(status: number, body: unknown): LedgerError {
  const b: Record<string, unknown> = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const code = typeof b.code === 'string' && b.code ? b.code : `HTTP_${status}`
  const cause = typeof b.cause === 'string' ? b.cause : typeof body === 'string' ? body : ''
  const ctx: Record<string, unknown> =
    b.context && typeof b.context === 'object' ? (b.context as Record<string, unknown>) : {}

  // 1. structured context entry named error_id / errorId; 2. cause; 3. any context value.
  let errorId: string | undefined
  for (const [k, v] of Object.entries(ctx)) {
    if (/^(error_?id|sa_?error)$/i.test(k) && typeof v === 'string') {
      errorId = SA_RE.exec(v)?.[0]
      if (errorId) break
    }
  }
  errorId ??= SA_RE.exec(cause)?.[0]
  if (!errorId) {
    for (const v of Object.values(ctx)) {
      const m = typeof v === 'string' ? SA_RE.exec(v) : null
      if (m) {
        errorId = m[0]
        break
      }
    }
  }

  const cat = b.errorCategory
  const category = cat === undefined || cat === null ? undefined : String(cat)
  const retryInfo = b.retryInfo
  const retryable =
    RETRY_CODE_RE.test(code) ||
    cat === CONTENTION_CATEGORY ||
    (typeof cat === 'string' && /contention|retry/i.test(cat)) ||
    (retryInfo !== undefined && retryInfo !== null && retryInfo !== '')

  return new LedgerError(cause ? `${code}: ${cause}` : code, code, status, body, retryable, errorId, category)
}
