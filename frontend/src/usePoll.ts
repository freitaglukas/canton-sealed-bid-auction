import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from './api'
import type { ApiResult } from './api'

/** Runs `fn` now and every `ms`; returns a manual refresh. */
export function usePoll(fn: () => Promise<void>, ms = 2000): () => void {
  const ref = useRef(fn)
  ref.current = fn
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    const run = () => { if (live) void ref.current() }
    run()
    const t = setInterval(run, ms)
    return () => { live = false; clearInterval(t) }
  }, [ms, tick])
  return useCallback(() => setTick((n) => n + 1), [])
}

export interface PollCtx { setError: (e: string | null) => void; onUnauth: () => void }

/** Poll reporter: UNAUTHENTICATED logs out; any failure shows the banner; a clean poll clears a poll-set banner. */
export function usePollReporter({ setError, onUnauth }: PollCtx) {
  const polled = useRef(false)
  return (results: ApiResult<unknown>[]) => {
    const failed = results.find((r) => !r.ok)
    if (failed && !failed.ok) {
      if (failed.code === 'UNAUTHENTICATED') return onUnauth()
      polled.current = true
      setError(errorText(failed))
    } else if (polled.current) {
      polled.current = false
      setError(null)
    }
  }
}

/** For user actions: UNAUTHENTICATED logs out, other failures show the banner. */
export function reportAction(r: ApiResult<unknown>, { setError, onUnauth }: PollCtx) {
  if (r.ok) return
  if (r.code === 'UNAUTHENTICATED') onUnauth()
  else setError(errorText(r))
}
